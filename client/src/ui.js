import { S, V } from './state.js';
import { API, escHtml, fmtTime, fmtDatetime, parseMarkdown, avatarEl, displayNameFor, showToast, statusDotHtml, getServer, getChannel, t } from './utils.js';
import { IC } from './icons.js';
import { toggleReaction, confirmDeleteMessage, createInvite, deleteServer, leaveServer, createCategory, renameChannel, deleteChannel } from './api_requests.js';
import { showProfileCard, openCreateChannelModal, showNewDmModal, showNicknameModal, openChannelSettings, openNotificationSettings } from './modals.js';
import { showContextMenu } from './context_menus.js';
import { renderPollHtml, attachPollHandlers, openPollCreator, createThread } from './features.js';

// ─── LOCAL STORAGE REFS ───────────────────────────────────────────────────────
const EMOJI_LIST = ['😀', '😂', '😍', '😎', '🥺', '😭', '😡', '🤔', '🙏', '👍', '👎', '❤️', '🔥', '✅', '❌', '⭐',
  '🎉', '🚀', '💯', '🤩', '😴', '🥳', '😤', '🤣', '😱', '🥰', '🤯', '😏', '🙈', '🎮', '🎵', '🍕', '☕', '🌟', '💎', '🏆'];

export function userHasPermissionClient(serverId, perm) {
  const srv = S.servers.find(s => s.id === serverId);
  if (!srv || !S.me) return false;
  if (srv.owner_id === S.me.id) return true;
  const member = (S.members[serverId] || []).find(m => m.user_id === S.me.id || m.id === S.me.id);
  if (!member || !member.roles) return false;
  // Administrator override
  if (member.roles.some(r => typeof r.permissions === 'string' && r.permissions.includes('"administrator":true'))) return true;
  return member.roles.some(r => typeof r.permissions === 'string' && r.permissions.includes(`"${perm}":true`));
}

// ─── PERMISSIONS CACHE ──────────────────────────────────────────────────────────
const permCache = new Map();

export function hasPermission(serverId, memberId, permName) {
  const cacheKey = `${serverId}:${memberId}:${permName}`;
  const now = Date.now();
  if (permCache.has(cacheKey) && (now - permCache.get(cacheKey).ts < 60000)) return permCache.get(cacheKey).val;

  const srv = S.servers.find(s => s.id === serverId);
  let val = false;
  if (srv && srv.owner_id === memberId) val = true;
  else {
    const member = (S.members[serverId] || []).find(m => m.user_id === memberId || m.id === memberId);
    if (member && member.roles) {
      if (member.roles.some(r => typeof r.permissions === 'string' && r.permissions.includes('"administrator":true'))) val = true;
      else if (member.roles.some(r => typeof r.permissions === 'string' && r.permissions.includes(`"${permName}":true`))) val = true;
    }
  }
  permCache.set(cacheKey, { val, ts: now });
  return val;
}

export function clearPermCache() {
  permCache.clear();
}

// ─── LINK EMBEDS ──────────────────────────────────────────────────────────────
const _embedCache = new Map();

export async function fetchLinkEmbeds(msgEl) {
  const contentEl = msgEl.querySelector('.msg-content');
  if (!contentEl) return;
  const links = contentEl.querySelectorAll('a[href^="http"]');
  if (!links.length) return;

  const urls = [...links].slice(0, 3).map(a => a.href);
  for (const url of urls) {
    if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|ogg|wav)$/i.test(url)) continue;
    if (msgEl.querySelector(`.msg-embed[data-url="${CSS.escape(url)}"]`)) continue;
    try {
      let meta = _embedCache.get(url);
      if (!meta) {
        meta = await API.get(`/api/embed?url=${encodeURIComponent(url)}`);
        _embedCache.set(url, meta);
      }
      if (!meta || (!meta.title && !meta.description)) continue;

      const embedHtml = `
        <div class="msg-embed" data-url="${escHtml(url)}">
          ${meta.siteName ? `<div class="embed-provider">${escHtml(meta.siteName)}</div>` : ''}
          ${meta.title ? `<a class="embed-title" href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(meta.title)}</a>` : ''}
          ${meta.description ? `<div class="embed-desc">${escHtml(meta.description.slice(0, 300))}</div>` : ''}
          ${meta.image ? `<img class="embed-thumb" src="${escHtml(meta.image)}" loading="lazy" onerror="this.remove()">` : ''}
        </div>
      `;
      const attsEl = msgEl.querySelector('.msg-attachments');
      if (attsEl) attsEl.insertAdjacentHTML('afterend', embedHtml);
      else {
        const body = msgEl.querySelector('.msg-content');
        body?.insertAdjacentHTML('afterend', embedHtml);
      }
    } catch { /* ignore */ }
  }
}

