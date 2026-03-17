import { S, V } from './state.js';
import { API, escHtml, clamp, fmtDatetime, fmtTime, t, showToast, daConfirm, daPrompt, avatarEl, displayNameFor } from './utils.js';
import { IC } from './icons.js';
import { getServer, getChannel, selectServer, selectChannel, renderServerIcons, renderChannelList, renderMembersPanel, openServerSettings, openNotificationSettings } from './ui.js';
import { createInvite, leaveServer, deleteServer, createCategory, deleteChannel, renameChannel } from './api_requests.js';
import { openUserSettings } from './settings.js';
import { closeContextMenu } from './context_menus.js';

// ─── PROFILE CARD ─────────────────────────────────────────────────────────────
export async function showProfileCard(userId, anchorEl) {
  closeContextMenu();
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
    showToast(t('notifications_wip'));
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

export function closeProfileCard() {
  document.getElementById('profile-card-popup').classList.add('hidden');
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
export function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
export function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

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
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const input = document.getElementById('nick-input');
  input?.focus();

  document.getElementById('nick-save').onclick = async () => {
    try {
      const nick = input.value.trim();
      await API.patch(`/api/guilds/${S.activeServerId}/members/${S.me.id}`, { nickname: nick || null });
      if (member) member.nickname = nick || null;
      showToast(t('nickname_saved'), 'success');
      overlay.remove();
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
      overlay.remove();
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
        <button class="btn btn-outline" id="dm-search-cancel">${t('cancel')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#dm-search-input');
  const results = overlay.querySelector('#dm-search-results');
  const close = () => overlay.remove();

  overlay.querySelector('#dm-search-cancel').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

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

export function openSearchModal() {
  const existing = document.querySelector('.search-overlay');
  if (existing) { existing.remove(); return; }

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

  async function renderSearchResults(q) {
    if (q.length < 2) { results.innerHTML = '<div class="search-empty">Введите минимум 2 символа</div>'; return; }
    results.innerHTML = '<div class="search-empty"><div class="spinner"></div></div>';
    try {
      const channelId = S.activeChannelId;
      let msgs = [];
      if (channelId && channelId !== 'friends') {
        msgs = await API.get(`/api/channels/${channelId}/messages/search?q=${encodeURIComponent(q)}&limit=25`);
      }
      if (!msgs.length) { results.innerHTML = '<div class="search-empty">Ничего не найдено</div>'; return; }

      results.innerHTML = msgs.map((m, i) => {
        const highlighted = escHtml(m.content || '').replace(new RegExp(escHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<mark>$&</mark>');
        return `<div class="qs-item search-result ${i === _qsSelectedIdx ? 'selected' : ''}" data-idx="${i}" data-msg-id="${escHtml(m.id)}" data-type="message">
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
    } catch { results.innerHTML = '<div class="search-empty">Ошибка поиска</div>'; }
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
    overlay.remove();
    const type = el.dataset.type;
    if (type === 'server') selectServer(el.dataset.id);
    else if (type === 'channel') { selectServer(el.dataset.server); setTimeout(() => selectChannel(el.dataset.id), 50); }
    else if (type === 'dm') { selectServer('@me'); setTimeout(() => selectChannel(el.dataset.id), 50); }
    else if (type === 'message') {
      const msgEl = document.querySelector(`[data-msg-id="${el.dataset.msgId}"]`);
      if (msgEl) { msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); msgEl.classList.add('msg-highlight'); setTimeout(() => msgEl.classList.remove('msg-highlight'), 2000); }
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

  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } };
  window.addEventListener('keydown', onKey);
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
  overlay.querySelector('.da-dialog-close-btn').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

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
          overlay.remove();
        } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      });
      body.querySelector('#cs-delete')?.addEventListener('click', async () => {
        if (!await daConfirm('Удалить этот канал?', { title: 'Удаление канала', danger: true })) return;
        try { await API.del(`/api/channels/${channelId}`); overlay.remove(); }
        catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
      });
    } else if (tab === 'permissions') {
      body.innerHTML = `
        <div class="form-group">
          <p style="color:var(--text-2)">Переопределения прав для этого канала. Добавьте роль или участника для настройки.</p>
        </div>
        <div id="cs-perm-list"></div>
        ${canManage ? '<button class="btn btn-outline mt-8" id="cs-add-perm">+ Добавить переопределение</button>' : ''}
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

async function loadChannelPermissions(body, channelId, guildId) {
  const permList = body.querySelector('#cs-perm-list');
  if (!permList) return;
  try {
    const ch = await API.get(`/api/channels/${channelId}`);
    const overwrites = ch.permission_overwrites || [];
    if (!overwrites.length) {
      permList.innerHTML = '<div style="color:var(--text-3);padding:8px">Нет переопределений</div>';
      return;
    }
    permList.innerHTML = overwrites.map(ow => `
      <div style="padding:8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span>${ow.target_type === 0 ? '🛡️ Роль' : '👤 Участник'}: ${escHtml(ow.target_id)}</span>
        <span style="color:var(--text-3);font-size:12px">allow: ${ow.allow || 0} | deny: ${ow.deny || 0}</span>
      </div>
    `).join('');
  } catch { permList.innerHTML = '<div style="color:var(--text-3)">Не удалось загрузить</div>'; }
}
