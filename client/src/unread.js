// client/src/unread.js
// Authoritative read-state handling and notification gating
import * as API from '/api.js';
import { S } from './state.js';

export function isNewerId(a, b) {
  if (!a) return false;
  if (!b) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return String(a) > String(b);
  }
}

function channelLastMessageId(channelId) {
  const cached = S.messages[channelId];
  if (cached?.length) return cached[cached.length - 1].id;
  for (const srv of S.servers) {
    const ch = srv.channels?.find(c => c.id === channelId);
    if (ch?.last_message_id) return ch.last_message_id;
  }
  const dm = S.dmChannels.find(c => c.id === channelId);
  return dm?.last_message_id || null;
}

export function applyReadStates(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.channel_id) continue;
    S.readStates[row.channel_id] = row.last_read_message_id;
    if (row.channel_id === S.activeChannelId) continue;
    const mentions = Number(row.mention_count || 0);
    if (mentions > (S.unread[row.channel_id] || 0)) S.unread[row.channel_id] = mentions;
    if (!(S.unread[row.channel_id] > 0) && isNewerId(channelLastMessageId(row.channel_id), row.last_read_message_id)) {
      S.unread[row.channel_id] = 1;
    }
  }
}

export async function loadReadStates() {
  try {
    applyReadStates(await API.get('/api/users/@me/read-states'));
    return true;
  } catch {
    return false;
  }
}

export async function loadGuildSettings() {
  await Promise.all(S.servers.map(async srv => {
    try { S.guildSettings[srv.id] = await API.get(`/api/users/@me/guilds/${srv.id}/settings`); }
    catch { }
  }));
}

export function guildNotificationsEnabled(guildId) {
  if (!guildId) return true;
  const settings = S.guildSettings[guildId];
  if (!settings) return true;
  if (Number(settings.message_notifications) === 0) return false;
  if (Number(settings.muted)) {
    const until = Number(settings.mute_until || 0);
    if (!until || until > Date.now() / 1000) return false;
  }
  return true;
}

// Canonical ack path: socket READ_ACK only.
export function ackChannel(channelId) {
  const messages = S.messages[channelId];
  const lastId = messages?.length ? messages[messages.length - 1].id : null;
  if (!lastId || !window.socket?.connected) return;
  if (!isNewerId(lastId, S.readStates[channelId])) return;
  S.readStates[channelId] = lastId;
  S.unread[channelId] = 0;
  window.socket.emit('READ_ACK', { channel_id: channelId, message_id: lastId });
}