// ─── I18N SUPPORT ─────────────────────────────────────────────────────────────
export function applyI18nToHtml() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const trans = t(key);
    if (!trans) return;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'button' || el.type === 'submit') el.value = trans;
      else el.placeholder = trans;
    } else {
      // Keep SVG icons inside buttons if present
      const svg = el.querySelector('svg');
      if (svg) {
        el.innerHTML = '';
        el.appendChild(svg);
        el.appendChild(document.createTextNode(' ' + trans));
      } else {
        el.textContent = trans;
      }
    }
  });

  const searchInput = document.getElementById('msg-input');
  if (searchInput) {
    const ch = getChannel(S.activeChannelId);
    if (ch) {
      searchInput.placeholder = ch.type === 'dm'
        ? t('msg_placeholder_dm', { name: ch.recipient?.username || 'user' })
        : t('msg_placeholder_channel', { name: ch.name });
    }
  }
}

// ─── UI RENDERERS ─────────────────────────────────────────────────────────────
export function renderServerIcons() {
  const container = document.getElementById('server-icons');
  if (!container) return;
  container.innerHTML = '';
  // The structure matches `app.js` renderServerIcons for parity
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
  const sld2 = document.getElementById('server-list-divider2');
  if (sld2) {
    if (S.servers.length) sld2.classList.remove('hidden');
    else sld2.classList.add('hidden');
  }

  container.querySelectorAll('.server-icon').forEach(el => {
    el.addEventListener('click', () => selectServer(el.dataset.serverId));
    el.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, 'server', { serverId: el.dataset.serverId }); });
  });

  const btnHome = document.getElementById('btn-home');
  if (btnHome) btnHome.classList.toggle('active', S.activeServerId === '@me');
}

export async function selectServer(id) {
  S.activeServerId = id;
  S.activeChannelId = null;
  renderServerIcons();

  const sidebarServerName = document.getElementById('sidebar-server-name');
  const sidebarHeaderArrow = document.getElementById('sidebar-header-arrow');

  if (id === '@me') {
    if (sidebarServerName) sidebarServerName.textContent = t('direct_messages');
    if (sidebarHeaderArrow) sidebarHeaderArrow.style.display = 'none';
    const drop = document.getElementById('server-dropdown');
    if (drop) drop.classList.add('hidden');
    renderChannelList();
  } else {
    const srv = getServer(id);
    if (!srv) return;
    if (sidebarServerName) sidebarServerName.textContent = srv.name;
    if (sidebarHeaderArrow) sidebarHeaderArrow.style.display = '';
    renderChannelList();

    if (!S.members[id] || !S.members[id].length) {
      try {
        const raw = await API.get(`/api/guilds/${id}/members`);
        S.members[id] = raw.map(m => ({ ...m, ...m.user, roles: m.role_ids?.map(rid => ({ id: rid })) }));
      } catch { }
    }
    const firstCh = srv.channels?.find(c => c.type === 'text');
    if (firstCh) selectChannel(firstCh.id);
  }
}

