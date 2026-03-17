// SVG ICON SYSTEM
const _ic = (d, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;
const _f = (d, s) => _ic(`<path d="${d}" fill="currentColor"/>`, s);
const _s = (d, s) => _ic(`<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`, s);

export const IC = {
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
