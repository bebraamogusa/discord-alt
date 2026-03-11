/**
 * migrate.js — Additive database migration
 * Discord-alt v2 schema
 *
 * Run: node migrate.js
 *
 * Safe to re-run: uses IF NOT EXISTS + additive ALTER TABLE only.
 * Never drops or renames existing columns.
 */

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Resolve DB path from .env or default ──────────────────────────────────────
let dbPath = resolve(__dir, '../data/chat.db');
try {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  const m = env.match(/^DB_PATH=(.+)$/m);
  if (m) dbPath = resolve(__dir, '..', m[1].trim());
} catch {}

console.log(`[migrate] DB → ${dbPath}`);
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Run all migrations inside one transaction ─────────────────────────────────
db.transaction(() => {

  /* ══════════════════════════════════════════════════════════════════════════
     LEGACY COMPATIBILITY
     Detect v1 tables by their old column names and rename them so the new
     schema can be created without conflicts. Old data is preserved in *_legacy.
  ══════════════════════════════════════════════════════════════════════════ */
  const hasCol = (table, col) => {
    try {
      const cols = db.pragma(`table_info(${table})`);
      return cols.some(c => c.name === col);
    } catch { return false; }
  };
  const tableExists = (t) => !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(t);

  // messages v1: had (room, username) instead of (channel_id, author_id)
  if (tableExists('messages') && !hasCol('messages', 'channel_id')) {
    db.exec('ALTER TABLE messages RENAME TO messages_legacy;');
    console.log('  ⚠  messages → messages_legacy (v1 schema preserved)');
  }

  // reactions v1: had (msg_id, username) instead of (message_id, user_id)
  if (tableExists('reactions') && !hasCol('reactions', 'message_id')) {
    db.exec('ALTER TABLE reactions RENAME TO reactions_legacy;');
    console.log('  ⚠  reactions → reactions_legacy (v1 schema preserved)');
  }

  // blocks v1: had (blocker, blocked) instead of (user_id, blocked_user_id)
  if (tableExists('blocks') && !hasCol('blocks', 'user_id')) {
    db.exec('ALTER TABLE blocks RENAME TO blocks_legacy;');
    console.log('  ⚠  blocks → blocks_legacy (v1 schema preserved)');
  }

  // users v1: had username as PRIMARY KEY, no id column
  if (tableExists('users') && !hasCol('users', 'id')) {
    db.exec('ALTER TABLE users RENAME TO users_legacy;');
    console.log('  ⚠  users → users_legacy (v1 schema preserved)');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     USERS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      username        TEXT NOT NULL,
      discriminator   TEXT NOT NULL DEFAULT '0001',   -- #0001‥#9999
      email           TEXT UNIQUE,
      password_hash   TEXT,
      avatar_url      TEXT NOT NULL DEFAULT '',
      avatar_color    TEXT NOT NULL DEFAULT '#5865f2', -- fallback colour
      banner_url      TEXT NOT NULL DEFAULT '',
      banner_color    TEXT NOT NULL DEFAULT '#5865f2',
      about_me        TEXT NOT NULL DEFAULT '',
      custom_status   TEXT NOT NULL DEFAULT '',
      tag             TEXT NOT NULL DEFAULT '0000',    -- legacy compat
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen       INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (username, discriminator)
    );
  `);

  // Additive columns for existing deployments
  for (const col of [
    ['discriminator', "TEXT NOT NULL DEFAULT '0001'"],
    ['email',         'TEXT UNIQUE'],
    ['password_hash', 'TEXT'],
    ['banner_url',    "TEXT NOT NULL DEFAULT ''"],
    ['last_seen',     'INTEGER NOT NULL DEFAULT (unixepoch())'],
  ]) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col[0]} ${col[1]};`); } catch {}
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SERVERS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS servers (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL,
      icon_url    TEXT NOT NULL DEFAULT '',
      banner_url  TEXT NOT NULL DEFAULT '',
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invite_code TEXT UNIQUE NOT NULL DEFAULT (lower(hex(randomblob(6)))),
      description TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      nickname   TEXT,
      joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (server_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     INVITES
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS invites (
      code        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(6)))),
      server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      creator_id  TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      max_uses    INTEGER,          -- NULL = unlimited
      uses        INTEGER NOT NULL DEFAULT 0,
      expires_at  INTEGER,          -- NULL = never
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     ROLES
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS roles (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#99aab5',
      -- JSON object: { send_messages, manage_messages, kick_members,
      --   ban_members, manage_channels, manage_server,
      --   mention_everyone, manage_roles, view_channel, ... }
      permissions TEXT NOT NULL DEFAULT '{}',
      position    INTEGER NOT NULL DEFAULT 0,
      is_default  INTEGER NOT NULL DEFAULT 0,  -- 1 = @everyone
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id   TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      role_id   TEXT NOT NULL REFERENCES roles(id)  ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    );
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     CATEGORIES & CHANNELS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS categories (
      id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_categories_server ON categories(server_id);

    -- type: text | voice | announcement | forum | stage
    CREATE TABLE IF NOT EXISTS channels (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      server_id        TEXT REFERENCES servers(id) ON DELETE CASCADE,  -- NULL for DM channels
      category_id      TEXT REFERENCES categories(id) ON DELETE SET NULL,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT 'text'
                         CHECK(type IN ('text','voice','announcement','forum','stage','dm','group')),
      position         INTEGER NOT NULL DEFAULT 0,
      topic            TEXT NOT NULL DEFAULT '',
      slowmode_seconds INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_channels_server   ON channels(server_id);
    CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     MESSAGES
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    -- type: text | system | pin_notification | server_join | server_boost
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id   TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL DEFAULT 'text'
                    CHECK(type IN ('text','system','pin_notification','server_join')),
      reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      is_edited   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel    ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_author     ON messages(author_id);
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to   ON messages(reply_to_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      filename   TEXT NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream'
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

    CREATE TABLE IF NOT EXISTS pins (
      channel_id  TEXT NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
      message_id  TEXT NOT NULL REFERENCES messages(id)  ON DELETE CASCADE,
      pinned_by   TEXT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
      pinned_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (channel_id, message_id)
    );
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     DM / GROUP CHANNELS
     Re-uses the channels table (type='dm'|'group') but needs a member map
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS dm_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_members_user    ON dm_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_dm_members_channel ON dm_members(channel_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     BLOCKS & READ STATES
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS blocks (
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, blocked_user_id)
    );

    CREATE TABLE IF NOT EXISTS read_states (
      user_id              TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      channel_id           TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_read_states_user ON read_states(user_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     AUDIT LOG
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    -- action: kick | ban | unban | role_create | role_delete | role_update |
    --         channel_create | channel_delete | member_update | server_update |
    --         message_delete | invite_create | invite_delete | pin_add | pin_remove
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      actor_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      target_id   TEXT,            -- user/channel/role being acted on (nullable)
      action      TEXT NOT NULL,
      changes     TEXT NOT NULL DEFAULT '{}',  -- JSON diff
      reason      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server_id, created_at);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     BANS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS bans (
      server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      banned_by  TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      reason     TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (server_id, user_id)
    );
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     SESSIONS / REFRESH TOKENS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(32)))),
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token TEXT UNIQUE NOT NULL,
      user_agent  TEXT,
      ip          TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at  INTEGER NOT NULL  -- unixepoch + 30 days
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     FRIENDS
  ══════════════════════════════════════════════════════════════════════════ */
  db.exec(/* sql */`
    CREATE TABLE IF NOT EXISTS friends (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','accepted','blocked')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE INDEX IF NOT EXISTS idx_friends_user   ON friends(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);
  `);

  /* ══════════════════════════════════════════════════════════════════════════
     MIGRATE EXISTING DATA
     Map old flat rooms/messages → new schema where possible
  ══════════════════════════════════════════════════════════════════════════ */

  // Old messages table may have (room, author, content, ts) columns — keep intact,
  // new messages table uses id/channel_id/author_id schema.
  // We don't auto-migrate here; run a separate data migration if needed.

  console.log('  ✓ Schema applied');

})();

// ── Verify ────────────────────────────────────────────────────────────────────
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
  .all()
  .map(r => r.name);

console.log(`\n[migrate] Tables (${tables.length}):`);
tables.forEach(t => console.log(`  • ${t}`));
console.log('\n[migrate] Done ✓');

db.close();