export function renderChannelList() {
  const el = document.getElementById('sidebar-channel-list');
  if (!el) return;
  el.innerHTML = '';

  if (S.activeServerId === '@me') {
    el.insertAdjacentHTML('beforeend', `
      <div class="dm-header">
        <span>${t('direct_messages')}</span>
        <button id="btn-new-dm" title="${t('new_message')}">＋</button>
      </div>
      <div class="dm-item friends-btn ${S.activeChannelId === 'friends' ? 'active' : ''}" data-ch-id="friends">
        <div class="dm-avatar">${IC.friends}</div>
        <div class="dm-info"><div class="dm-name">${t('friends')}</div></div>
        ${S._friendRequestCount > 0 ? `<div class="unread-badge">${S._friendRequestCount}</div>` : ''}
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
      e.addEventListener('click', () => {
        if (e.dataset.chId === 'friends') {
          S.activeChannelId = 'friends';
          renderChannelList();
          // showFriendsView() logic moved into app.js scope or to separate view file. For now stub handling:
          const cw = document.getElementById('friends-view');
          if (cw) cw.classList.remove('hidden');
          return;
        }
        selectChannel(e.dataset.chId);
      });
    });
    el.querySelector('#btn-new-dm')?.addEventListener('click', showNewDmModal);
    return;
  }

  const srv = getServer(S.activeServerId);
  if (!srv) return;

  const cats = (srv.categories || []).slice().sort((a, b) => a.position - b.position);
  const channels = (srv.channels || []).slice().sort((a, b) => a.position - b.position);

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
    const icon = ch.type === 'voice' ? IC.speaker : ch.type === 'announcement' ? IC.announcement : IC.hash;
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
              <span class="ch-voice-av" style="background:${escHtml(p.avatar_color || '#5865f2')}">
                ${p.avatar_url
        ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
        : escHtml((displayNameFor(p.user_id, p.display_name || p.nickname || p.username || '?', srv.id) || '?')[0].toUpperCase())}
              </span>
              <span>${escHtml(displayNameFor(p.user_id, p.display_name || p.nickname || p.username || '?', srv.id))}</span>
              ${p.muted ? '<span class="ch-voice-muted">' + IC.voiceMuted + '</span>' : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    `);
  }

  container.querySelectorAll('.channel-item').forEach(e => {
    e.addEventListener('click', () => selectChannel(e.dataset.chId));
    e.addEventListener('contextmenu', ev => { ev.preventDefault(); showContextMenu(ev, 'channel', { channelId: e.dataset.chId }); });
  });
  container.querySelectorAll('.category-add').forEach(e => {
    e.addEventListener('click', ev => {
      ev.stopPropagation();
      openCreateChannelModal(srv.id, e.dataset.catId);
    });
  });
}

export async function selectChannel(id) {
  S.activeChannelId = id;
  S.unread[id] = 0;
  renderChannelList();
  
  document.dispatchEvent(new CustomEvent('da:channel-selected'));
  
  const fv = document.getElementById('friends-view');
  if (fv) fv.classList.add('hidden');

  const ch = getChannel(id);
  if (!ch) return;

  if (ch.type === 'voice') {
    document.getElementById('welcome-screen')?.classList.add('hidden');
    document.getElementById('chat-header')?.classList.remove('hidden');
    document.getElementById('messages-wrapper')?.classList.add('hidden');
    document.getElementById('typing-indicator')?.classList.add('hidden');
    document.getElementById('input-area')?.classList.add('hidden');
    document.getElementById('members-panel')?.classList.add('hidden');
    const chIcon = document.getElementById('chat-ch-icon');
    if (chIcon) chIcon.innerHTML = IC.speaker;
    const chName = document.getElementById('chat-ch-name');
    if (chName) chName.textContent = ch.name;
    const chTopic = document.getElementById('chat-ch-topic');
    if (chTopic) chTopic.textContent = ch.topic || '';
    renderVoicePanel();
    return;
  }

  document.getElementById('voice-panel')?.remove();
  document.getElementById('welcome-screen')?.classList.add('hidden');
  document.getElementById('chat-header')?.classList.remove('hidden');
  document.getElementById('messages-wrapper')?.classList.remove('hidden');
  document.getElementById('typing-indicator')?.classList.remove('hidden');
  document.getElementById('input-area')?.classList.remove('hidden');

  const hIcon = ch.type === 'dm' ? '@' : ch.type === 'announcement' ? IC.announcement : IC.hash;
  const chIcon = document.getElementById('chat-ch-icon');
  if (chIcon) chIcon.innerHTML = hIcon;
  const chName = document.getElementById('chat-ch-name');
  if (chName) chName.textContent = ch.type === 'dm' ? ch.recipient?.username || t('direct_messages') : ch.name;
  const chTopic = document.getElementById('chat-ch-topic');
  if (chTopic) chTopic.textContent = ch.topic || '';

  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    msgInput.placeholder = ch.type === 'dm'
      ? t('msg_placeholder_dm', { name: ch.recipient?.username || 'user' })
      : t('msg_placeholder_channel', { name: ch.name });
  }

  if (S.membersVisible && S.activeServerId !== '@me') {
    document.getElementById('members-panel')?.classList.remove('hidden');
    renderMembersPanel();
  } else {
    document.getElementById('members-panel')?.classList.add('hidden');
  }

  // cancelReply(); (needs to be implemented or imported if used elsewhere)
  S.replyTo = null;
  const rBar = document.getElementById('reply-bar');
  if (rBar) rBar.classList.remove('visible');

  if (!S.messages[id]) {
    // loadMessages(id);
    document.dispatchEvent(new CustomEvent('da:load-messages', { detail: { channelId: id } }));
  } else {
    renderMessages();
    const el = document.getElementById('messages-wrapper');
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  }

  if (S.messages[id]?.length) {
    const lastId = S.messages[id][S.messages[id].length - 1]?.id;
    if (lastId && window.socket) window.socket.emit('READ_ACK', { channel_id: id, message_id: lastId });
  }
  msgInput?.focus();
}

