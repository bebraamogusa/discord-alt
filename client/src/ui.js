import { S, V } from './state.js';
import { API, escHtml, fmtTime, fmtDatetime, parseMarkdown, avatarEl, displayNameFor, showToast, statusDotHtml, getServer, getChannel, renderPollHtml, t, userHasPermissionClient, intToHexColor } from './utils.js';
import { ackChannel } from './unread.js';
import { IC } from './icons.js';

export { getServer, getChannel };

export function showWelcomeScreen() {
  document.getElementById('welcome-screen')?.classList.remove('hidden');
  document.getElementById('chat-header')?.classList.add('hidden');
  document.getElementById('messages-wrapper')?.classList.add('hidden');
  document.getElementById('input-area')?.classList.add('hidden');
  document.getElementById('friends-view')?.classList.add('hidden');
}

const DRAFT_KEY = 'da_channel_drafts';
const PAGE_SIZE = 50;
const pendingMessageLoads = new Set();
const exhaustedHistory = new Set();

// Protected-media blob URLs are deduplicated per source URL and refcounted:
// each rendered element holds one ref, released when its row leaves the DOM.
const mediaStore = new Map();
const mediaPending = new Map();

function acquireMedia(src) {
  const cached = mediaStore.get(src);
  if (cached) {
    cached.refs += 1;
    return Promise.resolve(cached);
  }
  let pending = mediaPending.get(src);
  if (!pending) {
    pending = API.fetchProtectedFile(src)
      .then(objectUrl => {
        let entry = mediaStore.get(src);
        if (!entry) {
          entry = { objectUrl, refs: 0 };
          mediaStore.set(src, entry);
        }
        return entry;
      });
    mediaPending.set(src, pending);
    pending.then(() => { }, () => { }).finally(() => mediaPending.delete(src));
  }
  return pending.then(entry => {
    entry.refs += 1;
    return entry;
  });
}

function releaseMedia(src) {
  const entry = mediaStore.get(src);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.objectUrl);
    mediaStore.delete(src);
  }
}

function releaseAttachmentRefs(root) {
  root?.querySelectorAll('[data-media-key]').forEach(el => {
    releaseMedia(el.dataset.mediaKey);
    delete el.dataset.mediaKey;
  });
}

function clearAttachmentError(el) {
  el.classList.remove('att-failed');
  const box = el.nextElementSibling;
  if (box?.classList.contains('att-error')) box.remove();
}

function showAttachmentError(el) {
  el.dataset.attachmentState = 'error';
  el.classList.add('att-failed');
  if (el.nextElementSibling?.classList.contains('att-error')) return;
  const box = document.createElement('div');
  box.className = 'att-error';
  box.setAttribute('role', 'status');
  box.innerHTML = `<span class="att-error-name"></span><button class="btn btn-outline att-retry" type="button">${t('retry')}</button>`;
  box.querySelector('.att-error-name').textContent = `${t('attachment_failed')}: ${el.dataset.attachmentName || 'file'}`;
  box.querySelector('.att-retry').onclick = () => {
    box.remove();
    el.classList.remove('att-failed');
    delete el.dataset.attachmentState;
    void hydrateAttachment(el);
  };
  el.after(box);
}

async function hydrateAttachment(el) {
  if (el.dataset.attachmentState) return;
  el.dataset.attachmentState = 'loading';
  el.setAttribute('aria-busy', 'true');
  const src = el.dataset.attachmentSrc;
  try {
    const entry = await acquireMedia(src);
    if (!el.isConnected || el.dataset.attachmentSrc !== el.dataset.attachmentOriginalSrc) {
      releaseMedia(src);
      return;
    }
    clearAttachmentError(el);
    el.src = entry.objectUrl;
    el.dataset.objectUrl = entry.objectUrl;
    el.dataset.mediaKey = src;
    el.dataset.attachmentState = 'loaded';
    if (el.tagName === 'IMG') {
      el.dataset.lightbox = entry.objectUrl;
      bindLightboxHandler(el);
    }
  } catch {
    if (el.isConnected) showAttachmentError(el);
  } finally {
    if (el.isConnected) el.removeAttribute('aria-busy');
  }
}

function hydrateAttachments(root) {
  root.querySelectorAll('[data-attachment-src]').forEach(el => { void hydrateAttachment(el); });
}

function readDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}

export function saveDraft(channelId, content) {
  if (!channelId) return;
  const drafts = readDrafts();
  if (content) drafts[channelId] = content;
  else delete drafts[channelId];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

function restoreDraft(channelId) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const draft = readDrafts()[channelId] || '';
  input.value = draft;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

// ─── LOCAL STORAGE REFS ───────────────────────────────────────────────────────
const EMOJI_LIST = ['😀', '😂', '😍', '😎', '🥺', '😭', '😡', '🤔', '🙏', '👍', '👎', '❤️', '🔥', '✅', '❌', '⭐',
  '🎉', '🚀', '💯', '🤩', '😴', '🥳', '😤', '🤣', '😱', '🥰', '🤯', '😏', '🙈', '🎮', '🎵', '🍕', '☕', '🌟', '💎', '🏆'];

export { userHasPermissionClient };

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
const _processedEmbedKeys = new Set();

function embedHtml(embed) {
  if (!embed || (!embed.title && !embed.description && !embed.image)) return '';
  const url = embed.url || '';
  const image = embed.image ? API.resolveUrl(embed.image) : '';
  return `
    <div class="msg-embed" data-url="${escHtml(url)}">
      ${embed.provider ? `<div class="embed-provider">${escHtml(embed.provider)}</div>` : ''}
      ${embed.title ? `<a class="embed-title" href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(embed.title)}</a>` : ''}
      ${embed.description ? `<div class="embed-desc">${escHtml(String(embed.description).slice(0, 300))}</div>` : ''}
      ${image ? `<img class="embed-thumb" src="${escHtml(image)}" loading="lazy" onerror="this.remove()">` : ''}
    </div>
  `;
}

