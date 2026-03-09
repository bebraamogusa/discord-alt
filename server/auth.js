/**
 * auth.js — Authentication helpers for discord-alt v2
 *
 * Exports:
 *   registerUser(db, { username, email, password })  → { user, token, refreshToken }
 *   loginUser(db, { email, password })               → { user, token, refreshToken }
 *   refreshTokens(db, refreshToken)                  → { token, refreshToken }
 *   revokeSession(db, refreshToken)                  → void
 *   authenticate          — Fastify preHandler (sets request.user)
 *   authenticateSocket    — Socket.IO middleware (sets socket.user)
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';

// ── Constants ─────────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS    = 12;
const JWT_EXPIRES_IN   = '1d';           // access token TTL
const REFRESH_EXPIRES  = 30 * 24 * 3600; // 30 days in seconds

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (≥32 chars)');
  return s;
}

// ── Token helpers ─────────────────────────────────────────────────────────────
export function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, discriminator: user.discriminator },
    getSecret(),
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function makeRefreshToken() {
  return nanoid(64);
}

function storeSession(db, userId, refreshToken, meta = {}) {
  const expires = Math.floor(Date.now() / 1000) + REFRESH_EXPIRES;
  db.prepare(`
    INSERT INTO sessions (id, user_id, refresh_token, user_agent, ip, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nanoid(32), userId, refreshToken, meta.userAgent || null, meta.ip || null, expires);
}

// ── Discriminator picker ──────────────────────────────────────────────────────
// Returns a free 4-digit discriminator for the given username, or null if all taken.
function pickDiscriminator(db, username) {
  // Fetch already-used discriminators for this username
  const used = new Set(
    db.prepare('SELECT discriminator FROM users WHERE username = ? COLLATE NOCASE')
      .all(username)
      .map(r => r.discriminator)
  );
  if (used.size >= 9999) return null;

  // Try random first; fall back to linear scan
  for (let attempt = 0; attempt < 20; attempt++) {
    const d = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
    if (!used.has(d)) return d;
  }
  for (let n = 1; n <= 9999; n++) {
    const d = String(n).padStart(4, '0');
    if (!used.has(d)) return d;
  }
  return null;
}

// ── Register ──────────────────────────────────────────────────────────────────
export function registerUser(db, { username, email, password }, meta = {}) {
  // Validate inputs
  if (!username || username.length < 2 || username.length > 32)
    throw Object.assign(new Error('Никнейм: 2–32 символа'), { statusCode: 400 });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw Object.assign(new Error('Некорректный email'), { statusCode: 400 });
  if (!password || password.length < 6)
    throw Object.assign(new Error('Пароль: минимум 6 символов'), { statusCode: 400 });

  // Check email uniqueness
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing)
    throw Object.assign(new Error('Email уже используется'), { statusCode: 409 });

  const discriminator = pickDiscriminator(db, username);
  if (!discriminator)
    throw Object.assign(new Error('Все теги для этого никнейма заняты'), { statusCode: 409 });

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const id = nanoid(20);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO users
      (id, username, discriminator, email, password_hash, tag, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, discriminator, email, passwordHash, discriminator, now, now);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = signAccessToken(user);
  const refreshToken = makeRefreshToken();
  storeSession(db, id, refreshToken, meta);

  return { user: publicUser(user), token, refreshToken };
}

// ── Login ─────────────────────────────────────────────────────────────────────
export function loginUser(db, { email, password }, meta = {}) {
  if (!email || !password)
    throw Object.assign(new Error('Email и пароль обязательны'), { statusCode: 400 });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user)
    throw Object.assign(new Error('Неверный email или пароль'), { statusCode: 401 });

  const ok = bcrypt.compareSync(password, user.password_hash || '');
  if (!ok)
    throw Object.assign(new Error('Неверный email или пароль'), { statusCode: 401 });

  // Update last_seen
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), user.id);

  const token = signAccessToken(user);
  const refreshToken = makeRefreshToken();
  storeSession(db, user.id, refreshToken, meta);

  return { user: publicUser(user), token, refreshToken };
}

// ── Refresh ───────────────────────────────────────────────────────────────────
export function refreshTokens(db, oldRefreshToken, meta = {}) {
  const session = db.prepare(`
    SELECT s.*, u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.refresh_token = ? AND s.expires_at > unixepoch()
  `).get(oldRefreshToken);

  if (!session)
    throw Object.assign(new Error('Сессия не найдена или истекла'), { statusCode: 401 });

  // Rotate refresh token
  db.prepare('DELETE FROM sessions WHERE refresh_token = ?').run(oldRefreshToken);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  const token = signAccessToken(user);
  const refreshToken = makeRefreshToken();
  storeSession(db, user.id, refreshToken, meta);

  return { user: publicUser(user), token, refreshToken };
}

// ── Revoke ────────────────────────────────────────────────────────────────────
export function revokeSession(db, refreshToken) {
  db.prepare('DELETE FROM sessions WHERE refresh_token = ?').run(refreshToken);
}

// ── Strip sensitive fields ────────────────────────────────────────────────────
export function publicUser(u) {
  // eslint-disable-next-line no-unused-vars
  const { password_hash, email: _e, ...rest } = u;
  return rest;
}

// ── Fastify preHandler: authenticate ─────────────────────────────────────────
// Usage: { preHandler: authenticate }
// Sets: request.user = { id, username, discriminator }
export function authenticate(request, reply, done) {
  const header = request.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return reply.code(401).send({ error: 'Требуется авторизация' });
  try {
    request.user = jwt.verify(token, getSecret());
    done();
  } catch {
    reply.code(401).send({ error: 'Неверный или истёкший токен' });
  }
}

// ── Socket.IO middleware: authenticateSocket ──────────────────────────────────
// Usage: io.use(authenticateSocket(db))
// Sets: socket.user = { id, username, discriminator }
export function authenticateSocket(db) {
  return (socket, next) => {
    const token = socket.handshake.auth?.token
      || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('UNAUTHORIZED'));

    try {
      const payload = jwt.verify(token, getSecret());
      // Confirm user still exists
      const user = db.prepare('SELECT id, username, discriminator FROM users WHERE id = ?')
        .get(payload.id);
      if (!user) return next(new Error('USER_NOT_FOUND'));
      socket.user = user;
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  };
}
