import {
  escHtml, fmtTime, fmtDatetime, daConfirm, daPrompt, showToast,
  parseMarkdown, avatarEl, clamp,
  getServerMember, displayNameFor, statusDotHtml, getServer, getChannel, normalizeMe, normalizeServer
} from './src/utils.js';
import { S, V } from './src/state.js';
import { connectGateway, sendTyping, socket } from './src/gateway.js';
import { API, sendMessage as sendMessageRequest, createInvite, leaveServer, deleteServer, createCategory, loadFriendCount, toggleReaction, uploadAndSend, confirmDeleteMessage } from './src/api_requests.js';
import * as VoiceClient from './voice.js';
import { showAuth, hideAuth, doLogin, doRegister, doMfaLogin, cancelMfaLogin, doLogout } from './src/auth.js';
import { LANG_NAMES, getLang, setLang, t, closeTopDialog } from './src/utils.js';
import { IC } from './src/icons.js';
import { renderServerSettingsPage, openRoleEditor, openServerSettings, openUserSettings, renderUserSettingsPage, openNotificationSettings } from './src/settings.js';
import { openCreateChannelModal, openAddServerModal, showNewDmModal, showNicknameModal, closeModal, openSearchModal, showPins, showProfileCard, closeProfileCard, openLightbox } from './src/modals.js';
import { closeContextMenu, showContextMenu } from './src/context_menus.js';
import { renderPollHtml, attachPollHandlers, openPollCreator, renderPollAnswerInputs, createThread, handlePollSocketEvents, updatePollInMessage } from './src/features.js';
import {
  renderServerIcons, selectServer, renderChannelList, selectChannel,
  userHasPermissionClient, applyI18nToHtml, renderMessages, showWelcomeScreen, loadMessages, saveDraft,
  renderMembersPanel, showFriendsView, renderVoicePanel, renderVoiceBar, requestOlderMessages,
  renderTyping
} from './src/ui.js';

const $ = id => document.getElementById(id);
let sendingMessage = false;
const COMPOSER_EMOJIS = ['😀', '😂', '😍', '😎', '🥺', '😭', '😡', '🤔', '🙏', '👍', '👎', '❤️', '🔥', '✅', '❌', '⭐', '🎉', '🚀'];

async function sendMessage() {
  const input = $('msg-input');
  const channelId = S.activeChannelId;
  const content = input?.value.trim();
  if (!input || !content || !channelId || sendingMessage) return;
  sendingMessage = true;
  try {
    await sendMessageRequest(content, S.replyTo?.id);
    if (S.activeChannelId === channelId && input.value.trim() === content) {
      input.value = '';
      input.style.height = 'auto';
      saveDraft(channelId, '');
      S.replyTo = null;
      document.getElementById('reply-bar')?.classList.remove('visible');
    }
  } catch { }
  finally {
    sendingMessage = false;
  }
}

// Expose globally for API / DOM onclicks
window.S = S;
window.V = V;
window.IC = IC;
window.t = t;
window.escHtml = escHtml;
window.fmtTime = fmtTime;
window.fmtDatetime = fmtDatetime;
window.daConfirm = daConfirm;
window.daPrompt = daPrompt;
window.showToast = showToast;
window.parseMarkdown = parseMarkdown;
window.avatarEl = avatarEl;
window.getServerMember = getServerMember;
window.displayNameFor = displayNameFor;
window.statusDotHtml = statusDotHtml;
window.getServer = getServer;
window.getChannel = getChannel;

window.connectGateway = connectGateway;
window.sendTyping = sendTyping;
window.renderTyping = renderTyping;

window.API = API;
window.createInvite = createInvite;
window.leaveServer = leaveServer;
window.deleteServer = deleteServer;
window.createCategory = createCategory;
window.showPins = showPins;
window.loadFriendCount = loadFriendCount;
window.joinVoiceChannel = VoiceClient.joinVoiceChannel;
window.leaveVoiceChannel = VoiceClient.leaveVoiceChannel;