export async function fetchLinkEmbeds(msgEl) {
  const contentEl = msgEl.querySelector('.msg-content');
  if (!contentEl) return;
  const links = contentEl.querySelectorAll('a[href^="http"]');
  if (!links.length) return;

  const urls = [...links].slice(0, 3).map(a => a.href);
  for (const url of urls) {
    if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|ogg|wav)$/i.test(url)) continue;
    const key = `${msgEl.dataset.msgId}:${url}`;
    // server-rendered embed payloads win; never refetch those links
    if (msgEl.querySelector(`.msg-embed[data-url="${CSS.escape(url)}"]`) || _processedEmbedKeys.has(key)) continue;
    _processedEmbedKeys.add(key);
    if (_processedEmbedKeys.size > 5000) _processedEmbedKeys.clear();
    try {
      let meta = _embedCache.get(url);
      if (!meta) {
        meta = await API.get(`/api/embed?url=${encodeURIComponent(url)}`);
        _embedCache.set(url, meta);
      }
      if (!meta || (!meta.title && !meta.description)) continue;
      if (!msgEl.isConnected || ![...msgEl.querySelectorAll('.msg-content a[href^="http"]')].some(a => a.href === url)) continue;

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
         <div class="server-icon ${active ? 'active' : ''}" data-server-id="${escHtml(srv.id)}" role="button" tabindex="0" aria-label="${escHtml(srv.name)}" aria-current="${active ? 'true' : 'false'}">
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
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectServer(el.dataset.serverId); } });
    el.addEventListener('contextmenu', e => { e.preventDefault(); document.dispatchEvent(new CustomEvent('da:show-context-menu', { detail: { event: e, type: 'server', data: { serverId: el.dataset.serverId } } })); });
  });

  const btnHome = document.getElementById('btn-home');
  if (btnHome) btnHome.classList.toggle('active', S.activeServerId === '@me');
}

export function renderTyping() {
  const el = document.getElementById('typing-indicator');
  if (!el) return;
  const entries = Object.entries(S.typingUsers[S.activeChannelId] || {});
  if (!entries.length) {
    el.textContent = '';
    delete el.dataset.typingCount;
    el.classList.add('hidden');
    return;
  }
  const names = entries.map(([userId, info]) => displayNameFor(userId, info.username || t('user_fallback')));
  const text = names.length === 1
    ? t('typing_one', { name: names[0] })
    : names.length === 2
      ? t('typing_two', { a: names[0], b: names[1] })
      : t('typing_many');
  el.innerHTML = `<span class="typing-text">${escHtml(text)}</span>`;
  el.dataset.typingCount = String(names.length);
  el.classList.remove('hidden');
}

export function updateUnreadIndicators(channelId) {
  const channel = document.querySelector(`.channel-item[data-ch-id="${CSS.escape(channelId)}"], .dm-item[data-ch-id="${CSS.escape(channelId)}"]`);
  if (channel) channel.classList.toggle('unread', S.activeChannelId !== channelId && (S.unread[channelId] || 0) > 0);

  document.querySelectorAll('.server-icon[data-server-id]').forEach(icon => {
    const server = getServer(icon.dataset.serverId);
    if (!server) return;
    const count = Object.entries(S.unread).reduce((sum, [id, unread]) =>
      sum + (unread > 0 && server.channels?.some(ch => ch.id === id) ? unread : 0), 0);
    const badge = icon.querySelector('.unread-badge');
    if (count > 0 && S.activeServerId !== server.id) {
      if (badge) badge.textContent = count > 99 ? '99+' : count;
      else icon.insertAdjacentHTML('beforeend', `<div class="unread-badge">${count > 99 ? '99+' : count}</div>`);
    } else if (badge) {
      badge.remove();
    }
  });
}

export async function selectServer(id) {
  S.activeServerId = id;
  S.activeChannelId = null;
  document.getElementById('friends-view')?.classList.add('hidden');
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
    let srv = getServer(id);
    if (!srv) return;
    if (!Array.isArray(srv.channels)) {
      try {
        const snapshot = await API.get(`/api/guilds/${id}`);
        if (S.activeServerId !== id) return;
        const index = S.servers.findIndex(server => server.id === id);
        if (index !== -1) {
          S.servers[index] = { ...srv, ...snapshot };
          srv = S.servers[index];
        }
      } catch { }
    }
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
        <button id="btn-new-dm" type="button" title="${t('new_message')}" aria-label="${t('new_message')}">＋</button>
      </div>
      <div class="dm-item friends-btn ${S.activeChannelId === 'friends' ? 'active' : ''}" role="button" tabindex="0" aria-label="${t('friends')}" data-ch-id="friends">
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
        <div class="dm-item ${isActive ? 'active' : ''}" role="button" tabindex="0" aria-current="${isActive ? 'page' : 'false'}" aria-label="${escHtml(name)}" data-ch-id="${escHtml(ch.id)}">
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
          showFriendsView();
          return;
        }
        selectChannel(e.dataset.chId);
      });
      e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); e.click(); } });
      const ch = S.dmChannels.find(c => c.id === e.dataset.chId);
      if (ch?.type === 'group') {
        e.addEventListener('contextmenu', ev => {
          ev.preventDefault();
          document.dispatchEvent(new CustomEvent('da:show-context-menu', { detail: { event: ev, type: 'dm', data: { channelId: ch.id } } }));
        });
      }
    });
    el.querySelector('#btn-new-dm')?.addEventListener('click', () => document.dispatchEvent(new Event('da:show-new-dm')));
    return;
  }

  const srv = getServer(S.activeServerId);
  if (!srv) return;

  const cats = (srv.categories || []).slice().sort((a, b) => a.position - b.position);
  const allChannels = (srv.channels || []).slice().sort((a, b) => a.position - b.position);
  const isThread = c => c.type === 'thread' || c.type === 11 || String(c.type) === '11';
  const threads = allChannels.filter(isThread);
  const channels = allChannels.filter(c => !isThread(c));
  const threadsByParent = new Map();
  for (const th of threads) {
    const pid = th.parent_id || th.category_id;
    if (!pid) continue;
    if (!threadsByParent.has(pid)) threadsByParent.set(pid, []);
    threadsByParent.get(pid).push(th);
  }
  for (const list of threadsByParent.values()) list.sort((a,b)=>a.position-b.position);
  const uncategorized = channels.filter(c => !c.category_id && c.type !== 'voice' && c.type !== 'stage').concat(
    channels.filter(c => !c.category_id && (c.type === 'voice' || c.type === 'stage'))
  );
  renderChannelGroup(el, null, uncategorized, srv, threadsByParent);
  for (const cat of cats) {
    const chans = channels.filter(c => String(c.category_id ?? c.parent_id ?? '') === String(cat.id));
    renderChannelGroup(el, cat, chans, srv, threadsByParent);
  }
  attachChannelDragHandlers(el, srv);
}

