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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT           = parseInt(process.env.PORT           || '3000');
const MAX_FILE_SIZE  = parseInt(process.env.MAX_FILE_SIZE  || '104857600'); // 100 MB
const UPLOADS_DIR    = process.env.UPLOADS_DIR  || join(ROOT, 'uploads');
const DB_PATH        = process.env.DB_PATH      || join(ROOT, 'data', 'chat.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ── Admin tokens (in-memory, reset on restart) ───────────────────────────────
const adminTokens = new Set();

[UPLOADS_DIR, dirname(DB_PATH)].forEach(d => mkdirSync(d, { recursive: true }));

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    room       TEXT NOT NULL,
    username   TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'text',
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room, created_at);
`);

const stmtInsert    = db.prepare('INSERT INTO messages (id,room,username,type,content,created_at) VALUES (?,?,?,?,?,?)');
const stmtSelect    = db.prepare('SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT ?');
const stmtDelete    = db.prepare('DELETE FROM messages WHERE id = ?');
const stmtClearRoom = db.prepare('DELETE FROM messages WHERE room = ?');
const stmtUpdate    = db.prepare('UPDATE messages SET content = ? WHERE id = ? AND username = ? AND type = \'text\'');

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

// SPA — all /room/* serve index.html
app.get('/room/:roomId', (_req, reply) => reply.sendFile('index.html'));

// ── File type helpers ─────────────────────────────────────────────────────────
const ALLOWED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.ogv', '.3gp', '.ts', '.mts',
  '.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus', '.wma',
  '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.7z', '.rar', '.tar', '.gz',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.ogv', '.3gp', '.ts', '.mts']);
function getMessageType(ext) {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
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

// ── Messages history ──────────────────────────────────────────────────────────
app.get('/api/rooms/:roomId/messages', (req) => {
  const { roomId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '200'), 500);
  return stmtSelect.all(roomId, limit).reverse();
});

// ── Link embed proxy ──────────────────────────────────────────────────────────
app.get('/api/embed', async (req, reply) => {
  const { url } = req.query;
  if (!url) return reply.code(400).send({ error: 'Missing url' });
  let u;
  try { u = new URL(url); } catch { return reply.code(400).send({ error: 'Invalid url' }); }
  if (!['http:', 'https:'].includes(u.protocol)) return reply.code(400).send({ error: 'Bad protocol' });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordAlt/1.0)' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return reply.code(204).send();
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk); total += chunk.length;
      if (total > 200_000) break;
    }
    const html = Buffer.concat(chunks).toString('utf-8');
    const og = (p) => {
      return html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']{1,500})["']`, 'i'))?.[1]
          || html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,500})["'][^>]+property=["']og:${p}["']`, 'i'))?.[1]
          || null;
    };
    const mt = (n) => {
      return html.match(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']{1,500})["']`, 'i'))?.[1]
          || html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']${n}["']`, 'i'))?.[1]
          || null;
    };
    const title       = og('title') || mt('title') || html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] || u.hostname;
    const description = og('description') || mt('description') || null;
    const image       = og('image') || null;
    const site        = og('site_name') || u.hostname;
    return { title: title?.trim(), description: description?.trim(), image, site, url };
  } catch { return reply.code(204).send(); }
});

// ── Admin auth helper ─────────────────────────────────────────────────────────
function checkAdmin(req, reply) {
  if (!ADMIN_PASSWORD) { reply.code(404).send({ error: 'Admin not configured' }); return false; }
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!adminTokens.has(token)) { reply.code(401).send({ error: 'Unauthorized' }); return false; }
  return true;
}

// ── Admin endpoints ───────────────────────────────────────────────────────────
app.post('/api/admin/auth', async (req, reply) => {
  if (!ADMIN_PASSWORD) return reply.code(404).send({ error: 'Admin not configured' });
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return reply.code(403).send({ error: 'Wrong password' });
  const token = nanoid(32);
  adminTokens.add(token);
  return { token };
});

app.delete('/api/admin/messages/:id', (req, reply) => {
  if (!checkAdmin(req, reply)) return;
  stmtDelete.run(req.params.id);
  io.emit('message-deleted', { id: req.params.id });
  return { ok: true };
});

app.delete('/api/admin/rooms/:roomId/messages', (req, reply) => {
  if (!checkAdmin(req, reply)) return;
  stmtClearRoom.run(req.params.roomId);
  io.to(req.params.roomId).emit('room-cleared');
  return { ok: true };
});

app.post('/api/admin/kick', (req, reply) => {
  if (!checkAdmin(req, reply)) return;
  const { roomId, username: target } = req.body || {};
  if (!roomId || !target) return reply.code(400).send({ error: 'Missing params' });
  const room = rooms.get(roomId);
  if (room) {
    for (const [sid, user] of room) {
      if (user.username === target) {
        io.to(sid).emit('kicked', { reason: 'Kicked by admin' });
        io.sockets.sockets.get(sid)?.disconnect(true);
        break;
      }
    }
  }
  return { ok: true };
});

// ── Socket.io ───────────────────────────────────────────────────────────────
const io = new Server(app.server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
});

// roomId → Map<socketId, { socketId, username, inCall }>
const rooms = new Map();

function getRoomUsers(roomId) {
  const r = rooms.get(roomId);
  return r ? Array.from(r.values()) : [];
}

io.on('connection', (socket) => {
  let roomId = null;
  let username = null;
  let inCall = false;

  // ── Комната ──────────────────────────────────────────
  socket.on('join-room', (data) => {
    if (roomId) leaveRoom();

    roomId = String(data.roomId).slice(0, 64);
    username = String(data.username).slice(0, 20);

    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    rooms.get(roomId).set(socket.id, { socketId: socket.id, username, inCall: false });

    socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
    io.to(roomId).emit('room-users', getRoomUsers(roomId));

    // Системное сообщение
    const msg = {
      id: nanoid(16),
      room: roomId,
      username: 'system',
      type: 'system',
      content: `${username} joined`,
      created_at: Date.now(),
    };
    stmtInsert.run(msg.id, msg.room, msg.username, msg.type, msg.content, msg.created_at);
    io.to(roomId).emit('chat-message', msg);
  });

  // ── Chat ──────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    if (!roomId || !username) return;
    const content = String(data.content || '').slice(0, 4000);
    if (!content) return;
    const VALID = new Set(['text', 'image', 'video', 'file']);
    const type = VALID.has(data.type) ? data.type : 'text';
    const msg = { id: nanoid(16), room: roomId, username, type, content, created_at: Date.now() };
    stmtInsert.run(msg.id, msg.room, msg.username, msg.type, msg.content, msg.created_at);
    io.to(roomId).emit('chat-message', msg);
  });
  // ── Edit own message ─────────────────────────────────
  socket.on('edit-message', (data) => {
    if (!roomId || !username) return;
    const id      = String(data.id || '');
    const content = String(data.content || '').trim().slice(0, 4000);
    if (!id || !content) return;
    const info = stmtUpdate.run(content, id, username);
    if (info.changes > 0) {
      io.to(roomId).emit('message-edited', { id, content });
    }
  });
  // ── Звонки ───────────────────────────────────────────
  socket.on('call-join', () => {
    if (!roomId) return;
    inCall = true;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      room.get(socket.id).inCall = true;
      socket.to(roomId).emit('call-user-joined', { socketId: socket.id, username });
      io.to(roomId).emit('room-users', getRoomUsers(roomId));
    }
  });

  socket.on('call-leave', () => {
    if (!roomId) return;
    inCall = false;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      room.get(socket.id).inCall = false;
      socket.to(roomId).emit('call-user-left', { socketId: socket.id });
      io.to(roomId).emit('room-users', getRoomUsers(roomId));
    }
  });

  // ── WebRTC signaling ─────────────────────────────────
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });
  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });
  socket.on('webrtc-ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  // ── Disconnect ───────────────────────────────────────
  function leaveRoom() {
    if (!roomId) return;
    socket.leave(roomId);
    const room = rooms.get(roomId);
    if (room) {
      room.delete(socket.id);
      if (inCall) socket.to(roomId).emit('call-user-left', { socketId: socket.id });
      socket.to(roomId).emit('user-left', { socketId: socket.id, username });
      io.to(roomId).emit('room-users', getRoomUsers(roomId));
      if (room.size === 0) rooms.delete(roomId);
    }
    roomId = null;
    username = null;
    inCall = false;
  }

  socket.on('disconnect', leaveRoom);
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server listening on :${PORT}`);
});