window.showAuth = showAuth;
window.hideAuth = hideAuth;
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doMfaLogin = doMfaLogin;
window.cancelMfaLogin = cancelMfaLogin;
window.doLogout = doLogout;
window.normalizeMe = normalizeMe;

window.LANG_NAMES = LANG_NAMES;
window.getLang = getLang;
window.setLang = setLang;

window.renderServerSettingsPage = renderServerSettingsPage;
window.openRoleEditor = openRoleEditor;
window.openServerSettings = openServerSettings;
window.openUserSettings = openUserSettings;
window.renderUserSettingsPage = renderUserSettingsPage;
window.applyI18nToHtml = applyI18nToHtml;

window.openCreateChannelModal = openCreateChannelModal;
window.openAddServerModal = openAddServerModal;
window.showNewDmModal = showNewDmModal;
window.showNicknameModal = showNicknameModal;
window.closeModal = closeModal;
window.openSearchModal = openSearchModal;

window.closeContextMenu = closeContextMenu;

window.renderPollHtml = renderPollHtml;
window.attachPollHandlers = attachPollHandlers;
window.openPollCreator = openPollCreator;
window.renderPollAnswerInputs = renderPollAnswerInputs;
window.createThread = createThread;

window.renderServerIcons = renderServerIcons;
window.selectServer = selectServer;
window.renderChannelList = renderChannelList;
window.selectChannel = selectChannel;
window.userHasPermissionClient = userHasPermissionClient;
window.renderMessages = renderMessages;
window.showWelcomeScreen = showWelcomeScreen;
window.loadMessages = loadMessages;
window.sendMessage = sendMessage;
window.toggleReaction = toggleReaction;
window.uploadAndSend = uploadAndSend;
window.confirmDeleteMessage = confirmDeleteMessage;
window.renderMembersPanel = renderMembersPanel;
window.showProfileCard = showProfileCard;
window.closeProfileCard = closeProfileCard;
window.showFriendsView = showFriendsView;
window.renderVoicePanel = renderVoicePanel;
window.renderVoiceBar = renderVoiceBar;
window.__voiceDebug = () => VoiceClient.debugState();

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
window.NotifSound = NotifSound;

// Override notification sound to also send native notification in Tauri
const _origNotifPlay = NotifSound.play.bind(NotifSound);
NotifSound.playCount = 0;
NotifSound.play = function(title, body) {
  NotifSound.playCount++;
  _origNotifPlay();
  if (IS_TAURI && document.hidden) {
    tauriNotify(title || 'Discord Alt', body || t('new_message'));
  }
};

if (IS_TAURI) document.body.classList.add('is-tauri');

function closeQuickReact() {
  document.querySelector('.quick-react-popup')?.remove();
}

function showQuickReact(target, msgId) {
  closeQuickReact();
  if (!S.activeChannelId) return;
  const popup = document.createElement('div');
  popup.className = 'quick-react-popup';
  popup.setAttribute('role', 'menu');
  popup.setAttribute('aria-label', t('react'));
  for (const emoji of COMPOSER_EMOJIS.slice(0, 6)) {
    const button = document.createElement('button');
    button.className = 'quick-react-btn';
    button.type = 'button';
    button.textContent = emoji;
    button.setAttribute('aria-label', `${t('react')} ${emoji}`);
    button.addEventListener('click', async () => {
      closeQuickReact();
      await toggleReaction(msgId, emoji);
    });
    popup.appendChild(button);
  }
  const rect = target.getBoundingClientRect();
  document.body.appendChild(popup);
  const left = Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8));
  const top = Math.max(8, rect.top - popup.offsetHeight - 8);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.querySelector('button')?.focus();
}