export function renderChannelGroup(container, cat, channels, srv, threadsByParent) {
  if (cat) {
    container.insertAdjacentHTML('beforeend', `
       <div class="category-row" draggable="true" data-cat-id="${escHtml(cat.id)}" data-cat-pos="${cat.position}" role="button" tabindex="0" aria-label="${escHtml(cat.name)}">
        <span>▸</span>
        <span class="category-name">${escHtml(cat.name)}</span>
         <button class="category-add" type="button" data-cat-id="${escHtml(cat.id)}" title="${t('create_channel')}" aria-label="${t('create_channel')}">＋</button>
      </div>
    `);
  }
  for (const ch of channels) {
    let icon;
    if (ch.type === 'voice') icon = IC.speaker;
    else if (ch.type === 'stage') icon = IC.speaker;
    else if (ch.type === 'announcement') icon = IC.announcement;
    else if (ch.type === 'forum') icon = IC.hash;
    else if (ch.type === 'thread' || String(ch.type) === '11') icon = '🧵';
    else icon = IC.hash;
    const isActive = ch.id === S.activeChannelId;
    const unread = S.unread[ch.id] || 0;
    const voiceParticipants = S.voiceStates[ch.id] || [];
    const isConnected = V.channelId === ch.id;
    const isThreadType = ch.type === 'thread' || String(ch.type) === '11';
    container.insertAdjacentHTML('beforeend', `
       <div class="channel-item ${isActive ? 'active' : ''} ${unread && !isActive ? 'unread' : ''} ${isConnected ? 'voice-active' : ''} ${isThreadType ? 'thread' : ''}"
            role="button" tabindex="0" aria-current="${isActive ? 'page' : 'false'}" aria-label="${escHtml(ch.name)}"
            data-ch-id="${escHtml(ch.id)}" data-ch-type="${ch.type}" ${isThreadType ? '' : 'draggable="true"'} data-parent-id="${escHtml(ch.category_id || ch.parent_id || '')}" data-pos="${ch.position}">
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
    const threadList = threadsByParent ? threadsByParent.get(ch.id) : null;
    if (threadList && threadList.length) {
      for (const th of threadList) {
        const thActive = th.id === S.activeChannelId;
        const thUnread = S.unread[th.id] || 0;
        container.insertAdjacentHTML('beforeend', `
          <div class="channel-item thread ${thActive ? 'active' : ''} ${thUnread && !thActive ? 'unread' : ''}"
               role="button" tabindex="0" aria-current="${thActive ? 'page' : 'false'}" aria-label="${escHtml(th.name)}"
               data-ch-id="${escHtml(th.id)}" data-ch-type="thread" data-parent-id="${escHtml(th.parent_id || '')}" data-pos="${th.position}">
            <span class="ch-icon">🧵</span>
            <span class="ch-name">${escHtml(th.name)}</span>
          </div>
        `);
      }
    }
  }

  container.querySelectorAll('.channel-item').forEach(e => {
    e.addEventListener('click', () => selectChannel(e.dataset.chId));
    e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectChannel(e.dataset.chId); } });
    e.addEventListener('contextmenu', ev => { ev.preventDefault(); document.dispatchEvent(new CustomEvent('da:show-context-menu', { detail: { event: ev, type: 'channel', data: { channelId: e.dataset.chId } } })); });
  });
  container.querySelectorAll('.category-add').forEach(e => {
    e.addEventListener('click', ev => {
      ev.stopPropagation();
      document.dispatchEvent(new CustomEvent('da:open-create-channel', { detail: { serverId: srv.id, categoryId: e.dataset.catId } }));
    });
  });
  container.querySelectorAll('.category-row').forEach(e => {
    e.addEventListener('click', () => {
      // toggle collapse could be added, but keep simple
    });
    e.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      document.dispatchEvent(new CustomEvent('da:show-context-menu', { detail: { event: ev, type: 'category', data: { categoryId: e.dataset.catId } } }));
    });
    e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); e.click(); } });
  });
}

let _draggedEl = null;
let _dragSnapshot = null;

function attachChannelDragHandlers(container, srv) {
  if (!srv || container.dataset.dragInit === '1') return;
  container.dataset.dragInit = '1';
  container.addEventListener('dragstart', e => {
    const row = e.target.closest('.channel-item[draggable="true"], .category-row[draggable="true"]');
    if (!row || !container.contains(row)) return;
    _draggedEl = row;
    _dragSnapshot = {
      categories: JSON.parse(JSON.stringify(srv.categories || [])),
      channels: JSON.parse(JSON.stringify(srv.channels || []))
    };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', row.dataset.chId || row.dataset.catId || ''); } catch {}
    setTimeout(() => row.classList.add('dragging'), 0);
  });
  container.addEventListener('dragend', e => {
    const row = e.target.closest('.channel-item, .category-row');
    if (row) row.classList.remove('dragging');
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    _draggedEl = null;
  });
  container.addEventListener('dragover', e => {
    const target = e.target.closest('.channel-item, .category-row');
    if (!target || target === _draggedEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.querySelectorAll('.drag-over').forEach(el => { if (el !== target) el.classList.remove('drag-over'); });
    target.classList.add('drag-over');
  });
  container.addEventListener('dragleave', e => {
    const target = e.target.closest('.channel-item, .category-row');
    if (target) target.classList.remove('drag-over');
  });
  container.addEventListener('drop', async e => {
    const target = e.target.closest('.channel-item, .category-row');
    if (!_draggedEl || !target || target === _draggedEl) return;
    e.preventDefault();
    target.classList.remove('drag-over');
    const isCatDrag = !!_draggedEl.dataset.catId;
    const isCatTarget = !!target.dataset.catId;
    const draggedId = _draggedEl.dataset.catId || _draggedEl.dataset.chId;
    // DOM reorder
    const children = [...container.children];
    const draggedIdx = children.indexOf(_draggedEl);
    const targetIdx = children.indexOf(target);
    if (draggedIdx < 0 || targetIdx < 0) return;
    if (isCatDrag && !isCatTarget) {
      // dragging category onto channel - ignore, put before channel's category group?
      return;
    }
    if (!isCatDrag && isCatTarget) {
      // channel dropped onto category -> insert after category row
      target.after(_draggedEl);
    } else if (draggedIdx < targetIdx) {
      target.after(_draggedEl);
    } else {
      target.before(_draggedEl);
    }
    const payload = buildReorderPayload(container);
    if (!payload.length) return;
    // optimistic update
    applyReorderOptimistic(srv, payload);
    renderChannelList();
    try {
      await API.patch(`/api/guilds/${srv.id}/channels`, payload);
      // Reconcile the optimistic DOM with the server response. Socket delivery can
      // be delayed or unavailable, so the successful PATCH must be authoritative.
      const fresh = await API.get(`/api/guilds/${srv.id}`);
      const serverIndex = S.servers.findIndex(server => server.id === srv.id);
      if (serverIndex !== -1) S.servers[serverIndex] = { ...S.servers[serverIndex], ...fresh };
      renderChannelList();
    } catch (err) {
      // rollback
      srv.categories = _dragSnapshot.categories;
      srv.channels = _dragSnapshot.channels;
      renderChannelList();
      showToast(err.body?.error || t('error_generic'), 'error');
    } finally {
      _dragSnapshot = null;
      _draggedEl = null;
    }
  });
}

function buildReorderPayload(container) {
  const payload = [];
  let position = 0;
  let currentCat = null;
  for (const child of [...container.children]) {
    if (child.classList.contains('category-row')) {
      const catId = child.dataset.catId;
      if (!catId) continue;
      payload.push({ id: catId, position: position++, parent_id: null });
      currentCat = catId;
    } else if (child.classList.contains('channel-item')) {
      if (child.classList.contains('thread')) continue;
      const chId = child.dataset.chId;
      if (!chId) continue;
      payload.push({ id: chId, position: position++, parent_id: currentCat });
    }
  }
  return payload;
}

function applyReorderOptimistic(srv, payload) {
  const map = new Map(payload.map(p => [p.id, p]));
  for (const cat of srv.categories || []) {
    const upd = map.get(cat.id);
    if (upd) { cat.position = upd.position; }
  }
  for (const ch of srv.channels || []) {
    const upd = map.get(ch.id);
    if (upd) {
      ch.position = upd.position;
      ch.parent_id = upd.parent_id;
      ch.category_id = upd.parent_id;
    }
  }
}

export async function selectChannel(id) {
  saveDraft(S.activeChannelId, document.getElementById('msg-input')?.value || '');
  S.activeChannelId = id;
  S.unread[id] = 0;
  renderChannelList();
  renderServerIcons();
  
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
  renderTyping();
  document.getElementById('input-area')?.classList.remove('hidden');

  const isDm = ch.type === 'dm' || ch.type === 'group';
  const participants = isDm && Array.isArray(ch.recipients) ? ch.recipients : [];
  let dmName = ch.type === 'dm' ? ch.recipient?.username : ch.name;
  if (ch.type === 'group' && !dmName) {
    dmName = participants.filter(u => u.id !== S.me?.id).map(u => u.display_name || u.username).join(', ');
  }
  const hIcon = isDm ? '@' : ch.type === 'announcement' ? IC.announcement : IC.hash;
  const chIcon = document.getElementById('chat-ch-icon');
  if (chIcon) chIcon.innerHTML = hIcon;
  const chName = document.getElementById('chat-ch-name');
  if (chName) chName.textContent = isDm ? dmName || t('direct_messages') : ch.name;
  const chTopic = document.getElementById('chat-ch-topic');
  if (chTopic) {
    chTopic.textContent = ch.topic
      || (ch.type === 'group' && participants.length ? t('group_members_count', { n: participants.length }) : '');
  }

  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    msgInput.placeholder = isDm
      ? t('msg_placeholder_dm', { name: dmName || 'user' })
      : t('msg_placeholder_channel', { name: ch.name });
    restoreDraft(id);
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
    refreshLoadMoreButton(id);
  }

  if (S.messages[id]?.length) {
    ackChannel(id);
    updateUnreadIndicators(id);
  }
  msgInput?.focus();
}

function setLoadMoreState(state) {
  const btn = document.getElementById('messages-load-more');
  if (!btn) return;
  const label = btn.querySelector('.load-more-label');
  btn.disabled = state === 'loading';
  if (label) label.textContent = state === 'loading' ? t('load_more_loading') : state === 'error' ? t('load_more_error') : t('load_more');
}

function refreshLoadMoreButton(channelId) {
  if (S.activeChannelId !== channelId) return;
  const btn = document.getElementById('messages-load-more');
  if (!btn) return;
  const canLoadOlder = (S.messages[channelId]?.length || 0) > 0 && !exhaustedHistory.has(channelId);
  btn.classList.toggle('hidden', !canLoadOlder);
  if (canLoadOlder) setLoadMoreState('idle');
}

export async function loadMessages(channelId, before) {
  if (!channelId || pendingMessageLoads.has(channelId)) return;
  if (before && exhaustedHistory.has(channelId)) return;
  const channel = getChannel(channelId);
  if (!channel) return;
  pendingMessageLoads.add(channelId);
  const loadingOlder = !!before;
  if (loadingOlder) setLoadMoreState('loading');
  else exhaustedHistory.delete(channelId);
  const wrapper = document.getElementById('messages-wrapper');
  const prevHeight = wrapper?.scrollHeight ?? 0;
  try {
    const query = before ? `?limit=${PAGE_SIZE}&before=${encodeURIComponent(before)}` : `?limit=${PAGE_SIZE}`;
    const result = await API.get(`/api/channels/${channelId}/messages${query}`);
    const messages = (Array.isArray(result) ? result : (result?.messages || [])).slice().reverse();
    if (messages.length < PAGE_SIZE) exhaustedHistory.add(channelId);
    else exhaustedHistory.delete(channelId);
    const current = S.messages[channelId] || [];
    const merged = before ? [...messages, ...current] : messages;
    const seen = new Set();
    S.messages[channelId] = merged.filter(message => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
    if (S.activeChannelId === channelId) {
      renderMessages();
      if (wrapper) {
        if (loadingOlder) wrapper.scrollTop += wrapper.scrollHeight - prevHeight;
        else wrapper.scrollTo({ top: wrapper.scrollHeight, behavior: 'instant' });
      }
      refreshLoadMoreButton(channelId);
      if (!before) {
        ackChannel(channelId);
        updateUnreadIndicators(channelId);
      }
    }
    return S.messages[channelId];
  } catch (e) {
    if (loadingOlder) setLoadMoreState('error');
    showToast(e.body?.error || t('error_generic'), 'error');
  } finally {
    pendingMessageLoads.delete(channelId);
  }
}

let suppressAutoLoadUntil = 0;

export function requestOlderMessages() {
  if (Date.now() < suppressAutoLoadUntil) return;
  const channelId = S.activeChannelId;
  const msgs = S.messages[channelId];
  if (!msgs?.length || exhaustedHistory.has(channelId)) return;
  void loadMessages(channelId, msgs[0].id);
}

export async function jumpToMessage(channelId, messageId) {
  if (!channelId || !messageId) return;
  suppressAutoLoadUntil = Date.now() + 1500;
  if (S.activeChannelId !== channelId) await selectChannel(channelId);
  if (!S.messages[channelId]?.length) await loadMessages(channelId);
  const targetSel = `[data-msg-id="${CSS.escape(String(messageId))}"]`;
  let el = document.querySelector('#messages-container ' + targetSel);
  if (!el) {
    try {
      const page = await API.get(`/api/channels/${channelId}/messages?around=${encodeURIComponent(messageId)}&limit=${PAGE_SIZE}`);
      S.messages[channelId] = page.slice().reverse();
      renderMessages();
      el = document.querySelector('#messages-container ' + targetSel);
    } catch {
      showToast(t('error_generic'), 'error');
      return;
    }
  }
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 2000);
}

export function renderMessages() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  const previousKeys = new Set();
  container.querySelectorAll('[data-media-key]').forEach(el => previousKeys.add(el.dataset.mediaKey));
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
  hydrateAttachments(container);
  previousKeys.forEach(releaseMedia);
  container.querySelectorAll('.msg-group').forEach(el => fetchLinkEmbeds(el));
}

function messageIsFirst(msg, previous) {
  if (!previous) return true;
  const msgTs = typeof msg.created_at === 'number' && msg.created_at < 1e12 ? msg.created_at * 1000 : msg.created_at;
  const previousTs = typeof previous.created_at === 'number' && previous.created_at < 1e12 ? previous.created_at * 1000 : previous.created_at;
  return previous.author_id !== msg.author_id || (msgTs - previousTs) >= 5 * 60 * 1000;
}

function bindAndFetchMessage(el) {
  if (!el) return;
  bindMessageHandlers(el);
  hydrateAttachments(el);
  void fetchLinkEmbeds(el);
}

export function appendMessage(msg, previous) {
  const container = document.getElementById('messages-container');
  if (!container) return false;
  container.insertAdjacentHTML('beforeend', msgHtml(msg, messageIsFirst(msg, previous), true));
  bindAndFetchMessage(container.lastElementChild);
  return true;
}

export function updateMessage(msg) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
  if (!el) return false;
  const contentEl = el.querySelector('.msg-content');
  if (!contentEl) return false;

  const editedMark = msg.is_edited || msg.edited_at ? `<span class="msg-edited">${t('edited_short')}</span>` : '';
  contentEl.innerHTML = parseMarkdown(msg.content || '') + editedMark;

  const storedEmbeds = Array.isArray(msg.embeds) ? msg.embeds : [];
  el.querySelectorAll('.msg-embed').forEach(embed => embed.remove());
  if (storedEmbeds.length) {
    const embedsHtml = storedEmbeds.map(embedHtml).join('');
    const attsEl = el.querySelector('.msg-attachments');
    if (attsEl) attsEl.insertAdjacentHTML('afterend', embedsHtml);
    else contentEl.insertAdjacentHTML('afterend', embedsHtml);
  } else {
    void fetchLinkEmbeds(el);
  }
  return true;
}

export function removeMessage(messageId, messages) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
  if (!el) return;
  const next = el.nextElementSibling;

  const nextMsg = messages?.find(msg => msg.id === next?.dataset.msgId);
  const previousMsg = messages?.[messages.findIndex(msg => msg.id === nextMsg?.id) - 1];
  const needsRegroup = !!next && !!nextMsg && next.classList.contains('first-in-group') !== messageIsFirst(nextMsg, previousMsg);

  if (needsRegroup) {
    // build the regrouped row before releasing the old one so shared media survives
    const embeds = [...next.querySelectorAll('.msg-embed')];
    next.insertAdjacentHTML('afterend', msgHtml(nextMsg, messageIsFirst(nextMsg, previousMsg)));
    const replacement = next.nextElementSibling;
    embeds.forEach(embed => replacement.appendChild(embed));
    bindAndFetchMessage(replacement);
  }

  releaseAttachmentRefs(el);
  el.remove();
}

function bindMemberItem(el) {
  if (!el) return;
  el.onclick = e => { e.stopPropagation(); document.dispatchEvent(new CustomEvent('da:show-profile', { detail: { userId: el.dataset.userId, anchor: el } })); };
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
}

function memberItemMarkup(m, serverId) {
  const p = S.presences[m.user_id] || {};
  const status = p.status || 'offline';
  const avCol = m.avatar_color || '#5865f2';
  const nColor = m.color || '';
  return `
    <div class="member-item ${status === 'offline' ? 'offline' : ''}" role="button" tabindex="0" aria-label="Профиль ${escHtml(displayNameFor(m.user_id, m.username, serverId))}" data-user-id="${escHtml(m.user_id)}">
      <div class="member-avatar" style="background:${escHtml(avCol)}">
        ${m.avatar_url ? `<img src="${escHtml(m.avatar_url)}">` : (m.username || '?')[0].toUpperCase()}
        ${statusDotHtml(m.user_id, 'var(--bg-2)')}
      </div>
      <div class="member-info">
        <span class="member-name" style="${nColor ? 'color:' + escHtml(nColor) : ''}">${escHtml(displayNameFor(m.user_id, m.username, serverId))}</span>
        ${p.custom_status ? `<span class="member-status">${escHtml(p.custom_status)}</span>` : ''}
      </div>
    </div>`;
}

export function updateMemberRow(serverId, userId) {
  const container = document.getElementById('members-list');
  if (!container || !S.membersVisible || S.activeServerId !== serverId || S.activeServerId === '@me') return false;
  const member = (S.members[serverId] || []).find(m => m.user_id === userId || m.id === userId);
  const row = container.querySelector(`.member-item[data-user-id="${CSS.escape(userId)}"]`);
  if (!member) {
    row?.remove();
    return !!row;
  }
  if (row) {
    row.outerHTML = memberItemMarkup(member, serverId);
    bindMemberItem(container.querySelector(`.member-item[data-user-id="${CSS.escape(userId)}"]`));
    return true;
  }
  container.insertAdjacentHTML('beforeend', memberItemMarkup(member, serverId));
  bindMemberItem(container.lastElementChild);
  return true;
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

function reactionsHtml(msg) {
  return (msg.reactions || []).map(r => {
    const emoji = r.emoji?.name || r.emoji;
    return `
    <button class="reaction-btn ${r.me ? 'me' : ''}" type="button" data-msg-id="${escHtml(msg.id)}" data-emoji="${escHtml(emoji)}">
      ${escHtml(emoji)} <span class="reaction-count">${r.count}</span>
    </button>
  `;
  }).join('');
}

export function updateMessageReactions(messageId) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
  if (!el || !el.classList.contains('msg-group')) return false;
  const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === messageId);
  if (!msg) return false;

  const html = reactionsHtml(msg);
  const existing = el.querySelector('.msg-reactions');
  if (!html) {
    existing?.remove();
    return true;
  }
  if (existing) {
    existing.innerHTML = html;
  } else {
    const anchor = el.querySelector('.poll-container')
      || [...el.querySelectorAll('.msg-body > .msg-attachments, .msg-body > .msg-embed, .msg-body > .msg-content')].pop();
    anchor?.insertAdjacentHTML('afterend', `<div class="msg-reactions">${html}</div>`);
  }
  el.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-reaction', { detail: { msgId: btn.dataset.msgId, emoji: btn.dataset.emoji } }));
  });
  return true;
}

export function msgHtml(msg, isFirst, isNew = false) {
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
           <div class="msg-av-fallback" role="button" tabindex="0" aria-label="Профиль ${escHtml(displayAuthor)}" style="background:${escHtml(author.avatar_color || '#5865f2')}"
                data-user-id="${escHtml(author.id)}">
            ${author.avatar_url
        ? `<img class="msg-avatar" src="${escHtml(author.avatar_url)}" data-user-id="${escHtml(author.id)}">`
        : (displayAuthor || '?')[0].toUpperCase()}
          </div>
        </div>
        <div class="msg-body">
          <div class="msg-meta">
             <span class="msg-username" role="button" tabindex="0" aria-label="Профиль ${escHtml(displayAuthor)}" data-user-id="${escHtml(author.id)}">${escHtml(displayAuthor)}</span>
            <span class="msg-time">${fmtTime(ts)}</span>
          </div>
    `;
  } else {
    headerHtml = `<div class="msg-body" style="padding-left:44px"><span class="msg-hover-time">${fmtTime(ts)}</span>`;
  }

  let replyHtml = '';
  if (isFirst && msg.referenced_message && msg.reference_message_id) {
    replyHtml = `
       <div class="msg-reply" role="button" tabindex="0" aria-label="Перейти к исходному сообщению" data-reply-msg="${escHtml(msg.reference_message_id)}">
         <span class="reply-author">${escHtml(displayNameFor(msg.referenced_message.author?.id, msg.referenced_message.author?.username || '?', S.activeServerId))}</span>
         <span class="reply-content">${escHtml((msg.referenced_message.content || '').slice(0, 80))}</span>
       </div>
    `;
  }

  const atts = (msg.attachments || []).map(a => {
    const ext = a.url.split('.').pop().toLowerCase();
    const url = API.resolveUrl(a.url);
    const name = escHtml(a.filename || 'file');
    const deferred = `data-attachment-src="${escHtml(url)}" data-attachment-original-src="${escHtml(url)}" data-attachment-name="${name}"`;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) {
      return `<img class="att-image" alt="${name}" ${deferred} loading="lazy" data-lightbox="">`;
    }
    if (['mp4', 'webm', 'mov'].includes(ext))
      return `<video class="att-video" ${deferred} controls></video>`;
    if (['mp3', 'ogg', 'wav', 'flac', 'aac'].includes(ext))
      return `<audio ${deferred} controls style="margin-top:4px"></audio>`;
    return `<a class="att-file" href="${escHtml(url)}" download="${escHtml(a.filename || 'file')}">${IC.attach} ${escHtml(a.filename || 'file')}</a>`;
  }).join('');

  const reactions = reactionsHtml(msg);

  const editedMark = msg.is_edited ? `<span class="msg-edited">${t('edited_short')}</span>` : '';
  const isMine = msg.author_id === S.me?.id;

  const canReact = !!getChannel(msg.channel_id);
  const actionsHtml = `
    <div class="msg-actions">
      ${canReact ? `<button class="msg-action-btn" type="button" data-action="react" data-msg-id="${escHtml(msg.id)}" title="${t('react')}" aria-label="${t('react')}">${IC.smile}</button>` : ''}
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
        ${(msg.embeds || []).map(embedHtml).join('')}
        ${reactions ? `<div class="msg-reactions">${reactions}</div>` : ''}
        ${msg.poll ? renderPollHtml(msg) : ''}
      ${closeHeader}
    </div>
  `;
}

