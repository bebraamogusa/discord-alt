import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase, runMigrations } from './database.js';
import { parsePermissions, serializePermissions } from './services/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sourcePath = resolve(process.cwd(), process.env.LEGACY_DB_PATH || './data/chat.db');
const targetPath = resolve(process.cwd(), process.env.DB_PATH || './data/discord-clone.db');

if (sourcePath === targetPath) {
  throw new Error(`Source and target DB paths are identical: ${sourcePath}`);
}

if (!existsSync(sourcePath)) {
  console.log(`[legacy->core] skipped: legacy DB not found at ${sourcePath}`);
  process.exit(0);
}

console.log(`[legacy->core] source: ${sourcePath}`);
console.log(`[legacy->core] target: ${targetPath}`);

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
source.pragma('foreign_keys = ON');

const target = createDatabase(targetPath);
runMigrations(target, join(__dirname, 'migrations'));

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  return !!row;
}

function mapStatusLegacyToCore(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (['online', 'idle', 'dnd', 'invisible', 'offline'].includes(normalized)) return normalized;
  return 'offline';
}

function channelTypeToCore(type) {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'voice' || value === 'stage') return 2;
  if (value === 'announcement') return 5;
  if (value === 'forum') return 15;
  if (value === 'category') return 4;
  return 0;
}

