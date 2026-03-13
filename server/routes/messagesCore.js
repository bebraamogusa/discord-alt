import { Permissions, buildPermissionService } from '../services/permissions.js';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function cleanMessage(value) {
  const text = String(value || '').trim();
  return text.slice(0, 4000);
}

export default async function messagesCoreRoutes(fastify, { db, authenticate, snowflake, io }) {
  const permissions = buildPermissionService(db);

  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getMessageById = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0');
  const getAuthorLite = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?');

  const listMessages = db.prepare(`
    SELECT *
    FROM messages
    WHERE channel_id = ?
      AND deleted = 0
      AND (? IS NULL OR id < ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, channel_id, guild_id, author_id, content, type, flags, tts,
      mention_everyone, pinned, embeds, components, sticker_ids,
      poll, created_at, deleted
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '[]', '[]', '[]', NULL, ?, 0)
  `);

  const updateMessage = db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND channel_id = ? AND deleted = 0');
  const softDeleteMessage = db.prepare('UPDATE messages SET deleted = 1, edited_at = ? WHERE id = ? AND channel_id = ?');
  const setChannelLastMessage = db.prepare('UPDATE channels SET last_message_id = ?, updated_at = ? WHERE id = ?');

  function canView(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.VIEW_CHANNEL);
  }

  function canSend(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.SEND_MESSAGES);
  }

  function canManageMessages(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.MANAGE_MESSAGES);
  }

  function enrichMessage(row) {
    const author = getAuthorLite.get(row.author_id);
    return {
      id: row.id,
      channel_id: row.channel_id,
      guild_id: row.guild_id,
      author_id: row.author_id,
      content: row.content,
      type: row.type,
      flags: row.flags,
      pinned: row.pinned,
      edited_at: row.edited_at,
      created_at: row.created_at,
      author,
    };
  }

  fastify.get('/api/channels/:channelId/messages', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          before: { type: 'string', minLength: 1, maxLength: 40 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canView(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });
    }

    const limit = req.query.limit ?? 50;
    const before = req.query.before ?? null;
    const rows = listMessages.all(channel.id, before, before, limit);

    return rows.map(enrichMessage);
  });

  fastify.post('/api/channels/:channelId/messages', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canSend(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing SEND_MESSAGES permission' });
    }

    const content = cleanMessage(req.body.content);
    if (!content) {
      return reply.code(400).send({ error: 'Message content is empty' });
    }

    const id = snowflake.generate();
    const ts = nowSec();

    db.transaction(() => {
      insertMessage.run(id, channel.id, channel.guild_id, req.user.id, content, ts);
      setChannelLastMessage.run(id, ts, channel.id);
    })();

    const message = enrichMessage(getMessageById.get(id, channel.id));
    io?.to(`guild:${channel.guild_id}`)?.emit('message:create', message);

    return reply.code(201).send(message);
  });

  fastify.patch('/api/channels/:channelId/messages/:messageId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to edit this message' });
    }

    const next = cleanMessage(req.body.content);
    if (!next) return reply.code(400).send({ error: 'Message content is empty' });

    updateMessage.run(next, nowSec(), existing.id, channel.id);
    const updated = enrichMessage(getMessageById.get(existing.id, channel.id));
    io?.to(`guild:${channel.guild_id}`)?.emit('message:update', updated);

    return updated;
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to delete this message' });
    }

    softDeleteMessage.run(nowSec(), existing.id, channel.id);

    io?.to(`guild:${channel.guild_id}`)?.emit('message:delete', {
      id: existing.id,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });

    return { ok: true };
  });
}
