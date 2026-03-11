import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createWriteStream, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  registerUser,
  loginUser,
  refreshTokens,
  revokeSession,
  authenticate,
  publicUser,
} from './auth.js';
import registerServerRoutes  from './routes/servers.js';
import registerChannelRoutes from './routes/channels.js';
import { setupGateway }      from './gateway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT           = parseInt(process.env.PORT           || '3000');
const MAX_FILE_SIZE  = parseInt(process.env.MAX_FILE_SIZE  || '104857600'); // 100 MB
const UPLOADS_DIR    = process.env.UPLOADS_DIR  || join(ROOT, 'uploads');
const DB_PATH        = process.env.DB_PATH      || join(ROOT, 'data', 'chat.db');

[UPLOADS_DIR, dirname(DB_PATH)].forEach(d => mkdirSync(d, { recursive: true }));

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Fastify ─────────────────────────────────────────────────────────────────
const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyCors, { origin: true });

await app.register(fastifyStatic, {
  root: join(ROOT, 'client'),
  prefix: '/',
});

await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: '/uploads/',
  decorateReply: false,
});

await app.register(fastifyMultipart, {
  limits: { fileSize: MAX_FILE_SIZE },
});

// ── CSP & security headers ────────────────────────────────────────────────────
app.addHook('onSend', (_req, reply, _payload, done) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data: *",
      "media-src 'self' blob: *",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'"
    ].join('; ')
  );
  done();
});

// ── File type helpers ─────────────────────────────────────────────────────────
const ALLOWED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.ogv', '.3gp', '.ts', '.mts',
  '.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus', '.wma', '.weba',
  '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.7z', '.rar', '.tar', '.gz',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.ogv', '.3gp', '.ts', '.mts']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus', '.wma', '.weba']);
function getMessageType(ext) {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  return 'file';
}

// ── Upload endpoint ───────────────────────────────────────────────────────────
app.post('/api/upload', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file provided' });

  const ext = extname(file.filename).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    file.file.resume();
    return reply.code(400).send({ error: `Unsupported type: ${ext}` });
  }

  const name = `${nanoid(12)}${ext}`;
  const dest = join(UPLOADS_DIR, name);
  await pipeline(file.file, createWriteStream(dest));

  if (file.file.truncated) {
    await unlink(dest).catch(() => {});
    return reply.code(413).send({ error: 'File too large' });
  }

  return { url: `/uploads/${name}`, name: file.filename, type: getMessageType(ext) };
});

// ── Auth routes ─────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, reply) => {
  try {
    const { username, email, password } = req.body || {};
    const meta = { userAgent: req.headers['user-agent'], ip: req.ip };
    const result = registerUser(db, { username, email, password }, meta);
    return reply.code(201).send(result);
  } catch (e) {
    return reply.code(e.statusCode || 500).send({ error: e.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const meta = { userAgent: req.headers['user-agent'], ip: req.ip };
    const result = loginUser(db, { email, password }, meta);
    return reply.send(result);
  } catch (e) {
    return reply.code(e.statusCode || 500).send({ error: e.message });
  }
});

// POST /api/auth/refresh
app.post('/api/auth/refresh', async (req, reply) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return reply.code(400).send({ error: 'refreshToken required' });
    const meta = { userAgent: req.headers['user-agent'], ip: req.ip };
    const result = refreshTokens(db, refreshToken, meta);
    return reply.send(result);
  } catch (e) {
    return reply.code(e.statusCode || 500).send({ error: e.message });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', async (req, reply) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) revokeSession(db, refreshToken);
  return reply.send({ ok: true });
});

// GET /api/@me  — current user (requires JWT)
app.get('/api/@me', { preHandler: authenticate }, async (req, reply) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return reply.code(404).send({ error: 'User not found' });
  return reply.send(publicUser(user));
});

// PATCH /api/@me — update own profile
app.patch('/api/@me', { preHandler: authenticate }, async (req, reply) => {
  const allowed = ['avatar_url', 'avatar_color', 'banner_url', 'banner_color', 'about_me', 'custom_status'];
  const fields = {};
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) fields[k] = String(req.body[k]).slice(0, 2048);
  }
  if (!Object.keys(fields).length) return reply.code(400).send({ error: 'No updatable fields' });
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`)
    .run(...Object.values(fields), req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  return reply.send(publicUser(user));
});

// ── Socket.io ───────────────────────────────────────────────────────────────
const io = new Server(app.server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
});

// ── v2 Socket.IO Gateway (/gateway namespace) ─────────────────────────────
// Must be set up before routes so gw is available for emit calls.
const gw = setupGateway(io, db);

// ── v2 API routes ────────────────────────────────────────────────────────────
// Pass gateway namespace (gw) so emits reach clients subscribed via /gateway.
registerServerRoutes(app, db, gw);
registerChannelRoutes(app, db, gw);

// Redirect root to the new app
app.get('/', (_req, reply) => reply.redirect('/app', 301));

// SPA for the new v2 app — /app* → app.html
app.get('/app', (_req, reply) => reply.sendFile('app.html'));
app.get('/app/*', (_req, reply) => reply.sendFile('app.html'));

// ── User lookup by ID (v2) ──────────────────────────────────────────────────
app.get('/api/users/:id', { preHandler: authenticate }, (req, reply) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return reply.code(404).send({ error: 'User not found' });
  return reply.send(publicUser(user));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server listening on :${PORT}`);
});
