// server/routes/phase4Core.js
// Handles Threads, Emojis, AutoMod, Reactions

export default async function phase4Routes(fastify, options) {
  const { db, authenticate, snowflake, io } = options;

  // --- Emojis ---
  fastify.post('/guilds/:guildId/emojis', { preHandler: [authenticate] }, async (req, reply) => {
    const { guildId } = req.params;
    const { name, image_url, animated } = req.body; 
    
    const id = snowflake.generate();
    const createdAt = Date.now();
    
    db.prepare(`
      INSERT INTO emojis (id, guild_id, name, creator_id, animated, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, guildId, name, req.user.id, animated ? 1 : 0, createdAt);

    const emojiInfo = { id, guild_id: guildId, name, creator_id: req.user.id, animated: animated ? 1 : 0, roles_allowed: '[]' };
    
    if (io) {
      io.to(`guild:${guildId}`).emit('GUILD_EMOJIS_UPDATE', {
        guild_id: guildId,
        emojis: db.prepare('SELECT * FROM emojis WHERE guild_id = ?').all(guildId)
      });
    }

    return emojiInfo;
  });

  fastify.get('/guilds/:guildId/emojis', { preHandler: [authenticate] }, async (req, reply) => {
    return db.prepare('SELECT * FROM emojis WHERE guild_id = ?').all(req.params.guildId);
  });

  // --- Reactions ---
  fastify.put('/channels/:channelId/messages/:messageId/reactions/:emoji', { preHandler: [authenticate] }, async (req, reply) => {
    const { channelId, messageId, emoji } = req.params;
    const userId = req.user.id;
    const decodedEmoji = decodeURIComponent(emoji);
    
    try {
      db.prepare(`
        INSERT INTO reactions (message_id, emoji, user_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(messageId, decodedEmoji, userId, Date.now());
    } catch (e) {
      // already reacted or constraint failed
    }

    if (io) {
      io.to(`channel:${channelId}`).emit('MESSAGE_REACTION_ADD', {
        user_id: userId,
        channel_id: channelId,
        message_id: messageId,
        emoji: { name: decodedEmoji } 
      });
    }

    return reply.code(204).send();
  });

  fastify.delete('/channels/:channelId/messages/:messageId/reactions/:emoji/@me', { preHandler: [authenticate] }, async (req, reply) => {
    const { channelId, messageId, emoji } = req.params;
    const userId = req.user.id;
    const decodedEmoji = decodeURIComponent(emoji);
    
    db.prepare(`
      DELETE FROM reactions 
      WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).run(messageId, userId, decodedEmoji);

    if (io) {
      io.to(`channel:${channelId}`).emit('MESSAGE_REACTION_REMOVE', {
        user_id: userId,
        channel_id: channelId,
        message_id: messageId,
        emoji: { name: decodedEmoji }
      });
    }

    return reply.code(204).send();
  });

  // --- Threads / Forums ---
  fastify.post('/channels/:channelId/messages/:messageId/threads', { preHandler: [authenticate] }, async (req, reply) => {
    const { channelId, messageId } = req.params;
    const { name, auto_archive_duration } = req.body;
    
    // Note: check fields match channels table exactly
    const parentChannel = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(channelId);
    if (!parentChannel) return reply.code(404).send({ error: "Channel not found" });

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
