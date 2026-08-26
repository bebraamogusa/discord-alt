import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, mkdirSync } from 'fs';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export const TEST_JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars-long!!';
let idCounter = 0;

export function nextId() {
  return String(Date.now()) + String(++idCounter).padStart(6, '0');
}

export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(filename, Math.floor(Date.now() / 1000));
  }

  return db;
}

export function seedUser(db, overrides = {}) {
  const id = overrides.id || nextId();
  const now = Math.floor(Date.now() / 1000);
  const row = {
    id,
    username: overrides.username || `user_${id}`,
    display_name: overrides.display_name || `User ${id}`,
    email: overrides.email || `user_${id}@test.com`,
    password_hash: overrides.password_hash || '$argon2id$v=19$m=19456,t=2,p=1$hash$hash',
    created_at: now,
    updated_at: now,
    status: 'offline',
    locale: 'en-US',
    theme: 'dark',
    message_font_size: 16,
    mfa_enabled: 0,
    flags: 0,
    deleted_at: null,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, created_at, updated_at, status, locale, theme, message_font_size, mfa_enabled, flags, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.username, row.display_name, row.email, row.password_hash, row.created_at, row.updated_at, row.status, row.locale, row.theme, row.message_font_size, row.mfa_enabled, row.flags, row.deleted_at);

  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(row.id);

  return row;
}

export function seedGuild(db, ownerId, overrides = {}) {
  const guildId = overrides.id || nextId();
  const now = Math.floor(Date.now() / 1000);
  const channelId = nextId();
  const everyoneRoleId = guildId;

  db.prepare(`
    INSERT INTO guilds (id, name, owner_id, preferred_locale, features, created_at, updated_at)
    VALUES (?, ?, ?, 'en-US', '[]', ?, ?)
  `).run(guildId, overrides.name || `guild_${guildId}`, ownerId, now, now);

  db.prepare('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(guildId, ownerId, now);

  const everyonePerms = (1n << 10n) | (1n << 11n) | (1n << 0n); // VIEW_CHANNEL | SEND_MESSAGES | CREATE_INSTANT_INVITE
  db.prepare(`
    INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, managed, mentionable, flags, created_at)
    VALUES (?, ?, '@everyone', 0, 0, 0, ?, 0, 0, 0, ?)
  `).run(everyoneRoleId, guildId, everyonePerms.toString(), now);

  db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guildId, ownerId, everyoneRoleId);

  db.prepare(`
    INSERT INTO channels (id, guild_id, type, name, position, nsfw, rate_limit_per_user, created_at, updated_at)
    VALUES (?, ?, 0, 'general', 0, 0, 0, ?, ?)
  `).run(channelId, guildId, now, now);

  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  const everyoneRole = db.prepare('SELECT * FROM roles WHERE id = ?').get(everyoneRoleId);

  return { guild, channel, everyoneRole, guildId, channelId, everyoneRoleId };
}

export function seedMember(db, guildId, userId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT OR IGNORE INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(guildId, userId, now);
  db.prepare('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guildId, userId, guildId);
}

export function seedRole(db, guildId, overrides = {}) {
  const id = overrides.id || nextId();
  const now = Math.floor(Date.now() / 1000);
  const position = overrides.position ?? 1;
  const permissions = overrides.permissions ?? '0';

  db.prepare(`
    INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, managed, mentionable, flags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
  `).run(id, guildId, overrides.name || `role_${id}`, overrides.color || 0, overrides.hoist || 0, position, permissions, now);

  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
}

export function seedChannel(db, guildId, overrides = {}) {
  const id = overrides.id || nextId();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO channels (id, guild_id, type, name, position, nsfw, rate_limit_per_user, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(id, guildId, overrides.type ?? 0, overrides.name || `ch_${id}`, overrides.position ?? 0, now, now);

  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

export function seedWebhook(db, channelId, guildId, creatorId, overrides = {}) {
  const id = overrides.id || nextId();
  const now = Math.floor(Date.now() / 1000);
  const token = overrides.token || `wh_token_${id}`;

  db.prepare(`
    INSERT INTO webhooks (id, guild_id, channel_id, creator_id, name, avatar, token, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, guildId, channelId, creatorId, overrides.name || `webhook_${id}`, overrides.avatar || null, token, now);

  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
}

export function makeToken(userId, username) {
  return jwt.sign({ sub: userId, username: username || `user_${userId}` }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

export function makeExpiredToken(userId, username) {
  return jwt.sign({ sub: userId, username: username || `user_${userId}` }, TEST_JWT_SECRET, { expiresIn: '-1h' });
}

export function buildTestApp(opts = {}) {
  const db = opts.db || createTestDb();
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: true, coerceTypes: true, useDefaults: true } },
  });

  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10, fieldSize: 5 * 1024 * 1024 } });

  return { app, db };
}
