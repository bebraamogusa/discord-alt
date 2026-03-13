import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function buildSocketServer(httpServer, { db, config }) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    maxHttpBufferSize: 10 * 1024 * 1024,
  });

  const userSockets = new Map();

  const getGuildIds = db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?');
  const updatePresence = db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?');
  const upsertQr = db.prepare(`
    INSERT INTO qr_login_sessions (qr_id, desktop_socket_id, status, scanned_by_user_id, created_at, expires_at)
    VALUES (?, ?, 'pending', NULL, ?, ?)
    ON CONFLICT(qr_id) DO UPDATE SET
      desktop_socket_id = excluded.desktop_socket_id,
      status = excluded.status,
      scanned_by_user_id = excluded.scanned_by_user_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  const getQr = db.prepare('SELECT * FROM qr_login_sessions WHERE qr_id = ?');
  const markQrScanned = db.prepare('UPDATE qr_login_sessions SET status = ?, scanned_by_user_id = ? WHERE qr_id = ?');
  const markQrConfirmed = db.prepare('UPDATE qr_login_sessions SET status = ? WHERE qr_id = ?');
  const cleanupQr = db.prepare('DELETE FROM qr_login_sessions WHERE expires_at <= ?');

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      socket.user = null;
      return next();
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = db
        .prepare('SELECT id, username, status FROM users WHERE id = ? AND deleted_at IS NULL')
        .get(payload.sub);
      if (!user) return next(new Error('Authentication failed'));
      socket.user = user;
      return next();
    } catch {
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.user) {
      const userId = socket.user.id;
      socket.join(`user:${userId}`);
      if (!userSockets.has(userId)) userSockets.set(userId, new Set());
      userSockets.get(userId).add(socket.id);

      for (const row of getGuildIds.all(userId)) {
        socket.join(`guild:${row.guild_id}`);
      }

      updatePresence.run('online', nowSec(), userId);
      io.emit('presence:update', { user_id: userId, status: 'online', activities: [], client_status: { web: 'online' } });
    }

    socket.on('presence:update', (payload = {}) => {
      if (!socket.user) return;
      const allowed = new Set(['online', 'idle', 'dnd', 'invisible']);
      const status = allowed.has(payload.status) ? payload.status : 'online';
      updatePresence.run(status, nowSec(), socket.user.id);
      io.emit('presence:update', {
        user_id: socket.user.id,
        status,
        activities: Array.isArray(payload.activities) ? payload.activities : [],
        client_status: { web: status },
      });
    });

    socket.on('qr:generate', () => {
      cleanupQr.run(nowSec());
      const qrId = randomUUID();
      const ts = nowSec();
      upsertQr.run(qrId, socket.id, ts, ts + 120);
      socket.emit('qr:generated', { qr_id: qrId, expires_in: 120 });
    });

    socket.on('qr:scan', ({ qr_id }) => {
      if (!socket.user || !qr_id) return;
      const row = getQr.get(qr_id);
      if (!row || row.expires_at <= nowSec() || row.status !== 'pending') {
        socket.emit('qr:error', { error: 'Invalid or expired QR' });
        return;
      }
      markQrScanned.run('scanned', socket.user.id, qr_id);
      io.to(row.desktop_socket_id).emit('qr:scanned', {
        qr_id,
        user: { id: socket.user.id, username: socket.user.username },
      });
    });

    socket.on('qr:confirm', ({ qr_id }) => {
      if (!socket.user || !qr_id) return;
      const row = getQr.get(qr_id);
      if (!row || row.expires_at <= nowSec() || row.status !== 'scanned') {
        socket.emit('qr:error', { error: 'QR confirmation failed' });
        return;
      }
      markQrConfirmed.run('confirmed', qr_id);
      io.to(row.desktop_socket_id).emit('qr:confirmed', {
        qr_id,
        user: { id: socket.user.id, username: socket.user.username },
      });
    });

    socket.on('disconnect', () => {
      if (!socket.user) return;
      const userId = socket.user.id;
      const userSet = userSockets.get(userId);
      if (!userSet) return;
      userSet.delete(socket.id);
      if (userSet.size === 0) {
        userSockets.delete(userId);
        updatePresence.run('offline', nowSec(), userId);
        io.emit('presence:update', {
          user_id: userId,
          status: 'offline',
          activities: [],
          client_status: { web: 'offline' },
        });
      }
    });
  });

  return io;
}