function bindLightboxHandler(el) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', 'Открыть изображение');
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('da:open-lightbox', { detail: { src: el.dataset.lightbox } }));
  };
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
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
        document.dispatchEvent(new CustomEvent('da:confirm-delete-message', { detail: { msgId } }));
      } else if (action === 'react') {
        document.dispatchEvent(new CustomEvent('da:show-quick-react', { detail: { target: btn, msgId } }));
      } else if (action === 'thread') {
        document.dispatchEvent(new CustomEvent('da:create-thread', { detail: { channelId: S.activeChannelId, messageId: msgId } }));
      }
    };
  });

  container.querySelectorAll('.msg-group').forEach(el => {
    let pressTimer = null;
    let lastLongPress = 0;
    let startX = 0, startY = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        lastLongPress = Date.now();
        el.dispatchEvent(new MouseEvent('contextmenu', { clientX: startX, clientY: startY, bubbles: true, cancelable: true }));
      }, 500);
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (!pressTimer) return;
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) cancelPress();
    }, { passive: true });
    el.addEventListener('touchend', cancelPress, { passive: true });
    el.addEventListener('touchcancel', cancelPress, { passive: true });
    el.oncontextmenu = event => {
      event.preventDefault();
      if (Date.now() - lastLongPress < 700) return;
      const message = (S.messages[S.activeChannelId] || []).find(item => item.id === el.dataset.msgId);
      if (!message) return;
      document.dispatchEvent(new CustomEvent('da:show-context-menu', {
        detail: {
          event,
          type: 'message',
          data: { msgId: message.id, authorId: message.author_id, pinned: !!message.pinned },
        },
      }));
    };
  });

  container.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-reaction', { detail: { msgId: btn.dataset.msgId, emoji: btn.dataset.emoji } }));
  });

  container.querySelectorAll('.poll-answer:not(.poll-expired)').forEach(el => {
    el.onclick = event => {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent('da:toggle-poll-vote', { detail: { msgId: el.dataset.msgId, answerId: el.dataset.answerId, channelId: el.dataset.chId, isVoted: el.classList.contains('poll-voted') } }));
    };
  });

  container.querySelectorAll('[data-user-id]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('da:show-profile', { detail: { userId: el.dataset.userId, anchor: el } }));
    };
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
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
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
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
    const c = intToHexColor(color);
    const cStr = c ? `color:${c}` : '';
    container.insertAdjacentHTML('beforeend', `<div class="member-group" style="${cStr}">${escHtml(label)} — ${arr.length}</div>`);
    for (const m of arr) {
      const p = S.presences[m.user_id] || {};
      const status = p.status || 'offline';
      let avCol = m.avatar_color || '#5865f2';
      let nColor = m.color ? m.color : '';

      container.insertAdjacentHTML('beforeend', memberItemMarkup(m, S.activeServerId));
    }
  }

  for (const group of sortedHoistedRoles) drawGrp(group.role.name, group.mems, group.role.color);
  drawGrp('В сети', grouped.online);
  drawGrp('Не в сети', grouped.offline);

  container.querySelectorAll('.member-item').forEach(bindMemberItem);
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

  const main = document.getElementById('main');
  if (main && mWrap) main.insertBefore(panel, mWrap);

  panel.querySelectorAll('.vp-screen-video').forEach(video => {
    const userId = video.dataset.screenUser;
    if (userId === S.me?.id) video.srcObject = V.screenStream || null;
    else video.srcObject = V.remoteStreams.get(userId) || null;
  });

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

