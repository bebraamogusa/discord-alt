import * as API from '/api.js';
import { t, getLang, setLang, LANG_NAMES } from '/i18n.js';
import { IC } from './icons.js';
import { S } from './state.js';

export { API, t, getLang, setLang, LANG_NAMES };

export const $ = id => document.getElementById(id);
export const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

export function normalizeMe(user) {
  if (!user) return null;
  if (user.avatar_url !== undefined || user.about_me !== undefined) return user;
  return {
    ...user,
    avatar_url: user.avatar || '',
    banner_url: user.banner || '',
    avatar_color: user.accent_color || '#5865f2',
    banner_color: user.accent_color || '#5865f2',
    about_me: user.bio || '',
    custom_status: user.custom_status_text || '',
  };
}

// REST guild payloads use icon/banner; legacy socket payloads use icon_url/banner_url
export function normalizeServer(srv) {
  if (!srv) return srv;
  const icon = srv.icon_url || srv.icon || '';
  const banner = srv.banner_url || srv.banner || '';
  return { ...srv, icon, banner, icon_url: icon, banner_url: banner };
}

export function intToHexColor(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffff) return '';
  return '#' + n.toString(16).padStart(6, '0');
}

export function hexToIntColor(hex) {
  const parsed = Number.parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffff ? parsed : 0;
}

export function channelTypeToCore(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'voice') return 2;
  if (value === 'announcement') return 5;
  if (value === 'forum') return 15;
  if (value === 'stage') return 13;
  if (value === 'thread') return 11;
  if (value === 'category') return 4;
  return 0;
}

