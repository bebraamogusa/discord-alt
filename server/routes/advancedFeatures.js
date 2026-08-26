// server/routes/advancedFeatures.js
// Handles: Webhooks, Polls, Soundboard, Scheduled Events, Stickers

import { randomBytes } from 'node:crypto';
import { buildPermissionService, Permissions } from '../services/permissions.js';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(len);
  let result = '';
  for (let i = 0; i < len; i++) result += chars[bytes[i] % chars.length];
  return result;
}

export default async function advancedFeaturesRoutes(fastify, { db, authenticate, snowflake, io, webhookRateLimit }) {
  const permissions = buildPermissionService(db);

  function requireGuildPermission(guildId, userId, permission, reply, message) {
    if (!permissions.hasGuildPermission(guildId, userId, permission)) {
      reply.code(403).send({ error: message });
      return false;
    }
    return true;
  }

  function requireGuildView(guildId, userId, reply) {
    return requireGuildPermission(guildId, userId, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission');
  }

  function requireChannelPermission(channelId, userId, permission, reply, message) {
    if (!permissions.hasChannelPermission(channelId, userId, permission)) {
      reply.code(403).send({ error: message });
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════════

  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getGuildMember = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?');
  const getWebhook = db.prepare('SELECT * FROM webhooks WHERE id = ?');
  const getWebhookByToken = db.prepare('SELECT * FROM webhooks WHERE id = ? AND token = ?');
  const listChannelWebhooks = db.prepare('SELECT * FROM webhooks WHERE channel_id = ?');
  const listGuildWebhooks = db.prepare('SELECT * FROM webhooks WHERE guild_id = ?');
  const insertWebhook = db.prepare(`
    INSERT INTO webhooks (id, guild_id, channel_id, creator_id, name, avatar, token, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateWebhookStmt = db.prepare(`
    UPDATE webhooks SET name = COALESCE(?, name), avatar = COALESCE(?, avatar), channel_id = COALESCE(?, channel_id)
    WHERE id = ?
  `);
  const deleteWebhookStmt = db.prepare('DELETE FROM webhooks WHERE id = ?');

  // Webhook message sender — reuses message insert logic
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, webhook_id, embeds, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const updateChannelLastMessage = db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?');
  const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

  // POST /api/channels/:channelId/webhooks
  fastify.post('/api/channels/:channelId/webhooks', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          avatar: { type: ['string', 'null'], maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel || !channel.guild_id) return reply.code(404).send({ error: 'Channel not found' });

    if (!permissions.hasGuildPermission(channel.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }

    const id = snowflake.generate();
    const token = randomToken(68);
    insertWebhook.run(id, channel.guild_id, channel.id, req.user.id, req.body.name, req.body.avatar || null, token, 1, nowSec());
    const { token: _, ...safe } = getWebhook.get(id);
    io?.to(`guild:${channel.guild_id}`)?.emit('webhook:create', safe);
    return reply.code(201).send(safe);
  });

  // GET /api/channels/:channelId/webhooks
  fastify.get('/api/channels/:channelId/webhooks', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel || !channel.guild_id) return reply.code(404).send({ error: 'Channel not found' });
    if (!permissions.hasGuildPermission(channel.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    return listChannelWebhooks.all(req.params.channelId).map(({ token, ...rest }) => rest);
  });

  // GET /api/guilds/:guildId/webhooks
  fastify.get('/api/guilds/:guildId/webhooks', { preHandler: authenticate }, async (req, reply) => {
    const member = getGuildMember.get(req.params.guildId, req.user.id);
    if (!member) return reply.code(404).send({ error: 'Not a member' });
    if (!permissions.hasGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    return listGuildWebhooks.all(req.params.guildId).map(({ token, ...rest }) => rest);
  });

  function webhookUrl(wh) {
    return `/api/webhooks/${wh.id}/${wh.token}`;
  }

  // GET /api/webhooks/:webhookId
  fastify.get('/api/webhooks/:webhookId', { preHandler: authenticate }, async (req, reply) => {
    const wh = getWebhook.get(req.params.webhookId);
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });
    if (wh.guild_id && !permissions.hasGuildPermission(wh.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    const { token: _, ...safe } = wh;
    return { ...safe, url: webhookUrl(wh) };
  });

  // POST /api/webhooks/:webhookId/regenerate-token — rotate the webhook URL secret
  fastify.post('/api/webhooks/:webhookId/regenerate-token', { preHandler: authenticate }, async (req, reply) => {
    const wh = getWebhook.get(req.params.webhookId);
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });
    if (wh.guild_id && !permissions.hasGuildPermission(wh.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    const token = randomToken(68);
    db.prepare('UPDATE webhooks SET token = ? WHERE id = ?').run(token, wh.id);
    const updated = getWebhook.get(wh.id);
    const { token: _, ...safe } = updated;
    io?.to(`guild:${updated.guild_id}`)?.emit('webhook:update', safe);
    return { id: updated.id, url: webhookUrl(updated) };
  });

  // PATCH /api/webhooks/:webhookId
  fastify.patch('/api/webhooks/:webhookId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          avatar: { type: ['string', 'null'] },
          channel_id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const wh = getWebhook.get(req.params.webhookId);
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });
    if (wh.guild_id && !permissions.hasGuildPermission(wh.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    if (req.body.channel_id) {
      const targetChannel = getChannelById.get(req.body.channel_id);
      if (!targetChannel || targetChannel.guild_id !== wh.guild_id) {
        return reply.code(400).send({ error: 'Target channel must be in the same guild' });
      }
    }
    updateWebhookStmt.run(req.body.name || null, req.body.avatar || null, req.body.channel_id || null, wh.id);
    const { token: _, ...safe } = getWebhook.get(wh.id);
    io?.to(`guild:${wh.guild_id}`)?.emit('webhook:update', safe);
    return safe;
  });

  // DELETE /api/webhooks/:webhookId
  fastify.delete('/api/webhooks/:webhookId', { preHandler: authenticate }, async (req, reply) => {
    const wh = getWebhook.get(req.params.webhookId);
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });
    if (wh.guild_id && !permissions.hasGuildPermission(wh.guild_id, req.user.id, Permissions.MANAGE_WEBHOOKS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_WEBHOOKS permission' });
    }
    deleteWebhookStmt.run(wh.id);
    io?.to(`guild:${wh.guild_id}`)?.emit('webhook:delete', { id: wh.id, guild_id: wh.guild_id, channel_id: wh.channel_id });
    return { ok: true };
  });

  // POST /api/webhooks/:webhookId/:token — send message via webhook (NO AUTH)
  fastify.post('/api/webhooks/:webhookId/:token', {
    preHandler: webhookRateLimit ? [webhookRateLimit] : [],
    schema: {
      body: {
        type: 'object',
        properties: {
          content: { type: 'string', maxLength: 2000 },
          username: { type: 'string', maxLength: 80 },
          avatar_url: { type: 'string', maxLength: 2048 },
          tts: { type: 'boolean' },
          embeds: { type: 'array', maxItems: 10 },
        },
      },
    },
  }, async (req, reply) => {
    const wh = getWebhookByToken.get(req.params.webhookId, req.params.token);
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });

    const content = req.body.content || '';
    const embeds = JSON.stringify(req.body.embeds || []);
    if (!content && embeds === '[]') return reply.code(400).send({ error: 'Content or embeds required' });

    const msgId = snowflake.generate();
    const channel = getChannelById.get(wh.channel_id);
    insertMessage.run(msgId, wh.channel_id, wh.guild_id, wh.creator_id || 'webhook', content, wh.id, embeds, nowSec());
    updateChannelLastMessage.run(msgId, wh.channel_id);

    const msg = {
      id: msgId,
      channel_id: wh.channel_id,
      guild_id: wh.guild_id,
      content,
      type: 0,
      webhook_id: wh.id,
      author: {
        id: wh.id,
        username: req.body.username || wh.name || 'Webhook',
        display_name: req.body.username || wh.name || 'Webhook',
        avatar: req.body.avatar_url || wh.avatar || null,
        bot: true,
      },
      embeds: req.body.embeds || [],
      attachments: [],
      reactions: [],
      created_at: nowSec(),
    };

    io?.to(`guild:${wh.guild_id}`)?.emit('MESSAGE_CREATE', msg);
    io?.to(`guild:${wh.guild_id}`)?.emit('message:create', msg);
    return reply.code(200).send(msg);
  });

  // ═══════════════════════════════════════════════════════
  // POLLS
  // ═══════════════════════════════════════════════════════

  const getPoll = db.prepare('SELECT * FROM polls WHERE message_id = ?');
  const getPollMessage = db.prepare(`
    SELECT m.*, c.guild_id AS channel_guild_id
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.id = ? AND m.channel_id = ? AND m.guild_id = c.guild_id
  `);
  const getPollAnswers = db.prepare('SELECT * FROM poll_answers WHERE message_id = ? ORDER BY id');
  const getPollVoteCount = db.prepare('SELECT answer_id, COUNT(*) AS count FROM poll_votes WHERE message_id = ? GROUP BY answer_id');
  const getUserVotes = db.prepare('SELECT answer_id FROM poll_votes WHERE message_id = ? AND user_id = ?');
  const insertPoll = db.prepare('INSERT INTO polls (message_id, question, allow_multiselect, expiry, layout_type) VALUES (?, ?, ?, ?, ?)');
  const insertPollAnswer = db.prepare('INSERT INTO poll_answers (id, message_id, text, emoji) VALUES (?, ?, ?, ?)');
  const insertPollVote = db.prepare('INSERT OR IGNORE INTO poll_votes (message_id, answer_id, user_id) VALUES (?, ?, ?)');
  const deletePollVote = db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND answer_id = ? AND user_id = ?');
  const getVotersForAnswer = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.accent_color
    FROM poll_votes pv
    JOIN users u ON u.id = pv.user_id
    WHERE pv.message_id = ? AND pv.answer_id = ?
    LIMIT ?
  `);

  function buildPollResponse(messageId, userId) {
    const poll = getPoll.get(messageId);
    if (!poll) return null;
    const answers = getPollAnswers.all(messageId);
    const voteCounts = {};
    for (const row of getPollVoteCount.all(messageId)) voteCounts[row.answer_id] = row.count;
    const myVotes = userId ? getUserVotes.all(messageId, userId).map(r => r.answer_id) : [];
    return {
      question: poll.question,
      allow_multiselect: !!poll.allow_multiselect,
      expiry: poll.expiry,
      layout_type: poll.layout_type,
      answers: answers.map(a => ({
        id: a.id,
        text: a.text,
        emoji: a.emoji,
        count: voteCounts[a.id] || 0,
        me: myVotes.includes(a.id),
      })),
    };
  }

  function authorizePoll(req, reply, permission) {
    const message = getPollMessage.get(req.params.messageId, req.params.channelId);
    if (!message) {
      reply.code(404).send({ error: 'Poll not found' });
      return null;
    }
    if (!requireChannelPermission(message.channel_id, req.user.id, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission')) return null;
    if (!requireChannelPermission(message.channel_id, req.user.id, Permissions.READ_MESSAGE_HISTORY, reply, 'Missing READ_MESSAGE_HISTORY permission')) return null;
    if (permission && !requireChannelPermission(message.channel_id, req.user.id, permission, reply, `Missing ${permission === Permissions.MANAGE_MESSAGES ? 'MANAGE_MESSAGES' : 'SEND_MESSAGES'} permission`)) return null;
    return message;
  }

  // Vote on poll
  fastify.put('/api/channels/:channelId/polls/:messageId/answers/:answerId/@me', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const { messageId, answerId } = req.params;
    const message = authorizePoll(req, reply, Permissions.SEND_MESSAGES);
    if (!message) return;
    const poll = getPoll.get(messageId);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (poll.expiry && poll.expiry < nowSec()) return reply.code(400).send({ error: 'Poll expired' });

    const answer = db.prepare('SELECT * FROM poll_answers WHERE message_id = ? AND id = ?').get(messageId, parseInt(answerId));
    if (!answer) return reply.code(404).send({ error: 'Answer not found' });

    if (!poll.allow_multiselect) {
      // Remove existing votes first
      db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(messageId, req.user.id);
    }

    insertPollVote.run(messageId, parseInt(answerId), req.user.id);

    const pollData = buildPollResponse(messageId, req.user.id);
    io?.emit('poll:vote_add', { message_id: messageId, answer_id: parseInt(answerId), user_id: req.user.id, poll: pollData });
    return pollData;
  });

  // Remove vote
  fastify.delete('/api/channels/:channelId/polls/:messageId/answers/:answerId/@me', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const { messageId, answerId } = req.params;
    const message = authorizePoll(req, reply, Permissions.SEND_MESSAGES);
    if (!message) return;
    if (!getPoll.get(messageId)) return reply.code(404).send({ error: 'Poll not found' });
    deletePollVote.run(messageId, parseInt(answerId), req.user.id);
    const pollData = buildPollResponse(messageId, req.user.id);
    io?.emit('poll:vote_remove', { message_id: messageId, answer_id: parseInt(answerId), user_id: req.user.id, poll: pollData });
    return pollData;
  });

  // Get voters for answer
  fastify.get('/api/channels/:channelId/polls/:messageId/answers/:answerId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    if (!authorizePoll(req, reply)) return;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    return getVotersForAnswer.all(req.params.messageId, parseInt(req.params.answerId), limit);
  });

  // End poll early
  fastify.post('/api/channels/:channelId/polls/:messageId/expire', {
    preHandler: authenticate,
  }, async (req, reply) => {
    if (!authorizePoll(req, reply, Permissions.MANAGE_MESSAGES)) return;
    const poll = getPoll.get(req.params.messageId);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    db.prepare('UPDATE polls SET expiry = ? WHERE message_id = ?').run(nowSec(), req.params.messageId);
    const pollData = buildPollResponse(req.params.messageId, req.user.id);
    io?.emit('message:update', { id: req.params.messageId, poll: pollData });
    return pollData;
  });

  // ═══════════════════════════════════════════════════════
  // SOUNDBOARD
  // ═══════════════════════════════════════════════════════

  const listSounds = db.prepare('SELECT * FROM soundboard_sounds WHERE guild_id = ? AND available = 1 ORDER BY name');
  const getSound = db.prepare('SELECT * FROM soundboard_sounds WHERE id = ?');
  const insertSound = db.prepare(`
    INSERT INTO soundboard_sounds (id, guild_id, name, emoji_name, emoji_id, volume, file, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateSoundStmt = db.prepare(`
    UPDATE soundboard_sounds SET name = COALESCE(?, name), volume = COALESCE(?, volume), emoji_name = COALESCE(?, emoji_name)
    WHERE id = ?
  `);
  const deleteSoundStmt = db.prepare('DELETE FROM soundboard_sounds WHERE id = ?');

  // GET /api/guilds/:guildId/soundboard-sounds
  fastify.get('/api/guilds/:guildId/soundboard-sounds', { preHandler: authenticate }, async (req, reply) => {
    if (!requireGuildView(req.params.guildId, req.user.id, reply)) return;
    return listSounds.all(req.params.guildId);
  });

  // POST /api/guilds/:guildId/soundboard-sounds
  fastify.post('/api/guilds/:guildId/soundboard-sounds', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'file'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 32 },
          file: { type: 'string' },
          volume: { type: 'number', minimum: 0, maximum: 1 },
          emoji_name: { type: ['string', 'null'] },
          emoji_id: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    const id = snowflake.generate();
    insertSound.run(id, req.params.guildId, req.body.name, req.body.emoji_name || null, req.body.emoji_id || null, req.body.volume ?? 1.0, req.body.file, req.user.id, nowSec());
    return reply.code(201).send(getSound.get(id));
  });

  // PATCH /api/guilds/:guildId/soundboard-sounds/:soundId
  fastify.patch('/api/guilds/:guildId/soundboard-sounds/:soundId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 32 },
          volume: { type: 'number', minimum: 0, maximum: 1 },
          emoji_name: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const sound = getSound.get(req.params.soundId);
    if (!sound || sound.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Sound not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    updateSoundStmt.run(req.body.name || null, req.body.volume ?? null, req.body.emoji_name || null, sound.id);
    return getSound.get(sound.id);
  });

  // DELETE /api/guilds/:guildId/soundboard-sounds/:soundId
  fastify.delete('/api/guilds/:guildId/soundboard-sounds/:soundId', { preHandler: authenticate }, async (req, reply) => {
    const sound = getSound.get(req.params.soundId);
    if (!sound || sound.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Sound not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    deleteSoundStmt.run(sound.id);
    return { ok: true };
  });

  // POST /api/channels/:channelId/soundboard — play sound in voice
  fastify.post('/api/channels/:channelId/soundboard', {
    preHandler: authenticate,
    schema: { body: { type: 'object', required: ['sound_id'], properties: { sound_id: { type: 'string' } } } },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel || !channel.guild_id) return reply.code(404).send({ error: 'Channel not found' });
    const sound = getSound.get(req.body.sound_id);
    if (!sound || sound.guild_id !== channel.guild_id) return reply.code(404).send({ error: 'Sound not found' });
    if (!requireChannelPermission(channel.id, req.user.id, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission')) return;
    if (!requireChannelPermission(channel.id, req.user.id, Permissions.CONNECT, reply, 'Missing CONNECT permission')) return;
    io?.to(`guild:${sound.guild_id}`)?.emit('soundboard:play', {
      channel_id: req.params.channelId,
      sound_id: sound.id,
      sound_name: sound.name,
      file: sound.file,
      volume: sound.volume,
      user_id: req.user.id,
    });
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════
  // SCHEDULED EVENTS
  // ═══════════════════════════════════════════════════════

  const listEvents = db.prepare('SELECT * FROM scheduled_events WHERE guild_id = ? ORDER BY scheduled_start_time ASC');
  const getEvent = db.prepare('SELECT * FROM scheduled_events WHERE id = ?');
  const insertEvent = db.prepare(`
    INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, description, image, scheduled_start_time, scheduled_end_time, entity_type, entity_metadata, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEventStmt = db.prepare(`
    UPDATE scheduled_events SET name = COALESCE(?, name), description = COALESCE(?, description),
      scheduled_start_time = COALESCE(?, scheduled_start_time), scheduled_end_time = COALESCE(?, scheduled_end_time),
      status = COALESCE(?, status), channel_id = COALESCE(?, channel_id), image = COALESCE(?, image)
    WHERE id = ?
  `);
  const deleteEventStmt = db.prepare('DELETE FROM scheduled_events WHERE id = ?');
  const listEventUsers = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.accent_color
    FROM scheduled_event_users seu
    JOIN users u ON u.id = seu.user_id
    WHERE seu.event_id = ?
  `);
  const insertEventUser = db.prepare('INSERT OR IGNORE INTO scheduled_event_users (event_id, user_id) VALUES (?, ?)');
  const deleteEventUser = db.prepare('DELETE FROM scheduled_event_users WHERE event_id = ? AND user_id = ?');
  const countEventUsers = db.prepare('SELECT COUNT(*) AS c FROM scheduled_event_users WHERE event_id = ?');
  const getEventUser = db.prepare('SELECT 1 FROM scheduled_event_users WHERE event_id = ? AND user_id = ?');

  function withEventViewer(ev, userId) {
    return { ...ev, me: !!getEventUser.get(ev.id, userId) };
  }

  function authorizeEvent(req, reply, manage = false) {
    const ev = getEvent.get(req.params.eventId);
    if (!ev || ev.guild_id !== req.params.guildId) {
      reply.code(404).send({ error: 'Event not found' });
      return null;
    }
    const permission = manage ? Permissions.MANAGE_EVENTS : Permissions.VIEW_CHANNEL;
    if (!requireGuildPermission(ev.guild_id, req.user.id, permission, reply, `Missing ${manage ? 'MANAGE_EVENTS' : 'VIEW_CHANNEL'} permission`)) return null;
    if (ev.channel_id && !requireChannelPermission(ev.channel_id, req.user.id, Permissions.VIEW_CHANNEL, reply, 'Missing VIEW_CHANNEL permission')) return null;
    return ev;
  }

  // GET /api/guilds/:guildId/scheduled-events
  fastify.get('/api/guilds/:guildId/scheduled-events', { preHandler: authenticate }, async (req, reply) => {
    if (!requireGuildView(req.params.guildId, req.user.id, reply)) return;
    const events = listEvents.all(req.params.guildId).filter((event) => !event.channel_id || permissions.hasChannelPermission(event.channel_id, req.user.id, Permissions.VIEW_CHANNEL));
    return events.map((e) => ({ ...withEventViewer(e, req.user.id), user_count: countEventUsers.get(e.id)?.c || 0 }));
  });

  // POST /api/guilds/:guildId/scheduled-events
  fastify.post('/api/guilds/:guildId/scheduled-events', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'entity_type', 'scheduled_start_time'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: ['string', 'null'], maxLength: 1000 },
          channel_id: { type: ['string', 'null'] },
          entity_type: { type: 'integer', minimum: 1, maximum: 3 },
          entity_metadata: { type: ['string', 'null'] },
          scheduled_start_time: { type: 'integer' },
          scheduled_end_time: { type: ['integer', 'null'] },
          image: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EVENTS, reply, 'Missing MANAGE_EVENTS permission')) return;
    const id = snowflake.generate();
    const b = req.body;
    if (b.channel_id) {
      const channel = getChannelById.get(b.channel_id);
      if (!channel || channel.guild_id !== req.params.guildId) return reply.code(400).send({ error: 'Channel must be in the same guild' });
    }
    insertEvent.run(id, req.params.guildId, b.channel_id || null, req.user.id, b.name, b.description || null, b.image || null, b.scheduled_start_time, b.scheduled_end_time || null, b.entity_type, b.entity_metadata || null, 1, nowSec());
    const ev = getEvent.get(id);
    io?.to(`guild:${req.params.guildId}`)?.emit('scheduled_event:create', ev);
    return reply.code(201).send(ev);
  });

  // GET /api/guilds/:guildId/scheduled-events/:eventId
  fastify.get('/api/guilds/:guildId/scheduled-events/:eventId', { preHandler: authenticate }, async (req, reply) => {
    const ev = authorizeEvent(req, reply);
    if (!ev) return;
    return { ...withEventViewer(ev, req.user.id), user_count: countEventUsers.get(ev.id)?.c || 0 };
  });

  // PATCH /api/guilds/:guildId/scheduled-events/:eventId
  fastify.patch('/api/guilds/:guildId/scheduled-events/:eventId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: ['string', 'null'] },
          scheduled_start_time: { type: 'integer' },
          scheduled_end_time: { type: ['integer', 'null'] },
          status: { type: 'integer', minimum: 1, maximum: 4 },
          channel_id: { type: ['string', 'null'] },
          image: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const ev = authorizeEvent(req, reply, true);
    if (!ev) return;
    const b = req.body;
    if (b.channel_id) {
      const channel = getChannelById.get(b.channel_id);
      if (!channel || channel.guild_id !== req.params.guildId) return reply.code(400).send({ error: 'Channel must be in the same guild' });
    }
    updateEventStmt.run(b.name || null, b.description ?? null, b.scheduled_start_time || null, b.scheduled_end_time ?? null, b.status || null, b.channel_id ?? null, b.image ?? null, req.params.eventId);
    const updatedEvent = getEvent.get(req.params.eventId);
    io?.to(`guild:${req.params.guildId}`)?.emit('scheduled_event:update', updatedEvent);
    return updatedEvent;
  });

  // DELETE /api/guilds/:guildId/scheduled-events/:eventId
  fastify.delete('/api/guilds/:guildId/scheduled-events/:eventId', { preHandler: authenticate }, async (req, reply) => {
    const ev = authorizeEvent(req, reply, true);
    if (!ev) return;
    deleteEventStmt.run(ev.id);
    io?.to(`guild:${req.params.guildId}`)?.emit('scheduled_event:delete', { id: req.params.eventId, guild_id: req.params.guildId });
    return { ok: true };
  });

  // GET /api/guilds/:guildId/scheduled-events/:eventId/users
  fastify.get('/api/guilds/:guildId/scheduled-events/:eventId/users', { preHandler: authenticate }, async (req, reply) => {
    if (!authorizeEvent(req, reply)) return;
    return listEventUsers.all(req.params.eventId);
  });

  // PUT /api/guilds/:guildId/scheduled-events/:eventId/users/@me — RSVP
  fastify.put('/api/guilds/:guildId/scheduled-events/:eventId/users/@me', { preHandler: authenticate }, async (req, reply) => {
    const ev = authorizeEvent(req, reply);
    if (!ev) return;
    insertEventUser.run(ev.id, req.user.id);
    io?.to(`guild:${ev.guild_id}`)?.emit('scheduled_event:update', { ...ev, user_count: countEventUsers.get(ev.id)?.c || 0 });
    return { ok: true, user_count: countEventUsers.get(ev.id)?.c || 0 };
  });

  // DELETE /api/guilds/:guildId/scheduled-events/:eventId/users/@me
  fastify.delete('/api/guilds/:guildId/scheduled-events/:eventId/users/@me', { preHandler: authenticate }, async (req, reply) => {
    const ev = authorizeEvent(req, reply);
    if (!ev) return;
    deleteEventUser.run(ev.id, req.user.id);
    io?.to(`guild:${ev.guild_id}`)?.emit('scheduled_event:update', { ...ev, user_count: countEventUsers.get(ev.id)?.c || 0, me: false });
    return { ok: true, user_count: countEventUsers.get(ev.id)?.c || 0 };
  });

  // ═══════════════════════════════════════════════════════
  // STICKERS
  // ═══════════════════════════════════════════════════════

  const listStickers = db.prepare('SELECT * FROM stickers WHERE guild_id = ? AND available = 1 ORDER BY sort_value, name');
  const getSticker = db.prepare('SELECT * FROM stickers WHERE id = ?');
  const insertSticker = db.prepare(`
    INSERT INTO stickers (id, guild_id, name, description, tags, type, format_type, creator_id, sort_value, created_at)
    VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
  `);
  const updateStickerStmt = db.prepare(`
    UPDATE stickers SET name = COALESCE(?, name), description = COALESCE(?, description), tags = COALESCE(?, tags)
    WHERE id = ?
  `);
  const deleteStickerStmt = db.prepare('DELETE FROM stickers WHERE id = ?');

  fastify.get('/api/guilds/:guildId/stickers', { preHandler: authenticate }, async (req, reply) => {
    if (!requireGuildView(req.params.guildId, req.user.id, reply)) return;
    return listStickers.all(req.params.guildId);
  });

  fastify.post('/api/guilds/:guildId/stickers', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 30 },
          description: { type: ['string', 'null'], maxLength: 100 },
          tags: { type: ['string', 'null'], maxLength: 200 },
          format_type: { type: 'integer', minimum: 1, maximum: 4 },
          file: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    const id = snowflake.generate();
    const b = req.body;
    insertSticker.run(id, req.params.guildId, b.name, b.description || null, b.tags || null, b.format_type || 1, req.user.id, 0, nowSec());
    const sticker = getSticker.get(id);
    io?.to(`guild:${req.params.guildId}`)?.emit('guild:stickers_update', { guild_id: req.params.guildId, stickers: listStickers.all(req.params.guildId) });
    return reply.code(201).send(sticker);
  });

  fastify.patch('/api/guilds/:guildId/stickers/:stickerId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 30 },
          description: { type: ['string', 'null'] },
          tags: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const sticker = getSticker.get(req.params.stickerId);
    if (!sticker || sticker.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Sticker not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    updateStickerStmt.run(req.body.name || null, req.body.description ?? null, req.body.tags ?? null, sticker.id);
    return getSticker.get(sticker.id);
  });

  fastify.delete('/api/guilds/:guildId/stickers/:stickerId', { preHandler: authenticate }, async (req, reply) => {
    const sticker = getSticker.get(req.params.stickerId);
    if (!sticker || sticker.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Sticker not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_EXPRESSIONS, reply, 'Missing MANAGE_EXPRESSIONS permission')) return;
    deleteStickerStmt.run(sticker.id);
    io?.to(`guild:${req.params.guildId}`)?.emit('guild:stickers_update', { guild_id: req.params.guildId, stickers: listStickers.all(req.params.guildId) });
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════
  // AUTOMOD (full CRUD — phase4Core only had create)
  // ═══════════════════════════════════════════════════════

  const listAutomodRules = db.prepare('SELECT * FROM automod_rules WHERE guild_id = ?');
  const getAutomodRule = db.prepare('SELECT * FROM automod_rules WHERE id = ?');
  const updateAutomodRuleStmt = db.prepare(`
    UPDATE automod_rules SET name = COALESCE(?, name), trigger_metadata = COALESCE(?, trigger_metadata),
      actions = COALESCE(?, actions), enabled = COALESCE(?, enabled),
      exempt_roles = COALESCE(?, exempt_roles), exempt_channels = COALESCE(?, exempt_channels)
    WHERE id = ?
  `);
  const deleteAutomodRuleStmt = db.prepare('DELETE FROM automod_rules WHERE id = ?');

  fastify.get('/api/guilds/:guildId/auto-moderation/rules', { preHandler: authenticate }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_GUILD, reply, 'Missing MANAGE_GUILD permission')) return;
    return listAutomodRules.all(req.params.guildId);
  });

  fastify.post('/api/guilds/:guildId/auto-moderation/rules', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'event_type', 'trigger_type', 'actions'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          event_type: { type: 'integer' },
          trigger_type: { type: 'integer' },
          trigger_metadata: {},
          actions: { type: 'array' },
          enabled: { type: 'boolean' },
          exempt_roles: { type: 'array' },
          exempt_channels: { type: 'array' },
        },
      },
    },
  }, async (req, reply) => {
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_GUILD, reply, 'Missing MANAGE_GUILD permission')) return;
    const id = snowflake.generate();
    const b = req.body;
    db.prepare(`
      INSERT INTO automod_rules (id, guild_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, enabled, exempt_roles, exempt_channels, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.guildId, b.name, req.user.id, b.event_type, b.trigger_type,
      JSON.stringify(b.trigger_metadata || {}), JSON.stringify(b.actions), b.enabled !== false ? 1 : 0,
      JSON.stringify(b.exempt_roles || []), JSON.stringify(b.exempt_channels || []), nowSec());
    return reply.code(201).send(getAutomodRule.get(id));
  });

  fastify.patch('/api/guilds/:guildId/auto-moderation/rules/:ruleId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          trigger_metadata: {},
          actions: { type: 'array' },
          enabled: { type: 'boolean' },
          exempt_roles: { type: 'array' },
          exempt_channels: { type: 'array' },
        },
      },
    },
  }, async (req, reply) => {
    const rule = getAutomodRule.get(req.params.ruleId);
    if (!rule || rule.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Rule not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_GUILD, reply, 'Missing MANAGE_GUILD permission')) return;
    const b = req.body;
    updateAutomodRuleStmt.run(
      b.name || null,
      b.trigger_metadata ? JSON.stringify(b.trigger_metadata) : null,
      b.actions ? JSON.stringify(b.actions) : null,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : null,
      b.exempt_roles ? JSON.stringify(b.exempt_roles) : null,
      b.exempt_channels ? JSON.stringify(b.exempt_channels) : null,
       rule.id
    );
    return getAutomodRule.get(req.params.ruleId) || reply.code(404).send({ error: 'Rule not found' });
  });

  fastify.delete('/api/guilds/:guildId/auto-moderation/rules/:ruleId', { preHandler: authenticate }, async (req, reply) => {
    const rule = getAutomodRule.get(req.params.ruleId);
    if (!rule || rule.guild_id !== req.params.guildId) return reply.code(404).send({ error: 'Rule not found' });
    if (!requireGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_GUILD, reply, 'Missing MANAGE_GUILD permission')) return;
    deleteAutomodRuleStmt.run(rule.id);
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════
  // ONBOARDING
  // ═══════════════════════════════════════════════════════

  const getOnboarding = db.prepare('SELECT * FROM guild_onboarding WHERE guild_id = ?');
  const upsertOnboarding = db.prepare(`
    INSERT INTO guild_onboarding (guild_id, enabled, default_channel_ids, prompts, mode)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, default_channel_ids = excluded.default_channel_ids, prompts = excluded.prompts, mode = excluded.mode
  `);

  fastify.get('/api/guilds/:guildId/onboarding', { preHandler: authenticate }, async (req) => {
    const row = getOnboarding.get(req.params.guildId);
    if (!row) return { guild_id: req.params.guildId, enabled: false, default_channel_ids: [], prompts: [], mode: 0 };
    return {
      ...row,
      default_channel_ids: JSON.parse(row.default_channel_ids || '[]'),
      prompts: JSON.parse(row.prompts || '[]'),
    };
  });

  fastify.put('/api/guilds/:guildId/onboarding', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          default_channel_ids: { type: 'array' },
          prompts: { type: 'array' },
          mode: { type: 'integer', minimum: 0, maximum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    if (!permissions.hasGuildPermission(req.params.guildId, req.user.id, Permissions.MANAGE_GUILD)) {
      return reply.code(403).send({ error: 'Missing MANAGE_GUILD permission' });
    }
    const b = req.body;
    upsertOnboarding.run(
      req.params.guildId,
      b.enabled ? 1 : 0,
      JSON.stringify(b.default_channel_ids || []),
      JSON.stringify(b.prompts || []),
      b.mode ?? 0
    );
    return { ok: true };
  });
}
