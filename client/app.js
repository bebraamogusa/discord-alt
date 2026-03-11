/**
 * app.js — discord-alt v2 client
 * Vanilla JS, no frameworks.
 */
import * as API from '/api.js';
import { t, setLang, getLang, LANG_NAMES } from '/i18n.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
const S = {
  me: null,
  servers: [],
  dmChannels: [],
  activeServerId: null,
  activeChannelId: null,
  messages: {},
  members: {},
  presences: {},
  typingUsers: {},
  unread: {},
  replyTo: null,
  membersVisible: true,
  pendingChannelCreate: null,
  voiceStates: {},          // { channelId: [participant, ...] }
};

// Voice connection state
const V = {
  channelId: null,          // currently connected channel id
  muted: false,
  deafened: false,
  stream: null,             // local MediaStream
  peers: new Map(),         // userId → RTCPeerConnection
  audios: new Map(),        // userId → HTMLAudioElement
};

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ─── UTILITY ─────────────────────────────────────────────────────────────────
let socket = null;   // Socket.IO /gateway socket

const $ = id => document.getElementById(id);

function showToast(msg, type = '') {
  const t = $('toast');
  const iconMap = { success: '✅', error: '❌', info: 'ℹ️' };
  const icon = iconMap[type] || '💬';
  t.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(msg)}</span>`;
  t.className = `toast ${type}`;
  void t.offsetWidth;
  t.classList.add('visible');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('visible'), 3000);
}

// ─── CUSTOM DIALOGS ───────────────────────────────────────────────────────────
function daConfirm(message, { title, danger = false, confirmText, cancelText } = {}) {
  const _title   = title       || t('confirm_action');
  const _cancel  = cancelText  || t('cancel');
  const okText   = confirmText || (danger ? t('delete_btn') : t('confirm'));
  const okClass  = danger ? 'btn btn-danger-solid' : 'btn btn-accent';
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'da-dialog-overlay';
    overlay.innerHTML = `
      <div class="da-dialog-box" role="dialog" aria-modal="true">
        <div class="da-dialog-head"><h3>${escHtml(_title)}</h3></div>
        <div class="da-dialog-body"><p>${escHtml(message)}</p></div>
        <div class="da-dialog-foot">
          <button class="btn btn-outline" id="dac-cancel">${escHtml(_cancel)}</button>
          <button class="${okClass}" id="dac-ok">${escHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = res => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(res); };
    overlay.querySelector('#dac-cancel').onclick = () => cleanup(false);
    overlay.querySelector('#dac-ok').onclick     = () => cleanup(true);
    overlay.onclick = e => { if (e.target === overlay) cleanup(false); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter')  { e.preventDefault(); cleanup(true);  }
    };
    window.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('#dac-ok').focus(), 40);
  });
}

function daPrompt(message, { title, placeholder = '', confirmText, cancelText } = {}) {
  const _title   = title       || t('confirm_action');
  const _ok      = confirmText || t('ok');
  const _cancel  = cancelText  || t('cancel');
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'da-dialog-overlay';
    overlay.innerHTML = `
      <div class="da-dialog-box" role="dialog" aria-modal="true">
        <div class="da-dialog-head"><h3>${escHtml(_title)}</h3></div>
        <div class="da-dialog-body">
          <p>${escHtml(message)}</p>
          <input class="da-dialog-input" id="dap-input" type="text" placeholder="${escHtml(placeholder)}" autocomplete="off">
        </div>
        <div class="da-dialog-foot">
          <button class="btn btn-outline" id="dap-cancel">${escHtml(_cancel)}</button>
          <button class="btn btn-accent" id="dap-ok">${escHtml(_ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#dap-input');
    const cleanup = res => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(res); };
    overlay.querySelector('#dap-cancel').onclick = () => cleanup(null);
    overlay.querySelector('#dap-ok').onclick     = () => cleanup(input.value);
    overlay.onclick = e => { if (e.target === overlay) cleanup(null); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      if (e.key === 'Enter')  { e.preventDefault(); cleanup(input.value); }
    };
    window.addEventListener('keydown', onKey);
    setTimeout(() => input.focus(), 40);
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtTime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
}
function fmtDatetime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleString(getLang());
}

function parseMarkdown(text) {
  let s = escHtml(text);
  // code block
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  // inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // underline
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  // strikethrough
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // links (filter out javascript: protocol for XSS protection)
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // newlines
  s = s.replace(/\n/g, '<br>');
  return s;
}

function avatarEl(user, size = 32) {
  const u = user || {};
  if (u.avatar_url) {
    return `<img src="${escHtml(u.avatar_url)}" style="width:${size}px;height:${size}px" class="av-img">`;
  }
  const letter = (u.username || '?')[0].toUpperCase();
  const color  = u.avatar_color || '#5865f2';
  return `<div class="av-fallback" style="width:${size}px;height:${size}px;background:${escHtml(color)};font-size:${Math.round(size*0.4)}px">${escHtml(letter)}</div>`;
}

function statusDotHtml(userId, parentBg = 'var(--bg-2)') {
  const p = S.presences[userId];
  const st = p?.status || 'offline';
  return `<div class="status-dot ${st}" style="border-color:${parentBg}"></div>`;
}

function getServer(id) { return S.servers.find(s => s.id === id); }
function getChannel(id) {
  for (const srv of S.servers) {
    const ch = (srv.channels || []).find(c => c.id === id);
    if (ch) return ch;
  }
  return S.dmChannels.find(c => c.id === id);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function showAuth(view = 'login') {
  $('auth-overlay').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('auth-login').classList.toggle('hidden', view !== 'login');
  $('auth-register').classList.toggle('hidden', view !== 'register');
  // Clear all auth fields to prevent browser from restoring stale values
  ['li-email','li-pass','reg-email','reg-name','reg-pass'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  $('auth-login-err').textContent = '';
  $('auth-reg-err').textContent = '';
}
function hideAuth() {
  $('auth-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
}

async function doLogin() {
  $('auth-login-err').textContent = '';
  const email = $('li-email').value.trim();
  const password = $('li-pass').value;
  if (!email || !password) { $('auth-login-err').textContent = t('fill_fields'); return; }
  try {
    const data = await API.post('/api/auth/login', { email, password });
    API.setToken(data.token);
    API.setRefreshToken(data.refreshToken);
    S.me = data.user;
    await bootApp();
  } catch (e) {
    $('auth-login-err').textContent = e.body?.error || t('login_error');
  }
}

async function doRegister() {
  $('auth-reg-err').textContent = '';
  const email = $('reg-email').value.trim();
  const username = $('reg-name').value.trim();
  const password = $('reg-pass').value;
  if (!email || !username || !password) { $('auth-reg-err').textContent = t('fill_fields'); return; }
  try {
    const data = await API.post('/api/auth/register', { email, username, password });
    API.setToken(data.token);
    API.setRefreshToken(data.refreshToken);
    S.me = data.user;
    await bootApp();
  } catch (e) {
    $('auth-reg-err').textContent = e.body?.error || t('register_error');
  }
}

function doLogout() {
  const rt = localStorage.getItem('da_refresh');
  if (rt) API.post('/api/auth/logout', { refreshToken: rt }).catch(() => {});
  API.clearTokens();
  socket?.disconnect();
  socket = null;
  Object.assign(S, { me: null, servers: [], dmChannels: [], activeServerId: null, activeChannelId: null });
  showAuth('login');
}

// ─── SOCKET.IO GATEWAY ────────────────────────────────────────────────────────
function connectGateway() {
  // Load socket.io from the server
  const sio = window.io;
  if (!sio) { console.warn('socket.io not loaded'); return; }

  socket = sio('/gateway', { transports: ['websocket'] });

  socket.on('connect', () => {
    socket.emit('IDENTIFY', { token: API.getToken() });
  });

  socket.on('READY', ({ user, servers, dm_channels, presences, voice_states }) => {
    S.me = user;
    S.servers = servers;
    S.dmChannels = dm_channels;
    S.presences = presences;
    S.voiceStates = voice_states || {};
    renderApp();
  });

  socket.on('MESSAGE_CREATE', (msg) => {
    if (!S.messages[msg.channel_id]) S.messages[msg.channel_id] = [];
    if (S.messages[msg.channel_id].some(m => m.id === msg.id)) return; // dedup
    S.messages[msg.channel_id].push(msg);
    if (msg.channel_id === S.activeChannelId) {
      appendMessage(msg);
      scrollToBottom();
    } else {
      S.unread[msg.channel_id] = (S.unread[msg.channel_id] || 0) + 1;
      renderChannelList();
      renderServerIcons();
      // Notification sound for messages in other channels (not from self)
      if (msg.author_id !== S.me?.id) NotifSound.play(msg.author?.username, msg.content?.slice(0, 100));
    }
  });

  socket.on('MESSAGE_UPDATE', (msg) => {
    if (S.messages[msg.channel_id]) {
      const idx = S.messages[msg.channel_id].findIndex(m => m.id === msg.id);
      if (idx !== -1) S.messages[msg.channel_id][idx] = msg;
    }
    if (msg.channel_id === S.activeChannelId) renderMessages();
  });

  socket.on('MESSAGE_DELETE', ({ message_id, channel_id }) => {
    if (S.messages[channel_id]) {
      S.messages[channel_id] = S.messages[channel_id].filter(m => m.id !== message_id);
    }
    if (channel_id === S.activeChannelId) {
      const el = document.querySelector(`[data-msg-id="${message_id}"]`);
      el?.remove();
    }
  });

  socket.on('REACTION_ADD', ({ message_id, channel_id, reactions }) => {
    updateReactions(message_id, channel_id, reactions);
  });
  socket.on('REACTION_REMOVE', ({ message_id, channel_id, reactions }) => {
    updateReactions(message_id, channel_id, reactions);
  });

  socket.on('TYPING_START', ({ channel_id, user_id, username }) => {
    if (user_id === S.me?.id) return;
    if (!S.typingUsers[channel_id]) S.typingUsers[channel_id] = {};
    clearTimeout(S.typingUsers[channel_id][user_id]);
    S.typingUsers[channel_id][user_id] = setTimeout(() => {
      delete S.typingUsers[channel_id]?.[user_id];
      if (channel_id === S.activeChannelId) renderTyping();
    }, 3000);
    if (channel_id === S.activeChannelId) renderTyping();
  });

  socket.on('PRESENCE_UPDATE', ({ user_id, status, custom_status }) => {
    S.presences[user_id] = { status, custom_status };
    if (S.activeServerId && S.activeServerId !== '@me') renderMembersPanel();
  });

  socket.on('MEMBER_JOIN', ({ server_id, member }) => {
    if (!S.members[server_id]) S.members[server_id] = [];
    if (!S.members[server_id].find(m => m.id === member.user_id)) {
      S.members[server_id].push(member);
    }
    if (S.activeServerId === server_id) renderMembersPanel();
  });

  socket.on('MEMBER_LEAVE', ({ server_id, user_id }) => {
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

  socket.on('CHANNEL_CREATE', (ch) => {
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

  socket.on('CHANNEL_UPDATE', (ch) => {
    const srv = getServer(ch.server_id);
    if (srv) {
      const idx = srv.channels.findIndex(c => c.id === ch.id);
      if (idx !== -1) srv.channels[idx] = ch;
      if (S.activeServerId === ch.server_id) renderChannelList();
    }
  });

  socket.on('CHANNEL_DELETE', ({ channel_id, server_id }) => {
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

  socket.on('SERVER_UPDATE', (srv) => {
    const idx = S.servers.findIndex(s => s.id === srv.id);
    if (idx !== -1) {
      S.servers[idx] = { ...S.servers[idx], ...srv };
      renderServerIcons();
      if (S.activeServerId === srv.id) {
        $('sidebar-server-name').textContent = srv.name;
      }
    }
  });

  socket.on('SERVER_DELETE', ({ server_id }) => {
    S.servers = S.servers.filter(s => s.id !== server_id);
    if (S.activeServerId === server_id) selectServer('@me');
    renderServerIcons();
    showToast(t('server_deleted'), 'error');
  });

  socket.on('ERROR', ({ message }) => console.warn('[GW]', message));
  socket.on('disconnect', () => console.log('[GW] disconnected'));

  // ── VOICE events ──────────────────────────────────────────────────────────
  socket.on('VOICE_STATE_UPDATE', ({ channel_id, voice_states }) => {
    S.voiceStates[channel_id] = voice_states;
    renderChannelList(); // update participant counts
    if (S.activeChannelId === channel_id) renderVoicePanel();
    renderVoiceBar();
  });

  socket.on('VOICE_READY', async ({ channel_id, peers }) => {
    // We just joined; initiate WebRTC offer to each existing peer
    for (const peer of peers) {
      await createOffer(peer.user_id);
    }
  });

  socket.on('WEBRTC_OFFER', async ({ from_user_id, offer }) => {
    const pc = getOrCreatePeer(from_user_id);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('WEBRTC_ANSWER', { to_user_id: from_user_id, answer });
  });

  socket.on('WEBRTC_ANSWER', async ({ from_user_id, answer }) => {
    const pc = V.peers.get(from_user_id);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('WEBRTC_ICE', async ({ from_user_id, candidate }) => {
    const pc = V.peers.get(from_user_id);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });
}

// ─── VOICE ────────────────────────────────────────────────────────────────────
function getOrCreatePeer(userId) {
  if (V.peers.has(userId)) return V.peers.get(userId);
  const pc = new RTCPeerConnection(RTC_CONFIG);

  // Add local tracks
  if (V.stream) {
    V.stream.getTracks().forEach(track => pc.addTrack(track, V.stream));
  }

  // Forward ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('WEBRTC_ICE', { to_user_id: userId, candidate });
  };

  // Receive remote audio
  pc.ontrack = ({ streams }) => {
    let audio = V.audios.get(userId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      V.audios.set(userId, audio);
    }
    audio.srcObject = streams[0];
    if (V.deafened) audio.muted = true;
  };

  V.peers.set(userId, pc);
  return pc;
}

async function createOffer(userId) {
  const pc = getOrCreatePeer(userId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('WEBRTC_OFFER', { to_user_id: userId, offer });
}

function closePeer(userId) {
  const pc = V.peers.get(userId);
  if (pc) { pc.close(); V.peers.delete(userId); }
  const audio = V.audios.get(userId);
  if (audio) { audio.srcObject = null; V.audios.delete(userId); }
}

async function joinVoiceChannel(channelId) {
  if (V.channelId === channelId) return; // already connected
  if (V.channelId) await leaveVoiceChannel();

  try {
    V.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    showToast(t('voice_no_mic'), 'error');
    return;
  }

  V.channelId  = channelId;
  V.muted      = false;
  V.deafened   = false;
  socket.emit('VOICE_JOIN', { channel_id: channelId });
  renderVoiceBar();
  renderVoicePanel();
  renderChannelList();
  showToast(t('voice_connected'), 'success');
}

async function leaveVoiceChannel() {
  if (!V.channelId) return;
  socket.emit('VOICE_LEAVE');
  // Close all peer connections
  for (const uid of V.peers.keys()) closePeer(uid);
  if (V.stream) { V.stream.getTracks().forEach(t => t.stop()); V.stream = null; }
  const prev = V.channelId;
  V.channelId = null;
  renderVoiceBar();
  if (S.activeChannelId === prev) renderVoicePanel();
  renderChannelList();
  showToast(t('voice_disconnected'));
}

function toggleVoiceMute() {
  V.muted = !V.muted;
  if (V.stream) V.stream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
  socket.emit('VOICE_MUTE', { muted: V.muted });
  renderVoiceBar();
}

function toggleVoiceDeafen() {
  V.deafened = !V.deafened;
  V.audios.forEach(audio => { audio.muted = V.deafened; });
  if (V.deafened && !V.muted) {
    V.muted = true;
    if (V.stream) V.stream.getAudioTracks().forEach(t => { t.enabled = false; });
    socket.emit('VOICE_MUTE', { muted: true });
  } else if (!V.deafened) {
    V.muted = false;
    if (V.stream) V.stream.getAudioTracks().forEach(t => { t.enabled = true; });
    socket.emit('VOICE_MUTE', { muted: false });
  }
  renderVoiceBar();
}

function renderVoiceBar() {
  const bar = $('voice-connected-bar');
  if (!bar) return;
  if (!V.channelId) {
    bar.classList.add('hidden');
    return;
  }
  const ch = getChannel(V.channelId);
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="vcb-info">
      <div class="vcb-status">
        <span class="vcb-dot"></span>
        <span class="vcb-name">${escHtml(ch?.name || 'Voice')}</span>
      </div>
      <div class="vcb-sub">${t('voice_active')}</div>
    </div>
    <div class="vcb-actions">
      <button class="vcb-btn ${V.muted ? 'active' : ''}" id="vcb-mute" title="${V.muted ? t('voice_unmute') : t('voice_mute')}">
        ${V.muted
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>'}
      </button>
      <button class="vcb-btn ${V.deafened ? 'active' : ''}" id="vcb-deaf" title="${V.deafened ? t('voice_undeafen') : t('voice_deafen')}">
        ${V.deafened
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>'}
      </button>
      <button class="vcb-btn danger" id="vcb-leave" title="${t('voice_disconnect')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
      </button>
    </div>
  `;
  $('vcb-mute')?.addEventListener('click', toggleVoiceMute);
  $('vcb-deaf')?.addEventListener('click', toggleVoiceDeafen);
  $('vcb-leave')?.addEventListener('click', leaveVoiceChannel);
}

