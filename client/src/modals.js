import { S, V } from './state.js';
import { API, escHtml, clamp, fmtDatetime, fmtTime, t, showToast, daConfirm, daPrompt, avatarEl, displayNameFor, mountDialog } from './utils.js';
import { IC } from './icons.js';
import { getServer, getChannel, selectServer, selectChannel, renderServerIcons, renderChannelList, renderMembersPanel, jumpToMessage, userHasPermissionClient } from './ui.js';
import { createInvite, leaveServer, deleteServer, createCategory, deleteChannel, renameChannel } from './api_requests.js';
import { openUserSettings } from './settings.js';

// ─── PROFILE CARD ─────────────────────────────────────────────────────────────
export async function showProfileCard(userId, anchorEl) {
  document.dispatchEvent(new Event('da:close-context-menu'));
  closeProfileCard();

  const member = S.members[S.activeServerId]?.find(m => m.id === userId) || null;
  let user = member ? { ...member } : null;
  try {
    const fullUser = await API.get(`/api/users/${userId}`).catch(() => null);
    if (fullUser) user = { ...(user || {}), ...fullUser };
  } catch { }
  if (!user) return;

  const p = S.presences[userId] || {};
  const status = p.status || 'offline';
  const isSelf = userId === S.me?.id;
  const banner = user.banner_url || '';
  const displayName = displayNameFor(user.id, user.username || '?', S.activeServerId);
  const bannerStyle = banner ? `background:url(${escHtml(banner)}) center/cover` : `background:${user.banner_color || user.avatar_color || '#5865f2'}`;

  const card = document.getElementById('profile-card-popup');
  card.innerHTML = `
    <div class="pc-banner" style="${bannerStyle}"></div>
    <div class="pc-av-wrap">
      ${user.avatar_url
      ? `<img class="pc-av" src="${escHtml(user.avatar_url)}">`
      : `<div class="pc-av-fallback" style="background:${user.avatar_color || '#5865f2'}">${(user.username || '?')[0].toUpperCase()}</div>`}
      <div class="status-dot ${status}" style="position:absolute;bottom:6px;right:6px;border-color:var(--bg-2)"></div>
    </div>
    <div class="pc-body">
      <div class="pc-name">${escHtml(displayName)}</div>
      ${(displayName !== user.username && user.username) ? `<div class="pc-tag">@${escHtml(user.username)}</div>` : ''}
      <div class="pc-tag">#${escHtml(user.discriminator || '0000')}</div>
      ${p.custom_status ? `<div class="pc-status">${escHtml(p.custom_status)}</div>` : ''}
      ${user.about_me ? `<div class="pc-about">${escHtml(user.about_me)}</div>` : ''}
      <div class="pc-actions">
        ${!isSelf ? `<button class="btn btn-primary pc-dm-btn" data-user-id="${escHtml(userId)}">${t('pc_send_dm')}</button>` : ''}
        ${!isSelf && S.activeServerId !== '@me' ? `<button class="btn btn-secondary pc-add-friend-btn" data-user-id="${escHtml(userId)}">${t('add_friend')}</button>` : ''}
        ${isSelf && S.activeServerId !== '@me' ? `<button class="btn btn-secondary pc-nick-btn">${t('set_nickname')}</button>` : ''}
      </div>
  `;
  card.classList.remove('hidden');

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;
  let left = rect.right + 8;
  let top = rect.top;
  const w = card.offsetWidth || 300;
  const h = card.offsetHeight || 340;
  if (left + w > window.innerWidth - margin) left = rect.left - w - 8;
  card.style.left = `${clamp(left, margin, window.innerWidth - w - margin)}px`;
  card.style.top = `${clamp(top, margin, window.innerHeight - h - margin)}px`;

  _profileDialog = mountDialog(card, { inert: false, trapTab: false });

  card.querySelector('.pc-dm-btn')?.addEventListener('click', async () => {
    closeProfileCard();
    try {
      const dm = await API.post(`/api/users/${userId}/dm`);
      if (!S.dmChannels.find(c => c.id === dm.id)) S.dmChannels.unshift(dm);
      await selectServer('@me');
      selectChannel(dm.id);
    } catch (e) { showToast(e.message, 'error'); }
  });

  card.querySelector('.pc-add-friend-btn')?.addEventListener('click', async () => {
    const btn = card.querySelector('.pc-add-friend-btn');
    if (!btn || btn.disabled || !user.username) return;
    btn.disabled = true;
    try {
      await API.post('/api/users/@me/relationships', { username: user.username });
      showToast(t('friend_added'), 'success');
      btn.textContent = t('pending_friends');
    } catch (e) {
      showToast(e.body?.error || t('error_generic'), 'error');
      btn.disabled = false;
    }
  });

  card.querySelector('.pc-nick-btn')?.addEventListener('click', () => {
    closeProfileCard();
    showNicknameModal();
  });

  const closeCard = e => {
    if (!card.contains(e.target)) { closeProfileCard(); document.removeEventListener('click', closeCard); }
  };
  setTimeout(() => document.addEventListener('click', closeCard), 0);
}

