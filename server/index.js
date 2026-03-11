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
import bcrypt from 'bcryptjs';
import {
  registerUser,
  loginUser,
  refreshTokens,
  revokeSession,
  authenticate,
  publicUser,
} from './auth.js';

// ── Rate limiter (in-memory) ──────────────────────────────────────────────────
const rateLimitBuckets = new Map();
function rateLimit(key, maxRequests, windowSec) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.start > windowSec * 1000) {
    rateLimitBuckets.set(key, { start: now, count: 1 });
    return false; // not limited
  }
  bucket.count++;
  return bucket.count > maxRequests;
}
// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitBuckets) {
    if (now - v.start > 300_000) rateLimitBuckets.delete(k);
  }
}, 300_000);
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

// ── Upload endpoint (requires auth) ───────────────────────────────────────────
app.post('/api/upload', { preHandler: authenticate }, async (req, reply) => {
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

// POST /api/auth/register (rate limited: 5 per 5 min per IP)
app.post('/api/auth/register', async (req, reply) => {
  if (rateLimit(`reg:${req.ip}`, 5, 300))
    return reply.code(429).send({ error: 'Слишком много попыток. Подождите немного.' });
  try {
    const { username, email, password } = req.body || {};
    const meta = { userAgent: req.headers['user-agent'], ip: req.ip };
    const result = registerUser(db, { username, email, password }, meta);
    return reply.code(201).send(result);
  } catch (e) {
    return reply.code(e.statusCode || 500).send({ error: e.message });
  }
});

// POST /api/auth/login (rate limited: 10 per 5 min per IP)
app.post('/api/auth/login', async (req, reply) => {
  if (rateLimit(`login:${req.ip}`, 10, 300))
    return reply.code(429).send({ error: 'Слишком много попыток. Подождите немного.' });
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

// ── User search (for New DM) ────────────────────────────────────────────────
app.get('/api/users', { preHandler: authenticate }, (req, reply) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 1) return reply.send([]);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
  const rows = db.prepare(`
    SELECT id, username, discriminator, avatar_url, avatar_color, custom_status, last_seen
    FROM users
    WHERE id != ? AND username LIKE ?
    ORDER BY username COLLATE NOCASE ASC
    LIMIT ?
  `).all(req.user.id, `%${q}%`, limit);
  return reply.send(rows);
});

// ── Password change ─────────────────────────────────────────────────────────
app.patch('/api/@me/password', { preHandler: authenticate }, async (req, reply) => {
  if (rateLimit(`pwd:${req.user.id}`, 5, 300))
    return reply.code(429).send({ error: 'Слишком много попыток.' });
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password)
    return reply.code(400).send({ error: 'Оба поля обязательны' });
  if (new_password.length < 6)
    return reply.code(400).send({ error: 'Новый пароль: минимум 6 символов' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return reply.code(404).send({ error: 'User not found' });
  const ok = bcrypt.compareSync(current_password, user.password_hash || '');
  if (!ok) return reply.code(401).send({ error: 'Неверный текущий пароль' });
  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  // Revoke all sessions except current to force re-login on other devices
  return reply.send({ ok: true });
});

// ── Message search ──────────────────────────────────────────────────────────
app.get('/api/channels/:id/messages/search', { preHandler: authenticate }, (req, reply) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!ch) return reply.code(404).send({ error: 'Channel not found' });
  // verify access
  if (ch.server_id) {
    const sm = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, req.user.id);
    if (!sm) return reply.code(403).send({ error: 'No access' });
  } else {
    const dm = db.prepare('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?').get(ch.id, req.user.id);
    if (!dm) return reply.code(403).send({ error: 'No access' });
  }
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return reply.code(400).send({ error: 'Минимум 2 символа для поиска' });
  const limit = Math.min(parseInt(req.query.limit || '25', 10), 50);
  const rows = db.prepare(`
    SELECT m.*, u.username, u.discriminator, u.avatar_url, u.avatar_color
    FROM messages m
    JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = ? AND m.content LIKE ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(ch.id, `%${q}%`, limit);
  const results = rows.map(r => ({
    ...r,
    author: { id: r.author_id, username: r.username, discriminator: r.discriminator, avatar_url: r.avatar_url, avatar_color: r.avatar_color },
  }));
  return reply.send(results);
});

// ── Link Embed / Open Graph Proxy ───────────────────────────────────────────
const _ogCache = new Map();
setInterval(() => { // Clear OG cache every 30 minutes
  const now = Date.now();
  for (const [url, entry] of _ogCache) {
    if (now - entry.ts > 30 * 60 * 1000) _ogCache.delete(url);
  }
}, 10 * 60 * 1000);

app.get('/api/embed', { preHandler: authenticate }, async (req, reply) => {
  const url = String(req.query.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'Invalid URL' });

  // Check cache
  const cached = _ogCache.get(url);
  if (cached) return reply.send(cached.data);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DiscordAlt-Bot/1.0 (link preview)' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return reply.send({});

    const html = await res.text();
    const og = {};

    const getTag = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m?.[1] || '';
    };

    og.title = getTag('og:title') || getTag('twitter:title') || (html.match(/<title[^>]*>([^<]+)/i)?.[1] || '').trim();
    og.description = getTag('og:description') || getTag('twitter:description') || getTag('description');
    og.image = getTag('og:image') || getTag('twitter:image');
    og.siteName = getTag('og:site_name') || '';

    // Make relative image URLs absolute
    if (og.image && !og.image.startsWith('http')) {
      try {
        og.image = new URL(og.image, url).href;
      } catch { og.image = ''; }
    }

    const data = { title: og.title, description: og.description?.slice(0, 300), image: og.image, siteName: og.siteName };
    _ogCache.set(url, { data, ts: Date.now() });
    return reply.send(data);
  } catch {
    return reply.send({});
  }
});

// ── Friend System ───────────────────────────────────────────────────────────

// GET /api/@me/friends — list all friends and pending requests
app.get('/api/@me/friends', { preHandler: authenticate }, (req, reply) => {
  const rows = db.prepare(`
    SELECT f.*, 
      u.id as user_id, u.username, u.discriminator, u.avatar_url, u.avatar_color, u.custom_status,
      CASE WHEN f.user_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
    WHERE f.user_id = ? OR f.friend_id = ?
    ORDER BY f.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);
  return reply.send(rows);
});

