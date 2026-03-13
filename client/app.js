/**
 * app.js — discord-alt v2 client
 * Vanilla JS, no frameworks.
 */
import * as API from '/api.js';
import { t, setLang, getLang, LANG_NAMES } from '/i18n.js';
import * as VoiceClient from '/voice.js';

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
  friends: [],              // friend list
  _friendRequestCount: 0,   // pending incoming friend requests
};

// Voice connection state
const V = {
  channelId: null,          // currently connected channel id
  muted: false,
  deafened: false,
  stream: null,             // local MediaStream
  screenStream: null,       // local screen share stream
  screenTrack: null,        // local screen video track
  isScreenSharing: false,
  peers: new Map(),         // userId → RTCPeerConnection
  audios: new Map(),        // userId → HTMLAudioElement
  remoteStreams: new Map(), // userId → remote MediaStream
  screenSenders: new Map(), // userId → RTCRtpSender (screen video)
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
const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

function normalizeMe(user) {
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

function channelTypeToCore(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'voice') return 2;
  if (value === 'announcement') return 5;
  if (value === 'forum') return 15;
  if (value === 'stage') return 13;
  if (value === 'category') return 4;
  return 0;
}

// ─── SVG ICON SYSTEM ─────────────────────────────────────────────────────────
const _ic = (d, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;
const _f = (d, s) => _ic(`<path d="${d}" fill="currentColor"/>`, s);
const _s = (d, s) => _ic(`<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`, s);
const IC = {
  // general
  settings: _f('M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z'),
  bell: _s('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0'),
  invite: _f('M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 2v-2h-2v2h-2v2h2v2h2v-2h2v-2h-2zM2 18v2h16v-2c0-2.66-5.33-4-8-4s-8 1.34-8 4z'),
  pin: _f('M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z'),
  hash: _s('M4 9h16M4 15h16M10 3 8 21M16 3l-2 18'),
  folder: _f('M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'),
  id: _f('M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 7H7V9h4v2zm6 4H7v-2h10v2zm0-8H7V5h10v2z'),
  leave: _s('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'),
  trash: _s('M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
  edit: _s('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'),
  search: _s('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35'),
  copy: _s('M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  plus: _s('M12 5v14M5 12h14'),
  close: _s('M18 6 6 18M6 6l12 12'),
  check: _s('M20 6 9 17l-5-5'),
  info: _ic(`<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
  msg: _f('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z'),
  reply: _s('M9 17H5l4-4M5 13a8 8 0 0 1 14.83-4.17'),
  attach: _s('M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'),
  upload: _s('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'),
  image: _ic(`<rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="m21 15-5-5L5 21" stroke="currentColor" stroke-width="2" fill="none"/>`),

  // status
  statusOnline: _ic(`<circle cx="12" cy="12" r="8" fill="#43b581"/>`, 14),
  statusIdle: _ic(`<circle cx="12" cy="12" r="8" fill="#faa61a"/><circle cx="6" cy="6" r="5" fill="var(--bg-3,#2f3136)"/>`, 14),
  statusDnd: _ic(`<circle cx="12" cy="12" r="8" fill="#f04747"/><rect x="7" y="10" width="10" height="4" rx="2" fill="var(--bg-3,#2f3136)"/>`, 14),
  statusInvisible: _ic(`<circle cx="12" cy="12" r="8" fill="#747f8d"/><circle cx="12" cy="12" r="4" fill="var(--bg-3,#2f3136)"/>`, 14),

  // voice
  voice: _f('M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15a.998.998 0 0 0-.98-.85c-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08a6.993 6.993 0 0 0 5.91-5.78c.1-.6-.39-1.14-1-1.14z'),
  voiceMuted: _ic(`<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" fill="currentColor"/><path d="M17.91 11c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15a.998.998 0 0 0-.98-.85c-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08a6.993 6.993 0 0 0 5.91-5.78c.1-.6-.39-1.14-1-1.14z" fill="currentColor"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--danger,#f04747)" stroke-width="2.5" stroke-linecap="round"/>`),
  speaker: _f('M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-3.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'),
  speakerMuted: _ic(`<path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><line x1="17" y1="7" x2="23" y2="17" stroke="var(--danger,#f04747)" stroke-width="2.5" stroke-linecap="round"/><line x1="23" y1="7" x2="17" y2="17" stroke="var(--danger,#f04747)" stroke-width="2.5" stroke-linecap="round"/>`),
  headphones: _f('M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h2V12H5v-2a7 7 0 1 1 14 0v2h-3v8h2c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z'),

  // server settings
  overview: _f('M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM6 20V4h5v7h7v9H6z'),
  shield: _f('M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z'),
  members: _f('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
  hammer: _ic(`<path d="M2 19l3.465-3.465M10.587 8.586L6.343 4.343a2 2 0 0 0-2.828 0L2.1 5.757a2 2 0 0 0 0 2.829l4.243 4.243" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="m10.586 8.586 2.829-2.829a2 2 0 0 1 2.828 0l1.414 1.414a2 2 0 0 1 0 2.829l-2.828 2.828" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M13.414 11.414L22 20M19 22l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>`),
  link: _s('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  scroll: _f('M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'),

  // user settings
  user: _f('M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'),
  palette: _f('M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z'),
  globe: _s('M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z'),
  crown: _f('M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm0 3c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-1H5v1z'),

  // channel types
  announcement: _f('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 9h-2V5h2v6zm0 4h-2v-2h2v2z'),

  // misc
  wave: _ic(`<path d="M7.69 15.58c-.37-.55-.83-1.2-1.37-1.87C5.41 12.5 5 11.5 5 10.5 5 7.46 7.46 5 10.5 5c.96 0 1.86.25 2.64.69" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M14.5 5.5c1.5-1.5 4-1.5 5.5 0s1.5 4 0 5.5l-7.5 7.5c-1.5 1.5-4 1.5-5.5 0s-1.5-4 0-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>`),
  mail: _s('M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6'),
  clock: _ic(`<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>`),
  lock: _s('M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4'),
  screen: _s('M3 4h18v12H3zM8 20h8M12 16v4'),
  screenOff: _ic(`<path d="M3 4h18v12H3zM8 20h8M12 16v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--danger,#f04747)" stroke-width="2.5" stroke-linecap="round"/>`),
  smile: _ic(`<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 14s1.5 2 4 2 4-2 4-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><line x1="9" y1="9" x2="9.01" y2="9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="15" y1="9" x2="15.01" y2="9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`),
  arrowUp: _s('M12 19V5M5 12l7-7 7 7'),
  friends: _f('M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'),
  logo: _f('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-3 12H7v-2h10v2zm0-3H7V9h10v2zm0-3H7V6h10v2z'),
};

function showToast(msg, type = '') {
  const t = $('toast');
  const iconMap = { success: IC.check, error: IC.close, info: IC.info };
  const icon = iconMap[type] || IC.msg;
  t.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(msg)}</span>`;
  t.className = `toast ${type}`;
  void t.offsetWidth;
  t.classList.add('visible');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('visible'), 3000);
}

// ─── CUSTOM DIALOGS ───────────────────────────────────────────────────────────
function daConfirm(message, { title, danger = false, confirmText, cancelText } = {}) {
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

function daPrompt(message, { title, placeholder = '', confirmText, cancelText } = {}) {
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

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  // spoiler
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // underline
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  // strikethrough
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // block quotes
  s = s.replace(/(^|\n)&gt; (.+)/g, '$1<blockquote class="msg-quote">$2</blockquote>');
  // links (filter out javascript: protocol for XSS protection)
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // newlines
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ─── LINK EMBED SYSTEM ───────────────────────────────────────────────────────
const _embedCache = new Map();

async function fetchLinkEmbeds(msgEl) {
  const contentEl = msgEl.querySelector('.msg-content');
  if (!contentEl) return;
  const links = contentEl.querySelectorAll('a[href^="http"]');
  if (!links.length) return;

  // Only process first 3 links per message
  const urls = [...links].slice(0, 3).map(a => a.href);
  for (const url of urls) {
    // Skip image/video/audio direct links (already handled by attachments)
    if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|ogg|wav)$/i.test(url)) continue;
    // Skip if already embedded
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
    } catch { /* ignore embed fetch errors */ }
  }
}

function avatarEl(user, size = 32) {
  const u = user || {};
  if (u.avatar_url) {
    return `<img src="${escHtml(u.avatar_url)}" style="width:${size}px;height:${size}px" class="av-img">`;
  }
  const letter = (u.username || '?')[0].toUpperCase();
  const color = u.avatar_color || '#5865f2';
  return `<div class="av-fallback" style="width:${size}px;height:${size}px;background:${escHtml(color)};font-size:${Math.round(size * 0.4)}px">${escHtml(letter)}</div>`;
}

function getServerMember(serverId, userId) {
  if (!serverId || serverId === '@me' || !userId) return null;
  return S.members[serverId]?.find(m => m.id === userId) || null;
}

function displayNameFor(userId, fallback = '', serverId = S.activeServerId) {
  const member = getServerMember(serverId, userId);
  if (member?.nickname?.trim()) return member.nickname.trim();
  if (member?.username?.trim()) return member.username.trim();
  return fallback || userId || '?';
}

function applySelfProfileToCaches(updated) {
  if (!updated?.id) return;
  for (const serverId of Object.keys(S.members)) {
    const member = S.members[serverId]?.find(m => m.id === updated.id);
    if (member) {
      member.avatar_url = updated.avatar_url;
      member.avatar_color = updated.avatar_color;
      member.banner_url = updated.banner_url;
      member.banner_color = updated.banner_color;
      member.about_me = updated.about_me;
    }
  }
  for (const channelId of Object.keys(S.voiceStates)) {
    const participant = S.voiceStates[channelId]?.find(p => p.user_id === updated.id);
    if (participant) {
      participant.avatar_url = updated.avatar_url;
      participant.avatar_color = updated.avatar_color;
    }
  }
}

function statusDotHtml(userId, parentBg = 'var(--bg-2)') {
  const p = S.presences[userId];
  const st = p?.status || 'offline';
  return `<div class="status-dot ${st}" style="border-color:${parentBg}"></div>`;
}

// ─── STATUS PICKER ────────────────────────────────────────────────────────────
function showStatusPicker() {
  let picker = document.querySelector('.status-picker');
  if (picker) { picker.remove(); return; }

  const myStatus = S.presences[S.me?.id]?.status || 'online';
  const statuses = [
    { key: 'online', icon: IC.statusOnline, labelKey: 'status_online' },
    { key: 'idle', icon: IC.statusIdle, labelKey: 'status_idle' },
    { key: 'dnd', icon: IC.statusDnd, labelKey: 'status_dnd' },
    { key: 'invisible', icon: IC.statusInvisible, labelKey: 'status_invisible' },
  ];

  picker = document.createElement('div');
  picker.className = 'status-picker';
  picker.innerHTML = `
    <div class="sp-header">${t('set_status')}</div>
    <div class="sp-custom">
      <input class="sp-custom-input" placeholder="${t('set_custom_status')}" value="${escHtml(S.me?.custom_status || '')}" maxlength="128">
      ${S.me?.custom_status ? `<button class="sp-clear">${t('clear_status')}</button>` : ''}
    </div>
    <div class="sp-divider"></div>
    ${statuses.map(s => `
      <div class="sp-item ${myStatus === s.key ? 'active' : ''}" data-status="${s.key}">
        <span class="sp-icon">${s.icon}</span>
        <span class="sp-label">${t(s.labelKey)}</span>
        ${myStatus === s.key ? '<span class="sp-check">✓</span>' : ''}
      </div>
    `).join('')}
  `;

  const wrapper = $('su-av-wrapper');
  const rect = wrapper.getBoundingClientRect();
  document.body.appendChild(picker);

  const margin = 8;
  const left = clamp(rect.left, margin, window.innerWidth - picker.offsetWidth - margin);
  const top = clamp(rect.top - picker.offsetHeight - 8, margin, window.innerHeight - picker.offsetHeight - margin);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  // Status item clicks
  picker.querySelectorAll('.sp-item').forEach(el => {
    el.onclick = () => {
      const newStatus = el.dataset.status;
      localStorage.setItem('da_status', newStatus);
      const cs = picker.querySelector('.sp-custom-input')?.value.trim() || '';
      socket?.emit('UPDATE_STATUS', { status: newStatus, custom_status: cs });
      S.presences[S.me.id] = { status: newStatus === 'invisible' ? 'offline' : newStatus, custom_status: cs };
      S.me.custom_status = cs;
      updateSidebarUser();
      if (S.activeServerId && S.activeServerId !== '@me') renderMembersPanel();
      picker.remove();
    };
  });

  // Custom status input
  const csInput = picker.querySelector('.sp-custom-input');
  csInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const cs = csInput.value.trim();
      const st = localStorage.getItem('da_status') || 'online';
      socket?.emit('UPDATE_STATUS', { status: st, custom_status: cs });
      S.me.custom_status = cs;
      S.presences[S.me.id] = { ...S.presences[S.me.id], custom_status: cs };
      updateSidebarUser();
      picker.remove();
    }
  });

  // Clear button
  picker.querySelector('.sp-clear')?.addEventListener('click', () => {
    const st = localStorage.getItem('da_status') || 'online';
    socket?.emit('UPDATE_STATUS', { status: st, custom_status: '' });
    S.me.custom_status = '';
    S.presences[S.me.id] = { ...S.presences[S.me.id], custom_status: '' };
    updateSidebarUser();
    picker.remove();
  });

  // Close on outside click
  const close = e => { if (!picker.contains(e.target) && !wrapper.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
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
  ['li-email', 'li-pass', 'reg-email', 'reg-name', 'reg-pass'].forEach(id => {
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
    S.me = normalizeMe(data.user);
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
    S.me = normalizeMe(data.user);
    await bootApp();
  } catch (e) {
    $('auth-reg-err').textContent = e.body?.error || t('register_error');
  }
}

function doLogout() {
  API.post('/api/auth/logout', {}).catch(() => { });
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
    S.me = normalizeMe(user);
    S.servers = servers;
    S.dmChannels = dm_channels;
    S.presences = presences;
    S.voiceStates = voice_states || {};
    renderApp();
    // Restore saved status
    const savedStatus = localStorage.getItem('da_status');
    if (savedStatus && savedStatus !== 'online') {
      socket.emit('UPDATE_STATUS', { status: savedStatus, custom_status: (S.me?.custom_status || '') });
    }
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
      if (msg.author_id !== S.me?.id) {
        const authorName = displayNameFor(msg.author_id, msg.author?.username || t('unknown_user'), S.activeServerId);
        NotifSound.play(authorName, msg.content?.slice(0, 100));
      }
    }
  });

  socket.on('MESSAGE_UPDATE', (msg) => {
    if (S.messages[msg.channel_id]) {
      const idx = S.messages[msg.channel_id].findIndex(m => m.id === msg.id);
      if (idx !== -1) S.messages[msg.channel_id][idx] = msg;
    }
    if (msg.channel_id === S.activeChannelId) {
      // Patch just the changed message element instead of full re-render
      const el = document.querySelector(`[data-msg-id="${msg.id}"] .msg-content`);
      if (el) {
        const editedMark = msg.is_edited ? `<span class="msg-edited">${t('edited_short')}</span>` : '';
        el.innerHTML = parseMarkdown(msg.content || '') + editedMark;
      } else {
        renderMessages();
      }
    }
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

  socket.on('REACTION_ADD', ({ message_id, channel_id, user_id, reactions }) => {
    updateReactions(message_id, channel_id, reactions, user_id);
  });
  socket.on('REACTION_REMOVE', ({ message_id, channel_id, user_id, reactions }) => {
    updateReactions(message_id, channel_id, reactions, user_id);
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
    // Update friends view if open
    if (S.activeChannelId === 'friends') showFriendsView();
  });

  // Friend events
  socket.on('FRIEND_REQUEST', (sender) => {
    S._friendRequestCount++;
    renderChannelList();
    NotifSound.play(sender.username, t('friend_requests'));
    showToast(`${sender.username} ${t('friend_added')}`, 'info');
  });

  socket.on('FRIEND_UPDATE', ({ user_id, status: fStatus }) => {
    if (fStatus === 'accepted') {
      showToast(t('friend_accepted'), 'success');
    } else if (fStatus === 'removed') {
      showToast(t('friend_removed'), 'info');
    }
    // Refresh friends view if open
    if (S.activeChannelId === 'friends') showFriendsView();
    loadFriendCount();
  });

  socket.on('MEMBER_JOIN', ({ server_id, member }) => {
    if (!S.members[server_id]) S.members[server_id] = [];
    if (!S.members[server_id].find(m => m.id === member.id)) {
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

  socket.on('MEMBER_UPDATE', ({ server_id, member }) => {
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
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { }
    }
  });

  // ── Mediasoup producer/consumer events ─────────────────────────────────────
  socket.on('voice:producer_added', async ({ producerId, user_id, kind, appData }) => {
    if (user_id === S.me?.id) return; // Don't consume own tracks
    if (!V.channelId) return;

    try {
      const consumer = await VoiceClient.consumeTrack(producerId, V.channelId);
      if (!consumer) return;

      const stream = new MediaStream([consumer.track]);

      if (kind === 'audio') {
        // Create audio element to play remote audio
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.muted = V.deafened;
        audio.dataset.userId = user_id;
        audio.dataset.producerId = producerId;
        document.body.appendChild(audio);
        V.audios.set(user_id, audio);
      } else if (kind === 'video') {
        // Store remote video stream for screen share rendering
        V.remoteStreams.set(user_id, stream);
        renderVoicePanel();
        setTimeout(bindVoiceScreenVideos, 100);
      }
    } catch (err) {
      console.error('Failed to consume producer:', err);
    }
  });

  socket.on('voice:producer_removed', ({ producerId }) => {
    // Clean up audio elements that match this producer
    V.audios.forEach((audio, userId) => {
      if (audio.dataset?.producerId === producerId) {
        audio.srcObject = null;
        audio.remove();
        V.audios.delete(userId);
      }
    });

    // Clean up video streams — check if the removed producer was a video
    V.remoteStreams.forEach((stream, userId) => {
      const tracks = stream.getTracks();
      if (tracks.length === 0 || tracks.every(t => t.readyState === 'ended')) {
        V.remoteStreams.delete(userId);
        renderVoicePanel();
      }
    });
  });
}

// ─── VOICE ────────────────────────────────────────────────────────────────────
async function joinVoiceChannel(channelId) {
  if (V.channelId === channelId) return;
  if (V.channelId) await leaveVoiceChannel();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    V.stream = stream;
  } catch {
    showToast(t('voice_no_mic'), 'error');
    return;
  }

  const success = await VoiceClient.joinVoiceChannel(channelId);
  if (!success) {
    showToast('Failed to connect to voice server', 'error');
    if (V.stream) { V.stream.getTracks().forEach(t => t.stop()); V.stream = null; }
    return;
  }

  if (V.stream && V.stream.getAudioTracks().length > 0) {
    await VoiceClient.produceAudio(V.stream.getAudioTracks()[0]);
  }

  V.channelId = channelId;
  V.muted = false;
  V.deafened = false;
  V.isScreenSharing = false;

  socket.emit('VOICE_JOIN', { channel_id: channelId });
  renderVoiceBar();
  renderVoicePanel();
  renderChannelList();
  showToast(t('voice_connected'), 'success');
}

async function leaveVoiceChannel() {
  if (!V.channelId) return;
  if (V.isScreenSharing) await stopScreenShare();

  socket.emit('VOICE_LEAVE');

  await VoiceClient.leaveVoiceChannel();

  if (V.stream) { V.stream.getTracks().forEach(t => t.stop()); V.stream = null; }

  V.remoteStreams.clear();
  V.audios.forEach(el => { el.srcObject = null; el.remove(); });
  V.audios.clear();
  V.screenTrack = null;
  V.screenStream = null;
  V.isScreenSharing = false;

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

async function startScreenShare() {
  if (!V.channelId || V.isScreenSharing) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    V.screenStream = stream;
    V.screenTrack = track;
    V.isScreenSharing = true;

    await VoiceClient.produceVideo(track);

    track.onended = () => { stopScreenShare(); };
    socket.emit('VOICE_SCREEN', { sharing: true });
    renderVoiceBar();
    renderVoicePanel();
    showToast(t('voice_screen_started'), 'success');
  } catch {
    showToast(t('voice_screen_failed'), 'error');
  }
}

async function stopScreenShare() {
  if (!V.isScreenSharing) return;

  if (V.screenTrack) V.screenTrack.stop();
  if (V.screenStream) V.screenStream.getTracks().forEach(t => t.stop());

  V.screenTrack = null;
  V.screenStream = null;
  V.isScreenSharing = false;

  socket.emit('VOICE_SCREEN', { sharing: false });
  renderVoiceBar();
  renderVoicePanel();
  showToast(t('voice_screen_stopped'), 'info');
}

function bindVoiceScreenVideos() {
  const panel = $('voice-panel');
  if (!panel) return;
  panel.querySelectorAll('video[data-screen-user]').forEach(video => {
    const uid = video.dataset.screenUser;
    if (uid === S.me?.id) {
      if (V.screenStream && video.srcObject !== V.screenStream) video.srcObject = V.screenStream;
      return;
    }
    const stream = V.remoteStreams.get(uid);
    if (stream && video.srcObject !== stream) video.srcObject = stream;
  });
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
      <button class="vcb-btn ${V.isScreenSharing ? 'active screen' : ''}" id="vcb-screen" title="${V.isScreenSharing ? t('voice_stop_screen') : t('voice_start_screen')}">
        ${V.isScreenSharing ? IC.screenOff : IC.screen}
      </button>
      <button class="vcb-btn danger" id="vcb-leave" title="${t('voice_disconnect')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
      </button>
    </div>
  `;
  $('vcb-mute')?.addEventListener('click', toggleVoiceMute);
  $('vcb-deaf')?.addEventListener('click', toggleVoiceDeafen);
  $('vcb-screen')?.addEventListener('click', () => V.isScreenSharing ? stopScreenShare() : startScreenShare());
  $('vcb-leave')?.addEventListener('click', leaveVoiceChannel);
}

function renderVoicePanel() {
  const ch = getChannel(S.activeChannelId);
  if (!ch || ch.type !== 'voice') return;

  const participants = S.voiceStates[ch.id] || [];
  const screenParticipants = participants.filter(p => p.sharing_screen);
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

  $('main').insertBefore(panel, $('messages-wrapper'));
  $('vp-join')?.addEventListener('click', () => joinVoiceChannel(ch.id));
  $('vp-mute')?.addEventListener('click', toggleVoiceMute);
  $('vp-deaf')?.addEventListener('click', toggleVoiceDeafen);
  $('vp-screen')?.addEventListener('click', () => V.isScreenSharing ? stopScreenShare() : startScreenShare());
  $('vp-leave')?.addEventListener('click', leaveVoiceChannel);
  bindVoiceScreenVideos();
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
  loadFriendCount(); // Load pending friend request count
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
    $('su-av-wrapper').innerHTML = `<div class="av-fallback" id="su-avatar" style="width:32px;height:32px;font-size:13px;background:${S.me.avatar_color || '#5865f2'}">${letter}</div>${statusDotHtml(S.me.id, 'var(--bg-3)')}`;
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
        const raw = await API.get(`/api/guilds/${id}/members`);
        S.members[id] = raw.map(m => ({ ...m, ...m.user, roles: m.role_ids?.map(rid => ({ id: rid })) }));
      } catch { }
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
          showFriendsView();
          return;
        }
        selectChannel(e.dataset.chId);
      });
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
  // Hide friends view if open
  const fv = $('friends-view'); if (fv) fv.classList.add('hidden');

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
    $('chat-ch-icon').innerHTML = IC.speaker;
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
  const hIcon = ch.type === 'dm' ? '@' : ch.type === 'announcement' ? IC.announcement : IC.hash;
  $('chat-ch-icon').innerHTML = hIcon;
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
  const fv = $('friends-view'); if (fv) fv.classList.add('hidden');
  $('welcome-screen').classList.remove('hidden');
  $('welcome-screen').innerHTML = `
    <div class="welcome-icon">${IC.logo}</div>
    <div class="welcome-title">${escHtml(t('welcome_title'))}</div>
    <div class="welcome-sub">${escHtml(t('welcome_sub'))}</div>
    <div class="welcome-shortcuts">
      <div class="welcome-tip"><span class="tip-icon">${IC.search}</span><span class="tip-text"><kbd>Ctrl+K</kbd> — ${escHtml(t('tip_search'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">${IC.msg}</span><span class="tip-text"><kbd>Enter</kbd> — ${escHtml(t('tip_send'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">${IC.attach}</span><span class="tip-text">${escHtml(t('tip_drag'))}</span></div>
      <div class="welcome-tip"><span class="tip-icon">${IC.settings}</span><span class="tip-text">${escHtml(t('tip_settings'))}</span></div>
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
      // Dedup: merge new batch with existing, avoiding duplicates
      const existing = new Set((S.messages[channelId] || []).map(m => m.id));
      const unique = msgs.filter(m => !existing.has(m.id));
      S.messages[channelId] = [...unique, ...(S.messages[channelId] || [])];
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
  // Dedup safety net: remove any duplicate IDs
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
  attachMsgHandlers(container);
  // Fetch link embeds for visible messages
  container.querySelectorAll('.msg-group').forEach(el => fetchLinkEmbeds(el));
}

function appendMessage(msg) {
  const container = $('messages-container');
  // Dedup: if already rendered, skip
  if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  const msgs = S.messages[S.activeChannelId] || [];
  const prev = msgs[msgs.length - 2];
  const ts = typeof msg.created_at === 'number' && msg.created_at < 1e12
    ? msg.created_at * 1000 : msg.created_at;
  const prevTs = prev ? (typeof prev.created_at === 'number' && prev.created_at < 1e12
    ? prev.created_at * 1000 : prev.created_at) : 0;
  const isFirst = !prev || prev.author_id !== msg.author_id || (ts - prevTs) > 5 * 60 * 1000;
  container.insertAdjacentHTML('beforeend', msgHtml(msg, isFirst, true));
  const newEl = container.querySelector(`[data-msg-id="${msg.id}"]`);
  if (newEl) fetchLinkEmbeds(newEl);
  attachMsgHandlers(container);
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
      } else if (action === 'thread') {
        createThread(S.activeChannelId, msgId);
      }
    };
  });

  // Reactions
  container.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => toggleReaction(btn.dataset.msgId, btn.dataset.emoji);
  });

  // Poll handlers
  attachPollHandlers(container);

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

  // Click on reply reference → jump to that message
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

function updateReactions(msgId, channelId, reactions, actorId) {
  // Server sends `me` from the actor's perspective; fix it for the current user
  const msgs = S.messages[channelId];
  const oldMsg = msgs?.find(m => m.id === msgId);
  const oldReactions = oldMsg?.reactions || [];

  // If this event is from someone else, preserve our own `me` state
  if (actorId && actorId !== S.me?.id) {
    const oldMe = {};
    for (const r of oldReactions) oldMe[r.emoji] = !!r.me;
    reactions = reactions.map(r => ({ ...r, me: oldMe[r.emoji] ?? false }));
  }

  // Update data model so re-renders show correct reactions
  if (oldMsg) oldMsg.reactions = reactions;

  if (channelId !== S.activeChannelId) return;
  const group = document.querySelector(`[data-msg-id="${msgId}"].msg-group`);
  if (!group) return;
  let reactDiv = group.querySelector('.msg-reactions');
  if (!reactions.length) { reactDiv?.remove(); return; }
  if (!reactDiv) {
    const body = group.querySelector('.msg-body');
    if (!body) return;
    body.insertAdjacentHTML('beforeend', '<div class="msg-reactions"></div>');
    reactDiv = body.querySelector('.msg-reactions');
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
  // Check if user already reacted with this emoji
  const msgs = S.messages[S.activeChannelId] || [];
  const msg = msgs.find(m => m.id === msgId);
  const existing = msg?.reactions?.find(r => r.emoji === emoji);
  const hasMyReaction = existing?.me;
  try {
    if (hasMyReaction) {
      await API.del(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await API.post(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
    }
  } catch (e) {
    // Ignore — server socket event will correct the UI
  }
}

function scrollToBottom(smooth = false) {
  const el = $('messages-wrapper');
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

// ─── QUICK REACT / EMOJI PICKER ──────────────────────────────────────────────
const EMOJI_LIST = ['😀', '😂', '😍', '😎', '🥺', '😭', '😡', '🤔', '🙏', '👍', '👎', '❤️', '🔥', '✅', '❌', '⭐',
  '🎉', '🚀', '💯', '🤩', '😴', '🥳', '😤', '🤣', '😱', '🥰', '🤯', '😏', '🙈', '🎮', '🎵', '🍕', '☕', '🌟', '💎', '🏆'];

// Extended emoji list with categories for the improved picker
const EMOJI_CATEGORIES = {
  smileys: { icon: '😀', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '😎', '🥳', '🤠', '🫣'] },
  people: { icon: '👋', emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫳', '🫴', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄'] },
  nature: { icon: '🐶', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🐢', '🐍', '🦎', '🦂', '🦀', '🦞', '🦐', '🦑', '🐙', '🌵', '🌲', '🌳', '🍀', '🌺', '🌻', '🌹', '🌸'] },
  food: { icon: '🍕', emojis: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🍞', '🥖', '🫓', '🥨', '🧀', '🥚', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🫔', '🌮', '🌯', '🫔', '🥗', '🍝', '🍜', '🍛', '🍚', '🍱', '🍙', '🍘'] },
  activities: { icon: '⚽', emojis: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🥍', '🏑', '🥊', '🥋', '🏹', '🎣', '🤿', '🏂', '🏄', '🏇', '🚴', '🏋️', '🤸', '🤼', '🤽', '🤾', '⛷️', '⛹️', '🧗', '🧘', '🎮', '🕹️', '🎲', '🧩', '🎯', '🎳', '🎻', '🎸', '🎺', '🥁', '🎹', '🎤', '🎧', '🎫', '🎬', '🎨', '🎪', '🎭', '🎠', '🎡', '🎢'] },
  travel: { icon: '🚗', emojis: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍️', '🚲', '🛴', '🛺', '🚃', '🚂', '✈️', '🚀', '🛸', '🚁', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🗺️', '🗻', '🏔️', '⛰️', '🌋', '🗾', '🏕️', '🏖️', '🏜️', '🏝️', '🏞️', '🏟️', '🏛️', '🏗️', '🏘️', '🏚️', '🏠', '🏡', '🏢', '🏣', '🏤', '🏥', '🏦', '🏨', '🏩', '🏪', '🏫', '🏬'] },
  objects: { icon: '💡', emojis: ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💾', '💿', '📀', '📼', '📷', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🔩', '⚙️'] },
  symbols: { icon: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮'] },
};

const DEFAULT_QUICK_EMOJIS = EMOJI_LIST.slice(0, 8);

function normalizeQuickEmojis(value) {
  if (!Array.isArray(value)) return DEFAULT_QUICK_EMOJIS;
  const cleaned = value
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
    .slice(0, 12);
  return cleaned.length ? cleaned : DEFAULT_QUICK_EMOJIS;
}

function loadQuickEmojis() {
  try {
    const parsed = JSON.parse(localStorage.getItem('da_quick_reactions') || '[]');
    return normalizeQuickEmojis(parsed);
  } catch {
    return DEFAULT_QUICK_EMOJIS;
  }
}

let QUICK_EMOJIS = loadQuickEmojis();

function saveQuickEmojis(next) {
  QUICK_EMOJIS = normalizeQuickEmojis(next);
  localStorage.setItem('da_quick_reactions', JSON.stringify(QUICK_EMOJIS));
}

function showQuickReactPicker(btn, msgId) {
  let existing = document.querySelector('.quick-react-popup');
  existing?.remove();
  const popEl = document.createElement('div');
  popEl.className = 'quick-react-popup';
  QUICK_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.className = 'quick-react-btn';
    b.textContent = em;
    b.onclick = () => { toggleReaction(msgId, em); popEl.remove(); };
    popEl.appendChild(b);
  });

  const more = document.createElement('button');
  more.className = 'quick-react-btn more';
  more.textContent = '+';
  more.title = 'Настроить быстрые реакции';
  more.onclick = () => {
    popEl.remove();
    openUserSettings('appearance');
  };
  popEl.appendChild(more);

  const rect = btn.getBoundingClientRect();
  document.body.appendChild(popEl);

  const maxLeft = window.innerWidth - popEl.offsetWidth - 8;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, maxLeft));
  const below = rect.bottom + 6;
  const above = rect.top - popEl.offsetHeight - 6;
  const top = (below + popEl.offsetHeight <= window.innerHeight - 8) ? below : Math.max(8, above);
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;

  const close = e => { if (!popEl.contains(e.target)) { popEl.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function setupEmojiPicker() {
  const oldPicker = $('emoji-picker');
  // We'll build a v2 picker on click instead of using the old static one
  if (oldPicker) oldPicker.remove();

  // Poll creation button
  $('btn-poll')?.addEventListener('click', e => {
    e.stopPropagation();
    openPollCreator();
  });

  $('btn-emoji').addEventListener('click', e => {
    e.stopPropagation();
    let picker = document.querySelector('.emoji-picker-v2');
    if (picker) { picker.remove(); return; }

    const recentEmojis = JSON.parse(localStorage.getItem('da_recent_emojis') || '[]').slice(0, 24);
    const catKeys = Object.keys(EMOJI_CATEGORIES);
    const catNameMap = {
      smileys: 'emoji_smileys', people: 'emoji_people', nature: 'emoji_nature',
      food: 'emoji_food', activities: 'emoji_activities', travel: 'emoji_travel',
      objects: 'emoji_objects', symbols: 'emoji_symbols',
    };

    picker = document.createElement('div');
    picker.className = 'emoji-picker-v2';
    picker.innerHTML = `
      <div class="ep-search"><input placeholder="${t('emoji_search')}" id="ep-search-input"></div>
      <div class="ep-tabs">
        ${recentEmojis.length ? `<button class="ep-tab active" data-cat="recent">${IC.clock}</button>` : ''}
        ${catKeys.map((k, i) => `<button class="ep-tab ${!recentEmojis.length && i === 0 ? 'active' : ''}" data-cat="${k}">${EMOJI_CATEGORIES[k].icon}</button>`).join('')}
      </div>
      <div class="ep-grid" id="ep-grid"></div>
    `;

    // Position above emoji button
    const wrapper = $('btn-emoji').closest('.input-actions') || $('btn-emoji').parentElement;
    picker.style.position = 'absolute';
    picker.style.bottom = '100%';
    picker.style.right = '0';
    wrapper.style.position = 'relative';
    wrapper.appendChild(picker);

    const grid = picker.querySelector('#ep-grid');
    let activeCat = recentEmojis.length ? 'recent' : catKeys[0];

    function renderGrid(cat, filter = '') {
      let emojis;
      if (filter) {
        // Search across all categories
        emojis = [];
        for (const c of catKeys) emojis.push(...EMOJI_CATEGORIES[c].emojis);
        // Simple: just show all (filtering by emoji is not very useful, but works for small sets)
        grid.innerHTML = emojis.map(em => `<button data-em="${em}">${em}</button>`).join('');
        return;
      }
      if (cat === 'recent') {
        emojis = recentEmojis;
        grid.innerHTML = `<div class="ep-cat-label">${t('emoji_recent')}</div>` + emojis.map(em => `<button data-em="${em}">${em}</button>`).join('');
      } else {
        emojis = EMOJI_CATEGORIES[cat]?.emojis || [];
        grid.innerHTML = `<div class="ep-cat-label">${t(catNameMap[cat] || cat)}</div>` + emojis.map(em => `<button data-em="${em}">${em}</button>`).join('');
      }
    }

    renderGrid(activeCat);

    // Tab clicks
    picker.querySelectorAll('.ep-tab').forEach(tab => {
      tab.onclick = () => {
        picker.querySelectorAll('.ep-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeCat = tab.dataset.cat;
        renderGrid(activeCat);
      };
    });

    // Search
    const searchInput = picker.querySelector('#ep-search-input');
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (q) renderGrid('', q);
      else renderGrid(activeCat);
    });

    // Click emoji
    grid.addEventListener('click', e => {
      const btn = e.target.closest('button[data-em]');
      if (!btn) return;
      const em = btn.dataset.em;
      const txt = $('msg-input');
      const pos = txt.selectionStart;
      txt.value = txt.value.slice(0, pos) + em + txt.value.slice(pos);
      txt.focus();
      // Save to recent
      const recent = JSON.parse(localStorage.getItem('da_recent_emojis') || '[]');
      const updated = [em, ...recent.filter(e => e !== em)].slice(0, 24);
      localStorage.setItem('da_recent_emojis', JSON.stringify(updated));
    });

    // Close on outside click
    const close = ev => { if (!picker.contains(ev.target) && ev.target !== $('btn-emoji')) { picker.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  });
}

// ─── TYPING ───────────────────────────────────────────────────────────────────
let _typingSent = false;
let _typingTimer = null;

function renderTyping() {
  const el = $('typing-indicator');
  const users = S.typingUsers[S.activeChannelId] || {};
  const names = Object.keys(users).map(uid => displayNameFor(uid, uid, S.activeServerId));
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
  bar.innerHTML = `${IC.attach} ${escHtml(file.name)} <div class="upload-bar"><div class="upload-fill" id="uf-${file.name}" style="width:0%"></div></div>`;
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
  const online = members.filter(m => (S.presences[m.id]?.status || 'offline') !== 'offline');
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
  const srv = getServer(S.activeServerId);
  const isOwner = srv && m.id === srv.owner_id;
  return `
    <div class="member-item" data-user-id="${escHtml(m.id)}">
      <div class="mem-av">
        ${avatarEl(m, 32)}
        <div class="status-dot ${status}" style="border-color:${bg}"></div>
      </div>
      <div class="mem-info">
        <div class="mem-name" style="${color ? `color:${color}` : ''}">${escHtml(displayNameFor(m.id, m.username || '?', S.activeServerId))}${isOwner ? ' <span class="owner-crown" title="' + t('server_owner') + '">' + IC.crown + '</span>' : ''}</div>
        ${p.custom_status ? `<div class="mem-role">${escHtml(p.custom_status)}</div>` : ''}
      </div>
    </div>
  `;
}

// ─── PROFILE CARD ─────────────────────────────────────────────────────────────
async function showProfileCard(userId, anchorEl) {
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

  const card = $('profile-card-popup');
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

function closeProfileCard() {
  $('profile-card-popup').classList.add('hidden');
}

// ─── CONTEXT MENUS ────────────────────────────────────────────────────────────
function showCtxMenu(x, y, items) {
  const menu = $('ctx-menu');
  menu.innerHTML = items.map(item => {
    if (item.divider) return '<div class="ctx-divider"></div>';
    if (item.header) return `<div class="ctx-header">${escHtml(item.header)}</div>`;
    return `<div class="ctx-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}">
      <span class="ctx-icon">${item.icon || ''}</span>
      <span class="ctx-label">${escHtml(item.label)}</span>
      ${item.hint ? `<span class="ctx-hint">${escHtml(item.hint)}</span>` : ''}
    </div>`;
  }).join('');
  // Smart positioning — keep inside viewport
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  menu.classList.remove('hidden');
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  const margin = 8;
  const cxRaw = x + mw > window.innerWidth ? x - mw : x;
  const cyRaw = y + mh > window.innerHeight ? y - mh : y;
  const cx = clamp(cxRaw, margin, Math.max(margin, window.innerWidth - mw - margin));
  const cy = clamp(cyRaw, margin, Math.max(margin, window.innerHeight - mh - margin));
  menu.style.left = cx + 'px';
  menu.style.top = cy + 'px';
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
  const canManageServer = userHasPermissionClient(serverId, 'manage_server');
  const canManageChannels = userHasPermissionClient(serverId, 'manage_channels');
  showCtxMenu(e.clientX, e.clientY, [
    { icon: IC.settings, label: t('server_settings_menu'), onClick: () => openServerSettings(serverId) },
    { icon: IC.bell, label: t('notifications'), onClick: () => openNotificationSettings(serverId) },
    { icon: IC.invite, label: t('invite_people'), onClick: () => createInvite(serverId) },
    { divider: true },
    { icon: IC.pin, label: t('pinned_messages'), onClick: () => showToast(t('pinned_hint')) },
    canManageChannels && { icon: IC.hash, label: t('create_channel_menu'), onClick: () => openCreateChannelModal(serverId, null) },
    canManageChannels && { icon: IC.folder, label: t('create_category_menu'), onClick: () => createCategory(serverId) },
    { divider: true },
    { icon: IC.id, label: t('copy_server_id'), onClick: () => { navigator.clipboard.writeText(serverId); showToast(t('id_copied')); } },
    { divider: true },
    !isOwner && { icon: IC.leave, label: t('leave_server'), danger: true, onClick: () => leaveServer(serverId) },
    isOwner && { icon: IC.trash, label: t('delete_server'), danger: true, onClick: () => deleteServer(serverId) },
  ].filter(Boolean));
}

function showChannelContextMenu(e, channelId) {
  const ch = getChannel(channelId);
  if (!ch || !ch.server_id) return;
  const canManageChannels = userHasPermissionClient(ch.server_id, 'manage_channels');
  const isVoice = ch.type === 'voice';

  const items = [
    { header: escHtml(ch.name) },
  ];

  if (isVoice) {
    if (V.channelId !== channelId) {
      items.push({ icon: IC.speaker, label: t('voice_connect'), onClick: () => joinVoiceChannel(channelId) });
    } else {
      items.push({ icon: IC.voiceMuted, label: t('voice_disconnect'), danger: true, onClick: leaveVoiceChannel });
    }
    items.push({ divider: true });
  }

  items.push(
    { icon: IC.bell, label: t('notifications'), onClick: () => openNotificationSettings(ch.server_id) },
    { icon: IC.pin, label: t('pins_short'), onClick: () => { S.activeChannelId = channelId; showPins(); } },
    { icon: IC.id, label: t('copy_id'), onClick: () => { navigator.clipboard.writeText(channelId); showToast(t('id_copied')); } },
    { divider: true },
  );

  if (canManageChannels) {
    items.push(
      { icon: IC.settings, label: 'Настройки канала', onClick: () => openChannelSettings(channelId) },
      { icon: IC.edit, label: t('rename_channel'), onClick: () => renameChannel(ch) },
      { icon: IC.invite, label: t('create_invite_ctx'), onClick: () => createInvite(ch.server_id) },
      { icon: '🔗', label: 'Вебхуки', onClick: () => showWebhooksPanel(channelId) },
      { icon: IC.trash, label: t('delete_channel'), danger: true, onClick: () => deleteChannel(channelId) },
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
  const canManageServer = userHasPermissionClient(srv.id, 'manage_server');
  const canManageChannels = userHasPermissionClient(srv.id, 'manage_channels');
  const dd = $('server-dropdown');
  dd.innerHTML = `
    <div class="sm-item" id="sm-invite"><span class="sm-icon">${IC.invite}</span><span class="sm-label">${t('invite_people')}</span><span class="sm-hint">⌘I</span></div>
    <div class="sm-item" id="sm-settings"><span class="sm-icon">${IC.settings}</span><span class="sm-label">${t('server_settings_menu')}</span></div>
    ${canManageChannels ? `<div class="sm-item" id="sm-create-ch"><span class="sm-icon">${IC.plus}</span><span class="sm-label">${t('create_channel')}</span></div>` : ''}
    ${canManageChannels ? `<div class="sm-item" id="sm-create-cat"><span class="sm-icon">${IC.folder}</span><span class="sm-label">${t('create_category')}</span></div>` : ''}
    <div class="sm-item" id="sm-events"><span class="sm-icon">📅</span><span class="sm-label">События</span></div>
    <div class="sm-divider"></div>
    ${isOwner
      ? `<div class="sm-item danger" id="sm-delete"><span class="sm-icon">${IC.trash}</span><span class="sm-label">${t('delete_server')}</span></div>`
      : `<div class="sm-item danger" id="sm-leave"><span class="sm-icon">${IC.leave}</span><span class="sm-label">${t('leave_server')}</span></div>`}
  `;
  dd.classList.remove('hidden');
  dd.querySelector('#sm-invite')?.addEventListener('click', () => { createInvite(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-settings')?.addEventListener('click', () => { openServerSettings(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-create-ch')?.addEventListener('click', () => { openCreateChannelModal(srv.id, null); hideServerDropdown(); });
  dd.querySelector('#sm-create-cat')?.addEventListener('click', () => { createCategory(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-delete')?.addEventListener('click', () => { deleteServer(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-leave')?.addEventListener('click', () => { leaveServer(srv.id); hideServerDropdown(); });
  dd.querySelector('#sm-events')?.addEventListener('click', () => { showEventsPanel(); hideServerDropdown(); });

  const closeDD = e => {
    if (!dd.contains(e.target) && !$('sidebar-header').contains(e.target)) { hideServerDropdown(); document.removeEventListener('click', closeDD); }
  };
  setTimeout(() => document.addEventListener('click', closeDD), 0);
}

function hideServerDropdown() { $('server-dropdown').classList.add('hidden'); }

// ─── SERVER ACTIONS ───────────────────────────────────────────────────────────
async function createInvite(serverId) {
  try {
    const inv = await API.post(`/api/guilds/${serverId}/invites`, { max_age: 7 * 24 * 3600 });
    const code = inv.code || (inv.invite && inv.invite.code) || inv;
    const url = `${location.origin}/app?invite=${code}`;
    await navigator.clipboard.writeText(url).catch(() => { });
    showToast(t('invite_copied', { url }), 'success');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function leaveServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_leave_server', { name: srv?.name || '?' }), { title: t('leave_server'), danger: true, confirmText: t('confirm_leave_server_btn') })) return;
  try {
    await API.post(`/api/guilds/${serverId}/leave`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function deleteServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_delete_server', { name: srv?.name || '?' }), { title: t('delete_server'), danger: true })) return;
  try {
    await API.del(`/api/guilds/${serverId}`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

async function createCategory(serverId) {
  const name = await daPrompt(t('category_name'), { title: t('create_category'), confirmText: t('create') });
  if (!name) return;
  try {
    await API.post(`/api/guilds/${serverId}/channels`, { name, type: 4 });
    // Refresh server
    const srv = await API.get(`/api/guilds/${serverId}`);
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
      $('pins-list').innerHTML = '<div class="empty-state"><div class="empty-icon">' + IC.pin + '</div><div class="empty-text">' + t('no_pinned_short') + '</div></div>';
      return;
    }
    $('pins-list').innerHTML = pins.map(msg => `
      <div style="padding:8px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:13px">${escHtml(msg.author?.username || '?')}</div>
        <div style="font-size:14px;color:var(--text-2)">${escHtml((msg.content || '').slice(0, 200))}</div>
        <div style="font-size:12px;color:var(--text-3)">${fmtDatetime(msg.created_at)}</div>
      </div>
    `).join('');
  } catch { }
}

// ─── FRIENDS SYSTEM ───────────────────────────────────────────────────────────
let _friendsTab = 'online';

async function loadFriendCount() {
  try {
    S.friends = await API.get('/api/users/@me/relationships');
  } catch {
    S.friends = [];
  }
  S._friendRequestCount = S.friends.filter(f => f.status === 'pending' && f.direction === 'incoming').length;
  if (S.activeServerId === '@me') renderChannelList();
}

async function showFriendsView() {
  $('welcome-screen').classList.add('hidden');
  $('chat-header').classList.add('hidden');
  $('messages-wrapper').classList.add('hidden');
  $('typing-indicator').classList.add('hidden');
  $('input-area').classList.add('hidden');
  $('members-panel').classList.add('hidden');

  try {
    S.friends = await API.get('/api/users/@me/relationships');
  } catch {
    S.friends = [];
  }
  S._friendRequestCount = S.friends.filter(f => f.status === 'pending' && f.direction === 'incoming').length;
  renderChannelList();

  // Render friends view in main area
  let main = $('friends-view');
  if (!main) {
    main = document.createElement('div');
    main.id = 'friends-view';
    main.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden';
    $('main').appendChild(main);
  }
  main.classList.remove('hidden');

  const accepted = S.friends.filter(f => f.status === 'accepted');
  const pending = S.friends.filter(f => f.status === 'pending');
  const blocked = S.friends.filter(f => f.status === 'blocked');
  const incomingPending = pending.filter(f => f.direction === 'incoming');
  const onlineFriends = accepted.filter(f => (S.presences[f.user_id]?.status || 'offline') !== 'offline');

  main.innerHTML = `
    <div class="friends-header">
      <span class="fh-title">${IC.friends} ${t('friends')}</span>
      <div class="fh-divider"></div>
      <button class="friends-tab ${_friendsTab === 'online' ? 'active' : ''}" data-tab="online">${t('online_friends')}</button>
      <button class="friends-tab ${_friendsTab === 'all' ? 'active' : ''}" data-tab="all">${t('all_friends')}</button>
      <button class="friends-tab ${_friendsTab === 'pending' ? 'active' : ''}" data-tab="pending">${t('pending_friends')}${incomingPending.length ? ` (${incomingPending.length})` : ''}</button>
      <button class="friends-tab ${_friendsTab === 'blocked' ? 'active' : ''}" data-tab="blocked">${t('blocked_friends')}</button>
      <button class="friends-tab green ${_friendsTab === 'add' ? 'active' : ''}" data-tab="add">${t('add_friend')}</button>
    </div>
    ${_friendsTab === 'add' ? `
      <div class="friend-search-bar">
        <input id="friend-search-input" placeholder="${t('add_friend_hint')}">
        <div id="friend-search-results" style="margin-top:8px"></div>
      </div>
    ` : ''}
    <div class="friends-body" id="friends-body"></div>
  `;

  // Tab clicks
  main.querySelectorAll('.friends-tab').forEach(btn => {
    btn.onclick = () => { _friendsTab = btn.dataset.tab; showFriendsView(); };
  });

  const body = $('friends-body');

  if (_friendsTab === 'online') {
    body.innerHTML = `<div class="friend-count">${t('online_friends')} — ${onlineFriends.length}</div>`;
    if (!onlineFriends.length) body.innerHTML += `<div class="empty-state"><div class="empty-icon">${IC.friends}</div><div class="empty-text">${t('no_friends')}</div></div>`;
    for (const f of onlineFriends) body.insertAdjacentHTML('beforeend', friendItemHtml(f));
  } else if (_friendsTab === 'all') {
    body.innerHTML = `<div class="friend-count">${t('all_friends')} — ${accepted.length}</div>`;
    if (!accepted.length) body.innerHTML += `<div class="empty-state"><div class="empty-icon">${IC.friends}</div><div class="empty-text">${t('no_friends')}</div></div>`;
    for (const f of accepted) body.insertAdjacentHTML('beforeend', friendItemHtml(f));
  } else if (_friendsTab === 'pending') {
    body.innerHTML = `<div class="friend-count">${t('pending_friends')} — ${pending.length}</div>`;
    if (!pending.length) body.innerHTML += `<div class="empty-state"><div class="empty-icon">${IC.mail}</div><div class="empty-text">${t('no_pending')}</div></div>`;
    for (const f of pending) body.insertAdjacentHTML('beforeend', friendItemHtml(f, true));
  } else if (_friendsTab === 'blocked') {
    body.innerHTML = `<div class="friend-count">${t('blocked_friends')} — ${blocked.length}</div>`;
    if (!blocked.length) body.innerHTML += `<div class="empty-state"><div class="empty-icon">${IC.shield}</div><div class="empty-text">${t('no_friends')}</div></div>`;
    for (const f of blocked) body.insertAdjacentHTML('beforeend', friendItemHtml(f));
  }

  // Friend item click actions
  body.querySelectorAll('.friend-item').forEach(el => {
    el.querySelector('.friend-dm')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const dm = await API.post(`/api/users/${el.dataset.userId}/dm`);
        if (dm?.id) selectChannel(dm.id);
      } catch { }
    });
    el.querySelector('.friend-remove')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await API.del(`/api/users/@me/relationships/${el.dataset.userId}`);
        await showFriendsView();
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
      }
    });
    el.querySelector('.friend-accept')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await API.put(`/api/users/@me/relationships/${el.dataset.userId}`, { type: 1 });
        await showFriendsView();
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
      }
    });
    el.querySelector('.friend-decline')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await API.del(`/api/users/@me/relationships/${el.dataset.userId}`);
        await showFriendsView();
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
      }
    });
    el.querySelector('.friend-block')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await API.put(`/api/users/@me/relationships/${el.dataset.userId}`, { type: 2 });
        await showFriendsView();
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
      }
    });
    el.querySelector('.friend-unblock')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await API.del(`/api/users/@me/relationships/${el.dataset.userId}`);
        await showFriendsView();
      } catch (err) {
        showToast(err.body?.error || t('error_generic'), 'error');
      }
    });
  });

  // Add friend search
  if (_friendsTab === 'add') {
    const searchInput = $('friend-search-input');
    let _debounce;
    searchInput?.addEventListener('input', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(async () => {
        const q = searchInput.value.trim();
        const resultsEl = $('friend-search-results');
        if (!q || q.length < 1) { resultsEl.innerHTML = ''; return; }
        try {
          const users = await API.get(`/api/users?q=${encodeURIComponent(q)}&limit=10`);
          resultsEl.innerHTML = users.map(u => `
            <div class="friend-item" data-user-id="${escHtml(u.id)}">
              <div class="friend-av">${avatarEl(u, 36)}</div>
              <div class="friend-info">
                <div class="friend-name">${escHtml(u.username)}<span style="color:var(--text-3)">#${escHtml(u.discriminator || '0000')}</span></div>
              </div>
              <div class="friend-actions">
                <button class="friend-add-btn success" title="${t('add_friend')}">${IC.plus}</button>
              </div>
            </div>
          `).join('') || `<div style="color:var(--text-3);padding:8px">${t('new_dm_no_results')}</div>`;
          resultsEl.querySelectorAll('.friend-add-btn').forEach(btn => {
            btn.onclick = async () => {
              try {
                const userId = btn.closest('.friend-item')?.dataset.userId;
                const user = users.find(u => u.id === userId);
                if (!user?.username) return;
                await API.post('/api/users/@me/relationships', { username: user.username.toLowerCase() });
                showToast(t('friend_added'), 'success');
                await showFriendsView();
              } catch (err) {
                showToast(err.body?.error || t('error_generic'), 'error');
              }
            };
          });
        } catch { }
      }, 300);
    });
    searchInput?.focus();
  }
}

