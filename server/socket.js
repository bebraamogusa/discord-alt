import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toLegacyChannelType(type) {
  if (type === 2) return 'voice';
  if (type === 4) return 'category';
  if (type === 5) return 'announcement';
  if (type === 1) return 'dm';
  if (type === 3) return 'group';
  return 'text';
}

export function buildSocketServer(httpServer, { db, config }) {
  const server = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    maxHttpBufferSize: 10 * 1024 * 1024,
  });

  const rootNs = server.of('/');
  const gatewayNs = server.of('/gateway');
  const userSockets = new Map();

  const getGuildIds = db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?');
  const getDmChannelIds = db.prepare(`
    SELECT c.id
    FROM channels c
    JOIN dm_participants dp ON dp.channel_id = c.id
    WHERE dp.user_id = ? AND c.type IN (1, 3)
  `);
  const getUserById = db.prepare(`
    SELECT id, username, display_name, avatar, banner, accent_color, bio, status, custom_status_text
    FROM users WHERE id = ? AND deleted_at IS NULL
  `);
  const getGuildsForUser = db.prepare(`
    SELECT g.*
    FROM guilds g
    JOIN guild_members gm ON gm.guild_id = g.id
    WHERE gm.user_id = ?
    ORDER BY gm.joined_at ASC
  `);
  const getChannelsForGuild = db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY position ASC, created_at ASC');
  const getRolesForGuild = db.prepare('SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC, created_at ASC');
  const getDmChannelsForUser = db.prepare(`
    SELECT c.*
    FROM channels c
    JOIN dm_participants dp ON dp.channel_id = c.id
    WHERE dp.user_id = ? AND c.type IN (1, 3) AND dp.closed = 0
    ORDER BY c.updated_at DESC, c.created_at DESC
  `);
  const getDmRecipient = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.accent_color, u.status
    FROM dm_participants dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.channel_id = ? AND dp.user_id <> ? AND u.deleted_at IS NULL
    LIMIT 1
  `);
  const getPresencesForUser = db.prepare(`
    SELECT DISTINCT u.id, u.status, u.custom_status_text
    FROM users u
    LEFT JOIN guild_members gm ON gm.user_id = u.id
    WHERE u.id = ? OR gm.guild_id IN (
      SELECT guild_id FROM guild_members WHERE user_id = ?
    )
  `);
  const getVoiceStatesForUserGuilds = db.prepare(`
    SELECT vs.channel_id, vs.user_id, vs.mute, vs.deaf, vs.self_mute, vs.self_deaf, vs.self_stream, vs.self_video,
           u.username, u.display_name, u.avatar, u.accent_color
    FROM voice_states vs
    JOIN users u ON u.id = vs.user_id
    WHERE vs.guild_id IN (
      SELECT guild_id FROM guild_members WHERE user_id = ?
    )
  `);

  const getVoiceStatesForChannel = db.prepare(`
    SELECT vs.channel_id, vs.user_id, vs.mute, vs.deaf, vs.self_mute, vs.self_deaf, vs.self_stream, vs.self_video,
           u.username, u.display_name, u.avatar, u.accent_color
    FROM voice_states vs
    JOIN users u ON u.id = vs.user_id
    WHERE vs.channel_id = ?
  `);
  const insertVoiceState = db.prepare(`
    INSERT INTO voice_states (user_id, guild_id, channel_id, mute, deaf, self_mute, self_deaf, self_stream, self_video)
    VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET
      guild_id = excluded.guild_id,
      channel_id = excluded.channel_id,
      self_mute = excluded.self_mute,
      self_deaf = excluded.self_deaf,
      self_stream = excluded.self_stream
  `);
  const deleteVoiceState = db.prepare('DELETE FROM voice_states WHERE user_id = ?');
  const getGuildIdForChannel = db.prepare('SELECT guild_id FROM channels WHERE id = ?');
  const updateVoiceSelfMute = db.prepare('UPDATE voice_states SET self_mute = ? WHERE user_id = ?');
  const updateVoiceSelfDeaf = db.prepare('UPDATE voice_states SET self_deaf = ? WHERE user_id = ?');
  const updateVoiceSelfStream = db.prepare('UPDATE voice_states SET self_stream = ? WHERE user_id = ?');

  const updatePresence = db.prepare('UPDATE users SET status = ?, custom_status_text = ?, updated_at = ? WHERE id = ?');
  const upsertQr = db.prepare(`
    INSERT INTO qr_login_sessions (qr_id, desktop_socket_id, status, scanned_by_user_id, created_at, expires_at)
    VALUES (?, ?, 'pending', NULL, ?, ?)
    ON CONFLICT(qr_id) DO UPDATE SET
      desktop_socket_id = excluded.desktop_socket_id,
      status = excluded.status,
      scanned_by_user_id = excluded.scanned_by_user_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  const getQr = db.prepare('SELECT * FROM qr_login_sessions WHERE qr_id = ?');
  const markQrScanned = db.prepare('UPDATE qr_login_sessions SET status = ?, scanned_by_user_id = ? WHERE qr_id = ?');
  const markQrConfirmed = db.prepare('UPDATE qr_login_sessions SET status = ? WHERE qr_id = ?');
  const cleanupQr = db.prepare('DELETE FROM qr_login_sessions WHERE expires_at <= ?');

  function verifyToken(token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      return getUserById.get(payload.sub) || null;
    } catch {
      return null;
    }
  }

  function mapLegacyUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar || '',
      banner_url: user.banner || '',
      avatar_color: user.accent_color || '#5865f2',
      banner_color: user.accent_color || '#5865f2',
      about_me: user.bio || '',
      status: user.status || 'offline',
      custom_status: user.custom_status_text || '',
    };
  }

  function mapLegacyGuild(guild) {
    const channelsRaw = getChannelsForGuild.all(guild.id);
    const categories = channelsRaw
      .filter((c) => c.type === 4)
      .map((c) => ({ id: c.id, name: c.name, position: c.position }));

    const channels = channelsRaw
      .filter((c) => c.type !== 4)
      .map((c) => ({
        id: c.id,
        server_id: guild.id,
        guild_id: guild.id,
        name: c.name,
        topic: c.topic,
        type: toLegacyChannelType(c.type),
        category_id: c.parent_id,
        position: c.position,
        nsfw: !!c.nsfw,
      }));

    const roles = getRolesForGuild.all(guild.id).map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      position: r.position,
      permissions: r.permissions,
      hoist: r.hoist,
      mentionable: r.mentionable,
      is_default: r.id === guild.id,
    }));

    return {
      id: guild.id,
      name: guild.name,
      icon_url: guild.icon || '',
      banner_url: guild.banner || '',
      owner_id: guild.owner_id,
      description: guild.description || '',
      channels,
      categories,
      roles,
    };
  }

  function mapLegacyDmChannel(channel, userId) {
    const recipient = getDmRecipient.get(channel.id, userId);
    return {
      id: channel.id,
      type: channel.type === 3 ? 'group' : 'dm',
      recipient: recipient ? {
        id: recipient.id,
        username: recipient.username,
        display_name: recipient.display_name,
        avatar_url: recipient.avatar || '',
        avatar_color: recipient.accent_color || '#5865f2',
        status: recipient.status || 'offline',
      } : null,
      last_message_id: channel.last_message_id,
      updated_at: channel.updated_at || channel.created_at,
    };
  }

  function buildLegacyReady(user) {
    const servers = getGuildsForUser.all(user.id).map(mapLegacyGuild);
    const dmChannels = getDmChannelsForUser.all(user.id).map((c) => mapLegacyDmChannel(c, user.id));

    const presences = {};
    for (const row of getPresencesForUser.all(user.id, user.id)) {
      presences[row.id] = {
        status: row.status || 'offline',
        custom_status: row.custom_status_text || '',
      };
    }

    const voiceStates = {};
    for (const row of getVoiceStatesForUserGuilds.all(user.id)) {
      if (!voiceStates[row.channel_id]) voiceStates[row.channel_id] = [];
      voiceStates[row.channel_id].push({
        user_id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar || '',
        avatar_color: row.accent_color || '#5865f2',
        muted: !!row.mute || !!row.self_mute,
        deafened: !!row.deaf || !!row.self_deaf,
        sharing_screen: !!row.self_stream,
        self_video: !!row.self_video,
      });
    }

    return {
      user: mapLegacyUser(user),
      servers,
      dm_channels: dmChannels,
      presences,
      voice_states: voiceStates,
    };
  }

  function addUserSocket(socket) {
    const userId = socket.user?.id;
    if (!userId) return;
    socket.join(`user:${userId}`);

    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    for (const row of getGuildIds.all(userId)) {
      socket.join(`guild:${row.guild_id}`);
    }
    for (const row of getDmChannelIds.all(userId)) {
      socket.join(`channel:${row.id}`);
    }
  }

  function broadcastVoiceState(channelId, guildId) {
    if (!channelId || !guildId) return;
    const voiceStates = getVoiceStatesForChannel.all(channelId).map(row => ({
      user_id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar || '',
      avatar_color: row.accent_color || '#5865f2',
      muted: !!row.mute || !!row.self_mute,
      deafened: !!row.deaf || !!row.self_deaf,
      sharing_screen: !!row.self_stream,
      self_video: !!row.self_video,
    }));
    gatewayNs.to(`guild:${guildId}`).emit('VOICE_STATE_UPDATE', { channel_id: channelId, voice_states: voiceStates });
  }

  function removeUserSocket(socket) {
    const userId = socket.user?.id;
    if (!userId) return;

    if (socket.voiceChannelId) {
      deleteVoiceState.run(userId);
      broadcastVoiceState(socket.voiceChannelId, socket.voiceGuildId);
      socket.voiceChannelId = null;
      socket.voiceGuildId = null;
    }

    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      userSockets.delete(userId);
      updatePresence.run('offline', null, nowSec(), userId);
      rootNs.emit('presence:update', { user_id: userId, status: 'offline', activities: [], client_status: { web: 'offline' } });
      rootNs.emit('PRESENCE_UPDATE', { user_id: userId, status: 'offline', custom_status: '' });
      gatewayNs.emit('presence:update', { user_id: userId, status: 'offline', activities: [], client_status: { web: 'offline' } });
      gatewayNs.emit('PRESENCE_UPDATE', { user_id: userId, status: 'offline', custom_status: '' });
    }
  }

  function handlePresenceUpdate(socket, payload = {}) {
    if (!socket.user) return;
    const allowed = new Set(['online', 'idle', 'dnd', 'invisible']);
    const status = allowed.has(payload.status) ? payload.status : 'online';
    const customStatus = payload.custom_status != null ? String(payload.custom_status).slice(0, 190) : (socket.user.custom_status_text || null);
    updatePresence.run(status, customStatus, nowSec(), socket.user.id);
    socket.user.status = status;
    socket.user.custom_status_text = customStatus;

    const modern = {
      user_id: socket.user.id,
      status,
      activities: Array.isArray(payload.activities) ? payload.activities : [],
      client_status: { web: status },
    };
    const legacy = {
      user_id: socket.user.id,
      status,
      custom_status: customStatus || '',
    };

    rootNs.emit('presence:update', modern);
    gatewayNs.emit('presence:update', modern);
    rootNs.emit('PRESENCE_UPDATE', legacy);
    gatewayNs.emit('PRESENCE_UPDATE', legacy);
  }

  function registerQrHandlers(socket, namespace) {
    socket.on('qr:generate', () => {
      cleanupQr.run(nowSec());
      const qrId = randomUUID();
      const ts = nowSec();
      upsertQr.run(qrId, socket.id, ts, ts + 120);
      socket.emit('qr:generated', { qr_id: qrId, expires_in: 120 });
      socket.emit('qr:generated'.toUpperCase(), { qr_id: qrId, expires_in: 120 });
    });

    socket.on('qr:scan', ({ qr_id }) => {
      if (!socket.user || !qr_id) return;
      const row = getQr.get(qr_id);
      if (!row || row.expires_at <= nowSec() || row.status !== 'pending') {
        socket.emit('qr:error', { error: 'Invalid or expired QR' });
        return;
      }
      markQrScanned.run('scanned', socket.user.id, qr_id);
      namespace.to(row.desktop_socket_id).emit('qr:scanned', {
        qr_id,
        user: { id: socket.user.id, username: socket.user.username },
      });
    });

    socket.on('qr:confirm', ({ qr_id }) => {
      if (!socket.user || !qr_id) return;
      const row = getQr.get(qr_id);
      if (!row || row.expires_at <= nowSec() || row.status !== 'scanned') {
        socket.emit('qr:error', { error: 'QR confirmation failed' });
        return;
      }
      markQrConfirmed.run('confirmed', qr_id);
      namespace.to(row.desktop_socket_id).emit('qr:confirmed', {
        qr_id,
        user: { id: socket.user.id, username: socket.user.username },
      });
    });
  }

  rootNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      socket.user = null;
      return next();
    }
    const user = verifyToken(token);
    if (!user) return next(new Error('Authentication failed'));
    socket.user = user;
    return next();
  });

  rootNs.on('connection', (socket) => {
    if (socket.user) {
      addUserSocket(socket);
      updatePresence.run('online', socket.user.custom_status_text || null, nowSec(), socket.user.id);
      rootNs.emit('presence:update', { user_id: socket.user.id, status: 'online', activities: [], client_status: { web: 'online' } });
      gatewayNs.emit('PRESENCE_UPDATE', { user_id: socket.user.id, status: 'online', custom_status: socket.user.custom_status_text || '' });
    }

    socket.on('presence:update', (payload = {}) => handlePresenceUpdate(socket, payload));
    registerQrHandlers(socket, rootNs);
    socket.on('disconnect', () => removeUserSocket(socket));
  });

  gatewayNs.on('connection', (socket) => {
    socket.on('IDENTIFY', ({ token } = {}) => {
      const user = verifyToken(token);
      if (!user) {
        socket.emit('ERROR', { message: 'Authentication failed' });
        return;
      }

      socket.user = user;
      addUserSocket(socket);
      updatePresence.run('online', socket.user.custom_status_text || null, nowSec(), socket.user.id);

      socket.emit('READY', buildLegacyReady(user));
      gatewayNs.emit('PRESENCE_UPDATE', { user_id: user.id, status: 'online', custom_status: user.custom_status_text || '' });
      rootNs.emit('presence:update', { user_id: user.id, status: 'online', activities: [], client_status: { web: 'online' } });
    });

    socket.on('UPDATE_STATUS', (payload = {}) => handlePresenceUpdate(socket, payload));
    socket.on('presence:update', (payload = {}) => handlePresenceUpdate(socket, payload));
    registerQrHandlers(socket, gatewayNs);

    // Voice & WebRTC Signaling
    socket.on('VOICE_JOIN', ({ channel_id }) => {
      const channel = getGuildIdForChannel.get(channel_id);
      if (!channel || !channel.guild_id) return;
      
      insertVoiceState.run(socket.user.id, channel.guild_id, channel_id, 0, 0, 0); // mute/deaf/screen
      socket.voiceChannelId = channel_id;
      socket.voiceGuildId = channel.guild_id;

      broadcastVoiceState(channel_id, channel.guild_id);

      const peers = getVoiceStatesForChannel.all(channel_id).filter(r => r.user_id !== socket.user.id);
      socket.emit('VOICE_READY', { channel_id, peers });
    });

    socket.on('VOICE_MUTE', (payload) => {
      if (!socket.voiceChannelId) return;
      if (payload.muted !== undefined) updateVoiceSelfMute.run(payload.muted ? 1 : 0, socket.user.id);
      if (payload.deafened !== undefined) updateVoiceSelfDeaf.run(payload.deafened ? 1 : 0, socket.user.id);
      broadcastVoiceState(socket.voiceChannelId, socket.voiceGuildId);
    });

    socket.on('VOICE_SCREEN', ({ sharing }) => {
      if (!socket.voiceChannelId) return;
      updateVoiceSelfStream.run(sharing ? 1 : 0, socket.user.id);
      broadcastVoiceState(socket.voiceChannelId, socket.voiceGuildId);
    });

    socket.on('VOICE_LEAVE', () => {
      if (!socket.voiceChannelId) return;
      const ch = socket.voiceChannelId;
      const g = socket.voiceGuildId;
      deleteVoiceState.run(socket.user.id);
      socket.voiceChannelId = null;
      socket.voiceGuildId = null;
      broadcastVoiceState(ch, g);
    });

    socket.on('WEBRTC_OFFER', ({ to_user_id, offer }) => {
      gatewayNs.to(`user:${to_user_id}`).emit('WEBRTC_OFFER', { from_user_id: socket.user.id, offer });
    });

    socket.on('WEBRTC_ANSWER', ({ to_user_id, answer }) => {
      gatewayNs.to(`user:${to_user_id}`).emit('WEBRTC_ANSWER', { from_user_id: socket.user.id, answer });
    });

    socket.on('WEBRTC_ICE', ({ to_user_id, candidate }) => {
      gatewayNs.to(`user:${to_user_id}`).emit('WEBRTC_ICE', { from_user_id: socket.user.id, candidate });
    });

    socket.on('disconnect', () => removeUserSocket(socket));
  });

  const broadcast = {
    to(room) {
      return {
        emit(event, payload) {
          rootNs.to(room).emit(event, payload);
          gatewayNs.to(room).emit(event, payload);
        },
      };
    },
    emit(event, payload) {
      rootNs.emit(event, payload);
      gatewayNs.emit(event, payload);
    },
  };

  return broadcast;
}