function toggleComposerEmojiPicker() {
  const picker = $('emoji-picker');
  if (!picker) return;
  const isHidden = picker.classList.contains('hidden');
  picker.classList.toggle('hidden', !isHidden);
  if (!isHidden) return;
  picker.replaceChildren();
  picker.setAttribute('role', 'menu');
  picker.setAttribute('aria-label', t('react'));
  for (const emoji of COMPOSER_EMOJIS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.setAttribute('aria-label', emoji);
    button.addEventListener('click', () => {
      const input = $('msg-input');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      picker.classList.add('hidden');
      input.focus();
    });
    picker.appendChild(button);
  }
  picker.querySelector('button')?.focus();
}

function closeStatusPicker() {
  document.querySelector('.status-picker')?.remove();
}

function showStatusPicker(anchor) {
  closeStatusPicker();
  if (!socket) {
    showToast('Статус будет доступен после подключения', 'error');
    return;
  }
  const picker = document.createElement('div');
  picker.className = 'status-picker';
  picker.setAttribute('role', 'menu');
  picker.setAttribute('aria-label', 'Статус');
  const current = localStorage.getItem('da_status') || 'online';
  const statuses = [
    ['online', 'В сети'],
    ['idle', 'Неактивен'],
    ['dnd', 'Не беспокоить'],
    ['invisible', 'Невидимый'],
  ];
  for (const [value, label] of statuses) {
    const button = document.createElement('button');
    button.className = `sp-item${current === value ? ' active' : ''}`;
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(current === value));
    button.textContent = label;
    button.addEventListener('click', () => {
      localStorage.setItem('da_status', value);
      socket.emit('UPDATE_STATUS', { status: value, custom_status: S.me?.custom_status || '' });
      if (S.me) S.me.status = value;
      if (S.me?.id) S.presences[S.me.id] = { status: value, custom_status: S.me.custom_status || '' };
      closeStatusPicker();
    });
    picker.appendChild(button);
  }
  const custom = document.createElement('input');
  custom.className = 'sp-custom-input';
  custom.type = 'text';
  custom.maxLength = 190;
  custom.value = S.me?.custom_status || '';
  custom.placeholder = 'Пользовательский статус';
  custom.setAttribute('aria-label', custom.placeholder);
  custom.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    socket.emit('UPDATE_STATUS', { status: current, custom_status: custom.value.trim() });
    if (S.me) S.me.custom_status = custom.value.trim();
    if (S.me?.id) S.presences[S.me.id] = { status: current, custom_status: custom.value.trim() };
    document.getElementById('su-custom-status').textContent = S.me?.custom_status || '';
    closeStatusPicker();
  });
  picker.appendChild(custom);
  document.body.appendChild(picker);
  const rect = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${Math.max(8, rect.top - picker.offsetHeight - 8)}px`;
  picker.querySelector('button')?.focus();
}


export async function bootApp() {
  $('app').classList.remove('hidden');
  try { S.servers = (await API.get('/api/guilds/@me')).map(normalizeServer); } catch { S.servers = []; }
  try { S.dmChannels = await API.get('/api/users/@me/channels'); } catch { S.dmChannels = []; }
  renderServerIcons();
  // don't clobber a server/channel selected while bootstrapping
  if (!S.activeServerId || S.activeServerId === '@me') {
    await selectServer('@me');
  }

  // Load friends in BG
  loadFriendCount();

  connectGateway();
}

function showServerDropdown() {
  const srv = getServer(S.activeServerId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  const dd = $('server-dropdown');
  dd.innerHTML = `
    <div class="sm-item" id="sm-invite">📋 ${t('invite_people')}</div>
    <div class="sm-item" id="sm-notifications">${IC.bell} ${t('ctx_notifications')}</div>
    <div class="sm-item" id="sm-settings">⚙ ${t('server_settings')}</div>
    <div class="sm-item" id="sm-create-ch">＋ ${t('create_channel')}</div>
    <div class="sm-item" id="sm-create-cat">📁 ${t('create_category')}</div>
    <div class="sm-divider"></div>
    ${isOwner
      ? `<div class="sm-item danger" id="sm-delete">🗑 ${t('delete_server')}</div>`
      : `<div class="sm-item danger" id="sm-leave">${IC.leave} ${t('leave_server')}</div>`}
  `;
  dd.classList.remove('hidden');

  const closeDD = () => { hideServerDropdown(); document.removeEventListener('click', closeDD); };
  const item = (id, fn) => { const el = $(id); if (el) el.onclick = e => { e.stopPropagation(); closeDD(); fn(); }; };
  item('sm-invite', () => createInvite(srv.id));
  item('sm-notifications', () => openNotificationSettings(srv.id));
  item('sm-settings', () => openServerSettings(srv.id));
  item('sm-create-ch', () => openCreateChannelModal(srv.id));
  item('sm-create-cat', () => createCategory(srv.id));
  item('sm-delete', () => deleteServer(srv.id));
  item('sm-leave', () => leaveServer(srv.id));
  setTimeout(() => document.addEventListener('click', closeDD), 0);
}

function hideServerDropdown() {
  $('server-dropdown')?.classList.add('hidden');
}

function setupDOMEventListeners() {
  $('li-btn').onclick = doLogin;
  $('reg-btn').onclick = doRegister;
  $('mfa-btn').onclick = doMfaLogin;
  $('mfa-back').onclick = cancelMfaLogin;
  $('goto-register').onclick = () => showAuth('register');
  $('goto-login').onclick = () => showAuth('login');
  $('li-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  $('reg-pass').onkeydown = e => { if (e.key === 'Enter') doRegister(); };
  $('mfa-code').onkeydown = e => { if (e.key === 'Enter') doMfaLogin(); };

  let mobileSidebarTrigger = null;
  let mobileMembersTrigger = null;
  const mobileDrawer = $('mobile-drawer');
  const mobileFocusable = 'button:not([disabled]), [role="button"], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  const isMobileViewport = () => window.matchMedia?.('(max-width: 768px)').matches;
  function openMobileSidebar() {
    mobileSidebarTrigger = document.activeElement;
    $('app').classList.add('mobile-sidebar-open');
    requestAnimationFrame(() => mobileDrawer?.querySelector(mobileFocusable)?.focus());
  }
  function closeMobileSidebar() {
    $('app').classList.remove('mobile-sidebar-open');
    const trigger = mobileSidebarTrigger;
    mobileSidebarTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  }
  function openMobileMembers() {
    if (S.activeServerId === '@me') return;
    mobileMembersTrigger = document.activeElement;
    const panel = $('members-panel');
    panel?.classList.remove('hidden');
    $('app').classList.add('mobile-members-open');
    renderMembersPanel();
    requestAnimationFrame(() => panel?.querySelector(mobileFocusable)?.focus());
  }
  function closeMobileMembers() {
    $('app').classList.remove('mobile-members-open');
    $('members-panel')?.classList.add('hidden');
    const trigger = mobileMembersTrigger;
    mobileMembersTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  }
  $('btn-mobile-menu').onclick = openMobileSidebar;
  $('mobile-sidebar-overlay').onclick = () => { closeMobileMembers(); closeMobileSidebar(); };
  $('welcome-open-menu').onclick = openMobileSidebar;
  mobileDrawer?.addEventListener('keydown', e => {
    if (!$('app').classList.contains('mobile-sidebar-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMobileSidebar(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...mobileDrawer.querySelectorAll(mobileFocusable)].filter(el => el.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('da:channel-selected', closeMobileSidebar);

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

  $('btn-home').onclick = () => selectServer('@me');
  $('btn-home').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectServer('@me'); } };
  $('btn-add-server').onclick = openAddServerModal;
  $('sidebar-header').onclick = () => {
    if (S.activeServerId !== '@me') {
      if ($('server-dropdown').classList.contains('hidden')) showServerDropdown();
      else hideServerDropdown();
    }
  };

  $('btn-members').onclick = () => {
    if (isMobileViewport()) {
      if ($('app').classList.contains('mobile-members-open')) closeMobileMembers();
      else openMobileMembers();
      return;
    }
    S.membersVisible = !S.membersVisible;
    const panel = $('members-panel');
    if (S.membersVisible && S.activeServerId !== '@me') {
      panel.classList.remove('hidden');
      renderMembersPanel();
    } else {
      panel.classList.add('hidden');
    }
  };

  $('btn-pins').onclick = showPins;
  $('btn-search').onclick = openSearchModal;

  const input = $('msg-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    else sendTyping();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
    saveDraft(S.activeChannelId, input.value);
  });

  document.addEventListener('da:load-messages', e => loadMessages(e.detail.channelId));
  document.addEventListener('da:show-context-menu', e => showContextMenu(e.detail.event, e.detail.type, e.detail.data));
  document.addEventListener('da:close-context-menu', closeContextMenu);
  document.addEventListener('da:open-create-channel', e => openCreateChannelModal(e.detail.serverId, e.detail.categoryId));
  document.addEventListener('da:show-new-dm', showNewDmModal);
  document.addEventListener('da:show-profile', e => showProfileCard(e.detail.userId, e.detail.anchor));
  document.addEventListener('da:confirm-delete-message', e => confirmDeleteMessage(e.detail.msgId));
  document.addEventListener('da:toggle-reaction', e => toggleReaction(e.detail.msgId, e.detail.emoji));
  document.addEventListener('da:show-quick-react', e => showQuickReact(e.detail.target, e.detail.msgId));
  document.addEventListener('da:open-lightbox', e => openLightbox(e.detail.src));
  document.addEventListener('da:show-status-picker', () => showStatusPicker($('su-av-wrapper')));
  document.addEventListener('da:create-thread', e => createThread(e.detail.channelId, e.detail.messageId));
  document.addEventListener('da:toggle-poll-vote', async e => {
    const { channelId, msgId, answerId, isVoted } = e.detail;
    try {
      if (isVoted) await API.del(`/api/channels/${channelId}/polls/${msgId}/answers/${answerId}/@me`);
      else await API.put(`/api/channels/${channelId}/polls/${msgId}/answers/${answerId}/@me`);
    } catch (error) {
      showToast(error.body?.error || 'Ошибка голосования', 'error');
    }
  });
  document.addEventListener('da:open-server-settings', e => openServerSettings(e.detail.serverId));
  document.addEventListener('da:leave-server', e => leaveServer(e.detail.serverId));
  document.addEventListener('da:delete-server', e => deleteServer(e.detail.serverId));

  document.addEventListener('da:join-voice', e => void VoiceClient.joinVoiceChannel(e.detail.channelId));
  document.addEventListener('da:leave-voice', () => void VoiceClient.leaveVoiceChannel());
  document.addEventListener('da:toggle-mute', () => void VoiceClient.toggleMute());
  document.addEventListener('da:toggle-deafen', () => void VoiceClient.toggleDeafen());
  document.addEventListener('da:toggle-screen', () => void VoiceClient.toggleScreenShare());

  $('btn-attach').onclick = () => $('file-input').click();
  $('btn-poll').onclick = event => {
    event.stopPropagation();
    openPollCreator();
  };
  $('btn-emoji').onclick = event => {
    event.stopPropagation();
    toggleComposerEmojiPicker();
  };
  $('file-input').onchange = e => {
    for (const f of e.target.files) uploadAndSend(f);
    $('file-input').value = '';
  };

  $('reply-close').onclick = () => {
    S.replyTo = null;
    $('reply-bar').classList.remove('visible');
  };
  $('btn-toggle-mute').onclick = () => document.dispatchEvent(new CustomEvent('da:toggle-mute'));

  $('btn-settings').onclick = () => openUserSettings('profile');
  $('su-av-wrapper').onclick = e => { e.stopPropagation(); document.dispatchEvent(new Event('da:show-status-picker')); };
  $('su-info-click').onclick = () => openUserSettings('profile');

  $('ss-close').onclick = () => $('server-settings').classList.add('hidden');
  $('us-close').onclick = () => $('user-settings').classList.add('hidden');
  $('us-logout').onclick = doLogout;

  $('messages-load-more').onclick = () => requestOlderMessages();
  $('messages-wrapper').addEventListener('scroll', e => {
    const btn = $('messages-load-more');
    if (e.target.scrollTop < 100 && btn && !btn.classList.contains('hidden') && !btn.disabled) btn.click();
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.onclick = () => closeModal(btn.dataset.close);
  });

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
      S.servers.push(normalizeServer(srv));
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
      showToast(t('server_created').replace('{name}', name), 'success');
    } catch (e) { $('cs-error').textContent = e.body?.error || t('error_generic'); }
  };
  $('btn-confirm-join-server').onclick = async () => {
    $('js-error').textContent = '';
    let code = $('join-invite-input').value.trim();
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
      if (!S.servers.find(s => s.id === srv.id)) S.servers.push(normalizeServer(srv));
      closeModal('modal-add-server');
      renderServerIcons();
      await selectServer(srv.id);
    } catch (e) { $('js-error').textContent = e.body?.error || t('error_generic'); }
  };

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
      const typeMap = { text: 0, voice: 2, announcement: 5, stage: 13, forum: 15 };
      const typeNum = typeMap[type] ?? 0;
      await API.post(`/api/guilds/${serverId}/channels`, { name, type: typeNum, topic, parent_id: categoryId });
      closeModal('modal-create-channel');
      const fresh = await API.get(`/api/guilds/${serverId}`);
      const idx = S.servers.findIndex(s => s.id === serverId);
      if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...fresh };
      renderChannelList();
    } catch (e) { $('cc-error').textContent = e.body?.error || t('error_generic'); }
  };

  document.addEventListener('click', () => {
    closeContextMenu();
    closeQuickReact();
    closeStatusPicker();
    $('emoji-picker')?.classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (closeTopDialog()) return;
      if ($('app').classList.contains('mobile-sidebar-open')) { closeMobileSidebar(); return; }
      if ($('app').classList.contains('mobile-members-open')) { closeMobileMembers(); return; }
      closeContextMenu();
      closeQuickReact();
      closeStatusPicker();
      $('emoji-picker')?.classList.add('hidden');
      $('server-settings').classList.add('hidden');
      $('user-settings').classList.add('hidden');
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearchModal();
    }
  });

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
          if (!S.servers.find(s => s.id === srv.id)) S.servers.push(normalizeServer(srv));
          renderServerIcons();
          selectServer(srv.id);
        }
      } catch (e) { showToast(t('invalid_invite'), 'error'); }
    }, { once: true });
  }

  window.addEventListener('da:logout', doLogout);

  function sanitizeAuthInputs() {
    document.querySelectorAll('#auth-overlay input').forEach(el => {
      el.removeAttribute('readonly');
      el.removeAttribute('disabled');
      el.style.pointerEvents = 'auto';
      el.style.userSelect = 'text';
      if (el.style.backgroundImage) el.style.backgroundImage = '';
    });
  }
  sanitizeAuthInputs();
  const _extObserver = new MutationObserver(sanitizeAuthInputs);
  document.querySelectorAll('#auth-overlay input').forEach(el => {
    _extObserver.observe(el, { attributes: true, attributeFilter: ['readonly', 'disabled', 'style'] });
  });

}


function hideSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 320);
}

async function init() {
  setupDOMEventListeners();
  applyI18nToHtml();

  if (!window.io) {
    const script = document.createElement('script');
    script.src = `${API.getServerUrl()}/socket.io/socket.io.js`;
    document.head.appendChild(script);
    await new Promise(res => script.onload = res);
  }

  const token = API.getToken();
  if (!token) {
    hideSplash();
    showAuth('login');
    return;
  }

  try {
    S.me = normalizeMe(await API.get('/api/users/@me'));
    hideSplash();
    window.dispatchEvent(new CustomEvent('da:authenticated'));
    await bootApp();
  } catch {
    API.clearTokens();
    hideSplash();
    showAuth('login');
  }
}

init();
