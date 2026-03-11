/**
 * gateway.js — Stage 6: Socket.IO v2 Gateway
 *
 * Events (Client → Server):
 *   IDENTIFY           { token }
 *   SUBSCRIBE_SERVER   { server_id }
 *   TYPING_START       { channel_id }
 *   UPDATE_STATUS      { status, custom_status }
 *   READ_ACK           { channel_id, message_id }
 *
 * Events (Server → Client):
 *   READY              { user, servers[], dm_channels[], presences{} }
 *   MESSAGE_CREATE     { message }
 *   MESSAGE_UPDATE     { message }
 *   MESSAGE_DELETE     { message_id, channel_id }
 *   REACTION_ADD       { message_id, ... }
 *   REACTION_REMOVE    { message_id, ... }
 *   TYPING_START       { channel_id, user_id, username }
 *   PRESENCE_UPDATE    { user_id, status, custom_status }
 *   MEMBER_JOIN        { server_id, member }
 *   MEMBER_LEAVE       { server_id, user_id }
 *   CHANNEL_CREATE     { channel }
 *   CHANNEL_UPDATE     { channel }
 *   CHANNEL_DELETE     { channel_id }
 *   SERVER_UPDATE      { server }
 *   SERVER_DELETE      { server_id }
 */

import jwt from 'jsonwebtoken';

// In-memory presence: userId → { status, custom_status, socket_count }
const presence = new Map();

// In-memory voice states: channelId → Map<userId, participant>
const voiceStates = new Map();

function getVoiceList(channelId) {
  if (!voiceStates.has(channelId)) return [];
  return [...voiceStates.get(channelId).values()];
}

// Build { server_id → [ voiceState, ... ] } for all servers
function buildVoiceStatesPayload(db, userId) {
  const out = {};
  const serverRows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId);
  for (const { server_id } of serverRows) {
    const chans = db.prepare("SELECT id FROM channels WHERE server_id = ? AND type = 'voice'").all(server_id);
    for (const { id } of chans) {
      if (voiceStates.has(id) && voiceStates.get(id).size > 0) {
        out[id] = getVoiceList(id);
      }
    }
  }
  return out;
}

