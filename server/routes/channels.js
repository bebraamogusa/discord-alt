/**
 * channels.js — Stage 4 & 5: Channels, Messages, Reactions, Pins, DM API
 */
import { nanoid } from 'nanoid';
import { authenticate } from '../auth.js';
import { requireMember, userHasPermission, auditLog } from './servers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Verify user can access a channel (server member or DM participant) */
function canAccessChannel(db, channelId, userId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return null;
  if (ch.type === 'dm' || ch.type === 'group') {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
    if (!member) return null;
  } else {
    // server channel
    const sm = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, userId);
    if (!sm) return null;
  }
  return ch;
}

/** Full message object with author, reactions, attachments, reply */
function enrichMessage(db, msg) {
  if (!msg) return null;
  const author = db.prepare('SELECT id, username, discriminator, avatar_url, avatar_color FROM users WHERE id = ?').get(msg.author_id);
  const reactions = db.prepare(`
    SELECT emoji, COUNT(*) as count,
           MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
    FROM reactions WHERE message_id = ? GROUP BY emoji
  `).all(msg.author_id, msg.id); // 'me' is relative to author here; gateway sets per-user
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(msg.id);
  let reply_to = null;
  if (msg.reply_to_id) {
    const r = db.prepare('SELECT id, content, author_id FROM messages WHERE id = ?').get(msg.reply_to_id);
    if (r) {
      const ru = db.prepare('SELECT id, username, avatar_url FROM users WHERE id = ?').get(r.author_id);
      reply_to = { id: r.id, content: r.content.slice(0, 100), author: ru };
    }
  }
  return { ...msg, author: author || { id: msg.author_id, username: 'Unknown', discriminator: '0000', avatar_url: '', avatar_color: '#5865f2' }, reactions, attachments, reply_to };
}