export function renderVoiceBar() {
  const bar = document.getElementById('voice-connected-bar');
  if (!bar) return;
  const ch = V.channelId ? getChannel(V.channelId) : null;
  if (!ch) {
    bar.classList.add('hidden');
    bar.replaceChildren();
    return;
  }
  bar.classList.remove('hidden');
  const serverName = ch.server_id ? getServer(ch.server_id)?.name : t('direct_messages');
  bar.innerHTML = `
    <div class="vcb-info">
      <div class="vcb-status"><span class="vcb-dot"></span><span class="vcb-name">${escHtml(ch.name)}</span></div>
      <div class="vcb-sub">${t('voice_connected')}${serverName ? ' · ' + escHtml(serverName) : ''}</div>
    </div>
    <div class="vcb-actions">
      <button class="vcb-btn ${V.muted ? 'active' : ''}" id="vcb-mute" title="${escHtml(t(V.muted ? 'voice_unmute' : 'voice_mute'))}">${V.muted ? IC.voiceMuted : IC.voice}</button>
      <button class="vcb-btn ${V.deafened ? 'active' : ''}" id="vcb-deaf" title="${escHtml(t(V.deafened ? 'voice_undeafen' : 'voice_deafen'))}">${V.deafened ? IC.speaker : IC.speakerMuted}</button>
      <button class="vcb-btn screen ${V.isScreenSharing ? 'active' : ''}" id="vcb-screen" title="${escHtml(t(V.isScreenSharing ? 'voice_stop_screen' : 'voice_start_screen'))}">${V.isScreenSharing ? IC.screenOff : IC.screen}</button>
      <button class="vcb-btn danger" id="vcb-leave" title="${escHtml(t('voice_disconnect'))}">${IC.leave}</button>
    </div>
  `;
  bar.querySelector('#vcb-mute').onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-mute'));
  bar.querySelector('#vcb-deaf').onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-deafen'));
  bar.querySelector('#vcb-screen').onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-screen'));
  bar.querySelector('#vcb-leave').onclick = () => document.dispatchEvent(new CustomEvent('da:leave-voice'));
}

