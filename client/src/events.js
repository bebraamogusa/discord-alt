import { S } from './state.js';
import { API, escHtml, fmtDatetime, t, showToast, getServer, daConfirm } from './utils.js';
import { userHasPermissionClient } from './ui.js';

// Currently open events modal view: { serverId, el }
let _activeView = null;

const IC_CLOCK = '🕐';

function startToLocalInputValue(epochSec) {
  const d = new Date(epochSec * 1000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function eventPlace(ev) {
  if (!ev.channel_id) {
    try {
      const meta = JSON.parse(ev.entity_metadata || '{}');
      if (meta.location) return meta.location;
    } catch { }
    return null;
  }
  const ch = getServer(ev.guild_id)?.channels?.find(c => c.id === ev.channel_id);
  return ch ? `#${ch.name}` : null;
}

function eventCardHtml(ev) {
  const canManage = userHasPermissionClient(ev.guild_id, 'manage_events');
  const place = eventPlace(ev);
  return `
    <div class="event-card ${ev.me ? 'event-mine' : ''}" data-event-id="${escHtml(String(ev.id))}">
      <div class="event-card-main">
        <div class="ev-name">${escHtml(ev.name)}</div>
        <div class="ev-time">${IC_CLOCK} ${fmtDatetime(Number(ev.scheduled_start_time) * 1000)}</div>
        ${place ? `<div class="ev-place"># ${escHtml(place)}</div>` : ''}
        ${ev.description ? `<div class="ev-desc">${escHtml(ev.description)}</div>` : ''}
      </div>
      <div class="event-card-actions">
        <button class="btn btn-sm ev-rsvp ${ev.me ? 'btn-accent' : 'btn-outline'}">
          <span class="ev-count">${ev.user_count || 0}</span> ${ev.me ? t('event_rsvp_cancel') : t('event_rsvp')}
        </button>
        ${canManage ? `<button class="table-btn del ev-del" title="${t('delete')}">&#128465;</button>` : ''}
      </div>
    </div>`;
}

function renderEvents() {
  if (!_activeView) return;
  const { serverId, el } = _activeView;
  const events = S.guildEvents[serverId] || [];
  el.innerHTML = events.length
    ? events.map(eventCardHtml).join('')
    : `<div class="empty-state"><div class="empty-text">${t('events_empty')}</div></div>`;
  bindCards(el, serverId);
}

function bindCards(el, serverId) {
  el.querySelectorAll('.ev-rsvp').forEach(btn => {
    btn.onclick = () => toggleRsvp(serverId, btn.closest('.event-card')?.dataset.eventId);
  });
  el.querySelectorAll('.ev-del').forEach(btn => {
    btn.onclick = async () => {
      const eventId = btn.closest('.event-card')?.dataset.eventId;
      if (!await daConfirm(t('confirm_delete_event'), { title: t('confirm_delete_event'), danger: true })) return;
      try {
        await API.del(`/api/guilds/${serverId}/scheduled-events/${eventId}`);
        showToast(t('event_deleted'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
  });
}

async function toggleRsvp(serverId, eventId) {
  const ev = (S.guildEvents[serverId] || []).find(x => String(x.id) === String(eventId));
  if (!ev) return;
  try {
    const res = ev.me
      ? await API.del(`/api/guilds/${serverId}/scheduled-events/${eventId}/users/@me`)
      : await API.put(`/api/guilds/${serverId}/scheduled-events/${eventId}/users/@me`, {});
    ev.me = !ev.me;
    ev.user_count = res?.user_count ?? Math.max(0, (ev.user_count || 0) + (ev.me ? 1 : -1));
    rerenderCard(serverId, ev);
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

function rerenderCard(serverId, ev) {
  if (_activeView?.serverId !== serverId) return;
  const card = _activeView.el.querySelector(`.event-card[data-event-id="${CSS.escape(String(ev.id))}"]`);
  if (card) card.outerHTML = eventCardHtml(ev);
  else renderEvents();
}

export async function openGuildEventsModal(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const canManage = userHasPermissionClient(serverId, 'manage_events');

  const overlay = document.createElement('div');
  overlay.className = 'da-dialog-overlay';
  overlay.innerHTML = `
    <div class="da-dialog-box da-dialog-wide" role="dialog" aria-modal="true" id="events-modal">
      <div class="da-dialog-head"><h3>${IC_CLOCK} ${t('events_title')} — ${escHtml(srv.name)}</h3></div>
      <div class="da-dialog-body" id="ev-body"><div class="empty-state"><div class="spinner"></div></div></div>
      <div class="da-dialog-foot">
        <button class="btn btn-outline" id="ev-close">${t('close')}</button>
        ${canManage ? `<button class="btn btn-accent" id="ev-create">${t('event_create')}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#ev-close').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  new MutationObserver((_, obs) => {
    if (!overlay.isConnected) { _activeView = null; obs.disconnect(); }
  }).observe(document.body, { childList: true });

  const listEl = overlay.querySelector('#ev-body');
  _activeView = { serverId, el: listEl };

  overlay.querySelector('#ev-create')?.addEventListener('click', () => openCreateDialog(serverId));

  try {
    S.guildEvents[serverId] = await API.get(`/api/guilds/${serverId}/scheduled-events`);
  } catch (e) {
    listEl.innerHTML = `
      <div class="perm-denied-notice">${escHtml(e.body?.error || t('error_generic'))}</div>
      <button class="btn btn-outline mt-8" id="ev-retry">${t('retry')}</button>
    `;
    listEl.querySelector('#ev-retry').onclick = () => openGuildEventsModal(serverId);
    return;
  }
  renderEvents();
}

function openCreateDialog(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const channels = (srv.channels || []).filter(c => c.type === 2 || c.type === 13 || c.type === 'voice' || c.type === 'stage');
  const dialogOverlay = document.createElement('div');
  dialogOverlay.className = 'da-dialog-overlay';
  dialogOverlay.innerHTML = `
    <div class="da-dialog-box" role="dialog" aria-modal="true">
      <div class="da-dialog-head"><h3>${t('event_create')}</h3></div>
      <div class="da-dialog-body">
        <div class="form-group">
          <label>${t('event_name')}</label>
          <input id="evd-name" maxlength="100">
        </div>
        <div class="form-group">
          <label>${t('event_description')}</label>
          <textarea id="evd-desc" maxlength="1000"></textarea>
        </div>
        <div class="form-group">
          <label>${t('event_start')}</label>
          <input type="datetime-local" id="evd-start">
        </div>
        <div class="form-group">
          <label>${t('event_channel')}</label>
          <select id="evd-channel">
            <option value="">${t('event_external')}</option>
            ${channels.map(c => `<option value="${escHtml(c.id)}">🔊 ${escHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group hidden" id="evd-location-group">
          <label>${t('event_location')}</label>
          <input id="evd-location" maxlength="100">
        </div>
        <div class="form-hint text-danger hidden" id="evd-error"></div>
      </div>
      <div class="da-dialog-foot">
        <button class="btn btn-outline" id="evd-cancel">${t('cancel')}</button>
        <button class="btn btn-accent" id="evd-save">${t('create')}</button>
      </div>
    </div>`;
  document.body.appendChild(dialogOverlay);
  const closeDialog = () => dialogOverlay.remove();
  const channelSelect = dialogOverlay.querySelector('#evd-channel');
  channelSelect.onchange = () => dialogOverlay.querySelector('#evd-location-group').classList.toggle('hidden', !!channelSelect.value);
  dialogOverlay.querySelector('#evd-cancel').onclick = closeDialog;
  dialogOverlay.onclick = e => { if (e.target === dialogOverlay) closeDialog(); };
  dialogOverlay.querySelector('#evd-start').value = startToLocalInputValue(Math.floor(Date.now() / 1000) + 3600);
  dialogOverlay.querySelector('#evd-save').onclick = async () => {
    const errEl = dialogOverlay.querySelector('#evd-error');
    const name = dialogOverlay.querySelector('#evd-name').value.trim();
    const description = dialogOverlay.querySelector('#evd-desc').value.trim();
    const startRaw = dialogOverlay.querySelector('#evd-start').value;
    const channelId = channelSelect.value || null;
    const location = dialogOverlay.querySelector('#evd-location').value.trim();
    const showErr = msg => { errEl.textContent = msg; errEl.classList.remove('hidden'); };
    if (!name) return showErr(t('enter_name'));
    const startTime = startRaw ? new Date(startRaw).getTime() : NaN;
    if (!startRaw || Number.isNaN(startTime)) return showErr(t('event_start_required'));
    if (startTime <= Date.now()) return showErr(t('event_start_future'));
    if (!channelId && !location) return showErr(t('event_location_required'));
    try {
      await API.post(`/api/guilds/${serverId}/scheduled-events`, {
        name,
        description: description || null,
        channel_id: channelId,
        entity_type: channelId ? 2 : 3,
        entity_metadata: channelId ? null : JSON.stringify({ location }),
        scheduled_start_time: Math.floor(startTime / 1000),
      });
      closeDialog();
      showToast(t('event_created'), 'success');
    } catch (e) { showErr(e.body?.error || t('error_generic')); }
  };
  dialogOverlay.querySelector('#evd-name').focus();
}

let _socketBound = false;

export function handleEventSocketEvents() {
  const socket = window.socket;
  if (!socket || _socketBound) return;
  _socketBound = true;

  socket.on('scheduled_event:create', ev => {
    if (!ev?.guild_id || !S.guildEvents[ev.guild_id]) return;
    if (!S.guildEvents[ev.guild_id].some(x => x.id === ev.id)) {
      S.guildEvents[ev.guild_id].push(ev);
      if (_activeView?.serverId === ev.guild_id) renderEvents();
    }
  });

  socket.on('scheduled_event:update', ev => {
    if (!ev?.guild_id || !S.guildEvents[ev.guild_id]) return;
    const events = S.guildEvents[ev.guild_id];
    const idx = events.findIndex(x => String(x.id) === String(ev.id));
    if (idx === -1) return;
    const mine = events[idx].me;
    events[idx] = { ...ev, me: mine };
    rerenderCard(ev.guild_id, events[idx]);
  });

  socket.on('scheduled_event:delete', ({ id, guild_id }) => {
    if (!id || !guild_id || !S.guildEvents[guild_id]) return;
    S.guildEvents[guild_id] = S.guildEvents[guild_id].filter(x => String(x.id) !== String(id));
    if (_activeView?.serverId === guild_id) renderEvents();
  });
}
