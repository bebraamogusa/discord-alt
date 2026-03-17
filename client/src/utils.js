import { t, getLang } from '/i18n.js';
import { IC } from './icons.js';
import { S } from './state.js';

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

export function channelTypeToCore(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'voice') return 2;
  if (value === 'announcement') return 5;
  if (value === 'forum') return 15;
  if (value === 'stage') return 13;
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
    const cleanup = res => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(res); };
    overlay.querySelector('#dac-cancel').onclick = () => cleanup(false);
    overlay.querySelector('#dac-ok').onclick = () => cleanup(true);
    overlay.onclick = e => { if (e.target === overlay) cleanup(false); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };
    window.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('#dac-ok').focus(), 40);
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
    const cleanup = res => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(res); };
    overlay.querySelector('#dap-cancel').onclick = () => cleanup(null);
    overlay.querySelector('#dap-ok').onclick = () => cleanup(input.value);
    overlay.onclick = e => { if (e.target === overlay) cleanup(null); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
    };
    window.addEventListener('keydown', onKey);
    setTimeout(() => input.focus(), 40);
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