function getSecret() {
  return process.env.JWT_SECRET;
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

function buildReadyPayload(db, userId) {
  // All servers the user belongs to with channels + categories + roles
  const serverRows = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ?
    ORDER BY sm.joined_at ASC
  `).all(userId);

  const servers = serverRows.map(s => {
    const channels   = db.prepare('SELECT * FROM channels   WHERE server_id = ? ORDER BY position ASC').all(s.id);
    const categories = db.prepare('SELECT * FROM categories WHERE server_id = ? ORDER BY position ASC').all(s.id);
    const roles      = db.prepare('SELECT * FROM roles      WHERE server_id = ? ORDER BY position DESC').all(s.id);
    const myRoles    = db.prepare('SELECT role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.server_id = ?').all(userId, s.id).map(r => r.role_id);
    return { ...s, channels, categories, roles, my_roles: myRoles };
  });

  // DM / group channels
  const dmChannels = db.prepare(`
    SELECT c.* FROM channels c
    JOIN dm_members dm ON dm.channel_id = c.id
    WHERE dm.user_id = ? AND c.type IN ('dm', 'group')
    ORDER BY c.created_at DESC
  `).all(userId).map(ch => {
    if (ch.type === 'dm') {
      const other = db.prepare(`
        SELECT u.id, u.username, u.discriminator, u.avatar_url, u.avatar_color, u.custom_status
        FROM dm_members dm JOIN users u ON u.id = dm.user_id
        WHERE dm.channel_id = ? AND dm.user_id != ?
      `).get(ch.id, userId);
      return { ...ch, recipient: other };
    }
    const members = db.prepare(`
      SELECT u.id, u.username, u.avatar_url FROM dm_members dm
      JOIN users u ON u.id = dm.user_id WHERE dm.channel_id = ?
    `).all(ch.id);
    return { ...ch, members };
  });

  // Collect all unique member IDs to build presence map
  const pMap = {};
  for (const [uid, info] of presence) {
    pMap[uid] = { status: info.status, custom_status: info.custom_status };
  }

  return { servers, dm_channels: dmChannels, presences: pMap };
}

export function setupGateway(io, db) {

  // ── Namespace: /gateway ──────────────────────────────────────────────────────
  const gw = io.of('/gateway');

  gw.on('connection', (socket) => {
    let userId = null;
    let username = null;

    // ── IDENTIFY ──────────────────────────────────────────────────────────────
    socket.on('IDENTIFY', ({ token } = {}) => {
      if (!token) { socket.emit('ERROR', { code: 4001, message: 'Token required' }); return; }
      const payload = verifyToken(token);
      if (!payload) { socket.emit('ERROR', { code: 4002, message: 'Invalid token' }); return; }

      userId   = payload.id;
      username = payload.username;

      socket.join(`user:${userId}`);

      // Update presence
      const prev = presence.get(userId);
      if (prev) {
        prev.socket_count++;
      } else {
        presence.set(userId, { status: 'online', custom_status: '', socket_count: 1 });
      }

      // Join all server rooms
      const serverRows = db.prepare(`
        SELECT server_id FROM server_members WHERE user_id = ?
      `).all(userId);
      for (const { server_id } of serverRows) {
        socket.join(`server:${server_id}`);
      }

      // Subscribe to channels of those servers
      const channelRows = db.prepare(`
        SELECT c.id FROM channels c
        JOIN server_members sm ON sm.server_id = c.server_id
        WHERE sm.user_id = ?
      `).all(userId);
      for (const { id } of channelRows) {
        socket.join(`channel:${id}`);
      }

      // Subscribe to DM channels
      const dmRows = db.prepare(`SELECT channel_id FROM dm_members WHERE user_id = ?`).all(userId);
      for (const { channel_id } of dmRows) {
        socket.join(`channel:${channel_id}`);
      }

      // Update last_seen in DB
      db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(userId);

      // Send READY
      const user = db.prepare('SELECT id, username, discriminator, avatar_url, avatar_color, banner_url, banner_color, about_me, custom_status, last_seen FROM users WHERE id = ?').get(userId);
      socket.emit('READY', { user, ...buildReadyPayload(db, userId), voice_states: buildVoiceStatesPayload(db, userId) });

      // Broadcast online presence to members of same servers
      broadcastPresence(userId, 'online');
    });

    // ── SUBSCRIBE_SERVER ──────────────────────────────────────────────────────
    socket.on('SUBSCRIBE_SERVER', ({ server_id } = {}) => {
      if (!userId) return;
      const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server_id, userId);
      if (!member) return;
      socket.join(`server:${server_id}`);
      // also join all channels of that server
      const channels = db.prepare('SELECT id FROM channels WHERE server_id = ?').all(server_id);
      for (const { id } of channels) socket.join(`channel:${id}`);
    });

    // ── TYPING_START ──────────────────────────────────────────────────────────
    socket.on('TYPING_START', ({ channel_id } = {}) => {
      if (!userId || !channel_id) return;
      socket.to(`channel:${channel_id}`).emit('TYPING_START', {
        channel_id,
        user_id: userId,
        username,
      });
    });

    // ── UPDATE_STATUS ─────────────────────────────────────────────────────────
    socket.on('UPDATE_STATUS', ({ status, custom_status } = {}) => {
      if (!userId) return;
      const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
      const newStatus = VALID_STATUSES.has(status) ? status : 'online';
      const cs = typeof custom_status === 'string' ? custom_status.slice(0, 128) : '';

      const info = presence.get(userId);
      if (info) {
        info.status = newStatus;
        info.custom_status = cs;
      }

      db.prepare("UPDATE users SET custom_status = ? WHERE id = ?").run(cs, userId);

      broadcastPresence(userId, newStatus === 'invisible' ? 'offline' : newStatus, cs);
    });

    // ── READ_ACK ──────────────────────────────────────────────────────────────
    socket.on('READ_ACK', ({ channel_id, message_id } = {}) => {
      if (!userId || !channel_id || !message_id) return;
      db.prepare(`
        INSERT OR REPLACE INTO read_states (user_id, channel_id, last_read_message_id, updated_at)
        VALUES (?, ?, ?, unixepoch())
      `).run(userId, channel_id, message_id);
    });

    // ── VOICE ─────────────────────────────────────────────────────────────────
    let voiceChannelId = null;

    function leaveVoice() {
      if (!voiceChannelId) return;
      const chMap = voiceStates.get(voiceChannelId);
      if (chMap) {
        chMap.delete(userId);
        if (chMap.size === 0) voiceStates.delete(voiceChannelId);
      }
      const prev = voiceChannelId;
      socket.leave(`voice:${prev}`);
      voiceChannelId = null;
      gw.to(`channel:${prev}`).emit('VOICE_STATE_UPDATE', {
        channel_id: prev,
        user_id: userId,
        action: 'leave',
        voice_states: getVoiceList(prev),
      });
    }

    socket.on('VOICE_JOIN', ({ channel_id } = {}) => {
      if (!userId || !channel_id) return;
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel_id);
      if (!channel || channel.type !== 'voice') return;
      const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, userId);
      if (!member) return;

      if (voiceChannelId === channel_id) return; // already in
      if (voiceChannelId) leaveVoice();

      voiceChannelId = channel_id;
      if (!voiceStates.has(channel_id)) voiceStates.set(channel_id, new Map());
      const user = db.prepare('SELECT username, avatar_url, avatar_color FROM users WHERE id = ?').get(userId);
      const participant = {
        user_id: userId,
        username: user.username,
        avatar_url: user.avatar_url,
        avatar_color: user.avatar_color,
        socket_id: socket.id,
        muted: false,
        deafened: false,
      };
      voiceStates.get(channel_id).set(userId, participant);
      socket.join(`voice:${channel_id}`);

      // Tell everyone about the new participant
      gw.to(`channel:${channel_id}`).emit('VOICE_STATE_UPDATE', {
        channel_id,
        user_id: userId,
        action: 'join',
        voice_states: getVoiceList(channel_id),
      });

      // Tell joining user about existing peers → they will initiate offers
      const existing = getVoiceList(channel_id).filter(p => p.user_id !== userId);
      socket.emit('VOICE_READY', { channel_id, peers: existing });
    });

    socket.on('VOICE_LEAVE', () => { if (userId) leaveVoice(); });

    socket.on('VOICE_MUTE', ({ muted } = {}) => {
      if (!userId || !voiceChannelId) return;
      const chMap = voiceStates.get(voiceChannelId);
      if (chMap && chMap.has(userId)) {
        chMap.get(userId).muted = !!muted;
        gw.to(`channel:${voiceChannelId}`).emit('VOICE_STATE_UPDATE', {
          channel_id: voiceChannelId,
          user_id: userId,
          action: 'mute',
          voice_states: getVoiceList(voiceChannelId),
        });
      }
    });

    // WebRTC signaling (routed through /gateway so no extra socket needed)
    socket.on('WEBRTC_OFFER', ({ to_user_id, offer } = {}) => {
      if (!userId || !to_user_id || !offer) return;
      gw.to(`user:${to_user_id}`).emit('WEBRTC_OFFER', { from_user_id: userId, offer });
    });
    socket.on('WEBRTC_ANSWER', ({ to_user_id, answer } = {}) => {
      if (!userId || !to_user_id || !answer) return;
      gw.to(`user:${to_user_id}`).emit('WEBRTC_ANSWER', { from_user_id: userId, answer });
    });
    socket.on('WEBRTC_ICE', ({ to_user_id, candidate } = {}) => {
      if (!userId || !to_user_id) return;
      gw.to(`user:${to_user_id}`).emit('WEBRTC_ICE', { from_user_id: userId, candidate });
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!userId) return;
      leaveVoice();
      db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(userId);

      const info = presence.get(userId);
      if (info) {
        info.socket_count--;
        if (info.socket_count <= 0) {
          presence.delete(userId);
          broadcastPresence(userId, 'offline');
        }
      }
    });

    // ── Helper: broadcast presence to all server members ──────────────────────
    function broadcastPresence(uid, status, custom_status = '') {
      // Find all server rooms the user is in, broadcast to those servers
      const serverRows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(uid);
      const payload = { user_id: uid, status, custom_status };
      for (const { server_id } of serverRows) {
        gw.to(`server:${server_id}`).emit('PRESENCE_UPDATE', payload);
      }
      // Also broadcast to DM channel participants
      const dmRows = db.prepare('SELECT channel_id FROM dm_members WHERE user_id = ?').all(uid);
      const notified = new Set();
      for (const { channel_id } of dmRows) {
        const others = db.prepare('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?').all(channel_id, uid);
        for (const { user_id } of others) {
          if (!notified.has(user_id)) {
            notified.add(user_id);
            gw.to(`user:${user_id}`).emit('PRESENCE_UPDATE', payload);
          }
        }
      }
    }
  });

  return gw;
}