// ─── FRIENDS VIEW ─────────────────────────────────────────────────────────────
const FRIEND_ACTION_SVG = {
  message: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  block: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg>',
};

const friendsViewState = { tab: 'online', loading: false, error: false };
let friendsLoadedOnce = false;
let friendsTabsBound = false;

function applyFriendData(list) {
  S.friends = Array.isArray(list) ? list : [];
  S._friendRequestCount = S.friends.filter(f => f.status === 'pending' && f.direction === 'incoming').length;
}

export async function loadFriendCount() {
  try {
    applyFriendData(await API.get('/api/users/@me/relationships'));
  } catch {
    S.friends = [];
    S._friendRequestCount = 0;
  }
  if (S.activeServerId === '@me') renderChannelList();
  if (S.activeChannelId === 'friends') renderFriendsView();
}

function isPresenceOnline(userId) {
  const st = S.presences[userId]?.status;
  return !!st && st !== 'offline' && st !== 'invisible';
}

function friendsForTab(tab) {
  const all = Array.isArray(S.friends) ? S.friends : [];
  if (tab === 'online') return all.filter(f => f.status === 'accepted' && isPresenceOnline(f.user_id));
  if (tab === 'all') return all.filter(f => f.status === 'accepted');
  if (tab === 'pending') return all.filter(f => f.status === 'pending');
  if (tab === 'blocked') return all.filter(f => f.status === 'blocked');
  return [];
}