function friendItemHtml(f, isPending = false) {
  const p = S.presences[f.user_id] || {};
  const status = p.status || 'offline';
  const statusText = p.custom_status || t(`status_${status === 'dnd' ? 'dnd' : status}`);
  return `
    <div class="friend-item" data-user-id="${escHtml(f.user_id)}">
      <div class="friend-av">
        ${f.avatar_url ? `<img src="${escHtml(f.avatar_url)}" style="width:36px;height:36px;border-radius:50%">` : `<div class="av-fallback" style="width:36px;height:36px;font-size:15px;background:${escHtml(f.avatar_color || '#5865f2')}">${(f.username || '?')[0].toUpperCase()}</div>`}
        <div class="status-dot ${status}" style="border-color:var(--bg-2)"></div>
      </div>
      <div class="friend-info">
        <div class="friend-name">${escHtml(f.username)}</div>
        <div class="friend-status-text">${escHtml(statusText)}</div>
      </div>
      <div class="friend-actions">
        ${isPending && f.direction === 'incoming' ? `
          <button class="friend-accept success" title="${t('accept_friend')}">✓</button>
          <button class="friend-decline danger" title="${t('decline_friend')}">✕</button>
        ` : isPending ? `
          <span style="color:var(--text-3);font-size:12px">${t('pending_friends')}...</span>
        ` : f.status === 'blocked' ? `
          <button class="friend-unblock" title="${t('unblock')}">${t('unblock')}</button>
        ` : `
          <button class="friend-dm" title="DM">${IC.msg}</button>
          <button class="friend-block danger" title="${t('block')}">${IC.close}</button>
          <button class="friend-remove danger" title="${t('remove_friend')}">✕</button>
        `}
      </div>
    </div>
  `;
}