let _profileDialog = null;

export function closeProfileCard() {
  document.getElementById('profile-card-popup').classList.add('hidden');
  if (_profileDialog) {
    const record = _profileDialog;
    _profileDialog = null;
    record.close();
  }
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
const _staticDialogs = new Map();
export function openModal(id) {
  const el = document.getElementById(id);
  if (!el || _staticDialogs.has(id)) return;
  el.classList.remove('hidden');
  _staticDialogs.set(id, mountDialog(el, { onClose: () => el.classList.add('hidden') }));
}
export function closeModal(id) {
  const record = _staticDialogs.get(id);
  if (!record) { document.getElementById(id)?.classList.add('hidden'); return; }
  _staticDialogs.delete(id);
  record.close();
}

// ─── ADD SERVER MODAL ─────────────────────────────────────────────────────────
export function openAddServerModal() {
  document.getElementById('add-server-step0').classList.remove('hidden');
  document.getElementById('add-server-step-create').classList.add('hidden');
  document.getElementById('add-server-step-join').classList.add('hidden');
  openModal('modal-add-server');
}

// ─── CREATE CHANNEL MODAL ─────────────────────────────────────────────────────
export function openCreateChannelModal(serverId, categoryId) {
  S.pendingChannelCreate = { serverId, categoryId };
  document.getElementById('new-ch-name').value = '';
  document.getElementById('new-ch-topic').value = '';
  document.getElementById('new-ch-type').value = 'text';
  document.getElementById('new-ch-category-id').value = categoryId || '';
  document.getElementById('cc-error').textContent = '';
  openModal('modal-create-channel');
}

// ─── NICKNAME MODAL ───────────────────────────────────────────────────────────
export function showNicknameModal() {
  if (!S.activeServerId || S.activeServerId === '@me') return;
  const member = S.members[S.activeServerId]?.find(m => m.id === S.me?.id);
  const currentNick = member?.nickname || '';

  const overlay = document.createElement('div');
  overlay.className = 'da-dialog-overlay';
  overlay.innerHTML = `
    <div class="da-dialog-box da-dialog-compact" role="dialog" aria-modal="true">
      <div class="da-dialog-head"><h3>${t('set_nickname')}</h3></div>
      <div class="nick-modal-content">
        <input id="nick-input" placeholder="${t('nickname_placeholder')}" value="${escHtml(currentNick)}" maxlength="32">
        <div class="nick-modal-actions">
          <button class="btn btn-secondary" id="nick-reset">${t('reset_nickname')}</button>
          <button class="btn btn-primary" id="nick-save">${t('save')}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#nick-input');
  const record = mountDialog(overlay, { initialFocus: input, dismiss: 'remove' });
  const closeNickModal = () => record.close();
  overlay.addEventListener('click', e => { if (e.target === overlay) closeNickModal(); });

  document.getElementById('nick-save').onclick = async () => {
    try {
      const nick = input.value.trim();
      await API.patch(`/api/guilds/${S.activeServerId}/members/${S.me.id}`, { nickname: nick || null });
      if (member) member.nickname = nick || null;
      showToast(t('nickname_saved'), 'success');
      closeNickModal();
      if (S.activeServerId !== '@me') {
        renderMembersPanel();
        renderChannelList();
      }
    } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
  };

  document.getElementById('nick-reset').onclick = async () => {
    try {
      await API.patch(`/api/guilds/${S.activeServerId}/members/${S.me.id}`, { nickname: null });
      if (member) member.nickname = null;
      showToast(t('nickname_saved'), 'success');
      closeNickModal();
      if (S.activeServerId !== '@me') {
        renderMembersPanel();
        renderChannelList();
      }
    } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
  };

  input?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('nick-save').click(); });
}

// ─── NEW DM MODAL ─────────────────────────────────────────────────────────────
export function showNewDmModal() {
  const overlay = document.createElement('div');
  overlay.className = 'da-dialog-overlay';
  overlay.innerHTML = `
    <div class="da-dialog-box da-dialog-wide" role="dialog" aria-modal="true">
      <div class="da-dialog-head">
        <h3>${t('new_dm_title')}</h3>
        <p class="da-dialog-subtitle">${t('new_dm_subtitle')}</p>
      </div>
      <div class="da-dialog-body da-dialog-body-tight">
        <input type="text" id="dm-search-input" class="dm-search-input" placeholder="${t('new_dm_placeholder')}" autocomplete="off">
        <div id="dm-search-results" class="dm-search-results"></div>
      </div>
      <div class="da-dialog-foot">
        <span id="dm-group-count" class="form-hint" style="margin-right:auto"></span>
        <button class="btn btn-primary" id="dm-group-create" disabled>${t('new_dm_group_btn')}</button>
        <button class="btn btn-outline" id="dm-search-cancel">${t('cancel')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const record = mountDialog(overlay, { trapTab: false, dismiss: 'remove' });
  const input = overlay.querySelector('#dm-search-input');
  const results = overlay.querySelector('#dm-search-results');
  const createBtn = overlay.querySelector('#dm-group-create');
  const countEl = overlay.querySelector('#dm-group-count');
  const close = () => record.close();
  const picked = new Map();

  const refreshGroupUi = () => {
    createBtn.disabled = picked.size === 0;
    countEl.textContent = picked.size ? t('new_dm_selected_count', { n: picked.size }) : '';
  };

  overlay.querySelector('#dm-search-cancel').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  results.addEventListener('change', e => {
    const cb = e.target.closest('.dm-pick-checkbox');
    if (!cb) return;
    const user = JSON.parse(cb.dataset.user);
    if (cb.checked) picked.set(user.id, user);
    else picked.delete(user.id);
    refreshGroupUi();
  });

  createBtn.onclick = async () => {
    if (!picked.size) return;
    createBtn.disabled = true;
    try {
      const dm = await API.post('/api/users/@me/channels', { recipients: [...picked.keys()] });
      if (!S.dmChannels.find(c => c.id === dm.id)) S.dmChannels.unshift(dm);
      close();
      await selectServer('@me');
      selectChannel(dm.id);
    } catch (e) {
      showToast(e.body?.error || t('error_generic'), 'error');
      createBtn.disabled = false;
    }
  };

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { results.innerHTML = `<div class="dm-search-empty">${t('new_dm_type_to_search')}</div>`; return; }
    debounce = setTimeout(async () => {
      try {
        const users = await API.get(`/api/users?q=${encodeURIComponent(q)}&limit=15`);
        if (!users.length) {
          results.innerHTML = `<div class="dm-search-empty">${t('new_dm_no_results')}</div>`;
          return;
        }
        results.innerHTML = users.map(u => `
          <div class="dm-search-item" data-user-id="${escHtml(u.id)}">
            <label class="dm-pick-label" title="${t('new_dm_group_btn')}">
              <input type="checkbox" class="dm-pick-checkbox" data-user="${escHtml(JSON.stringify({ id: u.id, username: u.username }))}" ${picked.has(u.id) ? 'checked' : ''}>
            </label>
            <div class="dm-search-meta">
              ${avatarEl(u, 36)}
              <div class="dm-search-text">
                <div class="dm-search-name">${escHtml(u.username)}<span class="dm-search-tag">#${escHtml(u.discriminator)}</span></div>
                ${u.custom_status ? `<div class="dm-search-status">${escHtml(u.custom_status)}</div>` : ''}
              </div>
            </div>
            <button class="btn btn-primary btn-sm dm-start-btn" data-user-id="${escHtml(u.id)}">${t('new_dm_send')}</button>
          </div>
        `).join('');

        results.querySelectorAll('.dm-start-btn').forEach(btn => {
          btn.onclick = async () => {
            try {
              const dm = await API.post(`/api/users/${btn.dataset.userId}/dm`);
              if (!S.dmChannels.find(c => c.id === dm.id)) S.dmChannels.unshift(dm);
              close();
              await selectServer('@me');
              selectChannel(dm.id);
            } catch (e) {
              showToast(e.body?.error || t('error_generic'), 'error');
            }
          };
        });
      } catch {
        results.innerHTML = `<div class="dm-search-empty">${t('error_generic')}</div>`;
      }
    }, 300);
  });

  results.innerHTML = `<div class="dm-search-empty">${t('new_dm_type_to_search')}</div>`;
  setTimeout(() => input.focus(), 50);
}

