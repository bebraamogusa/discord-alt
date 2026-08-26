// server/routes/phase4Core.js
// Handles Threads, Emojis, AutoMod

import { buildPermissionService, Permissions } from '../services/permissions.js';

export default async function phase4Routes(fastify, options) {
  const { db, authenticate, snowflake, io } = options;
  const permissions = buildPermissionService(db);

  function requireGuildPermission(guildId, userId, permission, reply, message) {
    if (!permissions.hasGuildPermission(guildId, userId, permission)) {
      reply.code(403).send({ error: message });
      return false;
    }
    return true;
  }

  function requireChannelPermission(channelId, userId, permission, reply, message) {
    if (!permissions.hasChannelPermission(channelId, userId, permission)) {
      reply.code(403).send({ error: message });
      return false;
    }
    return true;
  }

  // --- Emojis ---
  const listEmojisForGuild = db.prepare('SELECT * FROM emojis WHERE guild_id = ? ORDER BY created_at ASC');

  function emitEmojiUpdate(guildId) {
    if (io) {
      io.to(`guild:${guildId}`).emit('GUILD_EMOJIS_UPDATE', {
        guild_id: guildId,
        emojis: listEmojisForGuild.all(guildId),
      });
    }
  }

  fastify.post('/guilds/:guildId/emojis', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[\\w-]+$' },
          image_url: { type: 'string', maxLength: 500000 },
          animated: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { guildId } = req.params;
    const { name, image_url, animated } = req.body;

    if (!requireGuildPermission(guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;

    const id = snowflake.generate();
    const createdAt = Date.now();

    db.prepare(`
      INSERT INTO emojis (id, guild_id, name, creator_id, animated, image, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, guildId, name, req.user.id, animated ? 1 : 0, image_url || null, createdAt);

    const emojiInfo = { id, guild_id: guildId, name, creator_id: req.user.id, animated: animated ? 1 : 0, image: image_url || null, roles_allowed: '[]' };
    emitEmojiUpdate(guildId);

    return emojiInfo;
  });

  fastify.get('/guilds/:guildId/emojis', { preHandler: [authenticate] }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission')) return;
    return listEmojisForGuild.all(req.params.guildId);
  });

  fastify.delete('/guilds/:guildId/emojis/:emojiId', { preHandler: [authenticate] }, async (req, reply) => {
    const emoji = db.prepare('SELECT * FROM emojis WHERE id = ?').get(req.params.emojiId);
    if (!emoji || emoji.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Emoji not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;

    db.prepare('DELETE FROM emojis WHERE id = ?').run(emoji.id);
    emitEmojiUpdate(req.params.guildId);
    return { ok: true };
  });

  // --- Reactions ---
  // Removed: canonical reaction routes live in messagesCore.js (message_reactions table).

  // --- Threads / Forums ---
  fastify.post('/channels/:channelId/messages/:messageId/threads', { preHandler: [authenticate] }, async (req, reply) => {
    const { channelId, messageId } = req.params;
    const { name, auto_archive_duration } = req.body;
    
    const parentChannel = db.prepare('SELECT id, guild_id FROM channels WHERE id = ?').get(channelId);
    if (!parentChannel || !parentChannel.guild_id) return reply.code(404).send({ error: "Channel not found" });
    if (!requireChannelPermission(channelId, req.user.id, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission')) return;
    if (!requireChannelPermission(channelId, req.user.id, Permissions.SEND_MESSAGES, reply, 'Missing SEND_MESSAGES permission')) return;
    const message = db.prepare('SELECT id, channel_id, guild_id FROM messages WHERE id = ? AND channel_id = ?').get(messageId, channelId);
    if (!message || message.guild_id !== parentChannel.guild_id) return reply.code(404).send({ error: 'Message not found' });

    const threadId = snowflake.generate();
    const now = Date.now();

    db.transaction(() => {
      // type 11 = public thread
      db.prepare(`
        INSERT INTO channels (id, guild_id, type, name, parent_id, owner_id, flags, created_at)
        VALUES (?, ?, 11, ?, ?, ?, 0, ?)
      `).run(threadId, parentChannel.guild_id, name, channelId, req.user.id, now);
      
      db.prepare('INSERT INTO thread_members (thread_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(threadId, req.user.id, now);
    })();
    
    const threadInfo = db.prepare('SELECT * FROM channels WHERE id = ?').get(threadId);

    if (io) {
      io.to(`channel:${channelId}`).emit('THREAD_CREATE', threadInfo);
    }
    
    return threadInfo;
  });

  // --- AutoMod ---
  fastify.post('/guilds/:guildId/automod/rules', { preHandler: [authenticate] }, async (req, reply) => {
    const { guildId } = req.params;
    const { name, event_type, trigger_type, trigger_metadata, actions, enabled, exempt_roles, exempt_channels } = req.body;

    if (!requireGuildPermission(guildId, req.user.id, Permissions.MANAGE_GUILD, reply, 'Missing MANAGE_GUILD permission')) return;
    
    const id = snowflake.generate();
    const now = Date.now();

    db.prepare(`
      INSERT INTO automod_rules (id, guild_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, enabled, exempt_roles, exempt_channels, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, guildId, name, req.user.id, event_type, trigger_type, 
      JSON.stringify(trigger_metadata || {}), 
      JSON.stringify(actions || []), 
      enabled !== false ? 1 : 0,
      JSON.stringify(exempt_roles || []),
      JSON.stringify(exempt_channels || []),
      now
    );

    return db.prepare('SELECT * FROM automod_rules WHERE id = ?').get(id);
  });
}