export function renderMessages() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.innerHTML = '';
  const raw = S.messages[S.activeChannelId] || [];
  const seen = new Set();
  const msgs = raw.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  S.messages[S.activeChannelId] = msgs;
  let lastAuthor = null, lastTs = 0;
  for (const msg of msgs) {
    const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
      ? msg.created_at * 1000 : msg.created_at;
    const sameAuthor = lastAuthor === msg.author_id && (ts - lastTs) < 5 * 60 * 1000;
    container.insertAdjacentHTML('beforeend', msgHtml(msg, !sameAuthor));
    lastAuthor = msg.author_id;
    lastTs = ts;
  }
  bindMessageHandlers(container);
  container.querySelectorAll('.msg-group').forEach(el => fetchLinkEmbeds(el));
}

export function updateSidebarUser() {
  if (!S.me) return;
  const un = document.getElementById('su-username');
  if (un) un.textContent = S.me.username;
  const cs = document.getElementById('su-custom-status');
  if (cs) cs.textContent = S.me.custom_status || '';
  const avWrap = document.getElementById('su-av-wrapper');
  if (avWrap) {
    if (S.me.avatar_url) {
      avWrap.innerHTML = `<img src="${escHtml(S.me.avatar_url)}" style="width:32px;height:32px;border-radius:50%" id="su-avatar">${statusDotHtml(S.me.id, 'var(--bg-3)')}`;
    } else {
      const letter = (S.me.username || '?')[0].toUpperCase();
      avWrap.innerHTML = `<div class="av-fallback" id="su-avatar" style="width:32px;height:32px;font-size:13px;background:${S.me.avatar_color || '#5865f2'}">${letter}</div>${statusDotHtml(S.me.id, 'var(--bg-3)')}`;
    }
  }
}