// ─── IMAGE LIGHTBOX ───────────────────────────────────────────────────────────
export function openLightbox(src) {
  if (!src || document.querySelector('.lightbox-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('close'));
  overlay.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="${t('close')}">\u2715</button>
    <img src="${escHtml(src)}" alt="">
  `;
  document.body.appendChild(overlay);
  const record = mountDialog(overlay, {
    initialFocus: overlay.querySelector('.lightbox-close'),
    onClose: () => overlay.remove(),
  });
  overlay.onclick = e => { if (e.target === overlay || e.target.classList.contains('lightbox-close')) record.close(); };
}

// ─── PINS MODAL ───────────────────────────────────────────────────────────────
export async function showPins() {
  if (!S.activeChannelId) return;
  openModal('modal-pins');
  document.getElementById('pins-list').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  try {
    const pins = await API.get(`/api/channels/${S.activeChannelId}/pins`);
    if (!pins.length) {
      document.getElementById('pins-list').innerHTML = '<div class="empty-state"><div class="empty-icon">' + IC.pin + '</div><div class="empty-text">' + t('no_pinned_short') + '</div></div>';
      return;
    }
    document.getElementById('pins-list').innerHTML = pins.map(msg => `
      <div style="padding:8px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:13px">${escHtml(msg.author?.username || '?')}</div>
        <div style="font-size:14px;color:var(--text-2)">${escHtml((msg.content || '').slice(0, 200))}</div>
        <div style="font-size:12px;color:var(--text-3)">${fmtDatetime(msg.created_at)}</div>
      </div>
    `).join('');
  } catch { }
}

// ─── QUICK SWITCHER (Ctrl+K) ──────────────────────────────────────────────────
let _searchDebounce = null;
let _qsSelectedIdx = 0;
let _searchRecord = null;

export function openSearchModal() {
  const existing = document.querySelector('.search-overlay');
  if (existing) {
    _searchRecord?.close();
    return;
  }

  // Gather all navigable items
  const items = [];
  // Servers + their channels
  for (const srv of S.servers) {
    items.push({ type: 'server', id: srv.id, name: srv.name, icon: srv.icon_url ? `<img src="${escHtml(srv.icon_url)}" style="width:20px;height:20px;border-radius:50%">` : IC.logo, category: 'Серверы' });
    for (const ch of (srv.channels || [])) {
      const chIcon = ch.type === 'voice' ? IC.speaker : ch.type === 'announcement' ? IC.announcement : IC.hash;
      items.push({ type: 'channel', id: ch.id, serverId: srv.id, name: ch.name, icon: chIcon, sub: srv.name, category: 'Каналы' });
    }
  }
  // DMs
  for (const dm of S.dmChannels) {
    const name = dm.type === 'dm' ? (dm.recipient?.username || 'DM') : (dm.name || 'Group');
    items.push({ type: 'dm', id: dm.id, name, icon: IC.msg, category: 'Сообщения' });
  }

  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-box qs-box">
      <div class="search-input-wrap">
        ${IC.search}
        <input class="search-input" placeholder="Куда вы хотите перейти?" autofocus>
        <kbd class="qs-kbd">ESC</kbd>
      </div>
      <div class="qs-tabs">
        <button class="qs-tab active" data-mode="nav">Навигация</button>
        <button class="qs-tab" data-mode="search">Поиск сообщений</button>
      </div>
      <div class="search-results" id="qs-results"></div>
      <div class="qs-footer">
        <span>↑↓ навигация</span>
        <span>↵ перейти</span>
        <span>ESC закрыть</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _searchRecord = mountDialog(overlay, { trapTab: false, onClose: () => { _searchRecord = null; } });
  const dialogRecord = _searchRecord;

  const input = overlay.querySelector('.search-input');
  const results = overlay.querySelector('#qs-results');
  let mode = 'nav';
  _qsSelectedIdx = 0;

  function renderNavResults(q) {
    const lq = q.toLowerCase();
    const filtered = q ? items.filter(i => i.name.toLowerCase().includes(lq) || (i.sub || '').toLowerCase().includes(lq)) : items.slice(0, 15);
    if (!filtered.length) { results.innerHTML = '<div class="search-empty">Ничего не найдено</div>'; return; }

    const grouped = {};
    for (const item of filtered.slice(0, 30)) {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(item);
    }

    let html = '';
    let idx = 0;
    for (const [cat, catItems] of Object.entries(grouped)) {
      html += `<div class="qs-category">${escHtml(cat)}</div>`;
      for (const item of catItems) {
        html += `<div class="qs-item ${idx === _qsSelectedIdx ? 'selected' : ''}" data-idx="${idx}" data-type="${item.type}" data-id="${escHtml(item.id)}" ${item.serverId ? `data-server="${escHtml(item.serverId)}"` : ''}>
          <span class="qs-icon">${item.icon}</span>
          <span class="qs-name">${escHtml(item.name)}</span>
          ${item.sub ? `<span class="qs-sub">${escHtml(item.sub)}</span>` : ''}
        </div>`;
        idx++;
      }
    }
    results.innerHTML = html;
    bindQsItems();
  }

  let searchSeq = 0;
  async function renderSearchResults(q) {
    if (q.length < 2) { results.innerHTML = `<div class="search-empty">${escHtml(t('search_hint'))}</div>`; return; }
    const channelId = S.activeChannelId;
    if (!channelId || channelId === 'friends') {
      results.innerHTML = `<div class="search-empty">${escHtml(t('search_select_channel'))}</div>`;
      return;
    }
    const seq = ++searchSeq;
    results.innerHTML = '<div class="search-empty"><div class="spinner"></div></div>';
    try {
      const res = await API.get(`/api/channels/${channelId}/messages/search?content=${encodeURIComponent(q)}&limit=25`);
      if (seq !== searchSeq) return;
      const msgs = Array.isArray(res?.messages) ? res.messages : [];
      if (!msgs.length) { results.innerHTML = `<div class="search-empty">${escHtml(t('search_no_results'))}</div>`; return; }

      results.innerHTML = `<div class="qs-category">${escHtml(t('search_results_count', { n: res.total_results ?? msgs.length }))}</div>` + msgs.map((m, i) => {
        const highlighted = escHtml(m.content || '').replace(new RegExp(escHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<mark>$&</mark>');
        return `<div class="qs-item search-result ${i === _qsSelectedIdx ? 'selected' : ''}" data-idx="${i}" data-msg-id="${escHtml(m.id)}" data-channel-id="${escHtml(m.channel_id)}" data-type="message">
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:8px;align-items:center">
              <span class="sr-author">${escHtml(m.author?.username || '?')}</span>
              <span class="sr-time">${fmtDatetime(m.created_at)}</span>
            </div>
            <div class="sr-content">${highlighted}</div>
          </div>
        </div>`;
      }).join('');
      bindQsItems();
    } catch {
      if (seq === searchSeq) results.innerHTML = `<div class="search-empty">${escHtml(t('search_error'))}</div>`;
    }
  }

  function bindQsItems() {
    results.querySelectorAll('.qs-item').forEach(el => {
      el.onclick = () => handleQsSelect(el);
      el.onmouseenter = () => {
        results.querySelectorAll('.qs-item').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        _qsSelectedIdx = parseInt(el.dataset.idx);
      };
    });
  }

  function handleQsSelect(el) {
    dialogRecord.close();
    const type = el.dataset.type;
    if (type === 'server') selectServer(el.dataset.id);
    else if (type === 'channel') { selectServer(el.dataset.server); setTimeout(() => selectChannel(el.dataset.id), 50); }
    else if (type === 'dm') { selectServer('@me'); setTimeout(() => selectChannel(el.dataset.id), 50); }
    else if (type === 'message') {
      void jumpToMessage(el.dataset.channelId || S.activeChannelId, el.dataset.msgId);
    }
  }

  overlay.querySelectorAll('.qs-tab').forEach(tab => {
    tab.onclick = () => {
      overlay.querySelectorAll('.qs-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      _qsSelectedIdx = 0;
      const q = input.value.trim();
      if (mode === 'nav') renderNavResults(q);
      else renderSearchResults(q);
    };
  });

  input.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    const q = input.value.trim();
    _qsSelectedIdx = 0;
    if (mode === 'nav') { renderNavResults(q); return; }
    _searchDebounce = setTimeout(() => renderSearchResults(q), 400);
  });

  input.addEventListener('keydown', e => {
    const allItems = results.querySelectorAll('.qs-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _qsSelectedIdx = Math.min(_qsSelectedIdx + 1, allItems.length - 1);
      allItems.forEach((el, i) => el.classList.toggle('selected', i === _qsSelectedIdx));
      allItems[_qsSelectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _qsSelectedIdx = Math.max(_qsSelectedIdx - 1, 0);
      allItems.forEach((el, i) => el.classList.toggle('selected', i === _qsSelectedIdx));
      allItems[_qsSelectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = allItems[_qsSelectedIdx];
      if (sel) handleQsSelect(sel);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const next = mode === 'nav' ? 'search' : 'nav';
      overlay.querySelectorAll('.qs-tab').forEach(t => { t.classList.toggle('active', t.dataset.mode === next); });
      mode = next;
      _qsSelectedIdx = 0;
      const q = input.value.trim();
      if (mode === 'nav') renderNavResults(q);
      else renderSearchResults(q);
    }
  });

  overlay.onclick = e => { if (e.target === overlay) dialogRecord.close(); };
  renderNavResults('');
  input.focus();
}

// ─── CHANNEL SETTINGS MODAL ───────────────────────────────────────────────────
export async function openChannelSettings(channelId) {
  const ch = getChannel(channelId);
  if (!ch) return;
  const isGuild = !!ch.server_id;
  const canManage = isGuild && userHasPermissionClient(ch.server_id, 'manage_channels');

  const overlay = document.createElement('div');
  overlay.className = 'da-dialog-overlay';
  overlay.innerHTML = `
    <div class="da-dialog-box da-dialog-wide" role="dialog" aria-modal="true">
      <div class="da-dialog-head">
        <h3>${IC.settings} Настройки канала</h3>
        <button class="da-dialog-close-btn">✕</button>
      </div>
      <div class="da-dialog-body" style="max-height:60vh;overflow:auto">
        <div class="cs-tabs">
          <button class="cs-tab active" data-tab="overview">Обзор</button>
          <button class="cs-tab" data-tab="permissions">Права</button>
          ${isGuild ? '<button class="cs-tab" data-tab="invites">Приглашения</button>' : ''}
        </div>
        <div id="cs-body"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const dialog = mountDialog(overlay, { dismiss: 'remove' });
  overlay.querySelector('.da-dialog-close-btn').onclick = () => dialog.close();
  overlay.onclick = e => { if (e.target === overlay) dialog.close(); };

  async function renderTab(tab) {
    const body = overlay.querySelector('#cs-body');
    if (tab === 'overview') {
      body.innerHTML = `
        <div class="form-group">
          <label>Название</label>
          <input id="cs-name" value="${escHtml(ch.name || '')}" ${canManage ? '' : 'disabled'}>
        </div>
        <div class="form-group">
          <label>Тема</label>
          <textarea id="cs-topic" ${canManage ? '' : 'disabled'}>${escHtml(ch.topic || '')}</textarea>
        </div>
        ${ch.type === 'text' || ch.type === 0 ? `
        <div class="form-group">
          <label>Медленный режим (сек)</label>
          <input type="number" id="cs-slowmode" value="${ch.rate_limit_per_user || 0}" min="0" max="21600" ${canManage ? '' : 'disabled'}>
        </div>
        <div class="form-group">
          <label>NSFW</label>
          <input type="checkbox" id="cs-nsfw" ${ch.nsfw ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
        </div>` : ''}
        ${canManage ? '<button class="btn btn-primary mt-8" id="cs-save">Сохранить</button>' : ''}
        ${canManage ? `<div style="margin-top:24px"><button class="btn btn-danger" id="cs-delete">Удалить канал</button></div>` : ''}
      `;
      body.querySelector('#cs-save')?.addEventListener('click', async () => {
        try {
          await API.patch(`/api/channels/${channelId}`, {
            name: body.querySelector('#cs-name').value.trim(),
            topic: body.querySelector('#cs-topic').value.trim(),
            rate_limit_per_user: parseInt(body.querySelector('#cs-slowmode')?.value) || 0,
            nsfw: body.querySelector('#cs-nsfw')?.checked || false,
          });
          showToast('Канал обновлён', 'success');
          dialog.close();
        } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      });
      body.querySelector('#cs-delete')?.addEventListener('click', async () => {
        if (!await daConfirm('Удалить этот канал?', { title: 'Удаление канала', danger: true })) return;
        try { await API.del(`/api/channels/${channelId}`); dialog.close(); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      });
    } else if (tab === 'permissions') {
      if (!canManage) {
        body.innerHTML = `
          <div class="perm-denied-notice" id="cs-perm-denied">${IC.lock} Недостаточно прав: управление правами канала требует права «Управлять каналами»</div>
        `;
        return;
      }
      body.innerHTML = `
        <div class="form-group">
          <p style="color:var(--text-2)">Переопределения прав для этого канала. Добавьте роль или участника для настройки.</p>
        </div>
        <div id="cs-perm-list"><div class="empty-state"><div class="spinner"></div></div></div>
        <button class="btn btn-outline mt-8" id="cs-add-perm">+ Добавить переопределение</button>
      `;
      loadChannelPermissions(body, channelId, ch.server_id);
    } else if (tab === 'invites') {
      body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
      try {
        const inv = await API.get(`/api/guilds/${ch.server_id}/invites`);
        const channelInvs = inv.filter(i => i.channel_id === channelId);
        body.innerHTML = !channelInvs.length ? '<div class="empty-state">Нет приглашений для этого канала</div>' :
          channelInvs.map(i => `
            <div style="padding:8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
              <code>${escHtml(i.code)}</code>
              <span style="color:var(--text-3);font-size:12px">${i.uses} использований</span>
            </div>
          `).join('');
      } catch { body.innerHTML = '<div class="empty-state">Не удалось загрузить</div>'; }
    }
  }

  overlay.querySelectorAll('.cs-tab').forEach(tab => {
    tab.onclick = () => {
      overlay.querySelectorAll('.cs-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderTab(tab.dataset.tab);
    };
  });
  renderTab('overview');
}

const OVERWRITE_PERM_BITS = {
  create_instant_invite: 1n << 0n,
  manage_channels: 1n << 4n,
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  read_message_history: 1n << 12n,
  manage_messages: 1n << 13n,
  connect: 1n << 20n,
  mute_members: 1n << 22n,
  deafen_members: 1n << 23n,
  move_members: 1n << 24n,
};

const OVERWRITE_PERM_LABELS = {
  create_instant_invite: 'Создавать приглашения',
  manage_channels: 'Управлять каналом',
  view_channel: 'Видеть канал',
  send_messages: 'Отправлять сообщения',
  read_message_history: 'Читать историю',
  manage_messages: 'Управлять сообщениями',
  connect: 'Подключаться к голосовому',
  mute_members: 'Мьютить участников',
  deafen_members: 'Деафнить участников',
  move_members: 'Перемещать участников',
};

function bitsToNames(bits) {
  const names = [];
  for (const [name, bit] of Object.entries(OVERWRITE_PERM_BITS)) {
    if ((bits & bit) === bit) names.push(OVERWRITE_PERM_LABELS[name]);
  }
  return names;
}

async function loadChannelPermissions(body, channelId, guildId) {
  const permList = body.querySelector('#cs-perm-list');
  if (!permList) return;
  let overwrites = [];
  try {
    overwrites = await API.get(`/api/channels/${channelId}/permissions`);
  } catch (e) {
    permList.innerHTML = `<div class="perm-denied-notice">${escHtml(e.body?.error || 'Не удалось загрузить')}</div>`;
    body.querySelector('#cs-add-perm')?.remove();
    return;
  }

  const renderRows = () => {
    if (!overwrites.length) {
      permList.innerHTML = '<div style="color:var(--text-3);padding:8px" id="cs-perm-empty">Нет переопределений</div>';
      return;
    }
    permList.innerHTML = overwrites.map(ow => `
      <div class="cs-perm-row" data-target-id="${escHtml(ow.target_id)}" style="padding:8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis">
          ${ow.target_type === 0 ? '🛡️ Роль' : '👤 Участник'}: <b>${escHtml(ow.name || ow.target_id)}</b>
          <span style="color:var(--text-3);font-size:12px;display:block">+ ${escHtml(bitsToNames(BigInt(ow.allow || 0)).join(', ') || '—')} / − ${escHtml(bitsToNames(BigInt(ow.deny || 0)).join(', ') || '—')}</span>
        </span>
        <span style="white-space:nowrap">
          <button class="table-btn cs-perm-edit" data-target-id="${escHtml(ow.target_id)}" title="Изменить">&#9998;</button>
          <button class="table-btn del cs-perm-del" data-target-id="${escHtml(ow.target_id)}" title="Удалить">&#128465;</button>
        </span>
      </div>
    `).join('');

    permList.querySelectorAll('.cs-perm-row').forEach(row => {
      const targetId = row.dataset.targetId;
      row.querySelector('.cs-perm-del').onclick = async () => {
        if (!await daConfirm('Удалить это переопределение?', { title: 'Удаление переопределения', danger: true })) return;
        try {
          await API.del(`/api/channels/${channelId}/permissions/${targetId}`);
          showToast('Переопределение удалено', 'success');
          overwrites = overwrites.filter(o => o.target_id !== targetId);
          renderRows();
        } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      };
      row.querySelector('.cs-perm-edit').onclick = () => {
        const ow = overwrites.find(o => o.target_id === targetId);
        if (ow) openOverwriteForm(ow);
      };
    });
  };

  const openOverwriteForm = async existing => {
    const srv = getServer(guildId);
    const roles = (srv?.roles || []).map(r => ({ id: r.id, name: r.id === guildId ? '@everyone' : r.name }));
    let members = S.members[guildId] || [];
    if (!members.length) {
      members = await API.get(`/api/guilds/${guildId}/members`).catch(() => []);
      if (!S.members[guildId]) S.members[guildId] = members.map(m => ({ ...m, ...m.user, role_ids: m.role_ids }));
    }
    const memberOptions = members.map(m => ({ id: m.user_id, name: m.nickname || m.username }));

    const stateOf = ow => {
      const states = {};
      for (const [name, bit] of Object.entries(OVERWRITE_PERM_BITS)) {
        const allow = (BigInt(ow?.allow || 0) & bit) === bit;
        const deny = (BigInt(ow?.deny || 0) & bit) === bit;
        states[name] = allow ? 'allow' : deny ? 'deny' : 'neutral';
      }
      return states;
    };
    const states = stateOf(existing);

    const options = type => (type === 'role' ? roles : memberOptions)
      .map(o => `<option value="${escHtml(o.id)}">${escHtml(o.name)}</option>`).join('');
    const permChecks = Object.entries(OVERWRITE_PERM_BITS).map(([name]) => `
      <label style="display:flex;align-items:center;gap:6px;padding:3px 0">
        <span style="flex:1;font-size:13px">${OVERWRITE_PERM_LABELS[name]}</span>
        <select data-perm="${name}" style="padding:2px 4px;background:var(--input-bg);border:1px solid var(--border);color:var(--text);border-radius:4px">
          <option value="neutral" ${states[name] === 'neutral' ? 'selected' : ''}>—</option>
          <option value="allow" ${states[name] === 'allow' ? 'selected' : ''}>✓</option>
          <option value="deny" ${states[name] === 'deny' ? 'selected' : ''}>✗</option>
        </select>
      </label>
    `).join('');

    const overlay = document.createElement('div');
    overlay.className = 'da-dialog-overlay';
    overlay.id = 'cow-overlay';
    overlay.innerHTML = `
      <div class="da-dialog-box" role="dialog" aria-modal="true">
        <div class="da-dialog-head"><h3>${existing ? 'Изменить переопределение' : 'Добавить переопределение'}</h3></div>
        <div class="da-dialog-body">
          <div class="form-group">
            <label>Тип</label>
            <select id="cow-type">
              <option value="role">Роль</option>
              <option value="member">Участник</option>
            </select>
          </div>
          <div class="form-group">
            <label>Цель</label>
            <select id="cow-target"></select>
          </div>
          <div class="form-group">
            <label>Права</label>
            <div style="max-height:200px;overflow:auto">${permChecks}</div>
          </div>
        </div>
        <div class="da-dialog-foot">
          <button class="btn btn-outline" id="cow-cancel">Отмена</button>
          <button class="btn btn-accent" id="cow-save">Сохранить</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => record.close();
    const record = mountDialog(overlay, { initialFocus: overlay.querySelector('#cow-type'), dismiss: 'remove' });
    overlay.querySelector('#cow-cancel').onclick = close;

    const typeSel = overlay.querySelector('#cow-type');
    const targetSel = overlay.querySelector('#cow-target');
    const fillTargets = () => { targetSel.innerHTML = options(typeSel.value); };
    typeSel.onchange = fillTargets;
    fillTargets();

    if (existing) {
      typeSel.value = existing.target_type === 0 ? 'role' : 'member';
      fillTargets();
      targetSel.value = existing.target_id;
      typeSel.disabled = true;
      targetSel.disabled = true;
    }

    overlay.onclick = ev => { if (ev.target === overlay) close(); };
    overlay.querySelector('#cow-save').onclick = async () => {
      let allow = 0n, deny = 0n;
      for (const sel of overlay.querySelectorAll('select[data-perm]')) {
        if (sel.value === 'allow') allow |= OVERWRITE_PERM_BITS[sel.dataset.perm];
        else if (sel.value === 'deny') deny |= OVERWRITE_PERM_BITS[sel.dataset.perm];
      }
      const targetType = typeSel.value === 'role' ? 0 : 1;
      const targetId = targetSel.value;
      if (!targetId) { showToast('Выберите цель', 'error'); return; }
      try {
        const saved = await API.put(`/api/channels/${channelId}/permissions/${targetId}`, {
          type: targetType,
          allow: allow.toString(),
          deny: deny.toString(),
        });
        showToast('Переопределение сохранено', 'success');
        close();
        const idx = overwrites.findIndex(o => o.target_id === targetId);
        if (idx !== -1) overwrites[idx] = { ...overwrites[idx], ...saved };
        else overwrites.push({ ...saved, name: typeSel.value === 'role'
          ? ((getServer(guildId)?.roles || []).find(r => r.id === targetId)?.name ?? null)
          : ((S.members[guildId] || []).find(m => m.user_id === targetId)?.username ?? null) });
        renderRows();
      } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
    };
  };

  body.querySelector('#cs-add-perm')?.addEventListener('click', () => openOverwriteForm(null));
  renderRows();
}