// ─── NICKNAME MODAL ───────────────────────────────────────────────────────────
function showNicknameModal() {
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

  const input = $('nick-input');
  input?.focus();

  $('nick-save').onclick = async () => {
    try {
      const nick = input.value.trim();
      await API.patch(`/api/guilds/${S.activeServerId}/members/${S.me.id}`, { nickname: nick || null });
      // Update local state
      if (member) member.nickname = nick || null;
      showToast(t('nickname_saved'), 'success');
      overlay.remove();
      if (S.activeServerId !== '@me') {
        renderMembersPanel();
        renderChannelList();
        if (getChannel(S.activeChannelId)?.type === 'voice') renderVoicePanel();
        else renderMessages();
      }
    } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
  };

  $('nick-reset').onclick = async () => {
    try {
      await API.patch(`/api/guilds/${S.activeServerId}/members/${S.me.id}`, { nickname: null });
      if (member) member.nickname = null;
      showToast(t('nickname_saved'), 'success');
      overlay.remove();
      if (S.activeServerId !== '@me') {
        renderMembersPanel();
        renderChannelList();
        if (getChannel(S.activeChannelId)?.type === 'voice') renderVoicePanel();
        else renderMessages();
      }
    } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
  };

  input?.addEventListener('keydown', e => { if (e.key === 'Enter') $('nick-save').click(); });
}