function msgHtml(msg, isFirst, isNew = false) {
  if (msg.type === 'system' || msg.type === 'server_join') {
    return `<div class="msg-system" data-msg-id="${msg.id}">${IC.wave} ${escHtml(msg.content)}</div>`;
  }
  const author = msg.author || {};
  const displayAuthor = displayNameFor(author.id, author.username || t('unknown_user'), S.activeServerId);
  const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
    ? msg.created_at * 1000 : msg.created_at;

  let headerHtml = '';
  if (isFirst) {
    headerHtml = `
      <div class="msg-group-header">
        <div class="msg-avatar-col">
          <div class="msg-av-fallback" style="background:${escHtml(author.avatar_color || '#5865f2')}"
               data-user-id="${escHtml(author.id)}" style="cursor:pointer">
            ${author.avatar_url
        ? `<img class="msg-avatar" src="${escHtml(author.avatar_url)}" data-user-id="${escHtml(author.id)}">`
        : (displayAuthor || '?')[0].toUpperCase()}
          </div>
        </div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-username" data-user-id="${escHtml(author.id)}">${escHtml(displayAuthor)}</span>
            <span class="msg-time">${fmtTime(ts)}</span>
          </div>
    `;
  } else {
    headerHtml = `<div class="msg-body" style="padding-left:44px"><span class="msg-hover-time">${fmtTime(ts)}</span>`;
  }

  let replyHtml = '';
  if (isFirst && msg.reply_to && msg.reply_to_id) {
    replyHtml = `
      <div class="msg-reply" data-reply-msg="${escHtml(msg.reply_to_id)}">
        <span class="reply-author">${escHtml(displayNameFor(msg.reply_to.author?.id, msg.reply_to.author?.username || '?', S.activeServerId))}</span>
        <span class="reply-content">${escHtml((msg.reply_to.content || '').slice(0, 80))}</span>
      </div>
    `;
  }

  const atts = (msg.attachments || []).map(a => {
    const ext = a.url.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext))
      return `<img class="att-image" src="${escHtml(a.url)}" loading="lazy" data-lightbox="${escHtml(a.url)}">`;
    if (['mp4', 'webm', 'mov'].includes(ext))
      return `<video class="att-video" src="${escHtml(a.url)}" controls></video>`;
    if (['mp3', 'ogg', 'wav', 'flac', 'aac'].includes(ext))
      return `<audio src="${escHtml(a.url)}" controls style="margin-top:4px"></audio>`;
    return `<a class="att-file" href="${escHtml(a.url)}" download="${escHtml(a.filename || 'file')}">${IC.attach} ${escHtml(a.filename || 'file')}</a>`;
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
      <button class="msg-action-btn" data-action="react" data-msg-id="${escHtml(msg.id)}" title="${t('react')}">${IC.smile}</button>
      <button class="msg-action-btn" data-action="reply" data-msg-id="${escHtml(msg.id)}"
              data-username="${escHtml(displayAuthor || '')}"
              data-content="${escHtml((msg.content || '').slice(0, 100))}" title="${t('reply')}">↩</button>
      <button class="msg-action-btn" data-action="thread" data-msg-id="${escHtml(msg.id)}" title="Создать ветку">🧵</button>
      ${isMine ? `<button class="msg-action-btn" data-action="edit" data-msg-id="${escHtml(msg.id)}" title="${t('edit')}">${IC.edit}</button>` : ''}
      ${isMine ? `<button class="msg-action-btn danger" data-action="delete" data-msg-id="${escHtml(msg.id)}" title="${t('delete')}">${IC.trash}</button>` : ''}
    </div>
  `;

  const closeHeader = isFirst ? `</div></div>` : `</div>`;

  return `
    <div class="msg-group ${isFirst ? 'first-in-group' : 'continued'}${isNew ? ' msg-new' : ''}" data-msg-id="${msg.id}">
      ${actionsHtml}
      ${replyHtml}
      ${headerHtml}
        <div class="msg-content" id="msg-content-${msg.id}">${parseMarkdown(msg.content || '')}${editedMark}</div>
        ${atts ? `<div class="msg-attachments">${atts}</div>` : ''}
        ${reactions ? `<div class="msg-reactions">${reactions}</div>` : ''}
        ${msg.poll ? renderPollHtml(msg) : ''}
      ${closeHeader}
    </div>
  `;
}

function bindMessageHandlers(container) {
  container.querySelectorAll('.msg-action-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgId;
      if (action === 'reply') {
        S.replyTo = { id: msgId, username: btn.dataset.username, content: btn.dataset.content };
        const rn = document.getElementById('reply-name');
        if (rn) rn.textContent = btn.dataset.username;
        const rp = document.getElementById('reply-preview');
        if (rp) rp.textContent = btn.dataset.content.slice(0, 80);
        document.getElementById('reply-bar')?.classList.add('visible');
        document.getElementById('msg-input')?.focus();
      } else if (action === 'edit') {
        const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === msgId);
        if (msg) replaceWithEditInput(msgId, msg.content);
      } else if (action === 'delete') {
        confirmDeleteMessage(msgId);
      } else if (action === 'react') {
        document.dispatchEvent(new CustomEvent('da:show-quick-react', { detail: { target: btn, msgId } }));
      } else if (action === 'thread') {
        createThread(S.activeChannelId, msgId);
      }
    };
  });

  container.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => toggleReaction(btn.dataset.msgId, btn.dataset.emoji);
  });

  attachPollHandlers(container);

  container.querySelectorAll('[data-user-id]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      showProfileCard(el.dataset.userId, el);
    };
  });

  container.querySelectorAll('[data-lightbox]').forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('da:open-lightbox', { detail: { src: el.dataset.lightbox } }));
    };
  });

  container.querySelectorAll('.msg-reply[data-reply-msg]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      e.stopPropagation();
      const targetId = el.dataset.replyMsg;
      const target = document.querySelector(`[data-msg-id="${targetId}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('msg-highlight');
        setTimeout(() => target.classList.remove('msg-highlight'), 2000);
      }
    };
  });
}

