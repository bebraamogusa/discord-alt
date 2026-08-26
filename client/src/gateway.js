import * as API from '/api.js';
import { t } from '/i18n.js';
import * as VoiceClient from '/voice.js';

import { S } from './state.js';
import {
  $, normalizeMe, normalizeServer, showToast,
  displayNameFor, getServer, getChannel
} from './utils.js';
import {
  renderChannelList,
  renderServerIcons,
  renderMembersPanel,
  renderMessages,
  renderVoicePanel,
  updateUnreadIndicators,
  appendMessage,
  updateMessage,
  updateMessageReactions,
  removeMessage,
  updateMemberRow,
  updateSidebarUser,
  showWelcomeScreen,
  selectServer,
  renderFriendsView,
  loadMessages,
} from './ui.js';
import { loadFriendCount } from './api_requests.js';
import {
  loadReadStates,
  loadGuildSettings,
  guildNotificationsEnabled,
  ackChannel,
  isNewerId,
} from './unread.js';

export let socket = null;

const dirtyUiSections = new Set();
let uiRenderQueued = false;
const pendingMessageOps = [];

function panelVisible(id) {
  const panel = document.getElementById(id);
  return !!panel && !panel.closest('.hidden');
}

function flushUiSections() {
  uiRenderQueued = false;
  const dirty = new Set(dirtyUiSections);
  dirtyUiSections.clear();

  if (dirty.has('channels') && panelVisible('sidebar-channel-list')) renderChannelList();
  if (pendingMessageOps.length && S.activeChannelId !== 'friends' && panelVisible('messages-wrapper')) {
    const wrapper = document.getElementById('messages-wrapper');
    const scrollTop = wrapper?.scrollTop;
    const wasAtBottom = !!wrapper && wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 80;
    const ops = pendingMessageOps.splice(0);
    let appended = false;
    for (const op of ops) {
      if (op.type === 'append') { appendMessage(op.message, op.previous); appended = true; }
      else if (op.type === 'update') updateMessage(op.message);
      else if (op.type === 'reactions') updateMessageReactions(op.id);
      else removeMessage(op.id, op.messages);
    }
    if (wrapper && scrollTop !== undefined) {
      if (appended && wasAtBottom) wrapper.scrollTo({ top: wrapper.scrollHeight, behavior: 'instant' });
      else wrapper.scrollTop = scrollTop;
    }
  } else if (pendingMessageOps.length && (S.activeChannelId === 'friends' || !panelVisible('messages-wrapper'))) {
    pendingMessageOps.length = 0;
  } else if (dirty.has('messages') && S.activeChannelId !== 'friends' && panelVisible('messages-wrapper')) {
    renderMessages();
  }
  if (dirty.has('typing') && S.activeChannelId && S.activeChannelId !== 'friends') renderTyping();
  if (dirty.has('members') && S.activeServerId !== '@me' && S.membersVisible && panelVisible('members-panel')) renderMembersPanel();
  if (dirty.has('voice')) {
    if (getChannel(S.activeChannelId)?.type === 'voice' && panelVisible('voice-panel')) renderVoicePanel();
    renderVoiceBar();
  }
  if (dirty.has('friends') && S.activeChannelId === 'friends') renderFriendsView();
}

function queueMessageOp(op) {
  pendingMessageOps.push(op);
  scheduleUiSections('messages');
}

function scheduleUiSections(...sections) {
  sections.forEach(section => dirtyUiSections.add(section));
  if (uiRenderQueued) return;
  uiRenderQueued = true;
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flushUiSections);
  else setTimeout(flushUiSections, 0);
}

function setConnectionStatus(state) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  const labels = { connected: 'Подключено', connecting: 'Подключение…', reconnecting: 'Переподключение…', disconnected: 'Нет соединения' };
  el.textContent = labels[state] || labels.disconnected;
  el.dataset.state = state;
  el.className = `connection-status ${state}`;
}

async function resyncActiveChannel() {
  if (!S.activeChannelId || S.activeChannelId === 'friends') return;
  const channelId = S.activeChannelId;
  delete S.messages[channelId];
  await loadMessages(channelId);
}