// POST /api/@me/friends/:id — send friend request (or accept if incoming exists)
app.post('/api/@me/friends/:id', { preHandler: authenticate }, (req, reply) => {
  const friendId = req.params.id;
  if (friendId === req.user.id) return reply.code(400).send({ error: 'Cannot friend yourself' });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(friendId);
  if (!target) return reply.code(404).send({ error: 'User not found' });

  // Check if relationship already exists  
  const existing = db.prepare(`
    SELECT * FROM friends
    WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `).get(req.user.id, friendId, friendId, req.user.id);

  if (existing) {
    if (existing.status === 'accepted') return reply.code(400).send({ error: 'Already friends' });
    // If there's a pending request from the other user, accept it
    if (existing.status === 'pending' && existing.user_id === friendId) {
      db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?')
        .run('accepted', friendId, req.user.id);
      // Notify via gateway
      gw.to(`user:${friendId}`).emit('FRIEND_UPDATE', { user_id: req.user.id, status: 'accepted' });
      return reply.send({ status: 'accepted' });
    }
    return reply.code(400).send({ error: 'Request already sent' });
  }

  db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)')
    .run(req.user.id, friendId, 'pending');

  // Notify the target user
  const sender = db.prepare('SELECT id, username, discriminator, avatar_url, avatar_color FROM users WHERE id = ?').get(req.user.id);
  gw.to(`user:${friendId}`).emit('FRIEND_REQUEST', sender);

  return reply.code(201).send({ status: 'pending' });
});

// DELETE /api/@me/friends/:id — remove friend or decline request
app.delete('/api/@me/friends/:id', { preHandler: authenticate }, (req, reply) => {
  const friendId = req.params.id;
  db.prepare(`
    DELETE FROM friends
    WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `).run(req.user.id, friendId, friendId, req.user.id);

  gw.to(`user:${friendId}`).emit('FRIEND_UPDATE', { user_id: req.user.id, status: 'removed' });

  return reply.send({ ok: true });
});

// ── Nickname endpoints ──────────────────────────────────────────────────────
// PATCH /api/servers/:id/members/@me/nickname
app.patch('/api/servers/:id/members/@me/nickname', { preHandler: authenticate }, (req, reply) => {
  const serverId = req.params.id;
  const sm = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, req.user.id);
  if (!sm) return reply.code(403).send({ error: 'Not a member' });

  const nickname = req.body?.nickname != null ? String(req.body.nickname).slice(0, 32).trim() || null : null;
  db.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?')
    .run(nickname, serverId, req.user.id);

  return reply.send({ ok: true, nickname });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server listening on :${PORT}`);
});