function friendSubtitle(f) {
  if (f.status === 'pending') return t(f.direction === 'incoming' ? 'friend_incoming' : 'friend_outgoing');
  if (f.status === 'blocked') return t('blocked_users');
  const st = S.presences[f.user_id]?.status || 'offline';
  const keys = { online: 'status_online', idle: 'status_idle', dnd: 'status_dnd', invisible: 'status_offline', offline: 'status_offline' };
  return t(keys[st] || 'status_offline');
}

function friendRowHtml(f) {
  const name = f.display_name || f.username || '?';
  const clickable = f.status === 'accepted';
  const btn = (action, cls, titleKey, icon) =>
    `<button type="button" class="${cls}" data-action="${action}" data-user-id="${escHtml(f.user_id)}" title="${escHtml(t(titleKey))}" aria-label="${escHtml(t(titleKey))}">${icon}</button>`;
  let actions = '';
  if (clickable) {
    actions = btn('message', '', 'open_dm', FRIEND_ACTION_SVG.message)
      + btn('block', 'danger', 'block_user', FRIEND_ACTION_SVG.block)
      + btn('remove', 'danger', 'remove_friend', FRIEND_ACTION_SVG.close);
  } else if (f.status === 'pending' && f.direction === 'incoming') {
    actions = btn('accept', 'success', 'accept_friend', FRIEND_ACTION_SVG.check)
      + btn('decline', 'danger', 'decline_friend', FRIEND_ACTION_SVG.close)
      + btn('block', 'danger', 'block_user', FRIEND_ACTION_SVG.block);
  } else if (f.status === 'pending') {
    actions = btn('decline', 'danger', 'cancel', FRIEND_ACTION_SVG.close);
  } else if (f.status === 'blocked') {
    actions = btn('unblock', '', 'unblock_user', FRIEND_ACTION_SVG.close);
  }
  return `
    <div class="friend-item${clickable ? ' friend-clickable' : ''}" data-user-id="${escHtml(f.user_id)}" data-rel-status="${f.status}"
         ${clickable ? 'role="button" tabindex="0"' : ''}>
      <div class="friend-av">${avatarEl({ username: f.username, avatar_url: f.avatar_url, avatar_color: f.avatar_color }, 32)}${clickable ? statusDotHtml(f.user_id, 'var(--bg)') : ''}</div>
      <div class="friend-info">
        <div class="friend-name">${escHtml(name)}</div>
        <div class="friend-status-text">${escHtml(friendSubtitle(f))}</div>
      </div>
      <div class="friend-actions">${actions}</div>
    </div>`;
}

