/**
 * app.js — discord-alt v2 client
 * Vanilla JS, no frameworks.
 */
import * as API from '/api.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
const S = {
  me: null,                // { id, username, discriminator, avatar_url, ... }
  servers: [],             // [{ id, name, icon_url, channels, categories, roles, ... }]
  dmChannels: [],          // [{ id, type, recipient?, members?, last_message }]
  activeServerId: null,    // '@me' or server id
  activeChannelId: null,
  messages: {},            // { channelId: [{...}] }
  members: {},             // { serverId: [{...}] }
  presences: {},           // { userId: { status, custom_status } }
  typingUsers: {},         // { channelId: { userId: timeoutId } }
  unread: {},              // { channelId: count }
  replyTo: null,           // { id, username, content }
  membersVisible: true,
  pendingChannelCreate: null, // { serverId, categoryId }
};

let socket = null;   // Socket.IO /gateway socket
let muted  = false;

// ─── UTILITY ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const qs = (sel, el = document) => el.querySelector(sel);

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  void t.offsetWidth;
  t.classList.add('visible');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('visible'), 3000);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtTime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function fmtDatetime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleString('ru');
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
  // links
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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
}
function hideAuth() {
  $('auth-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
}

async function doLogin() {
  $('auth-login-err').textContent = '';
  const email = $('li-email').value.trim();
  const password = $('li-pass').value;
  if (!email || !password) { $('auth-login-err').textContent = 'Заполните все поля'; return; }
  try {
    const data = await API.post('/api/auth/login', { email, password });
    API.setToken(data.token);
    API.setRefreshToken(data.refreshToken);
    S.me = data.user;
    await bootApp();
  } catch (e) {
    $('auth-login-err').textContent = e.body?.error || 'Ошибка входа';
  }
}

async function doRegister() {
  $('auth-reg-err').textContent = '';
  const email = $('reg-email').value.trim();
  const username = $('reg-name').value.trim();
  const password = $('reg-pass').value;
  if (!email || !username || !password) { $('auth-reg-err').textContent = 'Заполните все поля'; return; }
  try {
    const data = await API.post('/api/auth/register', { email, username, password });
    API.setToken(data.token);
    API.setRefreshToken(data.refreshToken);
    S.me = data.user;
    await bootApp();
  } catch (e) {
    $('auth-reg-err').textContent = e.body?.error || 'Ошибка регистрации';
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

  socket.on('READY', ({ user, servers, dm_channels, presences }) => {
    S.me = user;
    S.servers = servers;
    S.dmChannels = dm_channels;
    S.presences = presences;
    renderApp();
  });

  socket.on('MESSAGE_CREATE', (msg) => {
    if (!S.messages[msg.channel_id]) S.messages[msg.channel_id] = [];
    S.messages[msg.channel_id].push(msg);
    if (msg.channel_id === S.activeChannelId) {
      appendMessage(msg);
      scrollToBottom();
    } else {
      S.unread[msg.channel_id] = (S.unread[msg.channel_id] || 0) + 1;
      renderChannelList();
      renderServerIcons();
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
    showToast('Сервер был удалён', 'error');
  });

  socket.on('ERROR', ({ message }) => console.warn('[GW]', message));
  socket.on('disconnect', () => console.log('[GW] disconnected'));
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
  const av = $('su-avatar');
  if (S.me.avatar_url) {
    av.outerHTML; // can't reassign outerHTML easily; use innerHTML trick
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
    const hasUnread = Object.entries(S.unread).some(([cid, n]) => n > 0 && srv.channels?.find(c => c.id === cid));
    const active = S.activeServerId === srv.id;
    const letter = srv.name[0].toUpperCase();
    container.insertAdjacentHTML('beforeend', `
      <div class="tooltip-wrapper">
        <div class="server-icon ${active ? 'active' : ''}" data-server-id="${escHtml(srv.id)}">
          ${srv.icon_url
            ? `<img src="${escHtml(srv.icon_url)}" alt="${escHtml(srv.name)}">`
            : escHtml(letter)}
          <div class="pill"></div>
          ${hasUnread && !active ? '<div class="unread-dot"></div>' : ''}
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
    $('sidebar-server-name').textContent = 'Личные сообщения';
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
        <span>Личные сообщения</span>
        <button id="btn-new-dm" title="Новое сообщение">＋</button>
      </div>
    `);
    for (const ch of S.dmChannels) {
      const isActive = ch.id === S.activeChannelId;
      const name = ch.type === 'dm'
        ? (ch.recipient?.username || 'Пользователь')
        : (ch.name || 'Групповой чат');
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
        <button class="category-add" data-cat-id="${escHtml(cat.id)}" title="Создать канал">＋</button>
      </div>
    `);
  }
  for (const ch of channels) {
    const icon = ch.type === 'voice' ? '🔊' : ch.type === 'announcement' ? '📣' : '#';
    const isActive = ch.id === S.activeChannelId;
    const unread = S.unread[ch.id] || 0;
    container.insertAdjacentHTML('beforeend', `
      <div class="channel-item ${isActive ? 'active' : ''} ${unread && !isActive ? 'unread' : ''}"
           data-ch-id="${escHtml(ch.id)}" data-ch-type="${ch.type}">
        <span class="ch-icon">${icon}</span>
        <span class="ch-name">${escHtml(ch.name)}</span>
      </div>
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

  const ch = getChannel(id);
  if (!ch) return;

  // Show chat UI
  $('welcome-screen').classList.add('hidden');
  $('chat-header').classList.remove('hidden');
  $('messages-wrapper').classList.remove('hidden');
  $('typing-indicator').classList.remove('hidden');
  $('input-area').classList.remove('hidden');

  // Update header
  const icon = ch.type === 'voice' ? '🔊' : ch.type === 'dm' ? '@' : ch.type === 'announcement' ? '📣' : '#';
  $('chat-ch-icon').textContent = icon;
  if (ch.type === 'dm') {
    $('chat-ch-name').textContent = ch.recipient?.username || 'Личные сообщения';
  } else {
    $('chat-ch-name').textContent = ch.name;
  }
  $('chat-ch-topic').textContent = ch.topic || '';

  // Update input placeholder
  $('msg-input').placeholder = ch.type === 'dm'
    ? `Написать @${ch.recipient?.username || 'user'}`
    : `Написать в #${ch.name}`;

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
  $('welcome-screen').classList.remove('hidden');
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
    showToast('Ошибка загрузки сообщений', 'error');
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
            <span class="msg-username" data-user-id="${escHtml(author.id)}">${escHtml(author.username||'Неизвестный')}</span>
            <span class="msg-time">${fmtTime(ts)}</span>
          </div>
    `;
  } else {
    headerHtml = `<div class="msg-body" style="padding-left:52px">`;
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
      return `<a href="${escHtml(a.url)}" target="_blank"><img class="att-image" src="${escHtml(a.url)}" loading="lazy"></a>`;
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

  const editedMark = msg.is_edited ? '<span class="msg-edited">(ред.)</span>' : '';
  const isMine = msg.author_id === S.me?.id;

  const actionsHtml = `
    <div class="msg-actions">
      <button class="msg-action-btn" data-action="react" data-msg-id="${escHtml(msg.id)}" title="Реакция">😀</button>
      <button class="msg-action-btn" data-action="reply" data-msg-id="${escHtml(msg.id)}"
              data-username="${escHtml(author.username||'')}"
              data-content="${escHtml((msg.content||'').slice(0,100))}" title="Ответить">↩</button>
      ${isMine ? `<button class="msg-action-btn" data-action="edit" data-msg-id="${escHtml(msg.id)}" title="Редактировать">✏</button>` : ''}
      ${isMine ? `<button class="msg-action-btn danger" data-action="delete" data-msg-id="${escHtml(msg.id)}" title="Удалить">🗑</button>` : ''}
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
  if (names.length === 1) el.innerHTML = `<span>${escHtml(names[0])}</span> печатает…`;
  else el.innerHTML = `<span>${names.slice(0, 3).map(escHtml).join(', ')}</span> печатают…`;
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
    showToast(e.body?.error || 'Ошибка отправки', 'error');
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
    showToast(e.message || 'Ошибка загрузки', 'error');
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
    <div class="msg-edit-hints">Нажмите <kbd>Enter</kbd> для сохранения · <kbd>Esc</kbd> для отмены</div>
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
          showToast(err.body?.error || 'Ошибка', 'error');
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
  if (!confirm('Удалить сообщение?')) return;
  try {
    await API.del(`/api/messages/${msgId}`);
  } catch (e) {
    showToast(e.body?.error || 'Ошибка', 'error');
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
    html += `<div class="members-section-title">В сети — ${online.length}</div>`;
    for (const m of online) html += memberItemHtml(m, 'var(--bg-2)');
  }
  if (offline.length) {
    html += `<div class="members-section-title mt-8">Не в сети — ${offline.length}</div>`;
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
      ${!isSelf ? `<div class="pc-actions"><button class="btn btn-primary pc-dm-btn" data-user-id="${escHtml(userId)}">Написать</button></div>` : ''}
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
    if (item.divider) return '<div class="ctx-divider"></div>';
    return `<div class="ctx-item ${item.danger ? 'danger' : ''}" data-action="${escHtml(item.action || '')}">${escHtml(item.label)}</div>`;
  }).join('');
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach((el, i) => {
    if (items[i] && items[i].onClick) el.addEventListener('click', () => { closeContextMenu(); items[i].onClick(); });
  });
}
function closeContextMenu() { $('ctx-menu').classList.add('hidden'); }

function showServerContextMenu(e, serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  showCtxMenu(e.clientX, e.clientY, [
    { label: '⚙ Настройки сервера', onClick: () => openServerSettings(serverId) },
    { label: '📋 Создать инвайт',   onClick: () => createInvite(serverId) },
    { divider: true },
    !isOwner && { label: '🚪 Покинуть сервер', danger: true, onClick: () => leaveServer(serverId) },
    isOwner  && { label: '🗑 Удалить сервер',  danger: true, onClick: () => deleteServer(serverId) },
  ].filter(Boolean));
}

function showChannelContextMenu(e, channelId) {
  const ch = getChannel(channelId);
  if (!ch || !ch.server_id) return;
  const canManage = getServer(ch.server_id)?.owner_id === S.me?.id;
  if (!canManage) return;
  showCtxMenu(e.clientX, e.clientY, [
    { label: '✏ Переименовать', onClick: () => renameChannel(ch) },
    { label: '🗑 Удалить канал', danger: true, onClick: () => deleteChannel(channelId) },
  ]);
}

async function renameChannel(ch) {
  const name = prompt('Новое название канала:', ch.name);
  if (!name || name === ch.name) return;
  try {
    await API.patch(`/api/channels/${ch.id}`, { name: name.trim() });
    showToast('Канал переименован');
  } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
}

async function deleteChannel(channelId) {
  if (!confirm('Удалить этот канал? Все сообщения будут потеряны.')) return;
  try { await API.del(`/api/channels/${channelId}`); }
  catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
}

// ─── SERVER DROPDOWN ──────────────────────────────────────────────────────────
function showServerDropdown() {
  if (S.activeServerId === '@me') return;
  const srv = getServer(S.activeServerId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  const dd = $('server-dropdown');
  dd.innerHTML = `
    <div class="sm-item" id="sm-invite">📋 Пригласить людей <span class="text-muted">⌘I</span></div>
    ${isOwner ? `<div class="sm-item" id="sm-settings">⚙ Настройки сервера</div>` : ''}
    <div class="sm-item" id="sm-create-ch">+ Создать канал</div>
    <div class="sm-item" id="sm-create-cat">📁 Создать категорию</div>
    <div class="sm-divider"></div>
    ${isOwner
      ? `<div class="sm-item danger" id="sm-delete">🗑 Удалить сервер</div>`
      : `<div class="sm-item danger" id="sm-leave">🚪 Покинуть сервер</div>`}
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
    showToast(`Ссылка скопирована: ${url}`, 'success');
  } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
}

async function leaveServer(serverId) {
  if (!confirm('Покинуть сервер?')) return;
  try {
    await API.post(`/api/servers/${serverId}/leave`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
}

async function deleteServer(serverId) {
  if (!prompt('Введите название сервера для подтверждения удаления:') === getServer(serverId)?.name) return;
  if (!confirm('Удалить сервер? Это действие необратимо.')) return;
  try {
    await API.del(`/api/servers/${serverId}`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
}

async function createCategory(serverId) {
  const name = prompt('Название категории:');
  if (!name) return;
  try {
    await API.post(`/api/servers/${serverId}/categories`, { name });
    // Refresh server
    const srv = await API.get(`/api/servers/${serverId}`);
    const idx = S.servers.findIndex(s => s.id === serverId);
    if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...srv };
    renderChannelList();
  } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
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
      $('pins-list').innerHTML = '<div class="empty-state"><div class="empty-icon">📌</div><div class="empty-text">Нет закреплённых</div></div>';
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
  const name = prompt('Имя пользователя (@username):');
  if (!name) return;
  // Can't search by username directly with current API, show placeholder
  showToast('Скопируйте ID пользователя и передайте ссылку-приглашение', 'error');
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
    { id: 'overview',  label: 'Обзор' },
    { id: 'roles',     label: 'Роли' },
    { id: 'members',   label: 'Участники' },
    { id: 'bans',      label: 'Баны' },
    { id: 'invites',   label: 'Инвайты' },
    { id: 'audit',     label: 'Аудит-лог' },
  ];

  $('ss-nav-items').innerHTML = pages.map(p => `
    <div class="settings-nav-item ${p.id === 'overview' ? 'active' : ''}" data-ss-page="${p.id}">${p.label}</div>
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
  $('ss-page-title').textContent = { overview: 'Обзор', roles: 'Роли', members: 'Участники', bans: 'Баны', invites: 'Инвайты', audit: 'Аудит-лог' }[page] || page;
  const body = $('ss-page-body');
  body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  if (page === 'overview') {
    const invUrl = `${location.origin}/app?invite=${srv.invite_code}`;
    body.innerHTML = `
      <div class="form-group">
        <label>Название сервера</label>
        <input id="ss-name" value="${escHtml(srv.name)}">
      </div>
      <div class="form-group">
        <label>Описание</label>
        <textarea id="ss-desc">${escHtml(srv.description||'')}</textarea>
      </div>
      <div class="form-group">
        <label>Иконка (URL)</label>
        <input id="ss-icon" value="${escHtml(srv.icon_url||'')}">
      </div>
      <div class="form-group">
        <label>Баннер (URL)</label>
        <input id="ss-banner" value="${escHtml(srv.banner_url||'')}">
      </div>
      <button class="btn btn-primary mt-8" id="ss-save-overview">Сохранить изменения</button>

      <div class="form-group mt-16">
        <label>Ссылка-приглашение (постоянная)</label>
        <div class="invite-link-box">
          <code id="ss-invite-url">${escHtml(invUrl)}</code>
          <button class="btn btn-primary copy-btn" id="ss-copy-inv">Скопировать</button>
        </div>
      </div>

      <div class="danger-zone">
        <h4>Опасная зона</h4>
        <button class="btn btn-danger" id="ss-danger-delete">Удалить сервер</button>
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
        showToast('Сохранено', 'success');
      } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
    };
    $('ss-copy-inv').onclick = () => { navigator.clipboard.writeText(invUrl).catch(()=>{}); showToast('Скопировано!', 'success'); };
    $('ss-danger-delete').onclick = () => deleteServer(serverId);
  }

  if (page === 'roles') {
    const roles = await API.get(`/api/servers/${serverId}/roles`).catch(() => []);
    const isOwner = srv.owner_id === S.me?.id;
    const perms = ['send_messages','manage_messages','kick_members','ban_members','manage_channels','manage_server','mention_everyone','manage_roles','view_channel','administrator'];
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <span>${roles.length} ролей</span>
        ${isOwner ? `<button class="btn btn-primary" id="ss-add-role">+ Создать роль</button>` : ''}
      </div>
      <table class="settings-table">
        <thead><tr><th>Роль</th><th>Участников</th><th>Действия</th></tr></thead>
        <tbody>
          ${roles.map(r => `
            <tr data-role-id="${escHtml(r.id)}">
              <td><span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span></td>
              <td>—</td>
              <td class="table-actions">
                ${!r.is_default && isOwner ? `
                  <button class="table-btn edit-role-btn" data-role-id="${escHtml(r.id)}" title="Редактировать">✏</button>
                  <button class="table-btn del delete-role-btn" data-role-id="${escHtml(r.id)}" title="Удалить">🗑</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    body.querySelector('#ss-add-role')?.addEventListener('click', async () => {
      const name  = prompt('Название роли:'); if (!name) return;
      const color = prompt('Цвет (hex, напр. #ff4444):', '#99aab5') || '#99aab5';
      try {
        const role = await API.post(`/api/servers/${serverId}/roles`, { name, color });
        const idx = S.servers.findIndex(s => s.id === serverId);
        if (idx !== -1) S.servers[idx].roles = [...(S.servers[idx].roles||[]), role];
        renderServerSettingsPage(serverId, 'roles');
        showToast('Роль создана', 'success');
      } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
    });
    body.querySelectorAll('.delete-role-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Удалить роль?')) return;
        try {
          await API.del(`/api/servers/${serverId}/roles/${btn.dataset.roleId}`);
          renderServerSettingsPage(serverId, 'roles');
          showToast('Роль удалена');
        } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
    });
    body.querySelectorAll('.edit-role-btn').forEach(btn => {
      btn.onclick = () => openRoleEditor(serverId, btn.dataset.roleId, roles, perms);
    });
  }

  if (page === 'members') {
    const members = S.members[serverId] || await API.get(`/api/servers/${serverId}/members`).catch(() => []);
    if (!S.members[serverId]) S.members[serverId] = members;
    const roles = getServer(serverId)?.roles || [];
    body.innerHTML = `
      <table class="settings-table">
        <thead><tr><th>Пользователь</th><th>Ник</th><th>Роли</th><th>Вступил</th><th></th></tr></thead>
        <tbody>
          ${members.map(m => `
            <tr>
              <td><div class="flex-row">${avatarEl(m, 24)} ${escHtml(m.username)}</div></td>
              <td>${escHtml(m.nickname||'—')}</td>
              <td>${(m.roles||[]).map(r => `<span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span>`).join(' ')}</td>
              <td style="font-size:12px;color:var(--text-3)">${fmtDatetime(m.joined_at)}</td>
              <td class="table-actions">
                ${m.id !== S.me?.id ? `
                  <button class="table-btn del kick-btn" data-user-id="${escHtml(m.id)}" title="Кик">👢</button>
                  <button class="table-btn del ban-btn" data-user-id="${escHtml(m.id)}" title="Бан">🔨</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Кикнуть пользователя?')) return;
        try { await API.del(`/api/servers/${serverId}/members/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'members'); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
    });
    body.querySelectorAll('.ban-btn').forEach(btn => {
      btn.onclick = async () => {
        const reason = prompt('Причина бана (необязательно):');
        if (reason === null) return;
        try { await API.post(`/api/servers/${serverId}/bans/${btn.dataset.userId}`, { reason }); renderServerSettingsPage(serverId, 'members'); showToast('Забанен'); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
    });
  }

  if (page === 'bans') {
    const bans = await API.get(`/api/servers/${serverId}/bans`).catch(() => []);
    body.innerHTML = !bans.length ? '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">Нет банов</div></div>' : `
      <table class="settings-table">
        <thead><tr><th>Пользователь</th><th>Причина</th><th></th></tr></thead>
        <tbody>
          ${bans.map(b => `
            <tr>
              <td>${escHtml(b.username)}</td>
              <td>${escHtml(b.reason||'—')}</td>
              <td><button class="btn btn-outline unban-btn" data-user-id="${escHtml(b.user_id)}">Разбанить</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.unban-btn').forEach(btn => {
      btn.onclick = async () => {
        try { await API.del(`/api/servers/${serverId}/bans/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'bans'); showToast('Разбанен'); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
    });
  }

  if (page === 'invites') {
    const invites = await API.get(`/api/servers/${serverId}/invites`).catch(() => []);
    body.innerHTML = `
      <button class="btn btn-primary mb-8" id="ss-create-inv">+ Создать инвайт</button>
      ${!invites.length ? '<div class="empty-state"><div class="empty-text">Нет инвайтов</div></div>' : `
      <table class="settings-table">
        <thead><tr><th>Код</th><th>Создал</th><th>Использований</th><th>Истекает</th><th></th></tr></thead>
        <tbody>
          ${invites.map(inv => `
            <tr>
              <td><code>${escHtml(inv.code)}</code></td>
              <td>${escHtml(inv.creator_username||'?')}</td>
              <td>${inv.uses}${inv.max_uses ? ` / ${inv.max_uses}` : ''}</td>
              <td>${inv.expires_at ? fmtDatetime(inv.expires_at) : '∞'}</td>
              <td><button class="table-btn del del-inv-btn" data-code="${escHtml(inv.code)}">🗑</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    `;
    body.querySelector('#ss-create-inv')?.addEventListener('click', () => createInvite(serverId));
    body.querySelectorAll('.del-inv-btn').forEach(btn => {
      btn.onclick = async () => {
        try { await API.del(`/api/invites/${btn.dataset.code}`); renderServerSettingsPage(serverId, 'invites'); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
    });
  }

  if (page === 'audit') {
    const logs = await API.get(`/api/servers/${serverId}/audit-log`).catch(() => []);
    const LABELS = { kick:'kicked',ban:'banned',unban:'unbanned',role_create:'created role',role_delete:'deleted role',role_update:'updated role',channel_create:'created channel',channel_delete:'deleted channel',server_update:'updated server',message_delete:'deleted message',invite_create:'created invite',invite_delete:'deleted invite',pin_add:'pinned message',pin_remove:'unpinned message',member_update:'updated member' };
    body.innerHTML = !logs.length ? '<div class="empty-state"><div class="empty-text">Нет записей</div></div>' : `
      <table class="settings-table">
        <thead><tr><th>Кто</th><th>Действие</th><th>Когда</th></tr></thead>
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
  const LABELS = { send_messages:'Отправлять сообщения', manage_messages:'Управлять сообщениями', kick_members:'Кикать участников', ban_members:'Банить участников', manage_channels:'Управлять каналами', manage_server:'Управлять сервером', mention_everyone:'@everyone', manage_roles:'Управлять ролями', view_channel:'Видеть каналы', administrator:'Администратор' };
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <button class="btn btn-outline" id="back-to-roles">← Назад</button>
      <h3>Редактировать: ${escHtml(role.name)}</h3>
    </div>
    <div class="form-group">
      <label>Название</label>
      <input id="re-name" value="${escHtml(role.name)}">
    </div>
    <div class="form-group">
      <label>Цвет</label>
      <input type="color" id="re-color" value="${escHtml(role.color)}">
    </div>
    <div class="form-group">
      <label>Права</label>
      <div class="perm-grid">
        ${perms.map(p => `
          <div class="perm-item">
            <input type="checkbox" id="perm-${p}" ${currentPerms[p] ? 'checked' : ''}>
            <label for="perm-${p}">${escHtml(LABELS[p]||p)}</label>
          </div>
        `).join('')}
      </div>
    </div>
    <button class="btn btn-primary" id="save-role-btn">Сохранить</button>
  `;
  $('back-to-roles').onclick = () => renderServerSettingsPage(serverId, 'roles');
  $('save-role-btn').onclick = async () => {
    const newPerms = {};
    for (const p of perms) { newPerms[p] = !!document.getElementById(`perm-${p}`)?.checked; }
    try {
      await API.patch(`/api/servers/${serverId}/roles/${roleId}`, { name: $('re-name').value.trim(), color: $('re-color').value, permissions: newPerms });
      renderServerSettingsPage(serverId, 'roles');
      showToast('Роль обновлена', 'success');
    } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
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
      <div class="settings-section-title">Мой аккаунт</div>
      <div class="form-group">
        <label>Аватар (URL)</label>
        <input id="us-avatar" value="${escHtml(S.me?.avatar_url||'')}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>Цвет аватара</label>
        <input type="color" id="us-av-color" value="${escHtml(S.me?.avatar_color||'#5865f2')}">
      </div>
      <div class="form-group">
        <label>Баннер (URL)</label>
        <input id="us-banner" value="${escHtml(S.me?.banner_url||'')}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>Цвет баннера</label>
        <input type="color" id="us-banner-color" value="${escHtml(S.me?.banner_color||'#5865f2')}">
      </div>
      <div class="form-group">
        <label>О себе (до 190 символов)</label>
        <textarea id="us-about" maxlength="190">${escHtml(S.me?.about_me||'')}</textarea>
      </div>
      <div class="form-group">
        <label>Статус</label>
        <input id="us-status" value="${escHtml(S.me?.custom_status||'')}" placeholder="Чем сейчас занят?">
      </div>
      <button class="btn btn-primary" id="us-save">Сохранить</button>
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
        showToast('Сохранено', 'success');
      } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
    };
  } else if (page === 'appearance') {
    content.innerHTML = `
      <div class="settings-section-title">Оформление</div>
      <div class="form-group">
        <label>Тема</label>
        <select id="us-theme">
          <option value="dark"  ${document.documentElement.dataset.theme==='dark'  ?'selected':''}>Тёмная</option>
          <option value="light" ${document.documentElement.dataset.theme==='light' ?'selected':''}>Светлая</option>
          <option value="amoled"${document.documentElement.dataset.theme==='amoled'?'selected':''}>AMOLED</option>
        </select>
      </div>
      <div class="form-group">
        <label>Размер шрифта</label>
        <input type="range" id="us-fontsize" min="12" max="20" value="${parseInt(localStorage.getItem('da_fontSize')||'16')}">
        <div class="form-hint" id="us-fs-preview">16px</div>
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
  }
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
function setup() {
  // Auth
  $('li-btn').onclick  = doLogin;
  $('reg-btn').onclick = doRegister;
  $('goto-register').onclick = () => showAuth('register');
  $('goto-login').onclick    = () => showAuth('login');
  $('li-pass').onkeydown  = e => e.key === 'Enter' && doLogin();
  $('reg-pass').onkeydown = e => e.key === 'Enter' && doRegister();

  // Switch password fields from type=text to type=password on first focus
  // (prevents Dashlane/DWL from injecting readonly on page load)
  ['li-pass','reg-pass'].forEach(id => {
    const el = $(id);
    el.addEventListener('focus', () => { if (el.type !== 'password') el.type = 'password'; }, { once: true });
  });

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

  // Mute button
  $('btn-toggle-mute').onclick = () => {
    muted = !muted;
    $('btn-toggle-mute').textContent = muted ? '🔇' : '🎤';
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
    if (!name) { $('cs-error').textContent = 'Введите название'; return; }
    try {
      const srv = await API.post('/api/servers', { name });
      S.servers.push(srv);
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
      showToast(`Сервер "${name}" создан`, 'success');
    } catch (e) { $('cs-error').textContent = e.body?.error || 'Ошибка'; }
  };
  $('btn-confirm-join-server').onclick = async () => {
    $('js-error').textContent = '';
    let code = $('join-invite-input').value.trim();
    // Extract code from URL if needed
    const m = code.match(/invite=([^&]+)/);
    if (m) code = m[1];
    if (!code) { $('js-error').textContent = 'Введите код или ссылку'; return; }
    try {
      const inv = await API.get(`/api/invites/${code}`);
      const srv = await API.post(`/api/servers/${inv.server.id}/join`, { invite_code: code });
      if (!S.servers.find(s => s.id === srv.id)) S.servers.push(srv);
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
    } catch (e) { $('js-error').textContent = e.body?.error || 'Ошибка'; }
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
    if (!name) { $('cc-error').textContent = 'Введите название'; return; }
    try {
      await API.post(`/api/servers/${serverId}/channels`, { name, type, topic, category_id: categoryId });
      closeModal('modal-create-channel');
      // Reload server data
      const fresh = await API.get(`/api/servers/${serverId}`);
      const idx = S.servers.findIndex(s => s.id === serverId);
      if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...fresh };
      renderChannelList();
    } catch (e) { $('cc-error').textContent = e.body?.error || 'Ошибка'; }
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
        if (confirm(`Вступить на сервер "${inv.server.name}"?`)) {
          const srv = await API.post(`/api/servers/${inv.server.id}/join`, { invite_code: invCode });
          if (!S.servers.find(s => s.id === srv.id)) S.servers.push(srv);
          renderServerIcons();
          selectServer(srv.id);
        }
      } catch (e) { showToast('Неверный инвайт', 'error'); }
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

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  setup();

  // Check if socket.io is available
  if (!window.io) {
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    document.head.appendChild(script);
    await new Promise(res => script.onload = res);
  }

  const token = API.getToken();
  if (!token) {
    showAuth('login');
    return;
  }

  // Validate token
  try {
    S.me = await API.get('/api/@me');
    window.dispatchEvent(new CustomEvent('da:authenticated'));
    await bootApp();
  } catch {
    API.clearTokens();
    showAuth('login');
  }
}

init();
