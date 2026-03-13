import { buildPermissionService, Permissions } from '../services/permissions.js';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function mapRelationStatus(type) {
  if (type === 1) return { status: 'accepted', direction: 'none' };
  if (type === 2) return { status: 'blocked', direction: 'none' };
  if (type === 3) return { status: 'pending', direction: 'incoming' };
  if (type === 4) return { status: 'pending', direction: 'outgoing' };
  return { status: 'unknown', direction: 'none' };
}

function mapDmChannel(row, recipient) {
  return {
    id: row.id,
    type: 'dm',
    recipient: recipient || null,
    recipient_id: recipient?.id || null,
    last_message_id: row.last_message_id || null,
    updated_at: row.updated_at || row.created_at || null,
  };
}

export default async function socialCoreRoutes(fastify, { db, authenticate, snowflake, io }) {
  const permissions = buildPermissionService(db);

  const getUserById = db.prepare('SELECT id, username, display_name, avatar, accent_color, status FROM users WHERE id = ? AND deleted_at IS NULL');
  const getUserByUsername = db.prepare('SELECT id, username, display_name, avatar, accent_color, status FROM users WHERE username = ? AND deleted_at IS NULL');
  const searchUsers = db.prepare(`
    SELECT id, username, display_name, avatar, accent_color, status
    FROM users
    WHERE deleted_at IS NULL
      AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
    ORDER BY username ASC
    LIMIT ?
  `);

  const getRelationship = db.prepare('SELECT * FROM relationships WHERE user_id = ? AND target_id = ?');
  const listRelationships = db.prepare(`
    SELECT r.user_id, r.target_id, r.type, r.created_at, r.nickname,
           u.username, u.display_name, u.avatar, u.accent_color, u.status
    FROM relationships r
    JOIN users u ON u.id = r.target_id
    WHERE r.user_id = ? AND u.deleted_at IS NULL
    ORDER BY r.created_at DESC
  `);

  const upsertRelationship = db.prepare(`
    INSERT INTO relationships (id, user_id, target_id, type, nickname, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT(user_id, target_id)
    DO UPDATE SET type = excluded.type, created_at = excluded.created_at
  `);

  const deleteRelationshipPair = db.prepare('DELETE FROM relationships WHERE (user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?)');

  const getDmChannel = db.prepare(`
    SELECT c.*
    FROM channels c
    JOIN dm_participants p1 ON p1.channel_id = c.id AND p1.user_id = ?
    JOIN dm_participants p2 ON p2.channel_id = c.id AND p2.user_id = ?
    WHERE c.type = 1
      AND (SELECT COUNT(*) FROM dm_participants dp WHERE dp.channel_id = c.id) = 2
    LIMIT 1
  `);

  const insertChannel = db.prepare(`
    INSERT INTO channels (id, guild_id, type, name, owner_id, created_at, updated_at)
    VALUES (?, NULL, 1, NULL, ?, ?, ?)
  `);
  const insertDmParticipant = db.prepare(`
    INSERT INTO dm_participants (channel_id, user_id, joined_at, closed)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET closed = 0
  `);

  const listMyDmChannels = db.prepare(`
    SELECT c.*
    FROM channels c
    JOIN dm_participants dp ON dp.channel_id = c.id
    WHERE dp.user_id = ? AND c.type = 1 AND dp.closed = 0
    ORDER BY c.updated_at DESC, c.created_at DESC
  `);

  const getDmRecipient = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.accent_color, u.status
    FROM dm_participants dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.channel_id = ? AND dp.user_id <> ? AND u.deleted_at IS NULL
    LIMIT 1
  `);

  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getDmParticipant = db.prepare('SELECT * FROM dm_participants WHERE channel_id = ? AND user_id = ?');
  const setDmClosed = db.prepare('UPDATE dm_participants SET closed = ? WHERE channel_id = ? AND user_id = ?');
  const getMessageById = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0');
  const getReactionByUser = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?');
  const addReaction = db.prepare('INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?)');
  const removeReaction = db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?');
  const removeReactionForUser = db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?');
  const removeReactionsByEmoji = db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ?');
  const removeAllReactions = db.prepare('DELETE FROM reactions WHERE message_id = ?');
  const listReactionSummary = db.prepare(`
    SELECT emoji, COUNT(*) AS count,
           MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
    FROM reactions
    WHERE message_id = ?
    GROUP BY emoji
    ORDER BY MIN(created_at) ASC
  `);
  const listReactionUsers = db.prepare(`
    SELECT r.user_id, r.created_at,
           u.username, u.display_name, u.avatar, u.accent_color, u.status
    FROM reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ?
      AND r.emoji = ?
      AND (? IS NULL OR r.user_id > ?)
    ORDER BY r.user_id ASC
    LIMIT ?
  `);

  const listPins = db.prepare(`
    SELECT p.channel_id, p.message_id, p.pinned_by, p.pinned_at,
           m.content, m.author_id, m.created_at
    FROM pins p
    JOIN messages m ON m.id = p.message_id
    WHERE p.channel_id = ?
    ORDER BY p.pinned_at DESC
  `);
  const countPins = db.prepare('SELECT COUNT(*) AS c FROM pins WHERE channel_id = ?');
  const getPin = db.prepare('SELECT * FROM pins WHERE channel_id = ? AND message_id = ?');
  const addPin = db.prepare('INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)');
  const removePin = db.prepare('DELETE FROM pins WHERE channel_id = ? AND message_id = ?');
  const updateMessagePinned = db.prepare('UPDATE messages SET pinned = ? WHERE id = ? AND channel_id = ?');
  const updateChannelLastPin = db.prepare('UPDATE channels SET last_pin_timestamp = ?, updated_at = ? WHERE id = ?');

  const searchInChannelFtsCount = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      AND m.channel_id = ?
      AND m.deleted = 0
  `);

  const searchInChannelFts = db.prepare(`
    SELECT m.id, m.channel_id, m.guild_id, m.author_id, m.content, m.created_at, m.edited_at, m.pinned,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      AND m.channel_id = ?
      AND m.deleted = 0
    ORDER BY rank ASC, m.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const searchInGuildFtsCount = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      AND m.guild_id = ?
      AND (? IS NULL OR m.channel_id = ?)
      AND m.deleted = 0
  `);

  const searchInGuildFts = db.prepare(`
    SELECT m.id, m.channel_id, m.guild_id, m.author_id, m.content, m.created_at, m.edited_at, m.pinned,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      AND m.guild_id = ?
      AND (? IS NULL OR m.channel_id = ?)
      AND m.deleted = 0
    ORDER BY rank ASC, m.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const authorLite = db.prepare('SELECT id, username, display_name, avatar, accent_color FROM users WHERE id = ? AND deleted_at IS NULL');

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar || '',
      avatar_color: user.accent_color || '#5865f2',
      status: user.status || 'offline',
    };
  }

  function canAccessChannel(userId, channel) {
    if (!channel) return false;
    if (channel.guild_id) return permissions.hasChannelPermission(channel.id, userId, Permissions.VIEW_CHANNEL);
    const p = db.prepare('SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ? AND closed = 0').get(channel.id, userId);
    return !!p;
  }

  function buildReactionPayload(messageId, channelId, actorId, userId) {
    return {
      message_id: messageId,
      channel_id: channelId,
      user_id: actorId,
      reactions: listReactionSummary.all(userId, messageId).map((r) => ({
        emoji: r.emoji,
        count: r.count,
        me: !!r.me,
      })),
    };
  }

  function emitCompat(eventModern, eventLegacy, room, payload) {
    io?.to(room)?.emit(eventModern, payload);
    io?.to(room)?.emit(eventLegacy, payload);
  }

  fastify.get('/api/users', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['q'],
      },
    },
  }, async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const safe = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    return searchUsers.all(`${safe}%`, `%${safe}%`, req.query.limit).filter((u) => u.id !== req.user.id).map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      avatar_url: u.avatar || '',
      avatar_color: u.accent_color || '#5865f2',
      status: u.status || 'offline',
      discriminator: '0000',
    }));
  });

  fastify.get('/api/users/@me/relationships', { preHandler: authenticate }, async (req) => {
    return listRelationships.all(req.user.id).map((row) => {
      const meta = mapRelationStatus(row.type);
      return {
        user_id: row.target_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar || '',
        avatar_color: row.accent_color || '#5865f2',
        status: meta.status,
        direction: meta.direction,
        relation_type: row.type,
        created_at: row.created_at,
      };
    });
  });

  fastify.post('/api/users/@me/relationships', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        additionalProperties: false,
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 32 },
        },
      },
    },
  }, async (req, reply) => {
    const username = String(req.body.username).trim().toLowerCase();
    const target = getUserByUsername.get(username);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.id === req.user.id) return reply.code(400).send({ error: 'Cannot add yourself' });

    const blockedByMe = getRelationship.get(req.user.id, target.id);
    const blockedByTarget = getRelationship.get(target.id, req.user.id);
    if (blockedByMe?.type === 2 || blockedByTarget?.type === 2) {
      return reply.code(403).send({ error: 'Relationship blocked' });
    }

    const now = nowSec();
    const myRel = getRelationship.get(req.user.id, target.id);
    const reverseRel = getRelationship.get(target.id, req.user.id);

    if (myRel?.type === 1 && reverseRel?.type === 1) {
      return reply.code(409).send({ error: 'Already friends' });
    }

    db.transaction(() => {
      if (myRel?.type === 3 || reverseRel?.type === 4) {
        upsertRelationship.run(snowflake.generate(), req.user.id, target.id, 1, now);
        upsertRelationship.run(snowflake.generate(), target.id, req.user.id, 1, now);
      } else {
        upsertRelationship.run(snowflake.generate(), req.user.id, target.id, 4, now);
        upsertRelationship.run(snowflake.generate(), target.id, req.user.id, 3, now);
      }
    })();

    io?.to(`user:${target.id}`)?.emit('relationship:add', { type: 'incoming_request', user: publicUser(req.user) });
    io?.to(`user:${target.id}`)?.emit('FRIEND_REQUEST', publicUser(req.user));
    io?.to(`user:${req.user.id}`)?.emit('relationship:update', { user_id: target.id, type: 'outgoing_request' });

    return { ok: true };
  });

  fastify.put('/api/users/@me/relationships/:userId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { type: 'integer', enum: [1, 2] },
        },
      },
    },
  }, async (req, reply) => {
    const target = getUserById.get(req.params.userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.id === req.user.id) return reply.code(400).send({ error: 'Invalid target' });

    const now = nowSec();
    const desiredType = req.body.type;
    const mine = getRelationship.get(req.user.id, target.id);
    const reverse = getRelationship.get(target.id, req.user.id);

    if (desiredType === 1) {
      if (!(mine?.type === 3 || reverse?.type === 4 || mine?.type === 1 || reverse?.type === 1)) {
        return reply.code(400).send({ error: 'No pending request to accept' });
      }
      db.transaction(() => {
        upsertRelationship.run(snowflake.generate(), req.user.id, target.id, 1, now);
        upsertRelationship.run(snowflake.generate(), target.id, req.user.id, 1, now);
      })();
      io?.to(`user:${target.id}`)?.emit('relationship:update', { user_id: req.user.id, type: 'friend' });
      io?.to(`user:${target.id}`)?.emit('FRIEND_UPDATE', { user_id: req.user.id, status: 'accepted' });
      io?.to(`user:${req.user.id}`)?.emit('FRIEND_UPDATE', { user_id: target.id, status: 'accepted' });
      return { ok: true };
    }

    db.transaction(() => {
      deleteRelationshipPair.run(req.user.id, target.id, target.id, req.user.id);
      upsertRelationship.run(snowflake.generate(), req.user.id, target.id, 2, now);
    })();

    io?.to(`user:${target.id}`)?.emit('relationship:remove', { user_id: req.user.id });
    io?.to(`user:${target.id}`)?.emit('FRIEND_UPDATE', { user_id: req.user.id, status: 'removed' });
    io?.to(`user:${req.user.id}`)?.emit('FRIEND_UPDATE', { user_id: target.id, status: 'removed' });
    return { ok: true };
  });

  fastify.delete('/api/users/@me/relationships/:userId', { preHandler: authenticate }, async (req, reply) => {
    const target = getUserById.get(req.params.userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });

    deleteRelationshipPair.run(req.user.id, target.id, target.id, req.user.id);
    io?.to(`user:${target.id}`)?.emit('relationship:remove', { user_id: req.user.id });
    io?.to(`user:${target.id}`)?.emit('FRIEND_UPDATE', { user_id: req.user.id, status: 'removed' });
    io?.to(`user:${req.user.id}`)?.emit('FRIEND_UPDATE', { user_id: target.id, status: 'removed' });
    return { ok: true };
  });

  fastify.post('/api/users/:userId/dm', { preHandler: authenticate }, async (req, reply) => {
    const target = getUserById.get(req.params.userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.id === req.user.id) return reply.code(400).send({ error: 'Cannot create DM with yourself' });

    const blockedByMe = getRelationship.get(req.user.id, target.id);
    const blockedByTarget = getRelationship.get(target.id, req.user.id);
    if (blockedByMe?.type === 2 || blockedByTarget?.type === 2) {
      return reply.code(403).send({ error: 'Cannot DM blocked user' });
    }

    let channel = getDmChannel.get(req.user.id, target.id);
    if (!channel) {
      const id = snowflake.generate();
      const ts = nowSec();
      db.transaction(() => {
        insertChannel.run(id, req.user.id, ts, ts);
        insertDmParticipant.run(id, req.user.id, ts);
        insertDmParticipant.run(id, target.id, ts);
      })();
      channel = getChannelById.get(id);
    } else {
      insertDmParticipant.run(channel.id, req.user.id, nowSec());
      insertDmParticipant.run(channel.id, target.id, nowSec());
    }

    const out = mapDmChannel(channel, publicUser(target));
    io?.to(`user:${req.user.id}`)?.emit('channel:create', out);
    io?.to(`user:${req.user.id}`)?.emit('CHANNEL_CREATE', out);
    io?.to(`user:${target.id}`)?.emit('channel:create', out);
    io?.to(`user:${target.id}`)?.emit('CHANNEL_CREATE', out);
    return out;
  });

  fastify.post('/api/users/@me/channels', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recipient_id: { type: 'string', minLength: 1, maxLength: 64 },
          recipients: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 64 },
            minItems: 1,
            maxItems: 10,
          },
          name: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body || {};

    if (body.recipient_id) {
      req.params.userId = body.recipient_id;
      return fastify.inject({
        method: 'POST',
        url: `/api/users/${body.recipient_id}/dm`,
        headers: {
          authorization: req.headers.authorization,
          'content-type': 'application/json',
        },
        payload: '{}',
      }).then((res) => {
        reply.code(res.statusCode);
        return res.body ? JSON.parse(res.body) : null;
      });
    }

    const recipients = [...new Set((body.recipients || []).map((v) => String(v)))].filter((id) => id !== req.user.id);
    if (!recipients.length) return reply.code(400).send({ error: 'Recipients required' });
    if (recipients.length > 10) return reply.code(400).send({ error: 'Group DM supports up to 10 recipients' });

    const users = recipients.map((id) => getUserById.get(id)).filter(Boolean);
    if (users.length !== recipients.length) return reply.code(404).send({ error: 'One or more recipients not found' });

    const channelId = snowflake.generate();
    const ts = nowSec();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO channels (id, guild_id, type, name, owner_id, created_at, updated_at)
        VALUES (?, NULL, 3, ?, ?, ?, ?)
      `).run(channelId, body.name ? String(body.name).slice(0, 100) : null, req.user.id, ts, ts);
      insertDmParticipant.run(channelId, req.user.id, ts);
      for (const userId of recipients) insertDmParticipant.run(channelId, userId, ts);
    })();

    const channel = getChannelById.get(channelId);
    const out = {
      id: channel.id,
      type: 'group',
      name: channel.name,
      owner_id: channel.owner_id,
      recipients: [publicUser(req.user), ...users.map(publicUser)],
      last_message_id: channel.last_message_id,
      updated_at: channel.updated_at || channel.created_at,
    };

    io?.to(`user:${req.user.id}`)?.emit('channel:create', out);
    io?.to(`user:${req.user.id}`)?.emit('CHANNEL_CREATE', out);
    for (const userId of recipients) {
      io?.to(`user:${userId}`)?.emit('channel:create', out);
      io?.to(`user:${userId}`)?.emit('CHANNEL_CREATE', out);
    }

    return reply.code(201).send(out);
  });

  fastify.get('/api/users/@me/channels', { preHandler: authenticate }, async (req) => {
    const channels = listMyDmChannels.all(req.user.id);
    return channels.map((c) => {
      if (c.type === 3) {
        const participants = db.prepare(`
          SELECT u.id, u.username, u.display_name, u.avatar, u.accent_color, u.status
          FROM dm_participants dp
          JOIN users u ON u.id = dp.user_id
          WHERE dp.channel_id = ? AND dp.closed = 0
        `).all(c.id).map(publicUser);
        return {
          id: c.id,
          type: 'group',
          name: c.name,
          owner_id: c.owner_id,
          recipients: participants,
          last_message_id: c.last_message_id,
          updated_at: c.updated_at || c.created_at,
        };
      }
      return mapDmChannel(c, publicUser(getDmRecipient.get(c.id, req.user.id)));
    });
  });

  fastify.delete('/api/channels/:channelId/recipients/@me', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel || (channel.type !== 1 && channel.type !== 3)) {
      return reply.code(404).send({ error: 'DM channel not found' });
    }
    if (!getDmParticipant.get(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Not a DM participant' });
    }

    if (channel.type === 1) {
      setDmClosed.run(1, channel.id, req.user.id);
      return { ok: true, closed: true };
    }

    if (channel.owner_id === req.user.id) {
      const nextOwner = db.prepare(`
        SELECT user_id FROM dm_participants
        WHERE channel_id = ? AND user_id <> ?
        ORDER BY joined_at ASC
        LIMIT 1
      `).get(channel.id, req.user.id);
      db.transaction(() => {
        db.prepare('DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?').run(channel.id, req.user.id);
        if (nextOwner) db.prepare('UPDATE channels SET owner_id = ?, updated_at = ? WHERE id = ?').run(nextOwner.user_id, nowSec(), channel.id);
      })();
    } else {
      db.prepare('DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?').run(channel.id, req.user.id);
    }

    io?.to(`channel:${channel.id}`)?.emit('channel:update', { id: channel.id });
    io?.to(`channel:${channel.id}`)?.emit('CHANNEL_UPDATE', { id: channel.id });
    return { ok: true };
  });

  fastify.post('/api/channels/:channelId/typing', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!canAccessChannel(req.user.id, channel)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });

    const payload = {
      channel_id: channel.id,
      user_id: req.user.id,
      username: req.user.username,
      timestamp: Date.now(),
    };

    const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
    emitCompat('typing:start', 'TYPING_START', room, payload);
    return { ok: true };
  });

  fastify.get('/api/channels/:channelId/pins', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!canAccessChannel(req.user.id, channel)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });
    return listPins.all(channel.id);
  });

  fastify.put('/api/channels/:channelId/pins/:messageId', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Pins supported only in guild channels' });
    if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== channel.id) return reply.code(404).send({ error: 'Message not found' });
    if (getPin.get(channel.id, message.id)) return { ok: true };

    if ((countPins.get(channel.id)?.c || 0) >= 50) {
      return reply.code(400).send({ error: 'Pin limit reached' });
    }

    const ts = nowSec();
    db.transaction(() => {
      addPin.run(channel.id, message.id, req.user.id, ts);
      updateMessagePinned.run(1, message.id, channel.id);
      updateChannelLastPin.run(ts, ts, channel.id);
    })();

    const payload = { channel_id: channel.id, last_pin_timestamp: ts };
    emitCompat('channel:pins_update', 'CHANNEL_PINS_UPDATE', `guild:${channel.guild_id}`, payload);
    return { ok: true };
  });

  fastify.delete('/api/channels/:channelId/pins/:messageId', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Pins supported only in guild channels' });
    if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    if (!getPin.get(channel.id, req.params.messageId)) return reply.code(404).send({ error: 'Pin not found' });
    const ts = nowSec();
    db.transaction(() => {
      removePin.run(channel.id, req.params.messageId);
      updateMessagePinned.run(0, req.params.messageId, channel.id);
      updateChannelLastPin.run(ts, ts, channel.id);
    })();

    const payload = { channel_id: channel.id, last_pin_timestamp: ts };
    emitCompat('channel:pins_update', 'CHANNEL_PINS_UPDATE', `guild:${channel.guild_id}`, payload);
    return { ok: true };
  });

  async function handleReact(req, reply, mode) {
    const message = getMessageById.get(req.params.messageId);
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    const channel = getChannelById.get(message.channel_id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!canAccessChannel(req.user.id, channel)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });

    const emoji = decodeURIComponent(String(req.params.emoji || '')).trim();
    if (!emoji || emoji.length > 128) return reply.code(400).send({ error: 'Invalid emoji' });

    if (mode === 'add') {
      if (!getReactionByUser.get(message.id, emoji, req.user.id)) {
        addReaction.run(message.id, emoji, req.user.id, nowSec());
      }
      const payload = buildReactionPayload(message.id, channel.id, req.user.id, req.user.id);
      const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
      emitCompat('message:reaction_add', 'REACTION_ADD', room, payload);
      return payload;
    }

    removeReaction.run(message.id, emoji, req.user.id);
    const payload = buildReactionPayload(message.id, channel.id, req.user.id, req.user.id);
    const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
    emitCompat('message:reaction_remove', 'REACTION_REMOVE', room, payload);
    return payload;
  }

  fastify.put('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', { preHandler: authenticate }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    return handleReact(req, reply, 'add');
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', { preHandler: authenticate }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    return handleReact(req, reply, 'remove');
  });

  fastify.post('/api/messages/:messageId/reactions/:emoji', { preHandler: authenticate }, async (req, reply) => {
    return handleReact(req, reply, 'add');
  });

  fastify.delete('/api/messages/:messageId/reactions/:emoji', { preHandler: authenticate }, async (req, reply) => {
    return handleReact(req, reply, 'remove');
  });

  fastify.get('/api/channels/:channelId/messages/:messageId/reactions/:emoji', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          after: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    const channel = getChannelById.get(message.channel_id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!canAccessChannel(req.user.id, channel)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });

    const emoji = decodeURIComponent(String(req.params.emoji || '')).trim();
    const rows = listReactionUsers.all(message.id, emoji, req.query.after || null, req.query.after || null, req.query.limit || 25);
    return rows.map((r) => ({
      user_id: r.user_id,
      created_at: r.created_at,
      user: {
        id: r.user_id,
        username: r.username,
        display_name: r.display_name,
        avatar_url: r.avatar || '',
        avatar_color: r.accent_color || '#5865f2',
        status: r.status || 'offline',
      },
    }));
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId/reactions/:emoji/:userId', { preHandler: authenticate }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    const channel = getChannelById.get(message.channel_id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    const emoji = decodeURIComponent(String(req.params.emoji || '')).trim();
    removeReactionForUser.run(message.id, emoji, req.params.userId);
    const payload = buildReactionPayload(message.id, channel.id, req.user.id, req.user.id);
    const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
    emitCompat('message:reaction_remove', 'REACTION_REMOVE', room, payload);
    return { ok: true };
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId/reactions', { preHandler: authenticate }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    const channel = getChannelById.get(message.channel_id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    removeAllReactions.run(message.id);
    const payload = buildReactionPayload(message.id, channel.id, req.user.id, req.user.id);
    const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
    emitCompat('message:reaction_remove_all', 'REACTION_REMOVE', room, payload);
    return { ok: true };
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId/reactions/:emoji', { preHandler: authenticate }, async (req, reply) => {
    const message = getMessageById.get(req.params.messageId);
    if (!message || message.channel_id !== req.params.channelId) return reply.code(404).send({ error: 'Message not found in channel' });
    const channel = getChannelById.get(message.channel_id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.MANAGE_MESSAGES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    const emoji = decodeURIComponent(String(req.params.emoji || '')).trim();
    removeReactionsByEmoji.run(message.id, emoji);
    const payload = buildReactionPayload(message.id, channel.id, req.user.id, req.user.id);
    const room = channel.guild_id ? `guild:${channel.guild_id}` : `channel:${channel.id}`;
    emitCompat('message:reaction_remove_emoji', 'REACTION_REMOVE', room, payload);
    return { ok: true };
  });

  fastify.get('/api/channels/:channelId/messages/search', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
        required: ['content'],
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!canAccessChannel(req.user.id, channel)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });

    const content = String(req.query.content).trim();
    const total = searchInChannelFtsCount.get(content, channel.id)?.c || 0;
    const messages = searchInChannelFts.all(content, channel.id, req.query.limit, req.query.offset).map((row) => ({
      ...row,
      author: authorLite.get(row.author_id),
    }));

    return { total_results: total, messages };
  });

  fastify.get('/api/guilds/:guildId/messages/search', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 200 },
          channel_id: { type: 'string', minLength: 1, maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
        required: ['content'],
      },
    },
  }, async (req, reply) => {
    const guildId = req.params.guildId;
    const member = db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, req.user.id);
    if (!member) return reply.code(403).send({ error: 'Not a guild member' });

    const content = String(req.query.content).trim();
    const channelId = req.query.channel_id || null;
    if (channelId) {
      const channel = getChannelById.get(channelId);
      if (!channel || channel.guild_id !== guildId) return reply.code(400).send({ error: 'Invalid channel_id filter' });
      if (!permissions.hasChannelPermission(channel.id, req.user.id, Permissions.VIEW_CHANNEL)) {
        return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission for channel filter' });
      }
    }

    const total = searchInGuildFtsCount.get(content, guildId, channelId, channelId)?.c || 0;
    const rows = searchInGuildFts.all(content, guildId, channelId, channelId, req.query.limit, req.query.offset);
    const messages = rows.filter((row) => {
      if (!row.channel_id) return false;
      return permissions.hasChannelPermission(row.channel_id, req.user.id, Permissions.VIEW_CHANNEL);
    }).map((row) => ({
      ...row,
      author: authorLite.get(row.author_id),
    }));

    return { total_results: total, messages };
  });
}