function renderVoicePanel() {
  const ch = getChannel(S.activeChannelId);
  if (!ch || ch.type !== 'voice') return;

  const participants = S.voiceStates[ch.id] || [];
  const inVoice = V.channelId === ch.id;

  // Replace messages area with voice panel
  $('messages-wrapper').classList.add('hidden');
  $('input-area').classList.add('hidden');
  $('voice-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'voice-panel';
  panel.className = 'voice-panel';
  panel.innerHTML = `
    <div class="vp-header">
      <div class="vp-icon">🔊</div>
      <h2>${escHtml(ch.name)}</h2>
      <div class="vp-sub">${participants.length > 0 ? t('voice_participants', { n: participants.length }) : t('voice_empty')}</div>
    </div>
    <div class="vp-participants">
      ${participants.map(p => `
        <div class="vp-participant">
          <div class="vp-av" style="background:${escHtml(p.avatar_color || '#5865f2')}">
            ${p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : escHtml((p.username||'?')[0].toUpperCase())}
            ${p.muted ? '<div class="vp-muted-badge">🔇</div>' : ''}
          </div>
          <div class="vp-name">${escHtml(p.username)}</div>
          ${p.user_id === V.channelId ? `<div class="vp-you">${t('voice_you')}</div>` : ''}
        </div>
      `).join('')}
    </div>
    ${!inVoice ? `
      <button class="btn btn-primary vp-join-btn" id="vp-join">
        ${t('voice_join')}
      </button>
    ` : `
      <div class="vp-controls">
        <button class="btn ${V.muted ? 'btn-danger-solid' : 'btn-outline'}" id="vp-mute">
          ${V.muted ? `🔇 ${t('voice_unmute')}` : `🎤 ${t('voice_mute')}`}
        </button>
        <button class="btn ${V.deafened ? 'btn-danger-solid' : 'btn-outline'}" id="vp-deaf">
          ${V.deafened ? `🔊 ${t('voice_undeafen')}` : `🔈 ${t('voice_deafen')}`}
        </button>
        <button class="btn btn-danger-solid" id="vp-leave">${t('voice_disconnect')}</button>
      </div>
    `}
  `;

  $('main').insertBefore(panel, $('messages-wrapper'));
  $('vp-join')?.addEventListener('click', () => joinVoiceChannel(ch.id));
  $('vp-mute')?.addEventListener('click', toggleVoiceMute);
  $('vp-deaf')?.addEventListener('click', toggleVoiceDeafen);
  $('vp-leave')?.addEventListener('click', leaveVoiceChannel);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function bootApp() {
  hideAuth();
  updateSidebarUser();
  connectGateway();
  // Gateway READY event will call renderApp()
  // Set a fallback in case gateway is slow
  setTimeout(() => {
    if (!S.servers.length && !S.dmChannels.length) renderApp();
  }, 2000);
}

function renderApp() {
  updateSidebarUser();
  renderServerIcons();
  selectServer('@me');
}

// ─── SIDEBAR USER ─────────────────────────────────────────────────────────────
function updateSidebarUser() {
  if (!S.me) return;
  $('su-username').textContent = S.me.username;
  $('su-custom-status').textContent = S.me.custom_status || '';
  if (S.me.avatar_url) {
    $('su-av-wrapper').innerHTML = `<img src="${escHtml(S.me.avatar_url)}" style="width:32px;height:32px;border-radius:50%" id="su-avatar">${statusDotHtml(S.me.id, 'var(--bg-3)')}`;
  } else {
    const letter = (S.me.username || '?')[0].toUpperCase();
    $('su-av-wrapper').innerHTML = `<div class="av-fallback" id="su-avatar" style="width:32px;height:32px;font-size:13px;background:${S.me.avatar_color||'#5865f2'}">${letter}</div>${statusDotHtml(S.me.id, 'var(--bg-3)')}`;
  }
}

// ─── SERVER LIST ──────────────────────────────────────────────────────────────
function renderServerIcons() {
  const container = $('server-icons');
  container.innerHTML = '';
  for (const srv of S.servers) {
    const unreadCount = Object.entries(S.unread).reduce((sum, [cid, n]) => sum + (n > 0 && srv.channels?.find(c => c.id === cid) ? n : 0), 0);
    const hasUnread = unreadCount > 0;
    const active = S.activeServerId === srv.id;
    const letter = srv.name[0].toUpperCase();
    container.insertAdjacentHTML('beforeend', `
      <div class="tooltip-wrapper">
        <div class="server-icon ${active ? 'active' : ''}" data-server-id="${escHtml(srv.id)}">
          ${srv.icon_url
            ? `<img src="${escHtml(srv.icon_url)}" alt="${escHtml(srv.name)}">`
            : escHtml(letter)}
          <div class="pill"></div>
          ${hasUnread && !active ? `<div class="unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</div>` : ''}
        </div>
        <div class="tooltip-label">${escHtml(srv.name)}</div>
      </div>
    `);
  }
  if (S.servers.length) $('server-list-divider2').classList.remove('hidden');
  else $('server-list-divider2').classList.add('hidden');

  container.querySelectorAll('.server-icon').forEach(el => {
    el.addEventListener('click', () => selectServer(el.dataset.serverId));
    el.addEventListener('contextmenu', e => { e.preventDefault(); showServerContextMenu(e, el.dataset.serverId); });
  });

  // Update home icon active state
  $('btn-home').classList.toggle('active', S.activeServerId === '@me');
}

// ─── SELECT SERVER / DM ───────────────────────────────────────────────────────
async function selectServer(id) {
  S.activeServerId = id;
  S.activeChannelId = null;
  renderServerIcons();

  if (id === '@me') {
    $('sidebar-server-name').textContent = t('direct_messages');
    $('sidebar-header-arrow').style.display = 'none';
    hideServerDropdown();
    renderChannelList();
    showWelcomeScreen();
  } else {
    const srv = getServer(id);
    if (!srv) return;
    $('sidebar-server-name').textContent = srv.name;
    $('sidebar-header-arrow').style.display = '';
    renderChannelList();
    showWelcomeScreen();
    // Load members
    if (!S.members[id] || !S.members[id].length) {
      try {
        S.members[id] = await API.get(`/api/servers/${id}/members`);
      } catch {}
    }
    // Auto-join first text channel
    const firstCh = srv.channels?.find(c => c.type === 'text');
    if (firstCh) selectChannel(firstCh.id);
  }
}

// ─── CHANNEL LIST ─────────────────────────────────────────────────────────────
function renderChannelList() {
  const el = $('sidebar-channel-list');
  el.innerHTML = '';

  if (S.activeServerId === '@me') {
    // DM mode
    el.insertAdjacentHTML('beforeend', `
      <div class="dm-header">
        <span>${t('direct_messages')}</span>
        <button id="btn-new-dm" title="${t('new_message')}">＋</button>
      </div>
    `);
    for (const ch of S.dmChannels) {
      const isActive = ch.id === S.activeChannelId;
      const name = ch.type === 'dm'
        ? (ch.recipient?.username || t('user_fallback'))
        : (ch.name || t('group_chat'));
      const user = ch.type === 'dm' ? ch.recipient : null;
      const status = user ? (S.presences[user.id]?.status || 'offline') : '';
      el.insertAdjacentHTML('beforeend', `
        <div class="dm-item ${isActive ? 'active' : ''}" data-ch-id="${escHtml(ch.id)}">
          <div class="dm-avatar">
            ${avatarEl(user, 32)}
            ${user ? statusDotHtml(user.id) : ''}
          </div>
          <div class="dm-info">
            <div class="dm-name">${escHtml(name)}</div>
            <div class="dm-preview">${escHtml((ch.last_message || '').slice(0, 40))}</div>
          </div>
        </div>
      `);
    }
    el.querySelectorAll('.dm-item').forEach(e => {
      e.addEventListener('click', () => selectChannel(e.dataset.chId));
    });
    el.querySelector('#btn-new-dm')?.addEventListener('click', showNewDmModal);
    return;
  }

  // Server mode
  const srv = getServer(S.activeServerId);
  if (!srv) return;

  // Group channels by category
  const cats = (srv.categories || []).slice().sort((a, b) => a.position - b.position);
  const channels = (srv.channels || []).slice().sort((a, b) => a.position - b.position);

  // Uncategorized channels first
  const uncategorized = channels.filter(c => !c.category_id && c.type !== 'voice').concat(
    channels.filter(c => !c.category_id && c.type === 'voice')
  );
  renderChannelGroup(el, null, uncategorized, srv);

  for (const cat of cats) {
    const chans = channels.filter(c => c.category_id === cat.id);
    renderChannelGroup(el, cat, chans, srv);
  }
}

function renderChannelGroup(container, cat, channels, srv) {
  if (cat) {
    container.insertAdjacentHTML('beforeend', `
      <div class="category-row" data-cat-id="${escHtml(cat.id)}">
        <span>▸</span>
        <span class="category-name">${escHtml(cat.name)}</span>
        <button class="category-add" data-cat-id="${escHtml(cat.id)}" title="${t('create_channel')}">＋</button>
      </div>
    `);
  }
  for (const ch of channels) {
    const icon = ch.type === 'voice' ? '🔊' : ch.type === 'announcement' ? '📣' : '#';
    const isActive = ch.id === S.activeChannelId;
    const unread = S.unread[ch.id] || 0;
    const voiceParticipants = S.voiceStates[ch.id] || [];
    const isConnected = V.channelId === ch.id;

    container.insertAdjacentHTML('beforeend', `
      <div class="channel-item ${isActive ? 'active' : ''} ${unread && !isActive ? 'unread' : ''} ${isConnected ? 'voice-active' : ''}"
           data-ch-id="${escHtml(ch.id)}" data-ch-type="${ch.type}">
        <span class="ch-icon">${icon}</span>
        <span class="ch-name">${escHtml(ch.name)}</span>
        ${voiceParticipants.length > 0 ? `<span class="ch-voice-count">${voiceParticipants.length}</span>` : ''}
      </div>
      ${voiceParticipants.length > 0 ? `
        <div class="ch-voice-users">
          ${voiceParticipants.map(p => `
            <div class="ch-voice-user ${p.muted ? 'muted' : ''}">
              <span class="ch-voice-av" style="background:${escHtml(p.avatar_color||'#5865f2')}">${escHtml((p.username||'?')[0].toUpperCase())}</span>
              <span>${escHtml(p.username)}</span>
              ${p.muted ? '<span class="ch-voice-muted">🔇</span>' : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    `);
  }

  container.querySelectorAll('.channel-item').forEach(e => {
    e.addEventListener('click', () => selectChannel(e.dataset.chId));
    e.addEventListener('contextmenu', ev => { ev.preventDefault(); showChannelContextMenu(ev, e.dataset.chId); });
  });
  container.querySelectorAll('.category-add').forEach(e => {
    e.addEventListener('click', ev => {
      ev.stopPropagation();
      openCreateChannelModal(srv.id, e.dataset.catId);
    });
  });
}

// ─── SELECT CHANNEL ───────────────────────────────────────────────────────────
async function selectChannel(id) {
  S.activeChannelId = id;
  S.unread[id] = 0;
  renderChannelList();
  // Notify mobile layout to close sidebar
  document.dispatchEvent(new CustomEvent('da:channel-selected'));

  const ch = getChannel(id);
  if (!ch) return;

  // Voice channel: show voice panel instead of text chat
  if (ch.type === 'voice') {
    $('welcome-screen').classList.add('hidden');
    $('chat-header').classList.remove('hidden');
    $('messages-wrapper').classList.add('hidden');
    $('typing-indicator').classList.add('hidden');
    $('input-area').classList.add('hidden');
    $('members-panel').classList.add('hidden');
    $('chat-ch-icon').textContent = '🔊';
    $('chat-ch-name').textContent = ch.name;
    $('chat-ch-topic').textContent = ch.topic || '';
    renderVoicePanel();
    return;
  }

  // Show chat UI — remove voice panel if present
  $('voice-panel')?.remove();
  $('welcome-screen').classList.add('hidden');
  $('chat-header').classList.remove('hidden');
  $('messages-wrapper').classList.remove('hidden');
  $('typing-indicator').classList.remove('hidden');
  $('input-area').classList.remove('hidden');

  // Update header
  const icon = ch.type === 'dm' ? '@' : ch.type === 'announcement' ? '📣' : '#';
  $('chat-ch-icon').textContent = icon;
  if (ch.type === 'dm') {
    $('chat-ch-name').textContent = ch.recipient?.username || t('direct_messages');
  } else {
    $('chat-ch-name').textContent = ch.name;
  }
  $('chat-ch-topic').textContent = ch.topic || '';

  // Update input placeholder
  $('msg-input').placeholder = ch.type === 'dm'
    ? t('msg_placeholder_dm', { name: ch.recipient?.username || 'user' })
    : t('msg_placeholder_channel', { name: ch.name });

  // Show members panel only for server channels
  if (S.membersVisible && S.activeServerId !== '@me') {
    $('members-panel').classList.remove('hidden');
    renderMembersPanel();
  } else {
    $('members-panel').classList.add('hidden');
  }

  // Clear reply
  cancelReply();

  // Load messages
  if (!S.messages[id]) {
    await loadMessages(id);
  } else {
    renderMessages();
    scrollToBottom();
  }

  // Mark as read
  if (S.messages[id]?.length) {
    const lastId = S.messages[id][S.messages[id].length - 1]?.id;
    if (lastId) socket?.emit('READ_ACK', { channel_id: id, message_id: lastId });
  }

  $('msg-input').focus();
}

function showWelcomeScreen() {
  $('voice-panel')?.remove();
  $('welcome-screen').classList.remove('hidden');
  $('welcome-screen').innerHTML = `
    <div class="welcome-icon">💬</div>
    <div class="welcome-title">${escHtml(t('welcome_title'))}</div>
    <div class="welcome-sub">${escHtml(t('welcome_sub'))}</div>
    <div class="welcome-shortcuts">
      <div class="welcome-tip"><span class="tip-icon">🔍</span><span class="tip-text"><kbd>Ctrl+K</kbd> — ${escHtml(t('tip_search'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">💬</span><span class="tip-text"><kbd>Enter</kbd> — ${escHtml(t('tip_send'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">📎</span><span class="tip-text">${escHtml(t('tip_drag'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">⚙️</span><span class="tip-text">${escHtml(t('tip_settings'))}</span></div>
    </div>
  `;
  $('chat-header').classList.add('hidden');
  $('messages-wrapper').classList.add('hidden');
  $('typing-indicator').classList.add('hidden');
  $('input-area').classList.add('hidden');
  $('members-panel').classList.add('hidden');
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
async function loadMessages(channelId, before = null) {
  try {
    const url = before
      ? `/api/channels/${channelId}/messages?limit=50&before=${before}`
      : `/api/channels/${channelId}/messages?limit=50`;
    const msgs = await API.get(url);
    if (!before) {
      S.messages[channelId] = msgs;
      renderMessages();
      scrollToBottom();
    } else {
      S.messages[channelId] = [...msgs, ...(S.messages[channelId] || [])];
      renderMessages();
    }
    $('messages-load-more').classList.toggle('hidden', msgs.length < 50);
  } catch (e) {
    showToast(t('error_load'), 'error');
  }
}

function renderMessages() {
  const container = $('messages-container');
  container.innerHTML = '';
  const msgs = S.messages[S.activeChannelId] || [];
  let lastAuthor = null, lastTs = 0;
  for (const msg of msgs) {
    const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
      ? msg.created_at * 1000 : msg.created_at;
    const sameAuthor = lastAuthor === msg.author_id && (ts - lastTs) < 5 * 60 * 1000;
    container.insertAdjacentHTML('beforeend', msgHtml(msg, !sameAuthor));
    lastAuthor = msg.author_id;
    lastTs = ts;
  }
  attachMsgHandlers(container);
}

function appendMessage(msg) {
  const container = $('messages-container');
  const msgs = S.messages[S.activeChannelId] || [];
  const prev = msgs[msgs.length - 2];
  const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
    ? msg.created_at * 1000 : msg.created_at;
  const prevTs = prev ? (typeof prev.created_at === 'number' && prev.created_at < 1e12
    ? prev.created_at * 1000 : prev.created_at) : 0;
  const isFirst = !prev || prev.author_id !== msg.author_id || (ts - prevTs) > 5 * 60 * 1000;
  container.insertAdjacentHTML('beforeend', msgHtml(msg, isFirst));
  attachMsgHandlers(container);
}

function msgHtml(msg, isFirst) {
  if (msg.type === 'system' || msg.type === 'server_join') {
    return `<div class="msg-system" data-msg-id="${msg.id}">👋 ${escHtml(msg.content)}</div>`;
  }
  const author = msg.author || {};
  const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
    ? msg.created_at * 1000 : msg.created_at;

  let headerHtml = '';
  if (isFirst) {
    headerHtml = `
      <div class="msg-group-header">
        <div class="msg-avatar-col">
          <div class="msg-av-fallback" style="background:${escHtml(author.avatar_color||'#5865f2')}"
               data-user-id="${escHtml(author.id)}" style="cursor:pointer">
            ${author.avatar_url
              ? `<img class="msg-avatar" src="${escHtml(author.avatar_url)}" data-user-id="${escHtml(author.id)}">`
              : (author.username||'?')[0].toUpperCase()}
          </div>
        </div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-username" data-user-id="${escHtml(author.id)}">${escHtml(author.username||t('unknown_user'))}</span>
            <span class="msg-time">${fmtTime(ts)}</span>
          </div>
    `;
  } else {
    headerHtml = `<div class="msg-body" style="padding-left:52px"><span class="msg-hover-time">${fmtTime(ts)}</span>`;
  }

  let replyHtml = '';
  if (isFirst && msg.reply_to && msg.reply_to_id) {
    replyHtml = `
      <div class="msg-reply" data-reply-msg="${escHtml(msg.reply_to_id)}">
        <span class="reply-author">${escHtml(msg.reply_to.author?.username||'?')}</span>
        <span class="reply-content">${escHtml((msg.reply_to.content||'').slice(0,80))}</span>
      </div>
    `;
  }

  const atts = (msg.attachments || []).map(a => {
    const ext = a.url.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','avif'].includes(ext))
      return `<img class="att-image" src="${escHtml(a.url)}" loading="lazy" data-lightbox="${escHtml(a.url)}">`;
    if (['mp4','webm','mov'].includes(ext))
      return `<video class="att-video" src="${escHtml(a.url)}" controls></video>`;
    if (['mp3','ogg','wav','flac','aac'].includes(ext))
      return `<audio src="${escHtml(a.url)}" controls style="margin-top:4px"></audio>`;
    return `<a class="att-file" href="${escHtml(a.url)}" download="${escHtml(a.filename||'file')}">📎 ${escHtml(a.filename||'file')}</a>`;
  }).join('');

  const reactions = (msg.reactions || []).map(r => `
    <button class="reaction-btn ${r.me ? 'me' : ''}" data-msg-id="${escHtml(msg.id)}" data-emoji="${escHtml(r.emoji)}">
      ${escHtml(r.emoji)} <span class="reaction-count">${r.count}</span>
    </button>
  `).join('');

  const editedMark = msg.is_edited ? `<span class="msg-edited">${t('edited_short')}</span>` : '';
  const isMine = msg.author_id === S.me?.id;

  const actionsHtml = `
    <div class="msg-actions">
      <button class="msg-action-btn" data-action="react" data-msg-id="${escHtml(msg.id)}" title="${t('react')}">😀</button>
      <button class="msg-action-btn" data-action="reply" data-msg-id="${escHtml(msg.id)}"
              data-username="${escHtml(author.username||'')}"
              data-content="${escHtml((msg.content||'').slice(0,100))}" title="${t('reply')}">↩</button>
      ${isMine ? `<button class="msg-action-btn" data-action="edit" data-msg-id="${escHtml(msg.id)}" title="${t('edit')}">✏</button>` : ''}
      ${isMine ? `<button class="msg-action-btn danger" data-action="delete" data-msg-id="${escHtml(msg.id)}" title="${t('delete')}">🗑</button>` : ''}
    </div>
  `;

  const closeHeader = isFirst ? `</div></div>` : `</div>`;

  return `
    <div class="msg-group ${isFirst ? 'first-in-group' : 'continued'}" data-msg-id="${msg.id}">
      ${actionsHtml}
      ${replyHtml}
      ${headerHtml}
        <div class="msg-content" id="msg-content-${msg.id}">${parseMarkdown(msg.content||'')}${editedMark}</div>
        ${atts ? `<div class="msg-attachments">${atts}</div>` : ''}
        ${reactions ? `<div class="msg-reactions">${reactions}</div>` : ''}
      ${closeHeader}
    </div>
  `;
}

function attachMsgHandlers(container) {
  // Message actions
  container.querySelectorAll('.msg-action-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgId;
      if (action === 'reply') {
        setReply(msgId, btn.dataset.username, btn.dataset.content);
      } else if (action === 'edit') {
        startEditMessage(msgId);
      } else if (action === 'delete') {
        confirmDeleteMessage(msgId);
      } else if (action === 'react') {
        showQuickReactPicker(btn, msgId);
      }
    };
  });

  // Reactions
  container.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => toggleReaction(btn.dataset.msgId, btn.dataset.emoji);
  });

  // Username / avatar clicks → profile card
  container.querySelectorAll('[data-user-id]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      showProfileCard(el.dataset.userId, el);
    };
  });

  // Image lightbox
  container.querySelectorAll('[data-lightbox]').forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(el.dataset.lightbox);
    };
  });
}

function updateReactions(msgId, channelId, reactions) {
  if (channelId !== S.activeChannelId) return;
  const group = document.querySelector(`[data-msg-id="${msgId}"].msg-group`);
  if (!group) return;
  let reactDiv = group.querySelector('.msg-reactions');
  if (!reactDiv) {
    group.querySelector('.msg-body, .msg-content')?.insertAdjacentHTML('afterend', '<div class="msg-reactions"></div>');
    reactDiv = group.querySelector('.msg-reactions');
  }
  if (!reactDiv) return;
  reactDiv.innerHTML = reactions.map(r => `
    <button class="reaction-btn ${r.me ? 'me' : ''}" data-msg-id="${escHtml(msgId)}" data-emoji="${escHtml(r.emoji)}">
      ${escHtml(r.emoji)} <span class="reaction-count">${r.count}</span>
    </button>
  `).join('');
  reactDiv.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => toggleReaction(btn.dataset.msgId, btn.dataset.emoji);
  });
}

async function toggleReaction(msgId, emoji) {
  try {
    await API.post(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
  } catch {
    await API.del(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
  }
}

function scrollToBottom(smooth = false) {
  const el = $('messages-wrapper');
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

// ─── QUICK REACT / EMOJI PICKER ──────────────────────────────────────────────
const QUICK_EMOJIS = ['👍','👎','❤️','😂','😮','😢','🎉','🔥','✅','❌','⭐','🚀','👀','💯','🤔','🙌'];
const EMOJI_LIST   = ['😀','😂','😍','😎','🥺','😭','😡','🤔','🙏','👍','👎','❤️','🔥','✅','❌','⭐',
  '🎉','🚀','💯','🤩','😴','🥳','😤','🤣','😱','🥰','🤯','😏','🙈','🎮','🎵','🍕','☕','🌟','💎','🏆'];

function showQuickReactPicker(btn, msgId) {
  let existing = document.querySelector('.quick-react-popup');
  existing?.remove();
  const popEl = document.createElement('div');
  popEl.className = 'quick-react-popup';
  popEl.style.cssText = 'position:absolute;z-index:200;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:6px;display:flex;gap:2px;box-shadow:var(--shadow)';
  QUICK_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.style.cssText = 'background:none;border:none;font-size:20px;cursor:pointer;padding:4px;border-radius:4px';
    b.textContent = em;
    b.onmouseenter = () => b.style.background = 'var(--bg-hover)';
    b.onmouseleave = () => b.style.background = '';
    b.onclick = () => { toggleReaction(msgId, em); popEl.remove(); };
    popEl.appendChild(b);
  });
  const rect = btn.getBoundingClientRect();
  popEl.style.left = rect.left + 'px';
  popEl.style.top  = (rect.bottom + 4) + 'px';
  document.body.appendChild(popEl);
  const close = e => { if (!popEl.contains(e.target)) { popEl.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function setupEmojiPicker() {
  const picker = $('emoji-picker');
  EMOJI_LIST.forEach(em => {
    const btn = document.createElement('button');
    btn.textContent = em;
    btn.onclick = () => {
      const txt = $('msg-input');
      const pos = txt.selectionStart;
      txt.value = txt.value.slice(0, pos) + em + txt.value.slice(pos);
      txt.focus();
      picker.classList.add('hidden');
    };
    picker.appendChild(btn);
  });
  $('btn-emoji').addEventListener('click', e => {
    e.stopPropagation();
    picker.classList.toggle('hidden');
  });
  document.addEventListener('click', () => picker.classList.add('hidden'));
}

// ─── TYPING ───────────────────────────────────────────────────────────────────
let _typingSent = false;
let _typingTimer = null;

function renderTyping() {
  const el = $('typing-indicator');
  const users = S.typingUsers[S.activeChannelId] || {};
  const names = Object.keys(users).map(uid => {
    const m = S.members[S.activeServerId]?.find(m => m.id === uid);
    return m?.username || uid;
  });
  if (!names.length) { el.textContent = ''; return; }
  if (names.length === 1) el.innerHTML = `<span>${escHtml(names[0])}</span> ${t('typing_singular')}`;
  else el.innerHTML = `<span>${names.slice(0, 3).map(escHtml).join(', ')}</span> ${t('typing_plural')}`;
}

function sendTyping() {
  if (!_typingSent && S.activeChannelId) {
    socket?.emit('TYPING_START', { channel_id: S.activeChannelId });
    _typingSent = true;
    clearTimeout(_typingTimer);
    _typingTimer = setTimeout(() => { _typingSent = false; }, 2500);
  }
}

// ─── REPLY ────────────────────────────────────────────────────────────────────
function setReply(msgId, username, content) {
  S.replyTo = { id: msgId, username, content };
  $('reply-name').textContent = username;
  $('reply-preview').textContent = content.slice(0, 80);
  $('reply-bar').classList.add('visible');
  $('msg-input').focus();
}
function cancelReply() {
  S.replyTo = null;
  $('reply-bar').classList.remove('visible');
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = $('msg-input');
  const content = input.value.trim();
  if (!content || !S.activeChannelId) return;
  input.value = '';
  input.style.height = '';
  input.dispatchEvent(new Event('input'));

  try {
    await API.post(`/api/channels/${S.activeChannelId}/messages`, {
      content,
      reply_to_id: S.replyTo?.id || null,
    });
    cancelReply();
  } catch (e) {
    showToast(e.body?.error || t('error_send'), 'error');
    input.value = content;
  }
  _typingSent = false;
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
async function uploadAndSend(file) {
  if (!S.activeChannelId) return;
  const bar = document.createElement('div');
  bar.className = 'upload-progress';
  bar.innerHTML = `📎 ${escHtml(file.name)} <div class="upload-bar"><div class="upload-fill" id="uf-${file.name}" style="width:0%"></div></div>`;
  $('input-area').prepend(bar);
  try {
    const data = await API.uploadFile(file, (p) => {
      const fill = document.getElementById(`uf-${file.name}`);
      if (fill) fill.style.width = Math.round(p * 100) + '%';
    });
    bar.remove();
    await API.post(`/api/channels/${S.activeChannelId}/messages`, {
      content: '',
      attachments: [{ url: data.url, filename: file.name, size: file.size, mime_type: file.type }],
    });
  } catch (e) {
    bar.remove();
    showToast(e.message || t('error_upload'), 'error');
  }
}

// ─── EDIT MESSAGE ─────────────────────────────────────────────────────────────
function startEditMessage(msgId) {
  const msg = S.messages[S.activeChannelId]?.find(m => m.id === msgId);
  if (!msg) return;
  const contentEl = $(`msg-content-${msgId}`);
  if (!contentEl) return;
  const original = msg.content;
  contentEl.innerHTML = `
    <textarea class="msg-edit-area" id="edit-ta-${msgId}">${escHtml(original)}</textarea>
    <div class="msg-edit-hints">${t('edit_hint')}</div>
  `;
  const ta = document.getElementById(`edit-ta-${msgId}`);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newContent = ta.value.trim();
      if (newContent && newContent !== original) {
        try {
          await API.patch(`/api/messages/${msgId}`, { content: newContent });
        } catch (err) {
          showToast(err.body?.error || t('error_generic'), 'error');
        }
      } else {
        contentEl.innerHTML = parseMarkdown(original);
      }
    } else if (e.key === 'Escape') {
      contentEl.innerHTML = parseMarkdown(original);
    }
  });
}

async function confirmDeleteMessage(msgId) {
  if (!await daConfirm(t('confirm_delete_message'), { title: t('confirm_delete_message_title'), danger: true })) return;
  try {
    await API.del(`/api/messages/${msgId}`);
  } catch (e) {
    showToast(e.body?.error || t('error_generic'), 'error');
  }
}

// ─── MEMBERS PANEL ────────────────────────────────────────────────────────────
function renderMembersPanel() {
  const panel = $('members-panel');
  const srv = getServer(S.activeServerId);
  if (!srv || S.activeServerId === '@me') { panel.classList.add('hidden'); return; }

  const members = S.members[S.activeServerId] || [];
  const online  = members.filter(m => (S.presences[m.id]?.status || 'offline') !== 'offline');
  const offline = members.filter(m => (S.presences[m.id]?.status || 'offline') === 'offline');

  let html = '';
  if (online.length) {
    html += `<div class="members-section-title">${t('members_online', { n: online.length })}</div>`;
    for (const m of online) html += memberItemHtml(m, 'var(--bg-2)');
  }
  if (offline.length) {
    html += `<div class="members-section-title mt-8">${t('members_offline', { n: offline.length })}</div>`;
    for (const m of offline) html += memberItemHtml(m, 'var(--bg-2)');
  }
  panel.innerHTML = html;
  panel.querySelectorAll('.member-item').forEach(el => {
    el.onclick = e => showProfileCard(el.dataset.userId, el);
  });
}

function memberItemHtml(m, bg) {
  const p = S.presences[m.id] || {};
  const status = p.status || 'offline';
  const color = m.roles?.[0]?.color || '';
  return `
    <div class="member-item" data-user-id="${escHtml(m.id)}">
      <div class="mem-av">
        ${avatarEl(m, 32)}
        <div class="status-dot ${status}" style="border-color:${bg}"></div>
      </div>
      <div class="mem-info">
        <div class="mem-name" style="${color ? `color:${color}` : ''}">${escHtml(m.nickname || m.username)}</div>
        ${p.custom_status ? `<div class="mem-role">${escHtml(p.custom_status)}</div>` : ''}
      </div>
    </div>
  `;
}

// ─── PROFILE CARD ─────────────────────────────────────────────────────────────
async function showProfileCard(userId, anchorEl) {
  closeContextMenu();
  closeProfileCard();

  let user = S.members[S.activeServerId]?.find(m => m.id === userId);
  if (!user) {
    try { user = await API.get(`/api/users/${userId}`).catch(() => null); } catch {}
  }
  if (!user) return;

  const p = S.presences[userId] || {};
  const status = p.status || 'offline';
  const isSelf = userId === S.me?.id;
  const banner = user.banner_url || '';
  const bannerStyle = banner ? `background:url(${escHtml(banner)}) center/cover` : `background:${user.banner_color || user.avatar_color || '#5865f2'}`;

  const card = $('profile-card-popup');
  card.innerHTML = `
    <div class="pc-banner" style="${bannerStyle}"></div>
    <div class="pc-av-wrap">
      ${user.avatar_url
        ? `<img class="pc-av" src="${escHtml(user.avatar_url)}">`
        : `<div class="pc-av-fallback" style="background:${user.avatar_color||'#5865f2'}">${(user.username||'?')[0].toUpperCase()}</div>`}
      <div class="status-dot ${status}" style="position:absolute;bottom:6px;right:6px;border-color:var(--bg-2)"></div>
    </div>
    <div class="pc-body">
      <div class="pc-name">${escHtml(user.username)}</div>
      <div class="pc-tag">#${escHtml(user.discriminator||'0000')}</div>
      ${p.custom_status ? `<div class="pc-status">${escHtml(p.custom_status)}</div>` : ''}
      ${user.about_me ? `<div class="pc-about">${escHtml(user.about_me)}</div>` : ''}
      ${!isSelf ? `<div class="pc-actions"><button class="btn btn-primary pc-dm-btn" data-user-id="${escHtml(userId)}">${t('pc_send_dm')}</button></div>` : ''}
    </div>
  `;
  card.classList.remove('hidden');

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const w = 280, h = 300;
  let left = rect.right + 8, top = rect.top;
  if (left + w > window.innerWidth) left = rect.left - w - 8;
  if (top + h > window.innerHeight) top = window.innerHeight - h - 8;
  card.style.left = left + 'px';
  card.style.top  = top + 'px';

  card.querySelector('.pc-dm-btn')?.addEventListener('click', async () => {
    closeProfileCard();
    try {
      const dm = await API.post(`/api/users/${userId}/dm`);
      if (!S.dmChannels.find(c => c.id === dm.id)) S.dmChannels.unshift(dm);
      await selectServer('@me');
      selectChannel(dm.id);
    } catch (e) { showToast(e.message, 'error'); }
  });

  const closeCard = e => {
    if (!card.contains(e.target)) { closeProfileCard(); document.removeEventListener('click', closeCard); }
  };
  setTimeout(() => document.addEventListener('click', closeCard), 0);
}

function closeProfileCard() {
  $('profile-card-popup').classList.add('hidden');
}

// ─── CONTEXT MENUS ────────────────────────────────────────────────────────────
function showCtxMenu(x, y, items) {
  const menu = $('ctx-menu');
  menu.innerHTML = items.map(item => {
    if (item.divider)  return '<div class="ctx-divider"></div>';
    if (item.header)   return `<div class="ctx-header">${escHtml(item.header)}</div>`;
    return `<div class="ctx-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}">
      <span class="ctx-icon">${item.icon || ''}</span>
      <span class="ctx-label">${escHtml(item.label)}</span>
      ${item.hint ? `<span class="ctx-hint">${escHtml(item.hint)}</span>` : ''}
    </div>`;
  }).join('');
  // Smart positioning — keep inside viewport
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  menu.classList.remove('hidden');
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  const cx = x + mw > window.innerWidth  ? x - mw : x;
  const cy = y + mh > window.innerHeight ? y - mh : y;
  menu.style.left = cx + 'px';
  menu.style.top  = cy + 'px';
  menu.querySelectorAll('.ctx-item:not(.disabled)').forEach((el, i) => {
    const item = items.filter(it => !it.divider && !it.header)[i];
    if (item?.onClick) el.addEventListener('click', () => { closeContextMenu(); item.onClick(); });
  });
}
function closeContextMenu() { $('ctx-menu').classList.add('hidden'); }

function showServerContextMenu(e, serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  showCtxMenu(e.clientX, e.clientY, [
    { icon: '⚙️',  label: t('server_settings_menu'),   onClick: () => openServerSettings(serverId) },
    { icon: '🔔',  label: t('notifications'),           onClick: () => showToast(t('notifications_wip')) },
    { icon: '📋',  label: t('invite_people'),           onClick: () => createInvite(serverId) },
    { divider: true },
    { icon: '📌',  label: t('pinned_messages'),          onClick: () => showToast(t('pinned_hint')) },
    { icon: '#️⃣', label: t('create_channel_menu'),      onClick: () => openCreateChannelModal(serverId, null) },
    { icon: '📁',  label: t('create_category_menu'),     onClick: () => createCategory(serverId) },
    { divider: true },
    { icon: '🆔',  label: t('copy_server_id'),           onClick: () => { navigator.clipboard.writeText(serverId); showToast(t('id_copied')); } },
    { divider: true },
    !isOwner && { icon: '🚪', label: t('leave_server'),  danger: true, onClick: () => leaveServer(serverId) },
    isOwner  && { icon: '🗑️', label: t('delete_server'), danger: true, onClick: () => deleteServer(serverId) },
  ].filter(Boolean));
}

function showChannelContextMenu(e, channelId) {
  const ch = getChannel(channelId);
  if (!ch || !ch.server_id) return;
  const isOwner = getServer(ch.server_id)?.owner_id === S.me?.id;
  const isVoice = ch.type === 'voice';

  const items = [
    { header: escHtml(ch.name) },
  ];

  if (isVoice) {
    if (V.channelId !== channelId) {
      items.push({ icon: '🔊', label: t('voice_connect'), onClick: () => joinVoiceChannel(channelId) });
    } else {
      items.push({ icon: '🔇', label: t('voice_disconnect'), danger: true, onClick: leaveVoiceChannel });
    }
    items.push({ divider: true });
  }

  items.push(
    { icon: '🔔', label: t('notifications'),  onClick: () => showToast(t('notifications_wip')) },
    { icon: '📌', label: t('pins_short'),       onClick: () => { S.activeChannelId = channelId; showPins(); } },
    { icon: '🆔', label: t('copy_id'), onClick: () => { navigator.clipboard.writeText(channelId); showToast(t('id_copied')); } },
    { divider: true },
  );

  if (isOwner) {
    items.push(
      { icon: '✏️',  label: t('rename_channel'), onClick: () => renameChannel(ch) },
      { icon: '📋',  label: t('create_invite_ctx'),    onClick: () => createInvite(ch.server_id) },
      { icon: '🗑️',  label: t('delete_channel'), danger: true, onClick: () => deleteChannel(channelId) },
    );
  }

  showCtxMenu(e.clientX, e.clientY, items);
}

async function renameChannel(ch) {
  const name = await daPrompt(t('channel_name'), { title: t('rename_channel'), placeholder: ch.name, confirmText: t('ok') });
  if (!name || name === ch.name) return;
  try {
    await API.patch(`/api/channels/${ch.id}`, { name: name.trim() });
    showToast(t('renamed'), 'success');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function deleteChannel(channelId) {
  if (!await daConfirm(t('confirm_delete_channel_msg'), { title: t('delete_channel'), danger: true })) return;
  try { await API.del(`/api/channels/${channelId}`); }
  catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

// ─── SERVER DROPDOWN ──────────────────────────────────────────────────────────
function showServerDropdown() {
  if (S.activeServerId === '@me') return;
  const srv = getServer(S.activeServerId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  const dd = $('server-dropdown');
  dd.innerHTML = `
    <div class="sm-item" id="sm-invite"><span class="sm-icon">📋</span><span class="sm-label">${t('invite_people')}</span><span class="sm-hint">⌘I</span></div>
    ${isOwner ? `<div class="sm-item" id="sm-settings"><span class="sm-icon">⚙️</span><span class="sm-label">${t('server_settings_menu')}</span></div>` : ''}
    <div class="sm-item" id="sm-create-ch"><span class="sm-icon">＋</span><span class="sm-label">${t('create_channel')}</span></div>
    <div class="sm-item" id="sm-create-cat"><span class="sm-icon">📁</span><span class="sm-label">${t('create_category')}</span></div>
    <div class="sm-divider"></div>
    ${isOwner
      ? `<div class="sm-item danger" id="sm-delete"><span class="sm-icon">🗑️</span><span class="sm-label">${t('delete_server')}</span></div>`
      : `<div class="sm-item danger" id="sm-leave"><span class="sm-icon">🚪</span><span class="sm-label">${t('leave_server')}</span></div>`}
  `;
  dd.classList.remove('hidden');
  dd.querySelector('#sm-invite')?.addEventListener('click', () => { createInvite(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-settings')?.addEventListener('click', () => { openServerSettings(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-create-ch')?.addEventListener('click', () => { openCreateChannelModal(srv.id, null); hideServerDropdown(); });
  dd.querySelector('#sm-create-cat')?.addEventListener('click', () => { createCategory(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-delete')?.addEventListener('click', () => { deleteServer(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-leave')?.addEventListener('click', () => { leaveServer(srv.id); hideServerDropdown(); });

  const closeDD = e => {
    if (!dd.contains(e.target) && !$('sidebar-header').contains(e.target)) { hideServerDropdown(); document.removeEventListener('click', closeDD); }
  };
  setTimeout(() => document.addEventListener('click', closeDD), 0);
}

function hideServerDropdown() { $('server-dropdown').classList.add('hidden'); }

// ─── SERVER ACTIONS ───────────────────────────────────────────────────────────
async function createInvite(serverId) {
  try {
    const inv = await API.post(`/api/servers/${serverId}/invites`, { ttl_seconds: 7 * 24 * 3600 });
    const url = `${location.origin}/app?invite=${inv.code}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    showToast(t('invite_copied', { url }), 'success');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function leaveServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_leave_server', { name: srv?.name || '?' }), { title: t('leave_server'), danger: true, confirmText: t('confirm_leave_server_btn') })) return;
  try {
    await API.post(`/api/servers/${serverId}/leave`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function deleteServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_delete_server', { name: srv?.name || '?' }), { title: t('delete_server'), danger: true })) return;
  try {
    await API.del(`/api/servers/${serverId}`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function createCategory(serverId) {
  const name = await daPrompt(t('category_name'), { title: t('create_category'), confirmText: t('create') });
  if (!name) return;
  try {
    await API.post(`/api/servers/${serverId}/categories`, { name });
    // Refresh server
    const srv = await API.get(`/api/servers/${serverId}`);
    const idx = S.servers.findIndex(s => s.id === serverId);
    if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...srv };
    renderChannelList();
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

// ─── CREATE CHANNEL MODAL ─────────────────────────────────────────────────────
function openCreateChannelModal(serverId, categoryId) {
  S.pendingChannelCreate = { serverId, categoryId };
  $('new-ch-name').value = '';
  $('new-ch-topic').value = '';
  $('new-ch-type').value = 'text';
  $('new-ch-category-id').value = categoryId || '';
  $('cc-error').textContent = '';
  openModal('modal-create-channel');
}

// ─── ADD SERVER MODAL ─────────────────────────────────────────────────────────
function openAddServerModal() {
  $('add-server-step0').classList.remove('hidden');
  $('add-server-step-create').classList.add('hidden');
  $('add-server-step-join').classList.add('hidden');
  openModal('modal-add-server');
}

// ─── PINS ─────────────────────────────────────────────────────────────────────
async function showPins() {
  if (!S.activeChannelId) return;
  openModal('modal-pins');
  $('pins-list').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  try {
    const pins = await API.get(`/api/channels/${S.activeChannelId}/pins`);
    if (!pins.length) {
      $('pins-list').innerHTML = '<div class="empty-state"><div class="empty-icon">📌</div><div class="empty-text">' + t('no_pinned_short') + '</div></div>';
      return;
    }
    $('pins-list').innerHTML = pins.map(msg => `
      <div style="padding:8px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:13px">${escHtml(msg.author?.username||'?')}</div>
        <div style="font-size:14px;color:var(--text-2)">${escHtml((msg.content||'').slice(0,200))}</div>
        <div style="font-size:12px;color:var(--text-3)">${fmtDatetime(msg.created_at)}</div>
      </div>
    `).join('');
  } catch {}
}

// ─── NEW DM MODAL ─────────────────────────────────────────────────────────────
function showNewDmModal() {
  showToast(t('dm_hint'), 'error');
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

// ─── SERVER SETTINGS ──────────────────────────────────────────────────────────
function openServerSettings(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  $('ss-server-name').textContent = srv.name;
  $('ss-leave-server').classList.toggle('hidden', isOwner);
  $('ss-delete-server').classList.toggle('hidden', !isOwner);

  const pages = [
    { id: 'overview',  label: t('ss_overview'), icon: '📋' },
    { id: 'roles',     label: t('ss_roles'),    icon: '🛡️' },
    { id: 'members',   label: t('ss_members'),  icon: '👥' },
    { id: 'bans',      label: t('ss_bans'),     icon: '🔨' },
    { id: 'invites',   label: t('ss_invites'),  icon: '🔗' },
    { id: 'audit',     label: t('ss_audit'),    icon: '📜' },
  ];

  $('ss-nav-items').innerHTML = pages.map(p => `
    <div class="settings-nav-item ${p.id === 'overview' ? 'active' : ''}" data-ss-page="${p.id}"><span class="nav-icon">${p.icon}</span>${p.label}</div>
  `).join('');

  $('ss-nav-items').querySelectorAll('[data-ss-page]').forEach(el => {
    el.addEventListener('click', () => {
      $('ss-nav-items').querySelectorAll('[data-ss-page]').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      renderServerSettingsPage(serverId, el.dataset.ssPage);
    });
  });

  $('ss-leave-server').onclick = () => leaveServer(serverId);
  $('ss-delete-server').onclick = () => deleteServer(serverId);

  renderServerSettingsPage(serverId, 'overview');
  $('server-settings').classList.remove('hidden');
}

async function renderServerSettingsPage(serverId, page) {
  const srv = getServer(serverId);
  if (!srv) return;
  const titleIcons = { overview: '📋', roles: '🛡️', members: '👥', bans: '🔨', invites: '🔗', audit: '📜' };
  $('ss-page-title').innerHTML = `${titleIcons[page] || ''} ${{ overview: t('ss_overview'), roles: t('ss_roles'), members: t('ss_members'), bans: t('ss_bans'), invites: t('ss_invites'), audit: t('ss_audit') }[page] || page}`;
  const body = $('ss-page-body');
  body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  if (page === 'overview') {
    const invUrl = `${location.origin}/app?invite=${srv.invite_code}`;
    body.innerHTML = `
      <div class="form-group">
        <label>${t('server_name')}</label>
        <input id="ss-name" value="${escHtml(srv.name)}">
      </div>
      <div class="form-group">
        <label>${t('server_description')}</label>
        <textarea id="ss-desc">${escHtml(srv.description||'')}</textarea>
      </div>
      <div class="form-group">
        <label>${t('server_icon_url')}</label>
        <input id="ss-icon" value="${escHtml(srv.icon_url||'')}">
      </div>
      <div class="form-group">
        <label>${t('server_banner_url')}</label>
        <input id="ss-banner" value="${escHtml(srv.banner_url||'')}">
      </div>
      <button class="btn btn-primary mt-8" id="ss-save-overview">${t('save_changes')}</button>

      <div class="form-group mt-16">
        <label>${t('invite_link')}</label>
        <div class="invite-link-box">
          <code id="ss-invite-url">${escHtml(invUrl)}</code>
          <button class="btn btn-primary copy-btn" id="ss-copy-inv">${t('copy')}</button>
        </div>
      </div>

      <div class="danger-zone">
        <h4>${t('danger_zone')}</h4>
        <button class="btn btn-danger" id="ss-danger-delete">${t('delete_server_btn')}</button>
      </div>
    `;
    $('ss-save-overview').onclick = async () => {
      try {
        const updated = await API.patch(`/api/servers/${serverId}`, {
          name:        $('ss-name').value.trim(),
          description: $('ss-desc').value.trim(),
          icon_url:    $('ss-icon').value.trim(),
          banner_url:  $('ss-banner').value.trim(),
        });
        const idx = S.servers.findIndex(s => s.id === serverId);
        if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...updated };
        renderServerIcons();
        showToast(t('saved'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
    $('ss-copy-inv').onclick = () => { navigator.clipboard.writeText(invUrl).catch(()=>{}); showToast(t('copied'), 'success'); };
    $('ss-danger-delete').onclick = () => deleteServer(serverId);
  }

  if (page === 'roles') {
    const roles = await API.get(`/api/servers/${serverId}/roles`).catch(() => []);
    const isOwner = srv.owner_id === S.me?.id;
    const canManageRoles = isOwner || userHasPermissionClient(serverId);
    const perms = ['send_messages','manage_messages','kick_members','ban_members','manage_channels','manage_server','mention_everyone','manage_roles','view_channel','administrator'];
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <span>${t('roles_count', { n: roles.length })}</span>
        ${canManageRoles ? `<button class="btn btn-primary" id="ss-add-role">${t('create_role')}</button>` : ''}
      </div>
      <table class="settings-table">
        <thead><tr><th>${t('role_name')}</th><th>${t('role_members')}</th><th>${t('role_actions')}</th></tr></thead>
        <tbody>
          ${roles.map(r => `
            <tr data-role-id="${escHtml(r.id)}">
              <td><span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span></td>
              <td>—</td>
              <td class="table-actions">
                ${!r.is_default && canManageRoles ? `
                  <button class="table-btn edit-role-btn" data-role-id="${escHtml(r.id)}" title="${t('edit')}">&#9998;</button>
                  <button class="table-btn del delete-role-btn" data-role-id="${escHtml(r.id)}" title="${t('delete')}">&#128465;</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    body.querySelector('#ss-add-role')?.addEventListener('click', async () => {
      const name = await daPrompt(t('role_name'), { title: t('create_role'), confirmText: t('create') });
      if (!name) return;
      const color = await daPrompt(t('role_color') + ' (hex)',  { title: t('create_role'), placeholder: '#99aab5', confirmText: t('ok') });
      try {
        const role = await API.post(`/api/servers/${serverId}/roles`, { name, color: color || '#99aab5' });
        const idx = S.servers.findIndex(s => s.id === serverId);
        if (idx !== -1) S.servers[idx].roles = [...(S.servers[idx].roles||[]), role];
        renderServerSettingsPage(serverId, 'roles');
        showToast(t('role_created'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    });
    body.querySelectorAll('.delete-role-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!await daConfirm(t('confirm_delete_role'), { title: t('confirm_delete_role_title'), danger: true })) return;
        try {
          await API.del(`/api/servers/${serverId}/roles/${btn.dataset.roleId}`);
          renderServerSettingsPage(serverId, 'roles');
          showToast(t('role_deleted'));
        } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
    body.querySelectorAll('.edit-role-btn').forEach(btn => {
      btn.onclick = () => openRoleEditor(serverId, btn.dataset.roleId, roles, perms);
    });
  }

  if (page === 'members') {
    const members = S.members[serverId] || await API.get(`/api/servers/${serverId}/members`).catch(() => []);
    if (!S.members[serverId]) S.members[serverId] = members;
    const roles = getServer(serverId)?.roles?.filter(r => !r.is_default) || [];
    const isOwner = srv.owner_id === S.me?.id;
    const canManage = isOwner || userHasPermissionClient(serverId);
    body.innerHTML = `
      <table class="settings-table">
        <thead><tr><th>${t('member_user')}</th><th>${t('member_nick')}</th><th>${t('member_roles')}</th><th>${t('member_joined')}</th><th></th></tr></thead>
        <tbody>
          ${members.map(m => `
            <tr>
              <td><div class="flex-row">${avatarEl(m, 24)} ${escHtml(m.username)}</div></td>
              <td>${escHtml(m.nickname||'—')}</td>
              <td>
                ${(m.roles||[]).map(r => `<span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span>`).join(' ')}
                ${canManage && roles.length ? `<button class="table-btn assign-role-btn" data-user-id="${escHtml(m.id)}" title="${t('assign_role')}">&#65291;</button>` : ''}
              </td>
              <td style="font-size:12px;color:var(--text-3)">${fmtDatetime(m.joined_at)}</td>
              <td class="table-actions">
                ${m.id !== S.me?.id && canManage ? `
                  <button class="table-btn del kick-btn" data-user-id="${escHtml(m.id)}" title="${t('kick')}">&#128098;</button>
                  <button class="table-btn del ban-btn" data-user-id="${escHtml(m.id)}" title="${t('ban')}">&#128296;</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!await daConfirm(t('confirm_kick'), { title: t('confirm_kick_title'), danger: true, confirmText: t('confirm_kick_btn') })) return;
        try { await API.del(`/api/servers/${serverId}/members/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'members'); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
    body.querySelectorAll('.ban-btn').forEach(btn => {
      btn.onclick = async () => {
        const reason = await daPrompt(t('prompt_ban_reason'), { title: t('prompt_ban_reason_title'), confirmText: t('ok') });
        if (reason === null) return;
        try { await API.post(`/api/servers/${serverId}/bans/${btn.dataset.userId}`, { reason }); renderServerSettingsPage(serverId, 'members'); showToast(t('banned')); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
    // Role assignment
    body.querySelectorAll('.assign-role-btn').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const memberId = btn.dataset.userId;
        const member = members.find(m => m.id === memberId);
        const assignedIds = new Set((member?.roles||[]).map(r => r.id));
        const items = roles.map(r => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
            <input type="checkbox" data-role-id="${escHtml(r.id)}" ${assignedIds.has(r.id) ? 'checked' : ''}>
            <span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span>
          </label>
        `).join('');
        const overlay = document.createElement('div');
        overlay.className = 'da-dialog-overlay';
        overlay.innerHTML = `<div class="da-dialog-box"><div class="da-dialog-head"><h3>${t('assign_role')}</h3></div><div class="da-dialog-body">${items}</div><div class="da-dialog-foot"><button class="btn btn-outline" id="daa-close">${t('cancel')}</button><button class="btn btn-accent" id="daa-save">${t('save')}</button></div></div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('#daa-close').onclick = close;
        overlay.onclick = ev => { if (ev.target === overlay) close(); };
        overlay.querySelector('#daa-save').onclick = async () => {
          const checks = overlay.querySelectorAll('input[data-role-id]');
          for (const cb of checks) {
            const rid = cb.dataset.roleId;
            const was = assignedIds.has(rid);
            if (cb.checked && !was) {
              await API.post(`/api/servers/${serverId}/members/${memberId}/roles/${rid}`, {}).catch(() => {});
            } else if (!cb.checked && was) {
              await API.del(`/api/servers/${serverId}/members/${memberId}/roles/${rid}`).catch(() => {});
            }
          }
          close();
          renderServerSettingsPage(serverId, 'members');
        };
      };
    });
  }

  if (page === 'bans') {
    const bans = await API.get(`/api/servers/${serverId}/bans`).catch(() => []);
    body.innerHTML = !bans.length ? `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">${t('no_bans')}</div></div>` : `
      <table class="settings-table">
        <thead><tr><th>${t('member_user')}</th><th>${t('ban_reason')}</th><th></th></tr></thead>
        <tbody>
          ${bans.map(b => `
            <tr>
              <td>${escHtml(b.username)}</td>
              <td>${escHtml(b.reason||'—')}</td>
              <td><button class="btn btn-outline unban-btn" data-user-id="${escHtml(b.user_id)}">${t('unban')}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.unban-btn').forEach(btn => {
      btn.onclick = async () => {
        try { await API.del(`/api/servers/${serverId}/bans/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'bans'); showToast(t('unbanned')); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
  }

  if (page === 'invites') {
    const invites = await API.get(`/api/servers/${serverId}/invites`).catch(() => []);
    body.innerHTML = `
      <button class="btn btn-primary mb-8" id="ss-create-inv">${t('create_invite')}</button>
      ${!invites.length ? `<div class="empty-state"><div class="empty-text">${t('no_invites')}</div></div>` : `
      <table class="settings-table">
        <thead><tr><th>${t('invite_code')}</th><th>${t('invite_creator')}</th><th>${t('invite_uses')}</th><th>${t('invite_expires')}</th><th></th></tr></thead>
        <tbody>
          ${invites.map(inv => `
            <tr>
              <td><code>${escHtml(inv.code)}</code></td>
              <td>${escHtml(inv.creator_username||'?')}</td>
              <td>${inv.uses}${inv.max_uses ? ` / ${inv.max_uses}` : ''}</td>
              <td>${inv.expires_at ? fmtDatetime(inv.expires_at) : t('invite_never')}</td>
              <td><button class="table-btn del del-inv-btn" data-code="${escHtml(inv.code)}">&#128465;</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    `;
    body.querySelector('#ss-create-inv')?.addEventListener('click', () => createInvite(serverId));
    body.querySelectorAll('.del-inv-btn').forEach(btn => {
      btn.onclick = async () => {
        try { await API.del(`/api/invites/${btn.dataset.code}`); renderServerSettingsPage(serverId, 'invites'); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
  }

  if (page === 'audit') {
    const logs = await API.get(`/api/servers/${serverId}/audit-log`).catch(() => []);
    const LABELS = { kick: t('audit_kick'), ban: t('audit_ban'), unban: t('audit_unban'), role_create: t('audit_role_create'), role_delete: t('audit_role_delete'), role_update: t('audit_role_update'), channel_create: t('audit_channel_create'), channel_delete: t('audit_channel_delete'), server_update: t('audit_server_update'), message_delete: t('audit_message_delete'), invite_create: t('audit_invite_create'), invite_delete: t('audit_invite_delete'), pin_add: t('audit_pin_add'), pin_remove: t('audit_pin_remove'), member_update: t('audit_member_update') };
    body.innerHTML = !logs.length ? `<div class="empty-state"><div class="empty-text">${t('no_audit')}</div></div>` : `
      <table class="settings-table">
        <thead><tr><th>${t('audit_who')}</th><th>${t('audit_action')}</th><th>${t('audit_when')}</th></tr></thead>
        <tbody>
          ${logs.map(l => `
            <tr>
              <td>${escHtml(l.actor_username||'?')}</td>
              <td>${escHtml(LABELS[l.action]||l.action)}</td>
              <td style="font-size:12px;color:var(--text-3)">${fmtDatetime(l.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

function openRoleEditor(serverId, roleId, roles, perms) {
  const role = roles.find(r => r.id === roleId);
  if (!role) return;
  let currentPerms = {};
  try { currentPerms = JSON.parse(role.permissions || '{}'); } catch {}

  const body = $('ss-page-body');
  const PERM_KEY = { send_messages:'perm_send_messages', manage_messages:'perm_manage_messages', kick_members:'perm_kick_members', ban_members:'perm_ban_members', manage_channels:'perm_manage_channels', manage_server:'perm_manage_server', mention_everyone:'perm_mention_everyone', manage_roles:'perm_manage_roles', view_channel:'perm_view_channel', administrator:'perm_administrator' };
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <button class="btn btn-outline" id="back-to-roles">${t('back_to_roles')}</button>
      <h3>${t('edit_role')}: ${escHtml(role.name)}</h3>
    </div>
    <div class="form-group">
      <label>${t('role_name')}</label>
      <input id="re-name" value="${escHtml(role.name)}">
    </div>
    <div class="form-group">
      <label>${t('role_color')}</label>
      <input type="color" id="re-color" value="${escHtml(role.color)}">
    </div>
    <div class="form-group">
      <label>${t('role_permissions')}</label>
      <div class="perm-grid">
        ${perms.map(p => `
          <div class="perm-item">
            <input type="checkbox" id="perm-${p}" ${currentPerms[p] ? 'checked' : ''}>
            <label for="perm-${p}">${escHtml(t(PERM_KEY[p]||p))}</label>
          </div>
        `).join('')}
      </div>
    </div>
    <button class="btn btn-primary" id="save-role-btn">${t('save_role')}</button>
  `;
  $('back-to-roles').onclick = () => renderServerSettingsPage(serverId, 'roles');
  $('save-role-btn').onclick = async () => {
    const newPerms = {};
    for (const p of perms) { newPerms[p] = !!document.getElementById(`perm-${p}`)?.checked; }
    try {
      await API.patch(`/api/servers/${serverId}/roles/${roleId}`, { name: $('re-name').value.trim(), color: $('re-color').value, permissions: newPerms });
      renderServerSettingsPage(serverId, 'roles');
      showToast(t('role_updated'), 'success');
    } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
  };
}

// ─── USER SETTINGS ────────────────────────────────────────────────────────────
function openUserSettings(page = 'profile') {
  renderUserSettingsPage(page);
  $('user-settings').classList.remove('hidden');
  $('us-nav-items').querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
    el.onclick = () => { $('us-nav-items').querySelectorAll('[data-page]').forEach(e => e.classList.remove('active')); el.classList.add('active'); renderUserSettingsPage(el.dataset.page); };
  });
}

function renderUserSettingsPage(page) {
  const content = $('us-content');
  if (page === 'profile') {
    content.innerHTML = `
      <div class="settings-section-title">${t('my_account')}</div>
      <div class="form-group">
        <label>${t('avatar_url')}</label>
        <input id="us-avatar" value="${escHtml(S.me?.avatar_url||'')}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>${t('avatar_color')}</label>
        <input type="color" id="us-av-color" value="${escHtml(S.me?.avatar_color||'#5865f2')}">
      </div>
      <div class="form-group">
        <label>${t('banner_url')}</label>
        <input id="us-banner" value="${escHtml(S.me?.banner_url||'')}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>${t('banner_color')}</label>
        <input type="color" id="us-banner-color" value="${escHtml(S.me?.banner_color||'#5865f2')}">
      </div>
      <div class="form-group">
        <label>${t('about_me')}</label>
        <textarea id="us-about" maxlength="190">${escHtml(S.me?.about_me||'')}</textarea>
      </div>
      <div class="form-group">
        <label>${t('custom_status')}</label>
        <input id="us-status" value="${escHtml(S.me?.custom_status||'')}">
      </div>
      <button class="btn btn-primary" id="us-save">${t('save')}</button>

      <div class="settings-section-title" style="margin-top:24px">🔒 ${t('change_password')}</div>
      <div class="form-group">
        <label>${t('current_password')}</label>
        <input type="password" id="us-cur-pass" autocomplete="current-password">
      </div>
      <div class="form-group">
        <label>${t('new_password')}</label>
        <input type="password" id="us-new-pass" autocomplete="new-password" minlength="6">
      </div>
      <div class="form-group">
        <label>${t('confirm_password')}</label>
        <input type="password" id="us-confirm-pass" autocomplete="new-password">
      </div>
      <button class="btn btn-danger" id="us-change-pass">${t('change_password')}</button>
    `;
    $('us-save').onclick = async () => {
      try {
        const updated = await API.patch('/api/@me', {
          avatar_url:   $('us-avatar').value.trim(),
          avatar_color: $('us-av-color').value,
          banner_url:   $('us-banner').value.trim(),
          banner_color: $('us-banner-color').value,
          about_me:     $('us-about').value.trim(),
          custom_status:$('us-status').value.trim(),
        });
        S.me = updated;
        updateSidebarUser();
        socket?.emit('UPDATE_STATUS', { status: 'online', custom_status: updated.custom_status });
        showToast(t('saved'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
    $('us-change-pass').onclick = async () => {
      const cur = $('us-cur-pass').value;
      const nw  = $('us-new-pass').value;
      const cnf = $('us-confirm-pass').value;
      if (!cur || !nw) { showToast(t('fill_all_fields'), 'error'); return; }
      if (nw.length < 6) { showToast(t('password_min_6'), 'error'); return; }
      if (nw !== cnf) { showToast(t('passwords_mismatch'), 'error'); return; }
      try {
        await API.patch('/api/@me/password', { current_password: cur, new_password: nw });
        showToast(t('password_changed'), 'success');
        $('us-cur-pass').value = '';
        $('us-new-pass').value = '';
        $('us-confirm-pass').value = '';
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
  } else if (page === 'appearance') {
    content.innerHTML = `
      <div class="settings-section-title">${t('us_appearance')}</div>
      <div class="form-group">
        <label>${t('theme')}</label>
        <select id="us-theme">
          <option value="dark"  ${document.documentElement.dataset.theme==='dark'  ?'selected':''}>${t('theme_dark')}</option>
          <option value="light" ${document.documentElement.dataset.theme==='light' ?'selected':''}>${t('theme_light')}</option>
          <option value="amoled"${document.documentElement.dataset.theme==='amoled'?'selected':''}>${t('theme_amoled')}</option>
        </select>
      </div>
      <div class="form-group">
        <label>${t('font_size')}</label>
        <input type="range" id="us-fontsize" min="12" max="20" value="${parseInt(localStorage.getItem('da_fontSize')||'16')}">
        <div class="form-hint" id="us-fs-preview">${parseInt(localStorage.getItem('da_fontSize')||'16')}px</div>
      </div>
    `;
    $('us-theme').onchange = e => {
      document.documentElement.dataset.theme = e.target.value;
      localStorage.setItem('da_theme', e.target.value);
    };
    $('us-fontsize').oninput = e => {
      const v = e.target.value;
      document.documentElement.style.fontSize = v + 'px';
      localStorage.setItem('da_fontSize', v);
      $('us-fs-preview').textContent = v + 'px';
    };
  } else if (page === 'language') {
    const currentLang = getLang();
    content.innerHTML = `
      <div class="settings-section-title">${t('language')}</div>
      <div class="lang-selector">
        ${Object.entries(LANG_NAMES).map(([code, name]) => `
          <div class="lang-option ${currentLang === code ? 'active' : ''}" data-lang="${code}">
            <div class="lang-flag">${code === 'ru' ? '🇷🇺' : code === 'en' ? '🇬🇧' : '🇵🇱'}</div>
            <div class="lang-name">${name}</div>
            ${currentLang === code ? '<div class="lang-check">&#10003;</div>' : ''}
          </div>
        `).join('')}
      </div>
    `;
    content.querySelectorAll('.lang-option').forEach(el => {
      el.onclick = () => {
        setLang(el.dataset.lang);
        applyI18nToHtml();
        openUserSettings('language');
      };
    });
  }
}
// ─── CLIENT-SIDE PERMISSION HELPER ──────────────────────────────────────────
function userHasPermissionClient(serverId) {
  const srv = getServer(serverId);
  if (!srv || !S.me) return false;
  if (srv.owner_id === S.me.id) return true;
  return false; // simplified; full check happens on server
}

// ─── APPLY STATIC HTML TRANSLATIONS ─────────────────────────────────────────
function applyI18nToHtml() {
  // Splash
  const splashText = document.querySelector('.splash-text');
  if (splashText) splashText.textContent = t('splash_loading');

  // Auth login
  const loginCard = document.querySelector('#auth-login');
  if (loginCard) {
    const h2 = loginCard.querySelector('h2');
    if (h2) h2.textContent = t('welcome_back');
    const sub = loginCard.querySelector('.sub');
    if (sub) sub.textContent = t('have_account');
    const liBtn = $('li-btn');
    if (liBtn) liBtn.textContent = t('sign_in');
    const goReg = $('goto-register');
    if (goReg) goReg.textContent = t('sign_up');
    const noAcc = loginCard.querySelector('.auth-switch');
    if (noAcc) { const a = noAcc.querySelector('a'); noAcc.childNodes[0].textContent = t('no_account') + ' '; if (a) a.textContent = t('sign_up'); }
    // Labels & placeholders
    const liEmail = loginCard.querySelector('label[for="li-email"]');
    if (liEmail) liEmail.textContent = t('email_label');
    const liPass = loginCard.querySelector('label[for="li-pass"]');
    if (liPass) liPass.textContent = t('password_label');
  }

  // Auth register
  const regCard = document.querySelector('#auth-register');
  if (regCard) {
    const h2 = regCard.querySelector('h2');
    if (h2) h2.textContent = t('create_account');
    const sub = regCard.querySelector('.sub');
    if (sub) sub.textContent = t('register_sub');
    const regBtn = $('reg-btn');
    if (regBtn) regBtn.textContent = t('sign_up');
    const hasAcc = regCard.querySelector('.auth-switch');
    if (hasAcc) { const a = hasAcc.querySelector('a'); hasAcc.childNodes[0].textContent = t('have_account') + ' '; if (a) a.textContent = t('sign_in'); }
    // Labels & placeholders
    const regEmail = regCard.querySelector('label[for="reg-email"]');
    if (regEmail) regEmail.textContent = t('email_label');
    const regName = regCard.querySelector('label[for="reg-name"]');
    if (regName) regName.textContent = t('username_label');
    const regPassL = regCard.querySelector('label[for="reg-pass"]');
    if (regPassL) regPassL.textContent = t('password_label');
    const regPassIn = $('reg-pass');
    if (regPassIn) regPassIn.placeholder = t('register_placeholder_pass');
    const regNameIn = $('reg-name');
    if (regNameIn) regNameIn.placeholder = t('register_placeholder_name');
  }

  // Server list tooltips
  const homeTooltip = document.querySelector('#btn-home')?.closest('.tooltip-wrapper')?.querySelector('.tooltip-label');
  if (homeTooltip) homeTooltip.textContent = t('direct_messages');
  const addServerTooltip = document.querySelector('#btn-add-server')?.closest('.tooltip-wrapper')?.querySelector('.tooltip-label');
  if (addServerTooltip) addServerTooltip.textContent = t('add_server');

  // Sidebar header (default DM mode)
  const sidebarName = $('sidebar-server-name');
  if (sidebarName && S.activeServerId === '@me') sidebarName.textContent = t('direct_messages');

  // Sidebar user tooltips & titles
  const profileTooltip = document.querySelector('#su-av-wrapper .tooltip-label');
  if (profileTooltip) profileTooltip.textContent = t('profile_tooltip');
  const muteBtn = $('btn-toggle-mute');
  if (muteBtn) muteBtn.title = t('microphone');
  const setBtn = $('btn-settings');
  if (setBtn) setBtn.title = t('settings');

  // Welcome screen (HTML default)
  const welText = document.querySelector('#welcome-screen .empty-text');
  if (welText) welText.textContent = t('select_channel_start');
  const welSub = document.querySelector('#welcome-screen .empty-sub');
  if (welSub) welSub.textContent = t('open_dms_hint');

  // Chat header buttons
  const menuBtn = $('btn-mobile-menu');
  if (menuBtn) menuBtn.title = t('menu');
  const searchBtn = $('btn-search');
  if (searchBtn) searchBtn.title = t('search_ctrl_k');
  const pinsBtn = $('btn-pins');
  if (pinsBtn) pinsBtn.title = t('pinned_btn');
  const membersBtn = $('btn-members');
  if (membersBtn) membersBtn.title = t('members_btn');

  // Load more
  const lm = $('messages-load-more');
  if (lm) lm.textContent = '⬆ ' + t('load_more');

  // Reply bar
  const replyBar = $('reply-bar');
  if (replyBar) {
    const span = replyBar.querySelector('span:first-child');
    if (span) {
      const nameEl = span.querySelector('.reply-name');
      const nameHtml = nameEl ? nameEl.outerHTML : '';
      span.innerHTML = t('reply_for') + ' ' + nameHtml;
    }
  }

  // Input area
  const attachBtn = $('btn-attach');
  if (attachBtn) attachBtn.title = t('attach_file');
  const emojiBtn = $('btn-emoji');
  if (emojiBtn) emojiBtn.title = t('emoji');
  const msgInput = $('msg-input');
  if (msgInput) msgInput.placeholder = t('msg_placeholder');

  // Add server modal
  const addServerTitle = $('add-server-title');
  if (addServerTitle) addServerTitle.textContent = t('add_server');
  // Step 0
  const step0 = $('add-server-step0');
  if (step0) {
    const title = step0.querySelector('.create-step-title');
    if (title) title.textContent = t('create_server_step');
    const sub = step0.querySelector('.create-step-sub');
    if (sub) sub.innerHTML = t('create_server_desc').replace('\n', '<br>');
    const createNext = $('btn-create-server-next');
    if (createNext) createNext.textContent = t('create_server_step');
    const orDiv = step0.querySelector('div[style*="text-align:center"]');
    if (orDiv) orDiv.textContent = t('or_separator');
    const joinNext = $('btn-join-server-next');
    if (joinNext) joinNext.textContent = t('join_by_link');
  }
  // Step create
  const stepCreate = $('add-server-step-create');
  if (stepCreate) {
    const title = stepCreate.querySelector('.create-step-title');
    if (title) title.textContent = t('configure_server');
    const label = stepCreate.querySelector('label[for="new-server-name"]');
    if (label) label.textContent = t('server_name_label');
    const input = $('new-server-name');
    if (input) input.placeholder = t('my_server');
    const btn = $('btn-confirm-create-server');
    if (btn) btn.textContent = t('create');
  }
  // Step join
  const stepJoin = $('add-server-step-join');
  if (stepJoin) {
    const title = stepJoin.querySelector('.create-step-title');
    if (title) title.textContent = t('join_server');
    const sub = stepJoin.querySelector('.create-step-sub');
    if (sub) sub.textContent = t('enter_invite_link');
    const input = $('join-invite-input');
    if (input) input.placeholder = t('invite_link_placeholder');
    const btn = $('btn-confirm-join-server');
    if (btn) btn.textContent = t('join');
  }

  // Create channel modal
  const ccModal = $('modal-create-channel');
  if (ccModal) {
    const h3 = ccModal.querySelector('.modal-header h3');
    if (h3) h3.textContent = t('create_channel_title');
    const typeLabel = ccModal.querySelector('label[for="new-ch-type"]');
    if (typeLabel) typeLabel.textContent = t('channel_type_label');
    const opts = ccModal.querySelectorAll('#new-ch-type option');
    if (opts[0]) opts[0].textContent = t('text_hash');
    if (opts[1]) opts[1].textContent = t('voice_speaker');
    if (opts[2]) opts[2].textContent = t('announcement_icon');
    const nameLabel = ccModal.querySelector('label[for="new-ch-name"]');
    if (nameLabel) nameLabel.textContent = t('channel_name_label');
    const nameInput = $('new-ch-name');
    if (nameInput) nameInput.placeholder = t('new_channel_placeholder');
    const topicLabel = ccModal.querySelector('label[for="new-ch-topic"]');
    if (topicLabel) topicLabel.textContent = t('topic_optional');
    const topicInput = $('new-ch-topic');
    if (topicInput) topicInput.placeholder = t('channel_desc_placeholder');
    const cancelBtn = ccModal.querySelector('.modal-footer .btn-outline');
    if (cancelBtn) cancelBtn.textContent = t('cancel');
    const createBtn = $('btn-confirm-create-channel');
    if (createBtn) createBtn.textContent = t('create');
  }

  // Pins modal
  const pinsModal = $('modal-pins');
  if (pinsModal) {
    const h3 = pinsModal.querySelector('.modal-header h3');
    if (h3) h3.textContent = t('pinned_messages');
  }

  // Server settings default title
  const ssTitle = $('ss-page-title');
  if (ssTitle && !ssTitle.innerHTML.trim()) ssTitle.textContent = t('ss_overview');

  // User settings nav — update via data-i18n spans
  const usNav = $('us-nav-items');
  if (usNav) {
    const items = usNav.querySelectorAll('[data-page]');
    items.forEach(el => {
      const span = el.querySelector('[data-i18n]');
      if (span) span.textContent = t(span.dataset.i18n);
      else {
        if (el.dataset.page === 'profile')    el.textContent = t('us_profile');
        if (el.dataset.page === 'appearance') el.textContent = t('us_appearance');
        if (el.dataset.page === 'language')   el.textContent = t('us_language');
      }
    });
    const logout = $('us-logout');
    if (logout) {
      const span = logout.querySelector('[data-i18n]');
      if (span) span.textContent = t(span.dataset.i18n);
      else logout.textContent = t('us_logout');
    }
  }
  const usTitle = document.querySelector('#user-settings .settings-nav-title');
  if (usTitle) usTitle.textContent = t('settings_title');

  // Generic data-i18n for server settings leave/delete
  document.querySelectorAll('#server-settings [data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
function setup() {
  // Auth
  $('li-btn').onclick  = doLogin;
  $('reg-btn').onclick = doRegister;
  $('goto-register').onclick = () => showAuth('register');
  $('goto-login').onclick    = () => showAuth('login');
  $('li-pass').onkeydown  = e => { if (e.key === 'Enter') doLogin(); };
  $('reg-pass').onkeydown = e => { if (e.key === 'Enter') doRegister(); };

  // ── Mobile sidebar toggle ────────────────────────────────────
  function openMobileSidebar()  { $('app').classList.add('mobile-sidebar-open'); }
  function closeMobileSidebar() { $('app').classList.remove('mobile-sidebar-open'); }
  $('btn-mobile-menu').onclick = openMobileSidebar;
  $('mobile-sidebar-overlay').onclick = closeMobileSidebar;
  // Close sidebar after selecting a channel/DM on mobile
  document.addEventListener('da:channel-selected', closeMobileSidebar);

  // Swipe right to open sidebar on mobile
  let _touchStartX = 0, _touchStartY = 0;
  document.addEventListener('touchstart', e => {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - _touchStartY);
    if (dx > 80 && dy < 60 && _touchStartX < 30 && !$('app').classList.contains('mobile-sidebar-open')) {
      openMobileSidebar();
    } else if (dx < -80 && dy < 60 && $('app').classList.contains('mobile-sidebar-open')) {
      closeMobileSidebar();
    }
  }, { passive: true });

  // DM home
  $('btn-home').onclick = () => selectServer('@me');

  // Add server
  $('btn-add-server').onclick = openAddServerModal;

  // Sidebar header click → server dropdown
  $('sidebar-header').onclick = () => {
    if (S.activeServerId !== '@me') {
      if ($('server-dropdown').classList.contains('hidden')) showServerDropdown();
      else hideServerDropdown();
    }
  };

  // Toggle members panel
  $('btn-members').onclick = () => {
    S.membersVisible = !S.membersVisible;
    const panel = $('members-panel');
    if (S.membersVisible && S.activeServerId !== '@me') {
      panel.classList.remove('hidden');
      renderMembersPanel();
    } else {
      panel.classList.add('hidden');
    }
  };

  // Pins
  $('btn-pins').onclick = showPins;

  // Search button
  $('btn-search').onclick = openSearchModal;

  // Message input
  const input = $('msg-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    else sendTyping();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  });

  // File upload
  $('btn-attach').onclick = () => $('file-input').click();
  $('file-input').onchange = e => {
    for (const f of e.target.files) uploadAndSend(f);
    $('file-input').value = '';
  };

  // Reply close
  $('reply-close').onclick = cancelReply;

  // Mute button — toggles mic (also works during voice calls)
  $('btn-toggle-mute').onclick = () => {
    if (V.channelId) {
      toggleVoiceMute();
    } else {
      V.muted = !V.muted;
    }
    $('btn-toggle-mute').style.color = V.muted ? 'var(--danger)' : '';
  };

  // Settings button
  $('btn-settings').onclick = () => openUserSettings('profile');
  $('su-av-wrapper').onclick = () => openUserSettings('profile');
  $('su-info-click').onclick = () => openUserSettings('profile');

  // Server settings close
  $('ss-close').onclick = () => $('server-settings').classList.add('hidden');
  $('us-close').onclick = () => $('user-settings').classList.add('hidden');

  // User settings logout
  $('us-logout').onclick = doLogout;

  // Load more messages
  $('messages-load-more').onclick = async () => {
    const msgs = S.messages[S.activeChannelId];
    if (!msgs?.length) return;
    await loadMessages(S.activeChannelId, msgs[0].id);
  };

  // Messages scroll
  $('messages-wrapper').addEventListener('scroll', e => {
    if (e.target.scrollTop < 100) $('messages-load-more').click();
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.onclick = () => closeModal(btn.dataset.close);
  });

  // Add server modal flow
  $('btn-create-server-next').onclick = () => {
    $('add-server-step0').classList.add('hidden');
    $('add-server-step-create').classList.remove('hidden');
  };
  $('btn-join-server-next').onclick = () => {
    $('add-server-step0').classList.add('hidden');
    $('add-server-step-join').classList.remove('hidden');
  };
  $('btn-confirm-create-server').onclick = async () => {
    $('cs-error').textContent = '';
    const name = $('new-server-name').value.trim();
    if (!name) { $('cs-error').textContent = t('enter_name'); return; }
    try {
      const srv = await API.post('/api/servers', { name });
      S.servers.push(srv);
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
      showToast(t('server_created').replace('{name}', name), 'success');
    } catch (e) { $('cs-error').textContent = e.body?.error || t('error_generic'); }
  };
  $('btn-confirm-join-server').onclick = async () => {
    $('js-error').textContent = '';
    let code = $('join-invite-input').value.trim();
    // Extract code from URL if needed
    const m = code.match(/invite=([^&]+)/);
    if (m) code = m[1];
    if (!code) { $('js-error').textContent = t('enter_code'); return; }
    try {
      const inv = await API.get(`/api/invites/${code}`);
      const srv = await API.post(`/api/servers/${inv.server.id}/join`, { invite_code: code });
      if (!S.servers.find(s => s.id === srv.id)) S.servers.push(srv);
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
    } catch (e) { $('js-error').textContent = e.body?.error || t('error_generic'); }
  };

  // Create channel confirm
  $('btn-confirm-create-channel').onclick = async () => {
    $('cc-error').textContent = '';
    const { serverId } = S.pendingChannelCreate || {};
    if (!serverId) return;
    const name       = $('new-ch-name').value.trim();
    const type       = $('new-ch-type').value;
    const topic      = $('new-ch-topic').value.trim();
    const categoryId = $('new-ch-category-id').value || null;
    if (!name) { $('cc-error').textContent = t('enter_name'); return; }
    try {
      await API.post(`/api/servers/${serverId}/channels`, { name, type, topic, category_id: categoryId });
      closeModal('modal-create-channel');
      // Reload server data
      const fresh = await API.get(`/api/servers/${serverId}`);
      const idx = S.servers.findIndex(s => s.id === serverId);
      if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...fresh };
      renderChannelList();
    } catch (e) { $('cc-error').textContent = e.body?.error || t('error_generic'); }
  };

  // Close ctx-menu and profile card on outside click
  document.addEventListener('click', () => closeContextMenu());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeContextMenu();
      closeProfileCard();
      $('server-settings').classList.add('hidden');
      $('user-settings').classList.add('hidden');
      document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
    }
  });

  // Setup emoji picker
  setupEmojiPicker();

  // Drag & drop file upload
  setupDragDrop();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearchModal();
    }
  });

  // Load preferences
  const theme    = localStorage.getItem('da_theme')    || 'dark';
  const fontSize = localStorage.getItem('da_fontSize') || '16';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = fontSize + 'px';

  // Handle invite in URL
  const urlParams = new URLSearchParams(location.search);
  const invCode = urlParams.get('invite');
  if (invCode) {
    window.addEventListener('da:authenticated', async () => {
      try {
        const inv = await API.get(`/api/invites/${invCode}`);
        if (await daConfirm(t('accept_invite_question').replace('{name}', inv.server.name), { title: t('accept_invite_title'), confirmText: t('join') })) {
          const srv = await API.post(`/api/servers/${inv.server.id}/join`, { invite_code: invCode });
          if (!S.servers.find(s => s.id === srv.id)) S.servers.push(srv);
          renderServerIcons();
          selectServer(srv.id);
        }
      } catch (e) { showToast(t('invalid_invite'), 'error'); }
    }, { once: true });
  }

  // Logout event
  window.addEventListener('da:logout', doLogout);

  // Strip browser-extension interference from auth inputs
  // (e.g. Dashlane/DWL injects style, readonly, autocomplete=off)
  function sanitizeAuthInputs() {
    document.querySelectorAll('#auth-overlay input').forEach(el => {
      el.removeAttribute('readonly');
      el.removeAttribute('disabled');
      el.style.pointerEvents = 'auto';
      el.style.userSelect    = 'text';
      // Remove injected background-image without wiping legit styles
      if (el.style.backgroundImage) el.style.backgroundImage = '';
    });
  }
  sanitizeAuthInputs();
  // Watch for extension re-injections
  const _extObserver = new MutationObserver(sanitizeAuthInputs);
  document.querySelectorAll('#auth-overlay input').forEach(el => {
    _extObserver.observe(el, { attributes: true, attributeFilter: ['readonly','disabled','style'] });
  });
} // end setup()

// ─── NOTIFICATION SOUND ───────────────────────────────────────────────────────
const NotifSound = (() => {
  let ctx = null;
  function play() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(); osc.stop(ctx.currentTime + 0.25);
    } catch {}
  }
  return { play };
})();

// ─── TAURI INTEGRATION ────────────────────────────────────────────────────────
const IS_TAURI = !!(window.__TAURI__);

async function tauriNotify(title, body) {
  if (!IS_TAURI) return;
  try {
    if (window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke('send_notification', { title, body });
    }
  } catch (e) { console.warn('[Tauri] notification error:', e); }
}

// Override notification sound to also send native notification in Tauri
const _origNotifPlay = NotifSound.play.bind(NotifSound);
NotifSound.play = function(title, body) {
  _origNotifPlay();
  if (IS_TAURI && document.hidden) {
    tauriNotify(title || 'Discord Alt', body || t('new_message'));
  }
};

// Add Tauri class to body for CSS adjustments
if (IS_TAURI) document.body.classList.add('is-tauri');

// ─── IMAGE LIGHTBOX ───────────────────────────────────────────────────────────
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <button class="lightbox-close">\u2715</button>
    <img src="${escHtml(src)}" alt="">
  `;
  overlay.onclick = e => { if (e.target === overlay || e.target.classList.contains('lightbox-close')) overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } };
  window.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// ─── SEARCH MODAL ─────────────────────────────────────────────────────────────
let _searchDebounce = null;
function openSearchModal() {
  if (!S.activeChannelId) { showToast(t('search_select_channel'), 'info'); return; }
  const existing = document.querySelector('.search-overlay');
  if (existing) { existing.remove(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-box">
      <div class="search-input-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input class="search-input" placeholder="${t('search_placeholder')}" autofocus>
      </div>
      <div class="search-hint">${t('search_hint')}</div>
      <div class="search-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.search-input');
  const results = overlay.querySelector('.search-results');
  const hint = overlay.querySelector('.search-hint');

  input.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; hint.style.display = ''; return; }
    hint.style.display = 'none';
    _searchDebounce = setTimeout(async () => {
      try {
        const msgs = await API.get(`/api/channels/${S.activeChannelId}/messages/search?q=${encodeURIComponent(q)}&limit=20`);
        if (!msgs.length) { results.innerHTML = '<div class="search-empty">' + t('search_no_results') + '</div>'; return; }
        results.innerHTML = msgs.map(m => {
          const highlighted = escHtml(m.content || '').replace(new RegExp(escHtml(q).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'gi'), '<mark>$&</mark>');
          return `<div class="search-result" data-msg-id="${escHtml(m.id)}">
            <div style="flex:1;min-width:0">
              <span class="sr-author">${escHtml(m.author?.username || '?')}</span>
              <span class="sr-time">${fmtDatetime(m.created_at)}</span>
              <div class="sr-content">${highlighted}</div>
            </div>
          </div>`;
        }).join('');
        results.querySelectorAll('.search-result').forEach(el => {
          el.onclick = () => {
            overlay.remove();
            const msgEl = document.querySelector(`[data-msg-id="${el.dataset.msgId}"]`);
            if (msgEl) { msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); msgEl.style.background = 'var(--mention-bg)'; setTimeout(() => msgEl.style.background = '', 2000); }
          };
        });
      } catch { results.innerHTML = '<div class="search-empty">' + t('search_error') + '</div>'; }
    }, 300);
  });

  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } };
  window.addEventListener('keydown', onKey);
  input.focus();
}

// ─── DRAG & DROP FILE UPLOAD ──────────────────────────────────────────────────
let _dragCounter = 0;
function setupDragDrop() {
  const app = $('app');
  let dropOverlay = null;

  app.addEventListener('dragenter', e => {
    e.preventDefault();
    _dragCounter++;
    if (_dragCounter === 1 && S.activeChannelId) {
      dropOverlay = document.createElement('div');
      dropOverlay.className = 'drop-overlay';
      dropOverlay.innerHTML = `<div class="drop-overlay-inner"><div class="drop-icon">📎</div><div class="drop-text">${t('drop_files')}</div><div class="drop-sub">${t('drop_sub')}</div></div>`;
      document.body.appendChild(dropOverlay);
    }
  });
  app.addEventListener('dragleave', e => {
    e.preventDefault();
    _dragCounter--;
    if (_dragCounter <= 0) { _dragCounter = 0; dropOverlay?.remove(); dropOverlay = null; }
  });
  app.addEventListener('dragover', e => e.preventDefault());
  app.addEventListener('drop', e => {
    e.preventDefault();
    _dragCounter = 0;
    dropOverlay?.remove();
    dropOverlay = null;
    if (!S.activeChannelId) return;
    const files = e.dataTransfer?.files;
    if (files?.length) for (const f of files) uploadAndSend(f);
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function hideSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 320);
}

async function init() {
  setup();
  applyI18nToHtml();

  // Load socket.io if needed
  if (!window.io) {
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    document.head.appendChild(script);
    await new Promise(res => script.onload = res);
  }

  const token = API.getToken();
  if (!token) {
    // No stored session — show login immediately
    hideSplash();
    showAuth('login');
    return;
  }

  // Silently validate stored session (api.js auto-refreshes if expired)
  try {
    S.me = await API.get('/api/@me');
    hideSplash();
    window.dispatchEvent(new CustomEvent('da:authenticated'));
    await bootApp();
  } catch {
    // Token invalid and refresh failed — force re-login
    API.clearTokens();
    hideSplash();
    showAuth('login');
  }
}

init();