export function replaceWithEditInput(msgId, content) {
  const contentEl = document.getElementById(`msg-content-${msgId}`);
  if (!contentEl) return;
  const originalHtml = contentEl.innerHTML;
  contentEl.innerHTML = `
    <textarea class="edit-input" id="edit-input-${msgId}">${escHtml(content)}</textarea>
    <div style="font-size:12px;color:var(--text-3);margin-top:4px">
      Нажмите <kbd>ESC</kbd> для <a>отмены</a> • Нажмите <kbd>ENTER</kbd> для <a>сохранения</a>
    </div>
  `;
  const textarea = document.getElementById(`edit-input-${msgId}`);
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  textarea.onkeydown = async e => {
    if (e.key === 'Escape') {
      contentEl.innerHTML = originalHtml;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newContent = textarea.value.trim();
      if (!newContent) return;
      if (newContent === content) { contentEl.innerHTML = originalHtml; return; }
      try {
        await API.patch(`/api/messages/${msgId}`, { content: newContent });
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
        contentEl.innerHTML = originalHtml;
      }
    }
  };
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  });
}

export function renderMembersPanel() {
  const container = document.getElementById('members-list');
  if (!container || !S.membersVisible || S.activeServerId === '@me') return;
  
  const guildRoles = S.servers.find(s => s.id === S.activeServerId)?.roles || [];
  const srvMembers = S.members[S.activeServerId] || [];

  const grouped = { online: [], offline: [] };

  const rolesWithMembers = {};
  for (const m of srvMembers) {
    const p = S.presences[m.user_id] || {};
    const st = p.status || 'offline';
    if (st === 'offline') { grouped.offline.push(m); continue; }
    
    const roleIds = m.role_ids || [];
    let hoistedRole = null;
    let highestPos = -1;
    for (const rid of roleIds) {
      const r = guildRoles.find(x => x.id === rid);
      if (r && r.hoist && r.position > highestPos) {
        hoistedRole = r;
        highestPos = r.position;
      }
    }
    if (hoistedRole) {
      if (!rolesWithMembers[hoistedRole.id]) rolesWithMembers[hoistedRole.id] = { role: hoistedRole, mems: [] };
      rolesWithMembers[hoistedRole.id].mems.push(m);
    } else {
      grouped.online.push(m);
    }
  }

  container.innerHTML = '';
  const sortedHoistedRoles = Object.values(rolesWithMembers).sort((a, b) => b.role.position - a.role.position);

  function drawGrp(label, arr, color) {
    if (!arr.length) return;
    const cStr = color ? `color:${color}` : '';
    container.insertAdjacentHTML('beforeend', `<div class="member-group" style="${cStr}">${escHtml(label)} — ${arr.length}</div>`);
    for (const m of arr) {
      const p = S.presences[m.user_id] || {};
      const status = p.status || 'offline';
      let avCol = m.avatar_color || '#5865f2';
      let nColor = m.color ? m.color : '';

      container.insertAdjacentHTML('beforeend', `
        <div class="member-item ${status === 'offline' ? 'offline' : ''}" data-user-id="${escHtml(m.user_id)}">
          <div class="member-avatar" style="background:${escHtml(avCol)}">
            ${m.avatar_url ? `<img src="${escHtml(m.avatar_url)}">` : (m.username || '?')[0].toUpperCase()}
            ${statusDotHtml(m.user_id, 'var(--bg-2)')}
          </div>
          <div class="member-info">
            <span class="member-name" style="${nColor ? 'color:' + escHtml(nColor) : ''}">${escHtml(displayNameFor(m.user_id, m.username, S.activeServerId))}</span>
            ${p.custom_status ? `<span class="member-status">${escHtml(p.custom_status)}</span>` : ''}
          </div>
        </div>
      `);
    }
  }

  for (const group of sortedHoistedRoles) drawGrp(group.role.name, group.mems, group.role.color);
  drawGrp('В сети', grouped.online);
  drawGrp('Не в сети', grouped.offline);

  container.querySelectorAll('.member-item').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); showProfileCard(el.dataset.userId, el); };
  });
}