function intColorFromHex(color) {
  const text = String(color || '').trim();
  if (!text) return 0;
  const clean = text.startsWith('#') ? text.slice(1) : text;
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsername(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function uniqueUsername(base, used) {
  let next = normalizeUsername(base) || 'user';
  if (!used.has(next)) {
    used.add(next);
    return next;
  }

  let i = 1;
  while (i < 100000) {
    const suffix = `_${i}`;
    const cut = Math.max(1, 32 - suffix.length);
    const candidate = `${next.slice(0, cut)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    i += 1;
  }

  const fallback = `user_${Date.now().toString(36).slice(-6)}`;
  used.add(fallback);
  return fallback;
}

function uniqueEmail(base, used) {
  const normalized = String(base || '').trim().toLowerCase();
  let email = normalized;
  if (!email || !email.includes('@')) {
    email = `${Date.now().toString(36)}@legacy.local`;
  }
  if (!used.has(email)) {
    used.add(email);
    return email;
  }

  const [local, domain = 'legacy.local'] = email.split('@');
  let i = 1;
  while (i < 100000) {
    const candidate = `${local}+${i}@${domain}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    i += 1;
  }

  const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@legacy.local`;
  used.add(fallback);
  return fallback;
}

const stats = {
  users: 0,
  guilds: 0,
  guildMembers: 0,
  roles: 0,
  memberRoles: 0,
  channels: 0,
  overwrites: 0,
  messages: 0,
  attachments: 0,
  reactions: 0,
  invites: 0,
  bans: 0,
};

const importTx = target.transaction(() => {
  const tsNow = nowSec();

  const insertUser = target.prepare(`
    INSERT OR REPLACE INTO users (
      id, username, display_name, email, password_hash,
      avatar, banner, accent_color, bio,
      status, custom_status_text,
      locale, theme, message_font_size,
      mfa_enabled, mfa_secret, flags,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en-US', 'dark', 16, ?, ?, 0, ?, ?, NULL)
  `);

  const insertUserSettings = target.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)');

  const insertGuild = target.prepare(`
    INSERT OR REPLACE INTO guilds (
      id, name, icon, banner, description, owner_id,
      preferred_locale, features, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'en-US', '[]', ?, ?)
  `);

  const insertGuildMember = target.prepare(`
    INSERT OR REPLACE INTO guild_members (
      guild_id, user_id, nickname, joined_at, deaf, mute, pending, communication_disabled_until, flags
    ) VALUES (?, ?, ?, ?, 0, 0, 0, NULL, 0)
  `);

  const insertRole = target.prepare(`
    INSERT OR REPLACE INTO roles (
      id, guild_id, name, color, hoist, icon, unicode_emoji,
      position, permissions, managed, mentionable, flags, created_at
    ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, 0, 0, 0, ?)
  `);

  const insertMemberRole = target.prepare(
    'INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
  );

  const insertChannel = target.prepare(`
    INSERT OR REPLACE INTO channels (
      id, guild_id, type, name, topic, position, parent_id, nsfw,
      bitrate, user_limit, rate_limit_per_user,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 64000, 0, ?, ?, ?)
  `);

  const insertOverwrite = target.prepare(`
    INSERT OR REPLACE INTO channel_permission_overwrites (
      channel_id, target_id, target_type, allow, deny
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const insertMessage = target.prepare(`
    INSERT OR REPLACE INTO messages (
      id, channel_id, guild_id, author_id, content,
      type, flags, tts, mention_everyone, pinned, edited_at,
      reference_message_id, reference_channel_id,
      embeds, components, sticker_ids, poll,
      created_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, NULL, '[]', '[]', '[]', NULL, ?, 0)
  `);

  const insertAttachment = target.prepare(`
    INSERT OR REPLACE INTO attachments (
      id, message_id, filename, original_filename, content_type,
      size, url, proxy_url, width, height, duration_secs,
      waveform, description, spoiler, flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0)
  `);

  const insertReaction = target.prepare(`
    INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertInvite = target.prepare(`
    INSERT OR REPLACE INTO invites (
      code, guild_id, channel_id, inviter_id,
      max_age, max_uses, uses, temporary,
      created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  const insertBan = target.prepare(`
    INSERT OR REPLACE INTO bans (guild_id, user_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const usernameUsed = new Set(target.prepare('SELECT username FROM users').all().map((row) => row.username));
  const emailUsed = new Set(target.prepare('SELECT email FROM users').all().map((row) => String(row.email || '').toLowerCase()));

  const users = tableExists(source, 'users')
    ? source.prepare('SELECT * FROM users').all()
    : [];

  const migratedUserIds = new Set();

  for (const user of users) {
    const userId = String(user.id || '').trim();
    if (!userId) continue;

    const username = uniqueUsername(user.username || `user_${userId.slice(-6)}`, usernameUsed);
    const email = uniqueEmail(
      user.email || `${username}-${userId.slice(-6)}@legacy.local`,
      emailUsed
    );

    const passwordHash = String(user.password_hash || '').trim() || '$2b$12$legacymigrationplaceholderhashstringforresetzzzzzzzzzzzzzzzzzzzz';
    const createdAt = Number(user.created_at) || tsNow;
    const updatedAt = Number(user.last_seen) || createdAt;

    insertUser.run(
      userId,
      username,
      String(user.username || username).slice(0, 64),
      email,
      passwordHash,
      user.avatar_url || null,
      user.banner_url || null,
      user.avatar_color || null,
      user.about_me || null,
      mapStatusLegacyToCore(user.custom_status ? 'online' : 'offline'),
      user.custom_status || null,
      Number(user.mfa_enabled) ? 1 : 0,
      user.mfa_secret || null,
      createdAt,
      updatedAt
    );

    insertUserSettings.run(userId);
    migratedUserIds.add(userId);
    stats.users += 1;
  }

  const servers = tableExists(source, 'servers')
    ? source.prepare('SELECT * FROM servers').all()
    : [];

  const migratedGuildIds = new Set();

  for (const server of servers) {
    const guildId = String(server.id || '').trim();
    if (!guildId) continue;
    if (!migratedUserIds.has(server.owner_id)) continue;

    const createdAt = Number(server.created_at) || tsNow;
    insertGuild.run(
      guildId,
      String(server.name || 'Untitled Guild').slice(0, 100),
      server.icon_url || null,
      server.banner_url || null,
      server.description || null,
      server.owner_id,
      createdAt,
      createdAt
    );
    migratedGuildIds.add(guildId);
    stats.guilds += 1;
  }

  const memberships = tableExists(source, 'server_members')
    ? source.prepare('SELECT * FROM server_members').all()
    : [];

  for (const row of memberships) {
    if (!migratedGuildIds.has(row.server_id) || !migratedUserIds.has(row.user_id)) continue;
    insertGuildMember.run(
      row.server_id,
      row.user_id,
      row.nickname || null,
      Number(row.joined_at) || tsNow
    );
    stats.guildMembers += 1;
  }

  const roles = tableExists(source, 'roles')
    ? source.prepare('SELECT * FROM roles').all()
    : [];

  const roleGuildById = new Map();
  const defaultRoleByGuild = new Map();

  for (const role of roles) {
    const guildId = role.server_id;
    if (!migratedGuildIds.has(guildId)) continue;

    const permissionsBits = parsePermissions(role.permissions || '{}');

    insertRole.run(
      role.id,
      guildId,
      String(role.name || 'role').slice(0, 100),
      intColorFromHex(role.color),
      Number(role.position) || 0,
      serializePermissions(permissionsBits),
      Number(role.created_at) || tsNow
    );

    roleGuildById.set(role.id, guildId);
    if (Number(role.is_default) === 1 && !defaultRoleByGuild.has(guildId)) {
      defaultRoleByGuild.set(guildId, role.id);
    }
    stats.roles += 1;
  }

  const userRoles = tableExists(source, 'user_roles')
    ? source.prepare('SELECT * FROM user_roles').all()
    : [];

  for (const row of userRoles) {
    const guildId = roleGuildById.get(row.role_id);
    if (!guildId) continue;
    if (!migratedUserIds.has(row.user_id)) continue;
    insertMemberRole.run(guildId, row.user_id, row.role_id);
    stats.memberRoles += 1;
  }

  const categories = tableExists(source, 'categories')
    ? source.prepare('SELECT * FROM categories').all()
    : [];

  const migratedChannelIds = new Set();
  const firstTextChannelByGuild = new Map();

  for (const category of categories) {
    if (!migratedGuildIds.has(category.server_id)) continue;
    const channelId = String(category.id || '').trim();
    if (!channelId) continue;

    insertChannel.run(
      channelId,
      category.server_id,
      4,
      String(category.name || 'category').slice(0, 100),
      null,
      Number(category.position) || 0,
      null,
      0,
      Number(category.created_at) || tsNow,
      Number(category.created_at) || tsNow
    );

    migratedChannelIds.add(channelId);
    stats.channels += 1;
  }

  const channels = tableExists(source, 'channels')
    ? source.prepare('SELECT * FROM channels').all()
    : [];

  const channelGuildMap = new Map();

  for (const channel of channels) {
    if (!channel.server_id || !migratedGuildIds.has(channel.server_id)) continue;
    const channelId = String(channel.id || '').trim();
    if (!channelId) continue;

    const mappedType = channelTypeToCore(channel.type);
    const createdAt = Number(channel.created_at) || tsNow;
    const position = Number(channel.position) || 0;

    insertChannel.run(
      channelId,
      channel.server_id,
      mappedType,
      String(channel.name || 'channel').slice(0, 100),
      channel.topic || null,
      position,
      channel.category_id || null,
      Number(channel.slowmode_seconds) || 0,
      createdAt,
      Number(channel.updated_at) || createdAt
    );

    if (mappedType === 0 && !firstTextChannelByGuild.has(channel.server_id)) {
      firstTextChannelByGuild.set(channel.server_id, channelId);
    }

    migratedChannelIds.add(channelId);
    channelGuildMap.set(channelId, channel.server_id);
    stats.channels += 1;
  }

  const overwrites = tableExists(source, 'channel_overwrites')
    ? source.prepare('SELECT * FROM channel_overwrites').all()
    : [];

  for (const row of overwrites) {
    const channelId = row.channel_id;
    if (!migratedChannelIds.has(channelId)) continue;
    const guildId = channelGuildMap.get(channelId);
    if (!guildId) continue;

    let targetId = row.target_id;
    let targetType = null;

    if (row.target_type === 'everyone') {
      targetType = 0;
      targetId = defaultRoleByGuild.get(guildId) || null;
    } else if (row.target_type === 'role') {
      targetType = 0;
    } else if (row.target_type === 'member') {
      targetType = 1;
    }

    if (targetType == null || !targetId) continue;

    insertOverwrite.run(
      channelId,
      targetId,
      targetType,
      serializePermissions(parsePermissions(row.allow_permissions || '{}')),
      serializePermissions(parsePermissions(row.deny_permissions || '{}'))
    );

    stats.overwrites += 1;
  }

  const messages = tableExists(source, 'messages')
    ? source.prepare('SELECT * FROM messages').all()
    : [];

  const migratedMessageIds = new Set();

  for (const msg of messages) {
    const channelId = msg.channel_id;
    if (!migratedChannelIds.has(channelId)) continue;
    if (!migratedUserIds.has(msg.author_id)) continue;

    const typeText = String(msg.type || 'text').toLowerCase();
    const type = typeText === 'system' ? 7 : 0;

    const createdAt = Number(msg.created_at) || tsNow;
    const editedAt = Number(msg.updated_at) || (Number(msg.is_edited) ? createdAt : null);

    insertMessage.run(
      msg.id,
      channelId,
      channelGuildMap.get(channelId) || null,
      msg.author_id,
      msg.content || '',
      type,
      editedAt,
      createdAt
    );

    migratedMessageIds.add(msg.id);
    stats.messages += 1;
  }

  const attachments = tableExists(source, 'attachments')
    ? source.prepare('SELECT * FROM attachments').all()
    : [];

  for (const att of attachments) {
    if (!migratedMessageIds.has(att.message_id)) continue;
    insertAttachment.run(
      att.id,
      att.message_id,
      att.filename || 'file',
      att.filename || 'file',
      att.mime_type || 'application/octet-stream',
      Number(att.size) || 0,
      att.url || ''
    );
    stats.attachments += 1;
  }

  const reactions = tableExists(source, 'reactions')
    ? source.prepare('SELECT * FROM reactions').all()
    : [];

  for (const reaction of reactions) {
    if (!migratedMessageIds.has(reaction.message_id)) continue;
    if (!migratedUserIds.has(reaction.user_id)) continue;
    insertReaction.run(
      reaction.message_id,
      String(reaction.emoji || ''),
      reaction.user_id,
      Number(reaction.created_at) || tsNow
    );
    stats.reactions += 1;
  }

  const invites = tableExists(source, 'invites')
    ? source.prepare('SELECT * FROM invites').all()
    : [];

  for (const invite of invites) {
    const guildId = invite.server_id;
    if (!migratedGuildIds.has(guildId)) continue;
    const channelId = firstTextChannelByGuild.get(guildId);
    if (!channelId) continue;

    const createdAt = Number(invite.created_at) || tsNow;
    let maxAge = 86400;
    if (invite.expires_at && createdAt && Number(invite.expires_at) > createdAt) {
      maxAge = Number(invite.expires_at) - createdAt;
    }

    insertInvite.run(
      invite.code,
      guildId,
      channelId,
      migratedUserIds.has(invite.creator_id) ? invite.creator_id : null,
      maxAge,
      Number(invite.max_uses) || 0,
      Number(invite.uses) || 0,
      createdAt,
      invite.expires_at ? Number(invite.expires_at) : null
    );

    stats.invites += 1;
  }

  const bans = tableExists(source, 'bans')
    ? source.prepare('SELECT * FROM bans').all()
    : [];

  for (const ban of bans) {
    const guildId = ban.server_id;
    if (!migratedGuildIds.has(guildId)) continue;
    if (!migratedUserIds.has(ban.user_id)) continue;

    const bannedBy = migratedUserIds.has(ban.banned_by)
      ? ban.banned_by
      : target.prepare('SELECT owner_id FROM guilds WHERE id = ?').get(guildId)?.owner_id;

    if (!bannedBy) continue;

    insertBan.run(
      guildId,
      ban.user_id,
      ban.reason || null,
      bannedBy,
      Number(ban.created_at) || tsNow
    );
    stats.bans += 1;
  }
});

try {
  importTx();
  console.log('[legacy->core] migration completed');
  console.log('[legacy->core] stats:', stats);
} finally {
  source.close();
  target.close();
}