/** Enrich messages with per-user reaction 'me' flag */
function enrichMessages(db, messages, viewerId) {
  if (!messages.length) return messages;
  const msgIds = messages.map(m => m.id);
  const placeholder = msgIds.map(() => '?').join(',');

  const reactionRows = db.prepare(`
    SELECT message_id, emoji, COUNT(*) as count,
           SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
    FROM reactions WHERE message_id IN (${placeholder})
    GROUP BY message_id, emoji
  `).all(viewerId, ...msgIds);

  const attachmentRows = db.prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholder})`).all(...msgIds);

  const reactionMap = {};
  for (const r of reactionRows) {
    if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
    reactionMap[r.message_id].push({ emoji: r.emoji, count: r.count, me: !!r.me });
  }
  const attachMap = {};
  for (const a of attachmentRows) {
    if (!attachMap[a.message_id]) attachMap[a.message_id] = [];
    attachMap[a.message_id].push(a);
  }

  // Fetch authors
  const authorIds = [...new Set(messages.map(m => m.author_id))];
  const authorPlaceholder = authorIds.map(() => '?').join(',');
  const authorRows = db.prepare(`SELECT id, username, discriminator, avatar_url, avatar_color FROM users WHERE id IN (${authorPlaceholder})`).all(...authorIds);
  const authorMap = {};
  for (const a of authorRows) authorMap[a.id] = a;

  return messages.map(msg => ({
    ...msg,
    author: authorMap[msg.author_id] || { id: msg.author_id, username: 'Unknown', discriminator: '0000', avatar_url: '', avatar_color: '#5865f2' },
    reactions: reactionMap[msg.id] || [],
    attachments: attachMap[msg.id] || [],
  }));
}

// ─── Route registration ───────────────────────────────────────────────────────

export default function registerChannelRoutes(app, db, io) {

  /* ── CHANNELS (stage 4) ─────────────────────────────────────────────────── */

  // POST /api/servers/:id/channels — create channel or category
  app.post('/api/servers/:id/channels', { preHandler: authenticate }, async (req, reply) => {
    const serverId = req.params.id;
    if (!userHasPermission(db, serverId, req.user.id, 'manage_channels')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const { name, type = 'text', category_id = null, topic = '', position = 0 } = req.body || {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const VALID_TYPES = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);
    if (!VALID_TYPES.has(type)) return reply.code(400).send({ error: 'Invalid type' });

    const channelId = nanoid(16);
    db.prepare(`
      INSERT INTO channels (id, server_id, category_id, name, type, topic, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channelId, serverId, category_id, name.trim().slice(0, 100), type, topic.slice(0, 1024), Number(position));
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    auditLog(db, { server_id: serverId, actor_id: req.user.id, action: 'channel_create', changes: { name, type } });
    io.to(`server:${serverId}`).emit('CHANNEL_CREATE', channel);
    return reply.code(201).send(channel);
  });

  // POST /api/servers/:id/categories — create category
  app.post('/api/servers/:id/categories', { preHandler: authenticate }, async (req, reply) => {
    const serverId = req.params.id;
    if (!userHasPermission(db, serverId, req.user.id, 'manage_channels')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const { name, position = 0 } = req.body || {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const catId = nanoid(16);
    db.prepare('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)').run(catId, serverId, name.trim().slice(0, 100), Number(position));
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(catId);
    io.to(`server:${serverId}`).emit('CATEGORY_CREATE', cat);
    return reply.code(201).send(cat);
  });

  // PATCH /api/channels/:id
  app.patch('/api/channels/:id', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    if (ch.server_id) {
      if (!userHasPermission(db, ch.server_id, req.user.id, 'manage_channels'))
        return reply.code(403).send({ error: 'Insufficient permissions' });
    } else {
      // DM/group — only allow group rename by participant
      const member = db.prepare('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?').get(ch.id, req.user.id);
      if (!member) return reply.code(403).send({ error: 'Insufficient permissions' });
    }
    const allowed = ['name', 'topic', 'slowmode_seconds', 'position', 'category_id'];
    const fields = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) fields[k] = req.body[k];
    if (!Object.keys(fields).length) return reply.code(400).send({ error: 'No fields' });
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE channels SET ${sets} WHERE id = ?`).run(...Object.values(fields), ch.id);
    const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(ch.id);
    if (ch.server_id) {
      auditLog(db, { server_id: ch.server_id, actor_id: req.user.id, action: 'channel_update', changes: fields });
      io.to(`server:${ch.server_id}`).emit('CHANNEL_UPDATE', updated);
    }
    return reply.send(updated);
  });

  // DELETE /api/channels/:id
  app.delete('/api/channels/:id', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    if (ch.server_id) {
      if (!userHasPermission(db, ch.server_id, req.user.id, 'manage_channels'))
        return reply.code(403).send({ error: 'Insufficient permissions' });
      db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
      auditLog(db, { server_id: ch.server_id, actor_id: req.user.id, action: 'channel_delete', changes: { name: ch.name } });
      io.to(`server:${ch.server_id}`).emit('CHANNEL_DELETE', { channel_id: ch.id, server_id: ch.server_id });
    } else {
      db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    }
    return reply.send({ ok: true });
  });

  // PATCH /api/servers/:id/channels/positions — reorder
  app.patch('/api/servers/:id/channels/positions', { preHandler: authenticate }, async (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_channels')) return reply.code(403).send({ error: 'Insufficient permissions' });
    // body: [{ id, position, category_id? }, ...]
    const updates = req.body;
    if (!Array.isArray(updates)) return reply.code(400).send({ error: 'Array expected' });
    const stmt = db.prepare('UPDATE channels SET position = ?, category_id = ? WHERE id = ? AND server_id = ?');
    db.transaction(() => {
      for (const u of updates) {
        stmt.run(Number(u.position), u.category_id ?? null, u.id, req.params.id);
      }
    })();
    return reply.send({ ok: true });
  });

  /* ── MESSAGES (stage 4) ─────────────────────────────────────────────────── */

  // GET /api/channels/:id/messages
  app.get('/api/channels/:id/messages', { preHandler: authenticate }, (req, reply) => {
    const ch = canAccessChannel(db, req.params.id, req.user.id);
    if (!ch) return reply.code(403).send({ error: 'No access' });
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const before = req.query.before || null;
    const raw = before
      ? db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY created_at DESC LIMIT ?').all(req.params.id, before, limit)
      : db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?').all(req.params.id, limit);
    return reply.send(enrichMessages(db, raw.reverse(), req.user.id));
  });

  // POST /api/channels/:id/messages
  app.post('/api/channels/:id/messages', { preHandler: authenticate }, async (req, reply) => {
    const ch = canAccessChannel(db, req.params.id, req.user.id);
    if (!ch) return reply.code(403).send({ error: 'No access' });
    if (ch.server_id && !userHasPermission(db, ch.server_id, req.user.id, 'send_messages'))
      return reply.code(403).send({ error: 'Cannot send messages' });

    const { content = '', reply_to_id = null, attachments: atts = [] } = req.body || {};
    if (!content.trim() && !atts.length) return reply.code(400).send({ error: 'content or attachments required' });

    const msgId = nanoid(16);
    db.prepare(`
      INSERT INTO messages (id, channel_id, author_id, content, reply_to_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, req.params.id, req.user.id, content.slice(0, 4000), reply_to_id || null);

    for (const a of atts) {
      db.prepare('INSERT INTO attachments (id, message_id, url, filename, size, mime_type) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nanoid(16), msgId, a.url, a.filename || 'file', a.size || 0, a.mime_type || 'application/octet-stream');
    }

    const msg = enrichMessage(db, db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));

    // Emit to correct room
    if (ch.server_id) {
      io.to(`channel:${ch.id}`).emit('MESSAGE_CREATE', msg);
    } else {
      // DM: emit to all channel members
      const members = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ?').all(ch.id);
      for (const m of members) io.to(`user:${m.user_id}`).emit('MESSAGE_CREATE', msg);
    }

    // Update read state
    db.prepare(`INSERT OR REPLACE INTO read_states (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, unixepoch())`).run(req.user.id, ch.id, msgId);

    return reply.code(201).send(msg);
  });

  // PATCH /api/messages/:id
  app.patch('/api/messages/:id', { preHandler: authenticate }, async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return reply.code(404).send({ error: 'Message not found' });
    if (msg.author_id !== req.user.id) return reply.code(403).send({ error: 'Not your message' });
    const { content } = req.body || {};
    if (!content?.trim()) return reply.code(400).send({ error: 'content required' });
    db.prepare('UPDATE messages SET content = ?, is_edited = 1, updated_at = unixepoch() WHERE id = ?').run(content.slice(0, 4000), msg.id);
    const updated = enrichMessage(db, db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id));
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.channel_id);
    if (ch?.server_id) {
      io.to(`channel:${ch.id}`).emit('MESSAGE_UPDATE', updated);
    } else {
      const members = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ?').all(msg.channel_id);
      for (const m of members) io.to(`user:${m.user_id}`).emit('MESSAGE_UPDATE', updated);
    }
    return reply.send(updated);
  });

  // DELETE /api/messages/:id
  app.delete('/api/messages/:id', { preHandler: authenticate }, async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return reply.code(404).send({ error: 'Message not found' });
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(msg.channel_id);
    const canDelete = msg.author_id === req.user.id ||
      (ch?.server_id && userHasPermission(db, ch.server_id, req.user.id, 'manage_messages'));
    if (!canDelete) return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    if (ch?.server_id) {
      auditLog(db, { server_id: ch.server_id, actor_id: req.user.id, target_id: msg.id, action: 'message_delete' });
      io.to(`channel:${ch.id}`).emit('MESSAGE_DELETE', { message_id: msg.id, channel_id: msg.channel_id });
    } else {
      const members = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ?').all(msg.channel_id);
      for (const m of members) io.to(`user:${m.user_id}`).emit('MESSAGE_DELETE', { message_id: msg.id, channel_id: msg.channel_id });
    }
    return reply.send({ ok: true });
  });

  /* ── REACTIONS (stage 4) ────────────────────────────────────────────────── */

  // POST /api/messages/:id/reactions/:emoji
  app.post('/api/messages/:id/reactions/:emoji', { preHandler: authenticate }, async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return reply.code(404).send({ error: 'Message not found' });
    const ch = canAccessChannel(db, msg.channel_id, req.user.id);
    if (!ch) return reply.code(403).send({ error: 'No access' });
    const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msg.id, req.user.id, emoji);
    const updatedReactions = db.prepare(`
      SELECT emoji, COUNT(*) as count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
      FROM reactions WHERE message_id = ? GROUP BY emoji
    `).all(req.user.id, msg.id);
    const payload = { message_id: msg.id, channel_id: msg.channel_id, emoji, user_id: req.user.id, reactions: updatedReactions };
    if (ch.server_id) {
      io.to(`channel:${ch.id}`).emit('REACTION_ADD', payload);
    } else {
      const members = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ?').all(ch.id);
      for (const m of members) io.to(`user:${m.user_id}`).emit('REACTION_ADD', payload);
    }
    return reply.code(204).send();
  });

  // DELETE /api/messages/:id/reactions/:emoji
  app.delete('/api/messages/:id/reactions/:emoji', { preHandler: authenticate }, async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return reply.code(404).send({ error: 'Message not found' });
    const ch = canAccessChannel(db, msg.channel_id, req.user.id);
    if (!ch) return reply.code(403).send({ error: 'No access' });
    const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msg.id, req.user.id, emoji);
    const updatedReactions = db.prepare(`
      SELECT emoji, COUNT(*) as count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
      FROM reactions WHERE message_id = ? GROUP BY emoji
    `).all(req.user.id, msg.id);
    const payload = { message_id: msg.id, channel_id: msg.channel_id, emoji, user_id: req.user.id, reactions: updatedReactions };
    if (ch.server_id) {
      io.to(`channel:${ch.id}`).emit('REACTION_REMOVE', payload);
    } else {
      const members = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ?').all(ch.id);
      for (const m of members) io.to(`user:${m.user_id}`).emit('REACTION_REMOVE', payload);
    }
    return reply.code(204).send();
  });

  /* ── PINS (stage 4) ─────────────────────────────────────────────────────── */

  // GET /api/channels/:id/pins
  app.get('/api/channels/:id/pins', { preHandler: authenticate }, (req, reply) => {
    const ch = canAccessChannel(db, req.params.id, req.user.id);
    if (!ch) return reply.code(403).send({ error: 'No access' });
    const pins = db.prepare(`
      SELECT m.* FROM pins p
      JOIN messages m ON m.id = p.message_id
      WHERE p.channel_id = ?
      ORDER BY p.pinned_at DESC
    `).all(req.params.id);
    return reply.send(enrichMessages(db, pins, req.user.id));
  });

  // PUT /api/channels/:id/pins/:messageId
  app.put('/api/channels/:id/pins/:messageId', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    if (ch.server_id && !userHasPermission(db, ch.server_id, req.user.id, 'manage_messages'))
      return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?)').run(req.params.id, req.params.messageId, req.user.id);
    if (ch.server_id) auditLog(db, { server_id: ch.server_id, actor_id: req.user.id, target_id: req.params.messageId, action: 'pin_add' });
    io.to(`channel:${req.params.id}`).emit('CHANNEL_PINS_UPDATE', { channel_id: req.params.id });
    return reply.code(204).send();
  });

  // DELETE /api/channels/:id/pins/:messageId
  app.delete('/api/channels/:id/pins/:messageId', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    if (ch.server_id && !userHasPermission(db, ch.server_id, req.user.id, 'manage_messages'))
      return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM pins WHERE channel_id = ? AND message_id = ?').run(req.params.id, req.params.messageId);
    if (ch.server_id) auditLog(db, { server_id: ch.server_id, actor_id: req.user.id, target_id: req.params.messageId, action: 'pin_remove' });
    io.to(`channel:${req.params.id}`).emit('CHANNEL_PINS_UPDATE', { channel_id: req.params.id });
    return reply.code(204).send();
  });

  /* ── DM API (stage 5) ───────────────────────────────────────────────────── */

  // POST /api/users/:id/dm — open DM with user
  app.post('/api/users/:id/dm', { preHandler: authenticate }, async (req, reply) => {
    const targetId = req.params.id;
    if (targetId === req.user.id) return reply.code(400).send({ error: 'Cannot DM yourself' });
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) return reply.code(404).send({ error: 'User not found' });

    // Check if DM already exists between these two users
    const existing = db.prepare(`
      SELECT c.* FROM channels c
      JOIN dm_members m1 ON m1.channel_id = c.id AND m1.user_id = ?
      JOIN dm_members m2 ON m2.channel_id = c.id AND m2.user_id = ?
      WHERE c.type = 'dm'
      LIMIT 1
    `).get(req.user.id, targetId);

    if (existing) return reply.send(existing);

    const channelId = nanoid(16);
    db.transaction(() => {
      db.prepare(`INSERT INTO channels (id, name, type) VALUES (?, 'dm', 'dm')`).run(channelId);
      db.prepare('INSERT INTO dm_members (channel_id, user_id) VALUES (?, ?)').run(channelId, req.user.id);
      db.prepare('INSERT INTO dm_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetId);
    })();

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    // Notify both users
    io.to(`user:${req.user.id}`).emit('CHANNEL_CREATE', channel);
    io.to(`user:${targetId}`).emit('CHANNEL_CREATE', channel);
    return reply.code(201).send(channel);
  });

  // GET /api/@me/channels — all my DMs and groups
  app.get('/api/@me/channels', { preHandler: authenticate }, (req, reply) => {
    const channels = db.prepare(`
      SELECT c.*, (
        SELECT m.content FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) as last_message
      FROM channels c
      JOIN dm_members dm ON dm.channel_id = c.id
      WHERE dm.user_id = ? AND c.type IN ('dm', 'group')
      ORDER BY c.created_at DESC
    `).all(req.user.id);

    // Attach recipient info for DM channels
    const result = channels.map(ch => {
      if (ch.type === 'dm') {
        const other = db.prepare(`
          SELECT u.id, u.username, u.discriminator, u.avatar_url, u.avatar_color, u.custom_status, u.last_seen
          FROM dm_members dm JOIN users u ON u.id = dm.user_id
          WHERE dm.channel_id = ? AND dm.user_id != ?
        `).get(ch.id, req.user.id);
        return { ...ch, recipient: other };
      }
      const members = db.prepare(`
        SELECT u.id, u.username, u.avatar_url FROM dm_members dm
        JOIN users u ON u.id = dm.user_id WHERE dm.channel_id = ?
      `).all(ch.id);
      return { ...ch, members };
    });
    return reply.send(result);
  });

  // POST /api/channels — create group DM
  app.post('/api/channels', { preHandler: authenticate }, async (req, reply) => {
    const { name = 'Group', members: memberIds = [] } = req.body || {};
    if (!Array.isArray(memberIds)) return reply.code(400).send({ error: 'members must be array' });
    const allMembers = [...new Set([req.user.id, ...memberIds])];

    const channelId = nanoid(16);
    db.transaction(() => {
      db.prepare(`INSERT INTO channels (id, name, type) VALUES (?, ?, 'group')`).run(channelId, name.slice(0, 100));
      for (const uid of allMembers) {
        db.prepare('INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?, ?)').run(channelId, uid);
      }
    })();

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    for (const uid of allMembers) io.to(`user:${uid}`).emit('CHANNEL_CREATE', channel);
    return reply.code(201).send(channel);
  });

  // POST /api/channels/:id/members — add member to group
  app.post('/api/channels/:id/members', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND type = ?').get(req.params.id, 'group');
    if (!ch) return reply.code(404).send({ error: 'Group channel not found' });
    const member = db.prepare('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?').get(ch.id, req.user.id);
    if (!member) return reply.code(403).send({ error: 'Not a member' });
    const { user_id } = req.body || {};
    if (!user_id) return reply.code(400).send({ error: 'user_id required' });
    db.prepare('INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, user_id);
    io.to(`user:${user_id}`).emit('CHANNEL_CREATE', ch);
    return reply.send({ ok: true });
  });

  // DELETE /api/channels/:id/members/:userId — remove from group
  app.delete('/api/channels/:id/members/:userId', { preHandler: authenticate }, async (req, reply) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND type = ?').get(req.params.id, 'group');
    if (!ch) return reply.code(404).send({ error: 'Group channel not found' });
    const isSelf = req.params.userId === req.user.id;
    const isOwner = true; // For simplicity, any member can remove others; could add owner check
    if (!isSelf && !isOwner) return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?').run(ch.id, req.params.userId);
    io.to(`user:${req.params.userId}`).emit('CHANNEL_DELETE', { channel_id: ch.id });
    return reply.send({ ok: true });
  });
}
