import * as API from '/api.js';
import { t } from '/i18n.js';
import * as VoiceClient from '/voice.js';

import { S, V } from './state.js';
import { 
  $, normalizeMe, showToast, parseMarkdown, 
  displayNameFor, getServer, getChannel
} from './utils.js';

import { socket } from '../app.js';
import { 
  renderApp, renderChannelList, renderServerIcons, 
  renderMembersPanel, renderMessages, renderTyping, 
  renderVoicePanel, renderVoiceBar, showWelcomeScreen,
  appendMessage, scrollToBottom, updateReactions,
  selectServer, showFriendsView, updateSidebarUser, loadFriendCount
} from '../app.js';

import { NotifSound } from '../app.js'; // Assuming we export this later or move it

export function connectGateway() {
  const sio = window.io;
  if (!sio) { console.warn('socket.io not loaded'); return; }

  const newSocket = sio('/gateway', { transports: ['websocket'] });

  newSocket.on('connect', () => {
    newSocket.emit('IDENTIFY', { token: API.getToken() });
  });

  newSocket.on('READY', ({ user, servers, dm_channels, presences, voice_states }) => {
    S.me = normalizeMe(user);
    S.servers = servers;
    S.dmChannels = dm_channels;
    S.presences = presences;
    S.voiceStates = voice_states || {};
    renderApp();
    const savedStatus = localStorage.getItem('da_status');
    if (savedStatus && savedStatus !== 'online') {
      newSocket.emit('UPDATE_STATUS', { status: savedStatus, custom_status: (S.me?.custom_status || '') });
    }
  });

  newSocket.on('MESSAGE_CREATE', (msg) => {
    if (!S.messages[msg.channel_id]) S.messages[msg.channel_id] = [];
    if (S.messages[msg.channel_id].some(m => m.id === msg.id)) return;
    S.messages[msg.channel_id].push(msg);
    if (msg.channel_id === S.activeChannelId) {
      appendMessage(msg);
      scrollToBottom();
    } else {
      S.unread[msg.channel_id] = (S.unread[msg.channel_id] || 0) + 1;
      renderChannelList();
      renderServerIcons();
      if (msg.author_id !== S.me?.id && window.NotifSound) {
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
      const el = document.querySelector(`[data-msg-id="${msg.id}"] .msg-content`);
      if (el) {
        const editedMark = msg.is_edited ? `<span class="msg-edited">${t('edited_short')}</span>` : '';
        el.innerHTML = parseMarkdown(msg.content || '') + editedMark;
      } else {
        renderMessages();
      }
    }
  });

  newSocket.on('MESSAGE_DELETE', ({ message_id, channel_id }) => {
    if (S.messages[channel_id]) {
      S.messages[channel_id] = S.messages[channel_id].filter(m => m.id !== message_id);
    }
    if (channel_id === S.activeChannelId) {
      const el = document.querySelector(`[data-msg-id="${message_id}"]`);
      el?.remove();
    }
  });

  newSocket.on('MESSAGE_REACTION_ADD', (data) => {
    updateReactions(data.message_id, data.channel_id, data.emoji, data.user_id, true);
  });
  newSocket.on('MESSAGE_REACTION_REMOVE', (data) => {
    updateReactions(data.message_id, data.channel_id, data.emoji, data.user_id, false);
  });

  newSocket.on('TYPING_START', ({ channel_id, user_id, username }) => {
    if (user_id === S.me?.id) return;
    if (!S.typingUsers[channel_id]) S.typingUsers[channel_id] = {};
    clearTimeout(S.typingUsers[channel_id][user_id]);
    S.typingUsers[channel_id][user_id] = setTimeout(() => {
      delete S.typingUsers[channel_id]?.[user_id];
      if (channel_id === S.activeChannelId) renderTyping();
    }, 3000);
    if (channel_id === S.activeChannelId) renderTyping();
  });

  newSocket.on('PRESENCE_UPDATE', ({ user_id, status, custom_status }) => {
    S.presences[user_id] = { status, custom_status };
    if (S.activeServerId && S.activeServerId !== '@me') renderMembersPanel();
    if (S.activeChannelId === 'friends') showFriendsView();
  });

  newSocket.on('FRIEND_REQUEST', (sender) => {
    S._friendRequestCount++;
    renderChannelList();
    if (window.NotifSound) window.NotifSound.play(sender.username, t('friend_requests'));
    showToast(`${sender.username} ${t('friend_added')}`, 'info');
  });

  newSocket.on('FRIEND_UPDATE', ({ user_id, status: fStatus }) => {
    if (fStatus === 'accepted') showToast(t('friend_accepted'), 'success');
    else if (fStatus === 'removed') showToast(t('friend_removed'), 'info');
    if (S.activeChannelId === 'friends') showFriendsView();
    loadFriendCount();
  });

  newSocket.on('MEMBER_JOIN', ({ server_id, member }) => {
    if (!S.members[server_id]) S.members[server_id] = [];
    if (!S.members[server_id].find(m => m.id === member.id)) {
      S.members[server_id].push(member);
    }
    if (S.activeServerId === server_id) renderMembersPanel();
  });

  newSocket.on('MEMBER_LEAVE', ({ server_id, user_id }) => {
    if (S.members[server_id]) {
      S.members[server_id] = S.members[server_id].filter(m => m.id !== user_id);
    }
    if (user_id === S.me?.id) {
      S.servers = S.servers.filter(s => s.id !== server_id);
      if (S.activeServerId === server_id) selectServer('@me');
      renderServerIcons();
    } else if (S.activeServerId === server_id) {
      renderMembersPanel();
    }
  });

  newSocket.on('MEMBER_UPDATE', ({ server_id, member }) => {
    if (!server_id || !member?.id) return;
    if (!S.members[server_id]) S.members[server_id] = [];
    const idx = S.members[server_id].findIndex(m => m.id === member.id);
    if (idx === -1) S.members[server_id].push(member);
    else S.members[server_id][idx] = { ...S.members[server_id][idx], ...member };

    if (S.activeServerId === server_id) {
      renderMembersPanel();
      if (S.activeChannelId && getChannel(S.activeChannelId)?.type === 'voice') renderVoicePanel();
      if (S.activeChannelId && getChannel(S.activeChannelId)?.type !== 'voice') renderMessages();
      renderChannelList();
      renderTyping();
    }
  });

  newSocket.on('CHANNEL_CREATE', (ch) => {
    if (ch.type === 'dm' || ch.type === 'group') {
      if (!S.dmChannels.find(c => c.id === ch.id)) S.dmChannels.push(ch);
      if (S.activeServerId === '@me') renderChannelList();
    } else if (ch.server_id) {
      const srv = getServer(ch.server_id);
      if (srv) {
        if (!srv.channels.find(c => c.id === ch.id)) srv.channels.push(ch);
        if (S.activeServerId === ch.server_id) renderChannelList();
      }
    }
  });

  newSocket.on('CHANNEL_UPDATE', (ch) => {
    const srv = getServer(ch.server_id);
    if (srv) {
      const idx = srv.channels.findIndex(c => c.id === ch.id);
      if (idx !== -1) srv.channels[idx] = ch;
      if (S.activeServerId === ch.server_id) renderChannelList();
    }
  });

  newSocket.on('CHANNEL_DELETE', ({ channel_id, server_id }) => {
    const srv = getServer(server_id);
    if (srv) {
      srv.channels = srv.channels.filter(c => c.id !== channel_id);
      if (S.activeChannelId === channel_id) {
        S.activeChannelId = null;
        showWelcomeScreen();
      }
      if (S.activeServerId === server_id) renderChannelList();
    }
  });

  newSocket.on('SERVER_UPDATE', (srv) => {
    const idx = S.servers.findIndex(s => s.id === srv.id);
    if (idx !== -1) {
      S.servers[idx] = { ...S.servers[idx], ...srv };
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
  newSocket.on('disconnect', () => console.log('[GW] disconnected'));

  newSocket.on('VOICE_STATE_UPDATE', ({ channel_id, voice_states }) => {
    S.voiceStates[channel_id] = voice_states;
    renderChannelList(); 
    if (S.activeChannelId === channel_id) renderVoicePanel();
    renderVoiceBar();
  });

  // Webrtc and mediasoup listeners... (will extract `voice.js` handling soon, but need to bring in `bindVoiceScreenVideos` maybe)
  newSocket.on('VOICE_READY', async ({ channel_id, peers }) => {
    for (const peer of peers) {
      // await createOffer(peer.user_id);
    }
  });

  newSocket.on('WEBRTC_ICE', async ({ from_user_id, candidate }) => {
    const pc = V.peers.get(from_user_id);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { }
    }
  });

  newSocket.on('voice:producer_added', async ({ producerId, user_id, kind, appData }) => {
    if (user_id === S.me?.id) return; 
    if (!V.channelId) return;
    try {
      const consumer = await VoiceClient.consumeTrack(producerId, V.channelId);
      if (!consumer) return;
      const stream = new MediaStream([consumer.track]);
      if (kind === 'audio') {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.muted = V.deafened;
        audio.dataset.userId = user_id;
        audio.dataset.producerId = producerId;
        document.body.appendChild(audio);
        V.audios.set(user_id, audio);
      } else if (kind === 'video') {
        V.remoteStreams.set(user_id, stream);
        renderVoicePanel();
      }
    } catch (err) { }
  });

  newSocket.on('voice:producer_removed', ({ producerId }) => {
    V.audios.forEach((audio, userId) => {
      if (audio.dataset?.producerId === producerId) {
        audio.srcObject = null;
        audio.remove();
        V.audios.delete(userId);
      }
    });

    V.remoteStreams.forEach((stream, userId) => {
      const tracks = stream.getTracks();
      if (tracks.length === 0 || tracks.every(t => t.readyState === 'ended')) {
        V.remoteStreams.delete(userId);
        renderVoicePanel();
      }
    });
  });

  return newSocket;
}