function renderTyping() {
  if (typeof window.renderTyping === 'function') window.renderTyping();
}

function renderVoiceBar() {
  if (typeof window.renderVoiceBar === 'function') window.renderVoiceBar();
}

function updateReactions(messageId, channelId, emoji, userId, add) {
  const name = typeof emoji === 'string' ? emoji : emoji?.name;
  const message = S.messages[channelId]?.find(item => item.id === messageId);
  if (!message || !name) return;
  message.reactions ||= [];
  let reaction = message.reactions.find(item => (item.emoji?.name || item.emoji) === name);
  if (add) {
    if (!reaction) {
      reaction = { emoji: { name }, count: 0, me: false };
      message.reactions.push(reaction);
    }
    reaction.count = Number(reaction.count || 0) + 1;
    if (userId === S.me?.id) reaction.me = true;
  } else if (reaction) {
    reaction.count = Math.max(0, Number(reaction.count || 0) - 1);
    if (userId === S.me?.id) reaction.me = false;
    if (!reaction.count) message.reactions = message.reactions.filter(item => item !== reaction);
  }
  if (channelId === S.activeChannelId && panelVisible('messages-wrapper')) {
    queueMessageOp({ type: 'reactions', id: messageId });
  }
}

const TYPING_DEBOUNCE_MS = 5000;
let typingSentAt = 0;
let typingSentChannel = null;
let typingResetTimer = null;

export function sendTyping() {
  if (!socket?.connected || !S.activeChannelId) return;
  const channelId = S.activeChannelId;
  const now = Date.now();
  if (channelId === typingSentChannel && now - typingSentAt < TYPING_DEBOUNCE_MS) return;
  typingSentAt = now;
  typingSentChannel = channelId;
  clearTimeout(typingResetTimer);
  // trailing reset: continuous typing re-emits once per window
  typingResetTimer = setTimeout(() => {
    typingSentAt = 0;
    typingSentChannel = null;
  }, TYPING_DEBOUNCE_MS);
  socket.emit('TYPING_START', { channel_id: channelId });
}