export function showToast(msg, type = '') {
  const tEl = $('toast');
  const iconMap = { success: IC.check, error: IC.close, info: IC.info };
  const icon = iconMap[type] || IC.msg;
  tEl.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(msg)}</span>`;
  tEl.className = `toast ${type}`;
  void tEl.offsetWidth;
  tEl.classList.add('visible');
  clearTimeout(tEl._to);
  tEl._to = setTimeout(() => tEl.classList.remove('visible'), 3000);
}

// ─── DIALOG STACK (focus trap, inert background, Escape, focus restore) ──────
const _dialogStack = [];
let _dialogKeysInstalled = false;

function dialogFocusables(overlay) {
  return [...overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function refreshDialogInert() {
  for (const el of document.querySelectorAll('body > [data-da-inert]')) {
    el.inert = false;
    el.removeAttribute('data-da-inert');
  }
  const top = _dialogStack[_dialogStack.length - 1];
  if (!top || !top.inert) return;
  for (const child of document.body.children) {
    if (child === top.overlay || (child.contains && child.contains(top.overlay))) continue;
    if (child.matches('script, style, link')) continue;
    if (child.inert) continue;
    child.inert = true;
    child.setAttribute('data-da-inert', '');
  }
}

function installDialogKeyHandler() {
  if (_dialogKeysInstalled) return;
  _dialogKeysInstalled = true;
  window.addEventListener('keydown', e => {
    const top = _dialogStack[_dialogStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      top.close();
    } else if (e.key === 'Tab' && top.trapTab) {
      const items = dialogFocusables(top.overlay);
      if (!items.length) {
        e.preventDefault();
        top.overlay.focus();
        return;
      }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !top.overlay.contains(active)) { e.preventDefault(); last.focus(); }
      } else if (active === last || !top.overlay.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }, true);
}

export function mountDialog(overlay, { inert = true, trapTab = true, initialFocus, onClose, dismiss = 'hide' } = {}) {
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const record = { overlay, inert, trapTab, onClose };
  overlay.tabIndex = -1;
  _dialogStack.push(record);
  installDialogKeyHandler();
  refreshDialogInert();
  const target = initialFocus instanceof HTMLElement && overlay.contains(initialFocus)
    ? initialFocus
    : dialogFocusables(overlay)[0];
  (target || overlay).focus();
  let closed = false;
  record.close = () => {
    if (closed) return;
    closed = true;
    const idx = _dialogStack.indexOf(record);
    if (idx !== -1) _dialogStack.splice(idx, 1);
    refreshDialogInert();
    if (prevFocus?.isConnected) prevFocus.focus();
    onClose?.();
    if (!overlay.isConnected || overlay.classList.contains('hidden')) return;
    if (dismiss === 'remove') overlay.remove();
    else overlay.classList.add('hidden');
  };
  return record;
}

export function closeTopDialog() {
  const top = _dialogStack[_dialogStack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function daConfirm(message, { title, danger = false, confirmText, cancelText } = {}) {
  const _title = title || t('confirm_action');
  const _cancel = cancelText || t('cancel');
  const okText = confirmText || (danger ? t('delete_btn') : t('confirm'));
  const okClass = danger ? 'btn btn-danger-solid' : 'btn btn-accent';
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

    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve(value); } };
    const record = mountDialog(overlay, { initialFocus: overlay.querySelector('#dac-ok'), onClose: () => settle(false) });
    const finish = value => { settle(value); record.close(); };
    overlay.querySelector('#dac-cancel').onclick = () => finish(false);
    overlay.querySelector('#dac-ok').onclick = () => finish(true);
    overlay.onclick = e => { if (e.target === overlay) finish(false); };
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });
  });
}

export function daPrompt(message, { title, placeholder = '', confirmText, cancelText } = {}) {
  const _title = title || t('confirm_action');
  const _ok = confirmText || t('ok');
  const _cancel = cancelText || t('cancel');
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

    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve(value); } };
    const record = mountDialog(overlay, { initialFocus: input, onClose: () => settle(null) });
    const finish = value => { settle(value); record.close(); };
    overlay.querySelector('#dap-cancel').onclick = () => finish(null);
    overlay.querySelector('#dap-ok').onclick = () => finish(input.value);
    overlay.onclick = e => { if (e.target === overlay) finish(null); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
  });
}

export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtTime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
}
export function fmtDatetime(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleString(getLang());
}

export function parseMarkdown(text) {
  let s = escHtml(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|\n)&gt; (.+)/g, '$1<blockquote class="msg-quote">$2</blockquote>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

export function avatarEl(user, size = 32) {
  const u = user || {};
  if (u.avatar_url) {
    return `<img src="${escHtml(u.avatar_url)}" style="width:${size}px;height:${size}px" class="av-img">`;
  }
  const letter = (u.username || '?')[0].toUpperCase();
  const color = u.avatar_color || '#5865f2';
  return `<div class="av-fallback" style="width:${size}px;height:${size}px;background:${escHtml(color)};font-size:${Math.round(size * 0.4)}px">${escHtml(letter)}</div>`;
}

export function getServerMember(serverId, userId) {
  if (!serverId || serverId === '@me' || !userId) return null;
  return S.members[serverId]?.find(m => m.id === userId) || null;
}

export function displayNameFor(userId, fallback = '', serverId = S.activeServerId) {
  const member = getServerMember(serverId, userId);
  if (member?.nickname?.trim()) return member.nickname.trim();
  if (member?.username?.trim()) return member.username.trim();
  return fallback || userId || '?';
}

export function statusDotHtml(userId, parentBg = 'var(--bg-2)') {
  const p = S.presences[userId];
  const st = p?.status || 'offline';
  return `<div class="status-dot ${st}" style="border-color:${parentBg}"></div>`;
}

export function getServer(id) { return S.servers.find(s => s.id === id); }
export function getChannel(id) {
  for (const srv of S.servers) {
    const ch = (srv.channels || []).find(c => c.id === id);
    if (ch) return ch;
  }
  return S.dmChannels.find(c => c.id === id);
}

const CLIENT_PERM_BITS = {
  administrator: 1n << 3n,
  kick_members: 1n << 1n,
  ban_members: 1n << 2n,
  manage_channels: 1n << 4n,
  manage_guild: 1n << 5n,
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  read_message_history: 1n << 12n,
  manage_messages: 1n << 13n,
  connect: 1n << 20n,
  mute_members: 1n << 22n,
  deafen_members: 1n << 23n,
  move_members: 1n << 24n,
  change_nickname: 1n << 26n,
  manage_nicknames: 1n << 27n,
  manage_roles: 1n << 28n,
  manage_webhooks: 1n << 29n,
  manage_expressions: 1n << 30n,
  manage_events: 1n << 33n,
  moderate_members: 1n << 40n,
};
const CLIENT_ALIAS_BITS = { manage_server: CLIENT_PERM_BITS.manage_guild, view_audit_log: CLIENT_PERM_BITS.manage_guild };

function rolePermissionBits(role) {
  const raw = String(role?.permissions ?? '').trim();
  if (raw.startsWith('{')) {
    let bits = 0n;
    try {
      const obj = JSON.parse(raw);
      for (const [name, enabled] of Object.entries(obj || {})) {
        if (enabled === true) bits |= (CLIENT_PERM_BITS[name] || CLIENT_ALIAS_BITS[name] || 0n);
      }
    } catch { }
    return bits;
  }
  try { return BigInt(raw || '0'); } catch { return 0n; }
}

export function memberPermissionBits(member) {
  let bits = 0n;
  for (const r of member?.roles || []) bits |= rolePermissionBits(r);
  for (const r of member?.role_objects || []) bits |= rolePermissionBits(r);
  return bits;
}

export function userHasPermissionClient(serverId, perm) {
  const srv = getServer(serverId);
  if (!srv || !S.me) return false;
  if (srv.owner_id === S.me.id) return true;
  const member = (S.members[serverId] || []).find(m => m.user_id === S.me.id || m.id === S.me.id);
  if (!member) return false;
  const bits = memberPermissionBits(member);
  const bit = CLIENT_PERM_BITS[perm] || CLIENT_ALIAS_BITS[perm];
  if (!bit) return false;
  return (bits & bit) === bit;
}

export function renderPollHtml(msg) {
  const poll = msg.poll;
  if (!poll) return '';
  const expired = poll.expiry && poll.expiry < Math.floor(Date.now() / 1000);
  const totalVotes = poll.answers.reduce((sum, answer) => sum + (answer.count || 0), 0);
  const answers = poll.answers.map(answer => {
    const percent = totalVotes ? Math.round(((answer.count || 0) / totalVotes) * 100) : 0;
    return `<div class="poll-answer ${answer.me ? 'poll-voted' : ''} ${expired ? 'poll-expired' : ''}" data-msg-id="${escHtml(msg.id)}" data-answer-id="${answer.id}" data-ch-id="${escHtml(msg.channel_id)}"><div class="poll-answer-bar" style="width:${percent}%"></div><span class="poll-answer-text">${answer.emoji ? escHtml(answer.emoji) + ' ' : ''}${escHtml(answer.text || '')}</span><span class="poll-answer-count">${answer.count || 0} (${percent}%)</span></div>`;
  }).join('');
  const expiry = expired ? '✅ Голосование завершено' : (poll.expiry ? `⏱ Завершится ${fmtTime(poll.expiry * 1000)}` : '');
  return `<div class="poll-container" data-msg-id="${escHtml(msg.id)}"><div class="poll-question">📊 ${escHtml(poll.question)}</div><div class="poll-answers">${answers}</div><div class="poll-footer"><span class="poll-total">${totalVotes} голос${totalVotes === 1 ? '' : totalVotes > 1 && totalVotes < 5 ? 'а' : 'ов'}</span><span class="poll-expiry">${expiry}</span></div></div>`;
}