// Ensure toggleReaction can be accessed
// For voice, if `voice-panel` isn't found, replace simply ignores. We only extracted DOM stuff here.
export function renderVoicePanel() {
  const ch = getChannel(S.activeChannelId);
  if (!ch || ch.type !== 'voice') return;

  const participants = S.voiceStates[ch.id] || [];
  const screenParticipants = participants.filter(p => p.sharing_screen);
  const inVoice = V.channelId === ch.id;

  const mWrap = document.getElementById('messages-wrapper');
  if (mWrap) mWrap.classList.add('hidden');
  const iArea = document.getElementById('input-area');
  if (iArea) iArea.classList.add('hidden');
  document.getElementById('voice-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'voice-panel';
  panel.className = 'voice-panel';
  panel.innerHTML = `
    <div class="vp-header">
      <div class="vp-icon">${IC.speaker}</div>
      <h2>${escHtml(ch.name)}</h2>
      <div class="vp-sub">${participants.length > 0 ? t('voice_participants', { n: participants.length }) : t('voice_empty')}</div>
    </div>
    <div class="vp-stage ${screenParticipants.length ? '' : 'hidden'}">
      ${screenParticipants.map(p => {
    const name = displayNameFor(p.user_id, p.display_name || p.nickname || p.username || '?', ch.server_id || S.activeServerId);
    return `
          <div class="vp-screen-tile">
            <video class="vp-screen-video" data-screen-user="${escHtml(p.user_id)}" autoplay playsinline ${p.user_id === S.me?.id ? 'muted' : ''}></video>
            <div class="vp-screen-overlay">${IC.screen} ${escHtml(name)}</div>
          </div>
        `;
  }).join('')}
    </div>
    <div class="vp-participants">
      ${participants.map(p => `
        <div class="vp-participant">
          <div class="vp-av" style="background:${escHtml(p.avatar_color || '#5865f2')}">
            ${p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : escHtml((displayNameFor(p.user_id, p.display_name || p.nickname || p.username || '?', ch.server_id || S.activeServerId) || '?')[0].toUpperCase())}
            ${p.muted ? '<div class="vp-muted-badge">' + IC.voiceMuted + '</div>' : ''}
          </div>
          <div class="vp-name">${escHtml(displayNameFor(p.user_id, p.display_name || p.nickname || p.username || '?', ch.server_id || S.activeServerId))}</div>
          ${p.user_id === S.me?.id ? `<div class="vp-you">${t('voice_you')}</div>` : ''}
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
          ${V.muted ? IC.voiceMuted + ` ${t('voice_unmute')}` : IC.voice + ` ${t('voice_mute')}`}
        </button>
        <button class="btn ${V.deafened ? 'btn-danger-solid' : 'btn-outline'}" id="vp-deaf">
          ${V.deafened ? IC.speaker + ` ${t('voice_undeafen')}` : IC.speakerMuted + ` ${t('voice_deafen')}`}
        </button>
        <button class="btn ${V.isScreenSharing ? 'btn-primary' : 'btn-outline'}" id="vp-screen">
          ${V.isScreenSharing ? IC.screenOff + ` ${t('voice_stop_screen')}` : IC.screen + ` ${t('voice_start_screen')}`}
        </button>
        <button class="btn btn-danger-solid" id="vp-leave">${t('voice_disconnect')}</button>
      </div>
    `}
  `;

  const main = document.querySelector('main');
  if (main && mWrap) main.insertBefore(panel, mWrap);

  const joinBtn = panel.querySelector('#vp-join');
  if (joinBtn) joinBtn.onclick = () => document.dispatchEvent(new CustomEvent('da:join-voice', { detail: { channelId: ch.id } }));
  
  const muteBtn = panel.querySelector('#vp-mute');
  if (muteBtn) muteBtn.onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-mute'));
  
  const deafBtn = panel.querySelector('#vp-deaf');
  if (deafBtn) deafBtn.onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-deafen'));

  const screenBtn = panel.querySelector('#vp-screen');
  if (screenBtn) screenBtn.onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-screen'));

  const leaveBtn = panel.querySelector('#vp-leave');
  if (leaveBtn) leaveBtn.onclick = () => document.dispatchEvent(new CustomEvent('da:leave-voice'));
}

// Friends View specific view handling (placeholder for UI module)
export function showFriendsView() {
  const fv = document.getElementById('friends-view');
  if (fv) fv.classList.remove('hidden');
}

// Make globally available to Context Menus and other files where they are requested via Events
document.addEventListener('da:open-server-settings', (e) => openServerSettings(e.detail.serverId));
document.addEventListener('da:leave-server', (e) => leaveServer(e.detail.serverId));
document.addEventListener('da:delete-server', (e) => deleteServer(e.detail.serverId));