function bindFriendsTabs() {
  if (friendsTabsBound) return;
  friendsTabsBound = true;
  document.querySelectorAll('.friends-header [data-tab]').forEach(btnEl => {
    btnEl.addEventListener('click', () => {
      friendsViewState.tab = btnEl.dataset.tab;
      renderFriendsView();
    });
  });
  const fhIcon = document.getElementById('friends-fh-icon');
  if (fhIcon) fhIcon.innerHTML = IC.friends;
}

export function renderFriendsView() {
  const view = document.getElementById('friends-view');
  const body = document.getElementById('friends-body');
  if (!view || !body || view.classList.contains('hidden')) return;
  bindFriendsTabs();

  document.querySelectorAll('.friends-header [data-tab]').forEach(btnEl => {
    btnEl.classList.toggle('active', btnEl.dataset.tab === friendsViewState.tab);
  });
  const pendingCount = (Array.isArray(S.friends) ? S.friends : []).filter(f => f.status === 'pending' && f.direction === 'incoming').length;
  const pendingBtn = document.querySelector('[data-tab="pending"]');
  if (pendingBtn) pendingBtn.innerHTML = `${escHtml(t('pending_friends'))}${pendingCount ? ` <span class="friends-tab-badge">${pendingCount}</span>` : ''}`;

  if (friendsViewState.error) {
    body.innerHTML = `
      <div class="empty-state" id="friends-error">
        <div class="empty-text">${escHtml(t('friends_load_error'))}</div>
        <button class="btn btn-outline" id="friends-retry" type="button">${escHtml(t('retry'))}</button>
      </div>`;
    body.querySelector('#friends-retry')?.addEventListener('click', () => {
      friendsViewState.error = false;
      void showFriendsView();
    });
    return;
  }
  if (friendsViewState.loading) {
    body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    return;
  }

  const tab = friendsViewState.tab;
  if (tab === 'add-friend') {
    body.innerHTML = `
      <div class="friend-add-form">
        <div class="friend-count">${escHtml(t('add_friend'))}</div>
        <p class="friend-status-text">${escHtml(t('add_friend_hint'))}</p>
        <div class="friend-search-bar">
          <input id="friend-add-input" type="text" maxlength="32" autocomplete="off" placeholder="${escHtml(t('add_friend_hint'))}">
          <button class="btn btn-primary" id="friend-add-submit" type="button">${escHtml(t('add_friend'))}</button>
        </div>
        <div class="auth-error" id="friend-add-error" role="alert"></div>
      </div>`;
    const input = body.querySelector('#friend-add-input');
    body.querySelector('#friend-add-submit')?.addEventListener('click', () => void submitFriendRequest(input));
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') void submitFriendRequest(input); });
    setTimeout(() => input?.focus(), 30);
    return;
  }

  const items = friendsForTab(tab);
  if (!items.length) {
    const emptyKey = tab === 'pending' ? 'no_pending' : tab === 'blocked' ? 'friends_empty_blocked' : 'no_friends';
    body.innerHTML = `<div class="empty-state friends-empty" data-empty-for="${escHtml(tab)}"><div class="empty-icon">${IC.friends}</div><div class="empty-text">${escHtml(t(emptyKey))}</div></div>`;
    return;
  }

  const label = { online: 'online_friends', all: 'all_friends', pending: 'pending_friends', blocked: 'blocked_users' }[tab] || 'all_friends';
  body.innerHTML = `<div class="friend-count">${escHtml(t(label))} — ${items.length}</div>${items.map(friendRowHtml).join('')}`;

  body.querySelectorAll('[data-action]').forEach(btnEl => {
    btnEl.addEventListener('click', ev => {
      ev.stopPropagation();
      handleFriendAction(btnEl.dataset.action, btnEl.dataset.userId);
    });
  });
  body.querySelectorAll('.friend-clickable').forEach(row => {
    row.addEventListener('click', () => void openFriendDm(row.dataset.userId));
    row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void openFriendDm(row.dataset.userId); } });
  });
}

async function mutateRelationship(fn) {
  try {
    await fn();
  } catch (e) {
    showToast(e.body?.error || e.message || t('error_generic'), 'error');
  }
  await loadFriendCount();
}

function handleFriendAction(action, userId) {
  if (!userId) return;
  if (action === 'message') return void openFriendDm(userId);
  if (action === 'accept') return void mutateRelationship(() => API.put(`/api/users/@me/relationships/${userId}`, { type: 1 }));
  if (action === 'decline' || action === 'remove' || action === 'unblock') return void mutateRelationship(() => API.del(`/api/users/@me/relationships/${userId}`));
  if (action === 'block') return void mutateRelationship(() => API.put(`/api/users/@me/relationships/${userId}`, { type: 2 }));
}

async function submitFriendRequest(input) {
  if (!input) return;
  const username = input.value.trim();
  const errBox = document.getElementById('friend-add-error');
  if (errBox) errBox.textContent = '';
  if (!username) return;
  try {
    await API.post('/api/users/@me/relationships', { username });
    showToast(t('friend_added'), 'success');
    input.value = '';
    await loadFriendCount();
  } catch (e) {
    if (errBox) errBox.textContent = e.body?.error || t('error_generic');
  }
}

export async function openFriendDm(userId) {
  try {
    const dm = await API.post('/api/users/@me/channels', { recipient_id: userId });
    if (dm?.id && !S.dmChannels.find(c => c.id === dm.id)) S.dmChannels.unshift(dm);
    await selectServer('@me');
    selectChannel(dm.id);
  } catch (e) {
    showToast(e.body?.error || t('error_generic'), 'error');
  }
}

export async function showFriendsView() {
  const view = document.getElementById('friends-view');
  if (!view) return;
  bindFriendsTabs();
  ['welcome-screen', 'chat-header', 'messages-wrapper', 'typing-indicator', 'input-area', 'members-panel']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('voice-panel')?.remove();
  view.classList.remove('hidden');

  if (!friendsLoadedOnce) {
    friendsViewState.loading = true;
    friendsViewState.error = false;
    renderFriendsView();
    try {
      applyFriendData(await API.get('/api/users/@me/relationships'));
      friendsLoadedOnce = true;
    } catch {
      friendsViewState.error = true;
    }
    friendsViewState.loading = false;
    renderFriendsView();
    return;
  }
  renderFriendsView();
}