// ─── NEW DM MODAL ─────────────────────────────────────────────────────────────
function showNewDmModal() {
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

  // Initial state
  results.innerHTML = `<div class="dm-search-empty">${t('new_dm_type_to_search')}</div>`;
  setTimeout(() => input.focus(), 50);
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

// ─── SERVER SETTINGS ──────────────────────────────────────────────────────────
function openServerSettings(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  const canManageServer = userHasPermissionClient(serverId, 'manage_server');
  const canManageRoles = userHasPermissionClient(serverId, 'manage_roles');
  const canBan = userHasPermissionClient(serverId, 'ban_members');
  const canViewAudit = userHasPermissionClient(serverId, 'view_audit_log') || canManageServer;

  $('ss-server-name').textContent = srv.name;
  $('ss-leave-server').classList.toggle('hidden', isOwner);
  $('ss-delete-server').classList.toggle('hidden', !isOwner);

  const allPages = [
    { id: 'overview', label: t('ss_overview'), icon: IC.overview, show: true },
    { id: 'roles', label: t('ss_roles'), icon: IC.shield, show: canManageRoles },
    { id: 'members', label: t('ss_members'), icon: IC.members, show: true },
    { id: 'bans', label: t('ss_bans'), icon: IC.hammer, show: canBan },
    { id: 'invites', label: t('ss_invites'), icon: IC.link, show: canManageServer },
    { id: 'audit', label: t('ss_audit'), icon: IC.scroll, show: canViewAudit },
  ];
  const pages = allPages.filter(p => p.show);

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
  const titleIcons = { overview: IC.overview, roles: IC.shield, members: IC.members, bans: IC.hammer, invites: IC.link, audit: IC.scroll };
  $('ss-page-title').innerHTML = `${titleIcons[page] || ''} ${{ overview: t('ss_overview'), roles: t('ss_roles'), members: t('ss_members'), bans: t('ss_bans'), invites: t('ss_invites'), audit: t('ss_audit') }[page] || page}`;
  const body = $('ss-page-body');
  body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  if (page === 'overview') {
    const invUrl = `${location.origin}/app?invite=${srv.invite_code}`;
    const canEdit = userHasPermissionClient(serverId, 'manage_server');
    const isOwner = srv.owner_id === S.me?.id;
    body.innerHTML = `
      ${canEdit ? `
      <div class="form-group">
        <label>${t('server_name')}</label>
        <input id="ss-name" value="${escHtml(srv.name)}">
      </div>
      <div class="form-group">
        <label>${t('server_description')}</label>
        <textarea id="ss-desc">${escHtml(srv.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>${t('server_icon_url')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ss-icon" value="${escHtml(srv.icon_url || '')}" style="flex:1">
          <label class="btn btn-secondary" style="cursor:pointer;white-space:nowrap;margin:0">
            ${IC.upload} Upload
            <input type="file" id="ss-icon-upload" accept="image/*" style="display:none">
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>${t('server_banner_url')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ss-banner" value="${escHtml(srv.banner_url || '')}" style="flex:1">
          <label class="btn btn-secondary" style="cursor:pointer;white-space:nowrap;margin:0">
            ${IC.upload} Upload
            <input type="file" id="ss-banner-upload" accept="image/*" style="display:none">
          </label>
        </div>
      </div>
      <button class="btn btn-primary mt-8" id="ss-save-overview">${t('save_changes')}</button>
      ` : `
      <div class="form-group">
        <label>${t('server_name')}</label>
        <div style="padding:10px 12px;color:var(--text);font-size:14px">${escHtml(srv.name)}</div>
      </div>
      ${srv.description ? `<div class="form-group"><label>${t('server_description')}</label><div style="padding:10px 12px;color:var(--text-2);font-size:14px">${escHtml(srv.description)}</div></div>` : ''}
      `}

      <div class="form-group mt-16">
        <label>${t('invite_link')}</label>
        <div class="invite-link-box">
          <code id="ss-invite-url">${escHtml(invUrl)}</code>
          <button class="btn btn-primary copy-btn" id="ss-copy-inv">${t('copy')}</button>
        </div>
      </div>

      <div class="form-group" style="margin-top:12px">
        <label>${t('server_owner')}</label>
        <div style="padding:10px 12px;color:var(--text);font-size:14px;display:flex;align-items:center;gap:8px">
          <span>${IC.crown}</span>
          <span id="ss-owner-name">...</span>
        </div>
      </div>

      ${isOwner ? `
      <div class="danger-zone">
        <h4>${t('danger_zone')}</h4>
        <button class="btn btn-danger" id="ss-danger-delete">${t('delete_server_btn')}</button>
      </div>
      ` : ''}
    `;
    // Load owner username
    const members = S.members[serverId] || await API.get(`/api/guilds/${serverId}/members`).catch(() => []);
    if (!S.members[serverId]) S.members[serverId] = members;
    const ownerMember = members.find(m => m.id === srv.owner_id);
    const ownerEl = document.getElementById('ss-owner-name');
    if (ownerEl) ownerEl.textContent = ownerMember?.username || '?';

    if (canEdit) {
      $('ss-icon-upload')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          const result = await API.uploadFile(file);
          $('ss-icon').value = result.url;
          showToast('Server icon uploaded', 'success');
        } catch (e) { showToast(e.body?.error || e.message || t('error_generic'), 'error'); }
      });
      $('ss-banner-upload')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          const result = await API.uploadFile(file);
          $('ss-banner').value = result.url;
          showToast('Server banner uploaded', 'success');
        } catch (e) { showToast(e.body?.error || e.message || t('error_generic'), 'error'); }
      });

      $('ss-save-overview').onclick = async () => {
        try {
          const updated = await API.patch(`/api/guilds/${serverId}`, {
            name: $('ss-name').value.trim(),
            description: $('ss-desc').value.trim(),
            icon_url: $('ss-icon').value.trim(),
            banner_url: $('ss-banner').value.trim(),
          });
          const idx = S.servers.findIndex(s => s.id === serverId);
          if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...updated };
          renderServerIcons();
          showToast(t('saved'), 'success');
        } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    }
    $('ss-copy-inv')?.addEventListener('click', () => { navigator.clipboard.writeText(invUrl).catch(() => { }); showToast(t('copied'), 'success'); });
    if (isOwner) $('ss-danger-delete')?.addEventListener('click', () => deleteServer(serverId));
  }

  if (page === 'roles') {
    const guild = await API.get(`/api/guilds/${serverId}`).catch(() => null);
    const roles = guild?.roles || [];
    const canManageRoles = userHasPermissionClient(serverId, 'manage_roles');
    const perms = ['send_messages', 'manage_messages', 'kick_members', 'ban_members', 'manage_channels', 'manage_server', 'mention_everyone', 'manage_roles', 'view_channel', 'administrator'];
    // Calculate member counts per role
    const members = S.members[serverId] || await API.get(`/api/guilds/${serverId}/members`).catch(() => []);
    if (!S.members[serverId]) S.members[serverId] = members;
    const roleCounts = {};
    for (const r of roles) {
      if (r.is_default) { roleCounts[r.id] = members.length; continue; }
      roleCounts[r.id] = members.filter(m => (m.roles || []).some(mr => mr.id === r.id)).length;
    }
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
              <td>${roleCounts[r.id] || 0}</td>
              <td class="table-actions">
                ${canManageRoles ? `
                  <button class="table-btn edit-role-btn" data-role-id="${escHtml(r.id)}" title="${t('edit')}">&#9998;</button>
                  ${!r.is_default ? `<button class="table-btn del delete-role-btn" data-role-id="${escHtml(r.id)}" title="${t('delete')}">&#128465;</button>` : ''}
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
      const color = await daPrompt(t('role_color') + ' (hex)', { title: t('create_role'), placeholder: '#99aab5', confirmText: t('ok') });
      try {
        const parsedColor = color ? Number.parseInt(color.replace('#', ''), 16) || 0 : 0;
        const role = await API.post(`/api/guilds/${serverId}/roles`, { name, color: parsedColor });
        const idx = S.servers.findIndex(s => s.id === serverId);
        if (idx !== -1) S.servers[idx].roles = [...(S.servers[idx].roles || []), role];
        renderServerSettingsPage(serverId, 'roles');
        showToast(t('role_created'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    });
    body.querySelectorAll('.delete-role-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!await daConfirm(t('confirm_delete_role'), { title: t('confirm_delete_role_title'), danger: true })) return;
        try {
          await API.del(`/api/guilds/${serverId}/roles/${btn.dataset.roleId}`);
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
    const members = S.members[serverId] || await API.get(`/api/guilds/${serverId}/members`).catch(() => []);
    if (!S.members[serverId]) S.members[serverId] = members;
    const roles = getServer(serverId)?.roles?.filter(r => !r.is_default) || [];
    const canManage = userHasPermissionClient(serverId, 'kick_members');
    const canBan = userHasPermissionClient(serverId, 'ban_members');
    const canManageRoles = userHasPermissionClient(serverId, 'manage_roles');
    body.innerHTML = `
      <table class="settings-table">
        <thead><tr><th>${t('member_user')}</th><th>${t('member_nick')}</th><th>${t('member_roles')}</th><th>${t('member_joined')}</th><th></th></tr></thead>
        <tbody>
          ${members.map(m => {
      const isMemberOwner = m.user_id === srv.owner_id;
      const isMe = m.user_id === S.me?.id;
      return `
            <tr>
              <td><div class="flex-row">${avatarEl({ id: m.user_id, ...m }, 24)} ${escHtml(m.nickname || m.username)}${isMemberOwner ? ' <span class="owner-crown" title="' + t('server_owner') + '">' + IC.crown + '</span>' : ''}</div></td>
              <td>${escHtml(m.nickname || '—')}</td>
              <td>
                ${(m.roles || []).map(r => `<span class="role-pill" style="background:${escHtml(r.color)}">${escHtml(r.name)}</span>`).join(' ')}
                ${canManageRoles && roles.length && !isMemberOwner ? `<button class="table-btn assign-role-btn" data-user-id="${escHtml(m.user_id)}" title="${t('assign_role')}">&#65291;</button>` : ''}
              </td>
              <td style="font-size:12px;color:var(--text-3)">${fmtDatetime(m.joined_at)}</td>
              <td class="table-actions">
                ${!isMe && !isMemberOwner && canManage ? `<button class="table-btn del kick-btn" data-user-id="${escHtml(m.user_id)}" title="${t('kick')}">&#128098;</button>` : ''}
                ${!isMe && !isMemberOwner && canBan ? `<button class="table-btn del ban-btn" data-user-id="${escHtml(m.user_id)}" title="${t('ban')}">&#128296;</button>` : ''}
              </td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!await daConfirm(t('confirm_kick'), { title: t('confirm_kick_title'), danger: true, confirmText: t('confirm_kick_btn') })) return;
        try { await API.del(`/api/guilds/${serverId}/members/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'members'); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
    body.querySelectorAll('.ban-btn').forEach(btn => {
      btn.onclick = async () => {
        const reason = await daPrompt(t('prompt_ban_reason'), { title: t('prompt_ban_reason_title'), confirmText: t('ok') });
        if (reason === null) return;
        try { await API.put(`/api/guilds/${serverId}/bans/${btn.dataset.userId}`, { reason }); renderServerSettingsPage(serverId, 'members'); showToast(t('banned')); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
    // Role assignment
    body.querySelectorAll('.assign-role-btn').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const memberId = btn.dataset.userId;
        const member = members.find(m => m.user_id === memberId);
        const assignedIds = new Set((member?.roles || []).map(r => r.id));
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
              await API.put(`/api/guilds/${serverId}/members/${memberId}/roles/${rid}`, {}).catch(() => { });
            } else if (!cb.checked && was) {
              await API.del(`/api/guilds/${serverId}/members/${memberId}/roles/${rid}`).catch(() => { });
            }
          }
          close();
          renderServerSettingsPage(serverId, 'members');
        };
      };
    });
  }

  if (page === 'bans') {
    const bans = await API.get(`/api/guilds/${serverId}/bans`).catch(() => []);
    body.innerHTML = !bans.length ? `<div class="empty-state"><div class="empty-icon">${IC.check}</div><div class="empty-text">${t('no_bans')}</div></div>` : `
      <table class="settings-table">
        <thead><tr><th>${t('member_user')}</th><th>${t('ban_reason')}</th><th></th></tr></thead>
        <tbody>
          ${bans.map(b => `
            <tr>
              <td>${escHtml(b.username)}</td>
              <td>${escHtml(b.reason || '—')}</td>
              <td><button class="btn btn-outline unban-btn" data-user-id="${escHtml(b.user_id)}">${t('unban')}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.unban-btn').forEach(btn => {
      btn.onclick = async () => {
        try { await API.del(`/api/guilds/${serverId}/bans/${btn.dataset.userId}`); renderServerSettingsPage(serverId, 'bans'); showToast(t('unbanned')); }
        catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    });
  }

  if (page === 'invites') {
    const invites = await API.get(`/api/guilds/${serverId}/invites`).catch(() => []);
    body.innerHTML = `
      <button class="btn btn-primary mb-8" id="ss-create-inv">${t('create_invite')}</button>
      ${!invites.length ? `<div class="empty-state"><div class="empty-text">${t('no_invites')}</div></div>` : `
      <table class="settings-table">
        <thead><tr><th>${t('invite_code')}</th><th>${t('invite_creator')}</th><th>${t('invite_uses')}</th><th>${t('invite_expires')}</th><th></th></tr></thead>
        <tbody>
          ${invites.map(inv => `
            <tr>
              <td><code>${escHtml(inv.code)}</code></td>
              <td>${escHtml(inv.creator_username || '?')}</td>
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
    let entries = [], users = {};
    try {
      const data = await API.get(`/api/guilds/${serverId}/audit-logs`);
      entries = data.audit_log_entries || data || [];
      users = data.users || {};
    } catch { }

    const ACTION_LABELS = {
      1: 'Обновление сервера', 10: 'Создание канала', 11: 'Обновление канала', 12: 'Удаление канала',
      13: 'Создание переопределения прав', 14: 'Обновление переопределения прав', 15: 'Удаление переопределения прав',
      20: 'Кик участника', 21: 'Очистка участников', 22: 'Бан участника', 23: 'Разбан участника',
      24: 'Обновление участника', 25: 'Обновление ролей участника', 30: 'Создание роли', 31: 'Обновление роли', 32: 'Удаление роли',
      40: 'Создание приглашения', 41: 'Обновление приглашения', 42: 'Удаление приглашения',
      50: 'Создание вебхука', 51: 'Обновление вебхука', 52: 'Удаление вебхука',
      60: 'Создание эмодзи', 61: 'Обновление эмодзи', 62: 'Удаление эмодзи',
      72: 'Удалён\u0438е сообщения', 73: 'Массовое удаление сообщений', 74: 'Закрепление', 75: 'Открепление',
      110: 'Создание треда', 111: 'Обновление треда', 112: 'Удаление треда',
    };

    body.innerHTML = !entries.length ? `<div class="empty-state"><div class="empty-text">${t('no_audit')}</div></div>` : `
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <select id="audit-filter" style="padding:6px 10px;background:var(--input-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px">
          <option value="">Все действия</option>
          ${[...new Set(entries.map(e => e.action_type))].map(at => `<option value="${at}">${escHtml(ACTION_LABELS[at] || 'Действие #' + at)}</option>`).join('')}
        </select>
        <span style="color:var(--text-3);font-size:12px">${entries.length} записей</span>
      </div>
      <table class="settings-table" id="audit-table">
        <thead><tr><th>Кто</th><th>Действие</th><th>Цель</th><th>Причина</th><th>Когда</th></tr></thead>
        <tbody>
          ${entries.map(l => {
      const actor = users[l.user_id] || {};
      const target = users[l.target_id] || {};
      return `
            <tr data-action-type="${l.action_type}">
              <td><div class="flex-row">${avatarEl(actor, 20)} ${escHtml(actor.username || l.user_id || '?')}</div></td>
              <td>${escHtml(ACTION_LABELS[l.action_type] || l.action_type)}</td>
              <td style="font-size:12px;color:var(--text-3)">${escHtml(target.username || l.target_id || '—')}</td>
              <td style="font-size:12px;color:var(--text-3)">${escHtml(l.reason || '—')}</td>
              <td style="font-size:12px;color:var(--text-3)">${fmtDatetime(l.created_at)}</td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
    `;

    // Filter functionality
    body.querySelector('#audit-filter')?.addEventListener('change', (e) => {
      const v = e.target.value;
      body.querySelectorAll('#audit-table tbody tr').forEach(tr => {
        tr.style.display = (!v || tr.dataset.actionType === v) ? '' : 'none';
      });
    });
  }
}

function openRoleEditor(serverId, roleId, roles, perms) {
  const role = roles.find(r => r.id === roleId);
  if (!role) return;
  let currentPerms = {};
  try { currentPerms = JSON.parse(role.permissions || '{}'); } catch { }

  const body = $('ss-page-body');
  const PERM_KEY = { send_messages: 'perm_send_messages', manage_messages: 'perm_manage_messages', kick_members: 'perm_kick_members', ban_members: 'perm_ban_members', manage_channels: 'perm_manage_channels', manage_server: 'perm_manage_server', mention_everyone: 'perm_mention_everyone', manage_roles: 'perm_manage_roles', view_channel: 'perm_view_channel', administrator: 'perm_administrator' };
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
            <label for="perm-${p}">${escHtml(t(PERM_KEY[p] || p))}</label>
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
      await API.patch(`/api/guilds/${serverId}/roles/${roleId}`, { name: $('re-name').value.trim(), color: Number.parseInt(($('re-color').value || '#000000').replace('#', ''), 16) || 0, permissions: newPerms });
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
        <div style="display:flex;gap:8px;align-items:center">
          <input id="us-avatar" value="${escHtml(S.me?.avatar_url || '')}" placeholder="https://..." style="flex:1">
          <label class="btn btn-secondary" style="cursor:pointer;white-space:nowrap;margin:0">
            ${IC.upload} Upload
            <input type="file" id="us-avatar-upload" accept="image/*" style="display:none">
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>${t('avatar_color')}</label>
        <input type="color" id="us-av-color" value="${escHtml(S.me?.avatar_color || '#5865f2')}">
      </div>
      <div class="form-group">
        <label>${t('banner_url')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="us-banner" value="${escHtml(S.me?.banner_url || '')}" placeholder="https://..." style="flex:1">
          <label class="btn btn-secondary" style="cursor:pointer;white-space:nowrap;margin:0">
            ${IC.upload} Upload
            <input type="file" id="us-banner-upload" accept="image/*" style="display:none">
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>${t('banner_color')}</label>
        <input type="color" id="us-banner-color" value="${escHtml(S.me?.banner_color || '#5865f2')}">
      </div>
      <div class="form-group">
        <label>${t('about_me')}</label>
        <textarea id="us-about" maxlength="190">${escHtml(S.me?.about_me || '')}</textarea>
      </div>
      <div class="form-group">
        <label>${t('custom_status')}</label>
        <input id="us-status" value="${escHtml(S.me?.custom_status || '')}">
      </div>
      <button class="btn btn-primary" id="us-save">${t('save')}</button>

      <div class="settings-section-title" style="margin-top:24px">${IC.lock} ${t('change_password')}</div>
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
        const updated = await API.patch('/api/users/@me', {
          avatar: $('us-avatar').value.trim(),
          banner: $('us-banner').value.trim(),
          accent_color: $('us-av-color').value,
          bio: $('us-about').value.trim(),
          custom_status_text: $('us-status').value.trim(),
        });
        S.me = normalizeMe(updated);
        applySelfProfileToCaches(S.me);
        updateSidebarUser();
        renderChannelList();
        if (S.activeServerId !== '@me') renderMembersPanel();
        if (getChannel(S.activeChannelId)?.type === 'voice') renderVoicePanel();
        else if (S.activeChannelId && S.activeChannelId !== 'friends') renderMessages();
        socket?.emit('UPDATE_STATUS', { status: localStorage.getItem('da_status') || 'online', custom_status: S.me.custom_status });
        showToast(t('saved'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
    // Avatar upload handler
    $('us-avatar-upload').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const result = await API.uploadFile(file);
        $('us-avatar').value = result.url;
        showToast('Avatar uploaded!', 'success');
      } catch (err) { showToast(err.body?.error || err.message || t('error_generic'), 'error'); }
    };
    $('us-banner-upload').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const result = await API.uploadFile(file);
        $('us-banner').value = result.url;
        showToast('Banner uploaded!', 'success');
      } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
    };
    $('us-change-pass').onclick = async () => {
      const cur = $('us-cur-pass').value;
      const nw = $('us-new-pass').value;
      const cnf = $('us-confirm-pass').value;
      if (!cur || !nw) { showToast(t('fill_all_fields'), 'error'); return; }
      if (nw.length < 6) { showToast(t('password_min_6'), 'error'); return; }
      if (nw !== cnf) { showToast(t('passwords_mismatch'), 'error'); return; }
      try {
        await API.patch('/api/users/@me/password', { current_password: cur, new_password: nw });
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
          <option value="dark"  ${document.documentElement.dataset.theme === 'dark' ? 'selected' : ''}>${t('theme_dark')}</option>
          <option value="light" ${document.documentElement.dataset.theme === 'light' ? 'selected' : ''}>${t('theme_light')}</option>
          <option value="amoled"${document.documentElement.dataset.theme === 'amoled' ? 'selected' : ''}>${t('theme_amoled')}</option>
        </select>
      </div>
      <div class="form-group">
        <label>${t('font_size')}</label>
        <input type="range" id="us-fontsize" min="12" max="20" value="${parseInt(localStorage.getItem('da_fontSize') || '16')}">
        <div class="form-hint" id="us-fs-preview">${parseInt(localStorage.getItem('da_fontSize') || '16')}px</div>
      </div>
      <div class="form-group quick-react-editor">
        <label>Быстрые реакции</label>
        <div class="form-hint">Выбери эмодзи для панели реакций (до 12).</div>
        <div class="quick-react-list" id="qr-list"></div>
        <div class="quick-react-controls">
          <input id="qr-input" maxlength="8" placeholder="😀" aria-label="emoji">
          <button class="btn btn-outline" id="qr-add" type="button">Добавить</button>
          <button class="btn btn-outline" id="qr-reset" type="button">Сброс</button>
        </div>
        <div class="quick-react-preset" id="qr-preset"></div>
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

    const listEl = $('qr-list');
    const presetEl = $('qr-preset');
    const inputEl = $('qr-input');
    const MAX_QR = 12;

    function renderQuickReactionsEditor() {
      listEl.innerHTML = QUICK_EMOJIS.map((em, idx) => `
        <button class="qr-chip" data-idx="${idx}" title="Удалить">
          <span class="qr-em">${escHtml(em)}</span>
          <span class="qr-del">×</span>
        </button>
      `).join('');

      presetEl.innerHTML = EMOJI_LIST.slice(0, 24).map(em => `
        <button class="qr-preset-btn ${QUICK_EMOJIS.includes(em) ? 'active' : ''}" data-em="${escHtml(em)}">${escHtml(em)}</button>
      `).join('');

      listEl.querySelectorAll('.qr-chip').forEach(btn => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.idx);
          const next = QUICK_EMOJIS.filter((_, i) => i !== idx);
          saveQuickEmojis(next.length ? next : DEFAULT_QUICK_EMOJIS);
          renderQuickReactionsEditor();
        };
      });

      presetEl.querySelectorAll('.qr-preset-btn').forEach(btn => {
        btn.onclick = () => {
          const em = btn.dataset.em;
          const exists = QUICK_EMOJIS.includes(em);
          let next;
          if (exists) {
            next = QUICK_EMOJIS.filter(v => v !== em);
            if (!next.length) next = DEFAULT_QUICK_EMOJIS;
          } else {
            next = [...QUICK_EMOJIS, em].slice(0, MAX_QR);
          }
          saveQuickEmojis(next);
          renderQuickReactionsEditor();
        };
      });
    }

    function tryAddQuickReaction(raw) {
      const em = String(raw || '').trim();
      if (!em) return;
      if (QUICK_EMOJIS.includes(em)) {
        inputEl.value = '';
        return;
      }
      if (QUICK_EMOJIS.length >= MAX_QR) {
        showToast('Максимум 12 быстрых реакций', 'error');
        return;
      }
      saveQuickEmojis([...QUICK_EMOJIS, em]);
      inputEl.value = '';
      renderQuickReactionsEditor();
    }

    $('qr-add').onclick = () => tryAddQuickReaction(inputEl.value);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAddQuickReaction(inputEl.value);
      }
    });
    $('qr-reset').onclick = () => {
      saveQuickEmojis(DEFAULT_QUICK_EMOJIS);
      renderQuickReactionsEditor();
    };

    renderQuickReactionsEditor();
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
function userHasPermissionClient(serverId, flag) {
  const srv = getServer(serverId);
  if (!srv || !S.me) return false;
  if (srv.owner_id === S.me.id) return true; // owner bypasses all
  const allRoles = srv.roles || [];
  const myRoleIds = new Set(srv.my_roles || []);
  // Collect all roles: user-assigned + @everyone
  const myRoles = allRoles.filter(r => r.is_default || myRoleIds.has(r.id));
  for (const r of myRoles) {
    try {
      const p = JSON.parse(r.permissions || '{}');
      if (p.administrator) return true;
      if (flag && (p[flag] || p.manage_server)) return true;
    } catch { }
  }
  return false;
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
  if (lm) lm.innerHTML = `${IC.arrowUp} ${escHtml(t('load_more'))}`;

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
        if (el.dataset.page === 'profile') el.textContent = t('us_profile');
        if (el.dataset.page === 'appearance') el.textContent = t('us_appearance');
        if (el.dataset.page === 'language') el.textContent = t('us_language');
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
  $('li-btn').onclick = doLogin;
  $('reg-btn').onclick = doRegister;
  $('goto-register').onclick = () => showAuth('register');
  $('goto-login').onclick = () => showAuth('login');
  $('li-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  $('reg-pass').onkeydown = e => { if (e.key === 'Enter') doRegister(); };

  // ── Mobile sidebar toggle ────────────────────────────────────
  function openMobileSidebar() { $('app').classList.add('mobile-sidebar-open'); }
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
  $('su-av-wrapper').onclick = (e) => { e.stopPropagation(); showStatusPicker(); };
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
      const srv = await API.post('/api/guilds', { name });
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
    try { code = decodeURIComponent(code); } catch { }
    if (!code) { $('js-error').textContent = t('enter_code'); return; }
    try {
      await API.post(`/api/invites/${code}`, {});
      const inv = await API.get(`/api/invites/${code}`);
      const guildId = inv.guild?.id;
      const srv = guildId ? await API.get(`/api/guilds/${guildId}`) : null;
      if (!srv) throw new Error('Guild not found');
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
    const name = $('new-ch-name').value.trim();
    const type = $('new-ch-type').value;
    const topic = $('new-ch-topic').value.trim();
    const categoryId = $('new-ch-category-id').value || null;
    if (!name) { $('cc-error').textContent = t('enter_name'); return; }
    try {
      await API.post(`/api/guilds/${serverId}/channels`, { name, type: channelTypeToCore(type), topic, parent_id: categoryId });
      closeModal('modal-create-channel');
      // Reload server data
      const fresh = await API.get(`/api/guilds/${serverId}`);
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
  const theme = localStorage.getItem('da_theme') || 'dark';
  const fontSize = localStorage.getItem('da_fontSize') || '16';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = fontSize + 'px';

  // Handle invite in URL
  const urlParams = new URLSearchParams(location.search);
  const rawInvite = urlParams.get('invite');
  let invCode = rawInvite;
  if (rawInvite) {
    try { invCode = decodeURIComponent(rawInvite); } catch { }
  }
  if (invCode) {
    window.addEventListener('da:authenticated', async () => {
      try {
        const inv = await API.get(`/api/invites/${invCode}`);
        if (await daConfirm(t('accept_invite_question').replace('{name}', inv.guild?.name || inv.server?.name || '?'), { title: t('accept_invite_title'), confirmText: t('join') })) {
          await API.post(`/api/invites/${invCode}`, {});
          const guildId = inv.guild?.id || inv.server?.id;
          const srv = guildId ? await API.get(`/api/guilds/${guildId}`) : null;
          if (!srv) throw new Error('Guild not found');
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
      el.style.userSelect = 'text';
      // Remove injected background-image without wiping legit styles
      if (el.style.backgroundImage) el.style.backgroundImage = '';
    });
  }
  sanitizeAuthInputs();
  // Watch for extension re-injections
  const _extObserver = new MutationObserver(sanitizeAuthInputs);
  document.querySelectorAll('#auth-overlay input').forEach(el => {
    _extObserver.observe(el, { attributes: true, attributeFilter: ['readonly', 'disabled', 'style'] });
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
    } catch { }
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
NotifSound.play = function (title, body) {
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

// ─── QUICK SWITCHER (Ctrl+K) ──────────────────────────────────────────────────
let _searchDebounce = null;
let _qsSelectedIdx = 0;

function openSearchModal() {
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

    // Group by category
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
      // Search in current channel first, then globally
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

  // Tab switching
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

  // Keyboard navigation
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
      // Switch mode
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
async function openChannelSettings(channelId) {
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

// ─── NOTIFICATION SETTINGS ────────────────────────────────────────────────────
async function openNotificationSettings(guildId) {
  const overlay = document.createElement('div');
  overlay.className = 'da-dialog-overlay';
  overlay.innerHTML = `
    <div class="da-dialog-box" role="dialog" aria-modal="true">
      <div class="da-dialog-head"><h3>${IC.bell} Настройки уведомлений</h3></div>
      <div class="da-dialog-body" id="ns-body">
        <div class="empty-state"><div class="spinner"></div></div>
      </div>
      <div class="da-dialog-foot">
        <button class="btn btn-outline" id="ns-cancel">Отмена</button>
        <button class="btn btn-accent" id="ns-save">Сохранить</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#ns-cancel').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  // Load current settings
  let settings = { muted: 0, message_notifications: -1, suppress_everyone: 0, suppress_roles: 0 };
  try {
    settings = await API.get(`/api/users/@me/guilds/${guildId}/settings`);
  } catch { }

  const body = overlay.querySelector('#ns-body');
  body.innerHTML = `
    <div class="form-group">
      <label>Заглушить сервер</label>
      <input type="checkbox" id="ns-muted" ${settings.muted ? 'checked' : ''}>
    </div>
    <div class="form-group">
      <label>Уведомления о сообщениях</label>
      <select id="ns-level">
        <option value="-1" ${settings.message_notifications === -1 ? 'selected' : ''}>По умолчанию</option>
        <option value="0" ${settings.message_notifications === 0 ? 'selected' : ''}>Все сообщения</option>
        <option value="1" ${settings.message_notifications === 1 ? 'selected' : ''}>Только упоминания</option>
        <option value="2" ${settings.message_notifications === 2 ? 'selected' : ''}>Ничего</option>
      </select>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="ns-suppress-everyone" ${settings.suppress_everyone ? 'checked' : ''}> Подавлять @everyone и @here</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="ns-suppress-roles" ${settings.suppress_roles ? 'checked' : ''}> Подавлять уведомления ролей</label>
    </div>
  `;

  overlay.querySelector('#ns-save').onclick = async () => {
    try {
      await API.patch(`/api/users/@me/guilds/${guildId}/settings`, {
        muted: body.querySelector('#ns-muted').checked ? 1 : 0,
        message_notifications: parseInt(body.querySelector('#ns-level').value),
        suppress_everyone: body.querySelector('#ns-suppress-everyone').checked ? 1 : 0,
        suppress_roles: body.querySelector('#ns-suppress-roles').checked ? 1 : 0,
      });
      showToast('Настройки сохранены', 'success');
      overlay.remove();
    } catch (e) { showToast(e.body?.error || 'Ошибка', 'error'); }
  };
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
      dropOverlay.innerHTML = `<div class="drop-overlay-inner"><div class="drop-icon">${IC.upload}</div><div class="drop-text">${t('drop_files')}</div><div class="drop-sub">${t('drop_sub')}</div></div>`;
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

function initIcons() {
  // Fill data-icon attributes with SVG from IC
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (IC[name]) el.innerHTML = IC[name];
  });
  // Welcome screen empty icon
  const wIcon = $('welcome-empty-icon');
  if (wIcon) wIcon.innerHTML = IC.logo;
}

async function init() {
  setup();
  applyI18nToHtml();
  initIcons();

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
    S.me = normalizeMe(await API.get('/api/users/@me'));
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


// ═══════════════════════════════════════════════════════
// POLLS — Render & Interact
// ═══════════════════════════════════════════════════════

function renderPollHtml(msg) {
  const poll = msg.poll;
  if (!poll) return '';
  const expired = poll.expiry && poll.expiry < Math.floor(Date.now() / 1000);
  const totalVotes = poll.answers.reduce((s, a) => s + (a.count || 0), 0);
  const answersHtml = poll.answers.map(a => {
    const pct = totalVotes > 0 ? Math.round(((a.count || 0) / totalVotes) * 100) : 0;
    return `
      <div class="poll-answer ${a.me ? 'poll-voted' : ''} ${expired ? 'poll-expired' : ''}"
           data-msg-id="${escHtml(msg.id)}" data-answer-id="${a.id}" data-ch-id="${escHtml(msg.channel_id)}">
        <div class="poll-answer-bar" style="width:${pct}%"></div>
        <span class="poll-answer-text">${a.emoji ? escHtml(a.emoji) + ' ' : ''}${escHtml(a.text || '')}</span>
        <span class="poll-answer-count">${a.count || 0} (${pct}%)</span>
      </div>
    `;
  }).join('');

  const expiryText = expired ? '✅ Голосование завершено' :
    (poll.expiry ? `⏱ Завершится ${fmtTime(poll.expiry * 1000)}` : '');

  return `
    <div class="poll-container" data-msg-id="${escHtml(msg.id)}">
      <div class="poll-question">${IC.poll || '📊'} ${escHtml(poll.question)}</div>
      <div class="poll-answers">${answersHtml}</div>
      <div class="poll-footer">
        <span class="poll-total">${totalVotes} голос${totalVotes === 1 ? '' : totalVotes > 1 && totalVotes < 5 ? 'а' : 'ов'}</span>
        <span class="poll-expiry">${expiryText}</span>
      </div>
    </div>
  `;
}

// Attach poll vote handlers (called within attachMsgHandlers)
function attachPollHandlers(container) {
  container.querySelectorAll('.poll-answer:not(.poll-expired)').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const msgId = el.dataset.msgId;
      const answerId = el.dataset.answerId;
      const chId = el.dataset.chId;
      const isVoted = el.classList.contains('poll-voted');
      try {
        if (isVoted) {
          await API.del(`/api/channels/${chId}/polls/${msgId}/answers/${answerId}/@me`);
        } else {
          await API.put(`/api/channels/${chId}/polls/${msgId}/answers/${answerId}/@me`);
        }
      } catch (err) {
        showToast(err.body?.error || 'Ошибка голосования', 'error');
      }
    };
  });
}

// ═══════════════════════════════════════════════════════
// POLLS — Creation
// ═══════════════════════════════════════════════════════

let _pollAnswers = [];

function openPollCreator() {
  _pollAnswers = ['', ''];
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-create-poll';
  modal.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-header">
        <h3>📊 Создать опрос</h3>
        <button class="modal-close" id="poll-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Вопрос</label>
          <input id="poll-question" type="text" placeholder="Задайте вопрос..." maxlength="300">
        </div>
        <div class="form-group">
          <label>Варианты ответов</label>
          <div id="poll-answers-list"></div>
          <button class="btn btn-outline" id="poll-add-answer" style="margin-top:8px">+ Добавить вариант</button>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="poll-multiselect">
          <label for="poll-multiselect" style="margin:0">Множественный выбор</label>
        </div>
        <div class="form-group">
          <label>Длительность (часы)</label>
          <input id="poll-duration" type="number" value="24" min="1" max="720" style="width:100px">
        </div>
        <div class="auth-error" id="poll-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="poll-cancel">Отмена</button>
        <button class="btn btn-primary" id="poll-submit">Создать опрос</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderPollAnswerInputs();

  $('poll-modal-close').onclick = () => modal.remove();
  $('poll-cancel').onclick = () => modal.remove();
  $('poll-add-answer').onclick = () => {
    if (_pollAnswers.length >= 10) return;
    _pollAnswers.push('');
    renderPollAnswerInputs();
  };

  $('poll-submit').onclick = async () => {
    const question = $('poll-question').value.trim();
    if (!question) { $('poll-error').textContent = 'Введите вопрос'; return; }
    const answers = _pollAnswers.map(a => a.trim()).filter(a => a);
    if (answers.length < 2) { $('poll-error').textContent = 'Минимум 2 варианта'; return; }
    const multiselect = $('poll-multiselect').checked;
    const duration = parseInt($('poll-duration').value) || 24;

    try {
      await API.post(`/api/channels/${S.activeChannelId}/messages`, {
        content: '',
        poll: {
          question,
          answers: answers.map((text, i) => ({ id: i + 1, text })),
          allow_multiselect: multiselect,
          duration_hours: duration,
        },
      });
      modal.remove();
    } catch (err) {
      $('poll-error').textContent = err.body?.error || 'Ошибка создания опроса';
    }
  };

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function renderPollAnswerInputs() {
  const list = $('poll-answers-list');
  if (!list) return;
  list.innerHTML = _pollAnswers.map((val, i) => `
    <div class="poll-answer-input" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <input type="text" class="poll-answer-field" data-idx="${i}" value="${escHtml(val)}" placeholder="Вариант ${i + 1}" maxlength="55" style="flex:1">
      ${_pollAnswers.length > 2 ? `<button class="btn-icon-sm poll-remove-answer" data-idx="${i}" title="Удалить">✕</button>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.poll-answer-field').forEach(inp => {
    inp.oninput = () => { _pollAnswers[parseInt(inp.dataset.idx)] = inp.value; };
  });
  list.querySelectorAll('.poll-remove-answer').forEach(btn => {
    btn.onclick = () => {
      _pollAnswers.splice(parseInt(btn.dataset.idx), 1);
      renderPollAnswerInputs();
    };
  });
}

// ═══════════════════════════════════════════════════════
// THREADS — Create from message
// ═══════════════════════════════════════════════════════

async function createThread(channelId, messageId) {
  const name = await daPrompt('Название ветки', { title: 'Создать ветку', placeholder: 'Новая ветка', confirmText: 'Создать' });
  if (!name) return;
  try {
    const thread = await API.post(`/api/v1/channels/${channelId}/messages/${messageId}/threads`, { name: name.trim() });
    showToast('Ветка создана!', 'success');
    // Switch to thread channel
    if (thread && thread.id) {
      const srv = getServer(S.activeServerId);
      if (srv) {
        if (!srv.channels.find(c => c.id === thread.id)) {
          srv.channels.push({
            id: thread.id, name: thread.name || name, type: 'text',
            server_id: srv.id, guild_id: srv.id, category_id: null, parent_id: channelId, position: 999
          });
        }
        renderChannelList();
        selectChannel(thread.id);
      }
    }
  } catch (err) {
    showToast(err.body?.error || 'Ошибка создания ветки', 'error');
  }
}

// ═══════════════════════════════════════════════════════
// SCHEDULED EVENTS — UI
// ═══════════════════════════════════════════════════════

async function showEventsPanel() {
  if (!S.activeServerId || S.activeServerId === '@me') return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-events';
  modal.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <h3>📅 События</h3>
        <button class="modal-close" data-close-events>✕</button>
      </div>
      <div class="modal-body" id="events-list" style="min-height:100px">
        <div class="text-muted" style="text-align:center;padding:20px">Загрузка...</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="btn-create-event">+ Создать событие</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('[data-close-events]').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  try {
    const events = await API.get(`/api/guilds/${S.activeServerId}/scheduled-events`);
    const list = $('events-list');
    if (!events.length) {
      list.innerHTML = '<div class="text-muted" style="text-align:center;padding:20px">Нет запланированных событий</div>';
    } else {
      list.innerHTML = events.map(ev => `
        <div class="event-card" data-event-id="${escHtml(ev.id)}">
          <div class="event-name">${escHtml(ev.name)}</div>
          <div class="event-time text-muted">${fmtTime(ev.scheduled_start_time * 1000)}${ev.scheduled_end_time ? ' — ' + fmtTime(ev.scheduled_end_time * 1000) : ''}</div>
          ${ev.description ? `<div class="event-desc text-muted">${escHtml(ev.description)}</div>` : ''}
          <div class="event-footer">
            <span class="event-users">${ev.user_count || 0} участников</span>
            <button class="btn btn-outline btn-sm event-rsvp" data-event-id="${escHtml(ev.id)}">Участвовать</button>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.event-rsvp').forEach(btn => {
        btn.onclick = async () => {
          try {
            await API.put(`/api/guilds/${S.activeServerId}/scheduled-events/${btn.dataset.eventId}/users/@me`);
            showToast('Вы записались!', 'success');
            btn.textContent = '✓ Записан';
            btn.disabled = true;
          } catch (err) {
            showToast(err.body?.error || 'Ошибка', 'error');
          }
        };
      });
    }
  } catch (err) {
    $('events-list').innerHTML = '<div class="text-muted" style="text-align:center;padding:20px">Ошибка загрузки событий</div>';
  }

  $('btn-create-event').onclick = () => { modal.remove(); openCreateEventModal(); };
}

async function openCreateEventModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-create-event';
  modal.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-header">
        <h3>Создать событие</h3>
        <button class="modal-close" id="event-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Название</label>
          <input id="event-name" type="text" placeholder="Название события" maxlength="100">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <textarea id="event-desc" rows="3" placeholder="Описание (необязательно)" maxlength="1000" style="width:100%;resize:vertical"></textarea>
        </div>
        <div class="form-group">
          <label>Дата и время начала</label>
          <input id="event-start" type="datetime-local">
        </div>
        <div class="form-group">
          <label>Дата и время окончания (необязательно)</label>
          <input id="event-end" type="datetime-local">
        </div>
        <div class="auth-error" id="event-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="event-cancel">Отмена</button>
        <button class="btn btn-primary" id="event-submit">Создать</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  $('event-modal-close').onclick = () => modal.remove();
  $('event-cancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  $('event-submit').onclick = async () => {
    const name = $('event-name').value.trim();
    const start = $('event-start').value;
    if (!name) { $('event-error').textContent = 'Введите название'; return; }
    if (!start) { $('event-error').textContent = 'Выберите время начала'; return; }

    const startTs = Math.floor(new Date(start).getTime() / 1000);
    const endVal = $('event-end').value;
    const endTs = endVal ? Math.floor(new Date(endVal).getTime() / 1000) : null;

    try {
      await API.post(`/api/guilds/${S.activeServerId}/scheduled-events`, {
        name,
        description: $('event-desc').value.trim() || null,
        entity_type: 3, // External
        scheduled_start_time: startTs,
        scheduled_end_time: endTs,
      });
      modal.remove();
      showToast('Событие создано!', 'success');
    } catch (err) {
      $('event-error').textContent = err.body?.error || 'Ошибка';
    }
  };
}

// ═══════════════════════════════════════════════════════
// WEBHOOKS — Management UI
// ═══════════════════════════════════════════════════════

async function showWebhooksPanel(channelId) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-webhooks';
  modal.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <h3>🔗 Вебхуки</h3>
        <button class="modal-close" id="wh-close">✕</button>
      </div>
      <div class="modal-body" id="wh-list" style="min-height:80px">
        <div class="text-muted" style="text-align:center;padding:20px">Загрузка...</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="btn-create-wh">+ Создать вебхук</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  $('wh-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  async function loadWebhooks() {
    try {
      const webhooks = await API.get(`/api/channels/${channelId}/webhooks`);
      const list = $('wh-list');
      if (!webhooks.length) {
        list.innerHTML = '<div class="text-muted" style="text-align:center;padding:20px">Нет вебхуков</div>';
      } else {
        list.innerHTML = webhooks.map(wh => `
          <div class="wh-card" style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:600">${escHtml(wh.name || 'Webhook')}</div>
              <div class="text-muted" style="font-size:11px;word-break:break-all">${escHtml(location.origin)}/api/webhooks/${escHtml(wh.id)}/${escHtml(wh.token)}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-outline btn-sm wh-copy" data-url="${escHtml(location.origin)}/api/webhooks/${escHtml(wh.id)}/${escHtml(wh.token)}">📋</button>
              <button class="btn btn-outline btn-sm danger wh-del" data-id="${escHtml(wh.id)}">🗑</button>
            </div>
          </div>
        `).join('');

        list.querySelectorAll('.wh-copy').forEach(btn => {
          btn.onclick = () => { navigator.clipboard.writeText(btn.dataset.url); showToast('URL скопирован!'); };
        });
        list.querySelectorAll('.wh-del').forEach(btn => {
          btn.onclick = async () => {
            try { await API.del(`/api/webhooks/${btn.dataset.id}`); loadWebhooks(); }
            catch (err) { showToast(err.body?.error || 'Ошибка', 'error'); }
          };
        });
      }
    } catch { $('wh-list').innerHTML = '<div class="text-muted" style="text-align:center;padding:20px">Ошибка загрузки</div>'; }
  }

  loadWebhooks();

  $('btn-create-wh').onclick = async () => {
    const name = await daPrompt('Название вебхука', { title: 'Создать вебхук', placeholder: 'Мой вебхук', confirmText: 'Создать' });
    if (!name) return;
    try {
      await API.post(`/api/channels/${channelId}/webhooks`, { name: name.trim() });
      loadWebhooks();
    } catch (err) { showToast(err.body?.error || 'Ошибка', 'error'); }
  };
}

// ═══════════════════════════════════════════════════════
// Socket handlers for polls
// ═══════════════════════════════════════════════════════

function handlePollSocketEvents() {
  if (!socket) return;
  socket.on('poll:vote_add', (data) => updatePollInMessage(data));
  socket.on('poll:vote_remove', (data) => updatePollInMessage(data));
}

function updatePollInMessage(data) {
  const { message_id, poll } = data;
  // Update data model
  for (const [chId, msgs] of Object.entries(S.messages)) {
    const msg = msgs.find(m => m.id === message_id);
    if (msg) {
      msg.poll = poll;
      break;
    }
  }
  // Re-render poll in DOM
  const pollContainer = document.querySelector(`.poll-container[data-msg-id="${message_id}"]`);
  if (pollContainer) {
    const msg = { id: message_id, channel_id: S.activeChannelId, poll };
    pollContainer.outerHTML = renderPollHtml(msg);
    const parent = $('messages-container');
    if (parent) attachPollHandlers(parent);
  }
}

init();
