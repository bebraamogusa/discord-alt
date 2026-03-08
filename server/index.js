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

const PORT = parseInt(process.env.PORT || '3000');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '5242880');
const UPLOADS_DIR = process.env.UPLOADS_DIR || join(ROOT, 'uploads');
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'chat.db');

[UPLOADS_DIR, dirname(DB_PATH)].forEach(d => mkdirSync(d, { recursive: true }));

// ── Database ────────────────────────────────────────────────────────────────
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

const stmtInsert = db.prepare(
  'INSERT INTO messages (id, room, username, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtSelect = db.prepare(
  'SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT ?'
);

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

// SPA — все /room/* отдают index.html
app.get('/room/:roomId', (_req, reply) => reply.sendFile('index.html'));

// ── REST API ────────────────────────────────────────────────────────────────
app.post('/api/upload', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file provided' });

  const ext = extname(file.filename).toLowerCase();
  const ALLOWED = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.pdf', '.txt', '.zip', '.7z', '.rar',
    '.doc', '.docx', '.mp3', '.mp4', '.ogg',
  ];
  if (!ALLOWED.includes(ext)) {
    return reply.code(400).send({ error: 'Unsupported file type' });
  }

  const name = `${nanoid(12)}${ext}`;
  const dest = join(UPLOADS_DIR, name);

  await pipeline(file.file, createWriteStream(dest));

  if (file.file.truncated) {
    await unlink(dest).catch(() => {});
    return reply.code(413).send({ error: 'File too large' });
  }

  return { url: `/uploads/${name}`, name: file.filename };
});

app.get('/api/rooms/:roomId/messages', (req, _reply) => {
  const { roomId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '200'), 500);
  return stmtSelect.all(roomId, limit).reverse();
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

  // ── Чат ──────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    if (!roomId || !username) return;
    const content = String(data.content || '').slice(0, 4000);
    if (!content) return;

    const msg = {
      id: nanoid(16),
      room: roomId,
      username,
      type: ['image', 'file'].includes(data.type) ? data.type : 'text',
      content,
      created_at: Date.now(),
    };
    stmtInsert.run(msg.id, msg.room, msg.username, msg.type, msg.content, msg.created_at);
    io.to(roomId).emit('chat-message', msg);
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