export function connectGateway() {
  const sio = window.io;
  if (!sio) { console.warn('socket.io not loaded'); return; }

  setConnectionStatus('connecting');
  const newSocket = sio(`${API.getServerUrl()}/gateway`, { transports: ['websocket'], withCredentials: true });
  socket = newSocket;
  window.socket = newSocket;

  newSocket.on('connect', () => {
    setConnectionStatus('connecting');
    newSocket.emit('IDENTIFY', { token: API.getToken() });
  });

  newSocket.on('READY', async ({ user, servers, dm_channels, presences, voice_states }) => {
    setConnectionStatus('connected');
    S.me = normalizeMe(user);
    S.servers = (servers || []).map(normalizeServer);
    S.dmChannels = dm_channels;
    S.presences = presences;
    S.voiceStates = voice_states || {};
    renderServerIcons();
    renderChannelList();
    updateSidebarUser();
    if (!S.activeServerId) {
      void selectServer('@me');
    }
    const savedStatus = localStorage.getItem('da_status');
    if (savedStatus && savedStatus !== 'online') {
      newSocket.emit('UPDATE_STATUS', { status: savedStatus, custom_status: (S.me?.custom_status || '') });
    }
    await Promise.all([loadReadStates(), loadGuildSettings()]);
    renderServerIcons();
    renderChannelList();
    void resyncActiveChannel();
  });

  newSocket.on('MESSAGE_CREATE', (msg) => {
    if (!S.messages[msg.channel_id]) S.messages[msg.channel_id] = [];
    if (S.messages[msg.channel_id].some(m => m.id === msg.id)) return;
    S.messages[msg.channel_id].push(msg);
    if (msg.channel_id === S.activeChannelId) {
      if (panelVisible('messages-wrapper')) {
        queueMessageOp({ type: 'append', message: msg, previous: S.messages[msg.channel_id][S.messages[msg.channel_id].length - 2] });
        ackChannel(msg.channel_id);
      }
    } else {
      S.unread[msg.channel_id] = (S.unread[msg.channel_id] || 0) + 1;
      updateUnreadIndicators(msg.channel_id);
      const channel = getChannel(msg.channel_id);
      const guildId = msg.guild_id || channel?.guild_id || channel?.server_id;
      if (msg.author_id !== S.me?.id && guildNotificationsEnabled(guildId) && window.NotifSound) {
        const authorName = displayNameFor(msg.author_id, msg.author?.username || t('unknown_user'), S.activeServerId);
        window.NotifSound.play(authorName, msg.content?.slice(0, 100));
      }
    }
  });

  newSocket.on('MESSAGE_UPDATE', (msg) => {
    if (S.messages[msg.channel_id]) {
      const idx = S.messages[msg.channel_id].findIndex(m => m.id === msg.id);
      if (idx !== -1) S.messages[msg.channel_id][idx] = msg;
    }
    if (msg.channel_id === S.activeChannelId) {
      if (panelVisible('messages-wrapper')) queueMessageOp({ type: 'update', message: msg });
    }
  });

  newSocket.on('MESSAGE_DELETE', ({ message_id, id, channel_id }) => {
    const deletedId = message_id || id;
    if (S.messages[channel_id]) {
      S.messages[channel_id] = S.messages[channel_id].filter(m => m.id !== deletedId);
    }
    if (channel_id === S.activeChannelId) {
      if (panelVisible('messages-wrapper')) queueMessageOp({ type: 'remove', id: deletedId, messages: S.messages[channel_id] });
    }
  });

  newSocket.on('MESSAGE_REACTION_ADD', (data) => {
    updateReactions(data.message_id, data.channel_id, data.emoji, data.user_id, true);
  });
  newSocket.on('MESSAGE_REACTION_REMOVE', (data) => {
    updateReactions(data.message_id, data.channel_id, data.emoji, data.user_id, false);
  });

  newSocket.on('TYPING_START', ({ channel_id, user_id, username }) => {
    if (user_id === S.me?.id || !channel_id) return;
    if (!S.typingUsers[channel_id]) S.typingUsers[channel_id] = {};
    const prev = S.typingUsers[channel_id][user_id];
    if (prev) clearTimeout(prev.timer);
    S.typingUsers[channel_id][user_id] = {
      username: username || '',
      timer: setTimeout(() => {
        delete S.typingUsers[channel_id]?.[user_id];
        if (!Object.keys(S.typingUsers[channel_id] || {}).length) delete S.typingUsers[channel_id];
        if (channel_id === S.activeChannelId) scheduleUiSections('typing');
      }, 3000),
    };
    if (channel_id === S.activeChannelId) scheduleUiSections('typing');
  });

  newSocket.on('READ_STATE_UPDATE', ({ user_id, channel_id, last_read_message_id }) => {
    if (user_id !== S.me?.id || !channel_id || channel_id === S.activeChannelId) return;
    S.readStates[channel_id] = last_read_message_id;
    const knownLatest = S.messages[channel_id]?.length
      ? S.messages[channel_id][S.messages[channel_id].length - 1].id
      : null;
    if (!S.unread[channel_id] || !isNewerId(knownLatest, last_read_message_id)) {
      delete S.unread[channel_id];
    }
    scheduleUiSections('channels');
  });

  newSocket.on('PRESENCE_UPDATE', ({ user_id, status, custom_status }) => {
    S.presences[user_id] = { status, custom_status };
    if (S.activeServerId && S.activeServerId !== '@me' && panelVisible('members-panel')) updateMemberRow(S.activeServerId, user_id);
    if (S.activeChannelId === 'friends') scheduleUiSections('friends');
  });

  newSocket.on('FRIEND_REQUEST', (sender) => {
    S._friendRequestCount++;
    scheduleUiSections('channels');
    if (window.NotifSound) window.NotifSound.play(sender.username, t('friend_requests'));
    showToast(`${sender.username} ${t('friend_added')}`, 'info');
  });

  newSocket.on('FRIEND_UPDATE', ({ user_id, status: fStatus }) => {
    if (fStatus === 'accepted') showToast(t('friend_accepted'), 'success');
    else if (fStatus === 'removed') showToast(t('friend_removed'), 'info');
    if (S.activeChannelId === 'friends') scheduleUiSections('friends');
  });

  newSocket.on('relationship:add', () => void loadFriendCount());
  newSocket.on('relationship:update', () => void loadFriendCount());
  newSocket.on('relationship:remove', () => void loadFriendCount());

  newSocket.on('MEMBER_JOIN', ({ server_id, member }) => {
    if (!S.members[server_id]) S.members[server_id] = [];
    if (!S.members[server_id].find(m => (m.user_id || m.id) === (member.user_id || member.id))) {
      S.members[server_id].push(member);
    }
    if (S.activeServerId === server_id && panelVisible('members-panel')) updateMemberRow(server_id, member.user_id || member.id);
  });

  newSocket.on('MEMBER_LEAVE', ({ server_id, user_id }) => {
    if (S.members[server_id]) {
      S.members[server_id] = S.members[server_id].filter(m => (m.user_id || m.id) !== user_id);
    }
    if (user_id === S.me?.id) {
      S.servers = S.servers.filter(s => s.id !== server_id);
      if (S.activeServerId === server_id) selectServer('@me');
      renderServerIcons();
    } else if (S.activeServerId === server_id && panelVisible('members-panel')) {
      updateMemberRow(server_id, user_id);
    }
  });

  newSocket.on('MEMBER_UPDATE', ({ server_id, member }) => {
    if (!server_id || !member?.id) return;
    if (!S.members[server_id]) S.members[server_id] = [];
    const idx = S.members[server_id].findIndex(m => m.id === member.id);
    if (idx === -1) S.members[server_id].push(member);
    else S.members[server_id][idx] = { ...S.members[server_id][idx], ...member };

    if (S.activeServerId === server_id && panelVisible('members-panel')) {
      updateMemberRow(server_id, member.user_id || member.id);
      if (S.activeChannelId && getChannel(S.activeChannelId)?.type === 'voice') scheduleUiSections('voice');
      if (member.nickname || member.username) {
        scheduleUiSections('channels', 'typing');
      }
    }
  });

  newSocket.on('CHANNEL_CREATE', (ch) => {
    if (ch.type === 'dm' || ch.type === 'group') {
      if (!S.dmChannels.find(c => c.id === ch.id)) S.dmChannels.push(ch);
       if (S.activeServerId === '@me') scheduleUiSections('channels');
    } else if (ch.server_id) {
      const srv = getServer(ch.server_id);
      if (srv) {
        if (ch.type === 'category') {
          if (!srv.categories) srv.categories = [];
          if (!srv.categories.find(c => c.id === ch.id)) srv.categories.push({ id: ch.id, name: ch.name, position: ch.position ?? 0 });
        } else {
          if (!srv.channels.find(c => c.id === ch.id)) srv.channels.push(ch);
        }
         if (S.activeServerId === ch.server_id) scheduleUiSections('channels');
      }
    }
  });

  newSocket.on('CHANNEL_UPDATE', (ch) => {
    const srv = getServer(ch.server_id);
    if (srv) {
      if (ch.type === 'category') {
        const idx = (srv.categories || []).findIndex(c => c.id === ch.id);
        if (idx !== -1) srv.categories[idx] = { ...srv.categories[idx], name: ch.name, position: ch.position ?? srv.categories[idx].position };
        if (S.activeServerId === ch.server_id) scheduleUiSections('channels');
        return;
      }
      const idx = srv.channels.findIndex(c => c.id === ch.id);
      if (idx !== -1) srv.channels[idx] = ch;
       if (S.activeServerId === ch.server_id) scheduleUiSections('channels');
    }
  });

  newSocket.on('CHANNEL_DELETE', ({ channel_id, server_id }) => {
    const srv = getServer(server_id);
    if (srv) {
      srv.channels = srv.channels.filter(c => c.id !== channel_id);
      // also remove from categories if it was a category
      if (srv.categories) srv.categories = srv.categories.filter(c => c.id !== channel_id);
      if (S.activeChannelId === channel_id) {
        S.activeChannelId = null;
        showWelcomeScreen();
      }
       if (S.activeServerId === server_id) scheduleUiSections('channels');
    }
  });

  newSocket.on('guild:channels:reorder', ({ guild_id, channels }) => {
    const srv = getServer(guild_id);
    if (!srv || !Array.isArray(channels)) return;
    const posMap = new Map(channels.map(c => [c.id, c]));
    for (const cat of srv.categories || []) {
      const upd = posMap.get(cat.id);
      if (upd) cat.position = upd.position;
    }
    for (const ch of srv.channels || []) {
      const upd = posMap.get(ch.id);
      if (upd) {
        ch.position = upd.position;
        ch.parent_id = upd.parent_id;
        ch.category_id = upd.parent_id;
      }
    }
    if (S.activeServerId === guild_id) scheduleUiSections('channels');
  });

  newSocket.on('THREAD_CREATE', (ch) => {
    const gid = ch.guild_id || S.activeServerId;
    const srv = getServer(gid);
    if (!srv) return;
    const legacy = ch.type === 11 ? 'thread' : ch.type === 13 ? 'stage' : ch.type === 15 ? 'forum' : ch.type === 4 ? 'category' : ch.type === 5 ? 'announcement' : ch.type === 2 ? 'voice' : 'text';
    const normalized = { id: ch.id, name: ch.name, type: legacy, server_id: gid, guild_id: gid, category_id: ch.parent_id, parent_id: ch.parent_id, position: ch.position ?? 999 };
    if (legacy === 'category') {
      if (!srv.categories) srv.categories = [];
      if (!srv.categories.find(c => c.id === ch.id)) srv.categories.push({ id: ch.id, name: ch.name, position: ch.position ?? 0 });
    } else {
      if (!srv.channels.find(c => c.id === ch.id)) srv.channels.push(normalized);
    }
    if (S.activeServerId === gid) scheduleUiSections('channels');
  });

  newSocket.on('SERVER_UPDATE', (srv) => {
    const idx = S.servers.findIndex(s => s.id === srv.id);
    if (idx !== -1) {
      S.servers[idx] = normalizeServer({ ...S.servers[idx], ...srv });
      renderServerIcons();
      if (S.activeServerId === srv.id) {
        $('sidebar-server-name').textContent = srv.name;
      }
    }
  });

  newSocket.on('SERVER_DELETE', ({ server_id }) => {
    S.servers = S.servers.filter(s => s.id !== server_id);
    if (S.activeServerId === server_id) selectServer('@me');
    renderServerIcons();
    showToast(t('server_deleted'), 'error');
  });

  newSocket.on('ERROR', ({ message }) => console.warn('[GW]', message));
  newSocket.on('disconnect', () => {
    setConnectionStatus('disconnected');
    VoiceClient.handleGatewayDisconnect();
    console.log('[GW] disconnected');
  });
  newSocket.io.on('reconnect_attempt', () => setConnectionStatus('reconnecting'));
  newSocket.io.on('reconnect_error', () => setConnectionStatus('disconnected'));

  newSocket.on('VOICE_STATE_UPDATE', ({ channel_id, voice_states }) => {
    S.voiceStates[channel_id] = voice_states;
    scheduleUiSections('channels');
    if (S.activeChannelId === channel_id) scheduleUiSections('voice');
  });

  // mediasoup voice listeners
  newSocket.on('VOICE_READY', ({ producers }) => {
    VoiceClient.consumeExistingProducers(producers);
  });

  newSocket.on('voice:producer_added', ({ producerId, user_id, kind }) => {
    void VoiceClient.handleProducerAdded({ producerId, user_id, kind });
  });

  newSocket.on('voice:producer_removed', ({ producerId }) => {
    VoiceClient.handleProducerRemoved(producerId);
  });

  return newSocket;
}
