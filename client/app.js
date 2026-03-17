import {
  S, V, IC,
  escHtml, fmtTime, fmtDatetime, daConfirm, daPrompt, showToast,
  parseMarkdown, avatarEl, clamp,
  getServerMember, displayNameFor, statusDotHtml, updateSidebarUser, getServer, getChannel,
  checkUnreads
} from './src/utils.js';
import { connectGateway, sendTyping, socket } from './src/gateway.js';
import { API, createInvite, leaveServer, deleteServer, createCategory, showPins, loadFriendCount, joinVoiceChannel, leaveVoiceChannel, toggleVoiceMute, toggleVoiceDeafen, startScreenShare, stopScreenShare, bindVoiceScreenVideos } from './src/api_requests.js';
import { showAuth, hideAuth, doLogin, doRegister, doLogout, normalizeMe } from './src/auth.js';
import { 
  QUICK_EMOJIS, EMOJI_LIST, saveQuickEmojis, setupEmojiPicker, 
  LANG_NAMES, getLang, setLang, t 
} from './src/utils.js';
import { renderServerSettingsPage, openRoleEditor, openServerSettings, openUserSettings, renderUserSettingsPage, applyI18nToHtml } from './src/settings.js';
import { openCreateChannelModal, openAddServerModal, showNewDmModal, showNicknameModal, closeModal, openSearchModal } from './src/modals.js';
import { showCtxMenu, closeContextMenu, showServerContextMenu, showChannelContextMenu, renameChannel, deleteChannel, showServerDropdown, hideServerDropdown } from './src/context_menus.js';
import { renderPollHtml, attachPollHandlers, openPollCreator, renderPollAnswerInputs, createThread, showEventsPanel, openCreateEventModal, showWebhooksPanel, handlePollSocketEvents, updatePollInMessage } from './src/features.js';
import { 
  renderServerIcons, selectServer, renderChannelList, renderChannelGroup, selectChannel, 
  userHasPermissionClient, applySelfProfileToCaches, renderMessages, showWelcomeScreen, loadMessages, sendMessage, 
  msgHtml, attachMsgHandlers, cancelReply, renderMessageReactions, updateReactions, toggleReaction, 
  uploadAndSend, startEditMessage, confirmDeleteMessage, renderMembersPanel, memberItemHtml, showProfileCard, closeProfileCard, 
  showFriendsView, friendItemHtml, renderVoicePanel, setupDragDrop, initIcons
} from './src/ui.js';

const $ = id => document.getElementById(id);

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
window.updateSidebarUser = updateSidebarUser;
window.getServer = getServer;
window.getChannel = getChannel;
window.checkUnreads = checkUnreads;

window.connectGateway = connectGateway;
window.sendTyping = sendTyping;

window.API = API;
window.createInvite = createInvite;
window.leaveServer = leaveServer;
window.deleteServer = deleteServer;
window.createCategory = createCategory;
window.showPins = showPins;
window.loadFriendCount = loadFriendCount;
window.joinVoiceChannel = joinVoiceChannel;
window.leaveVoiceChannel = leaveVoiceChannel;
window.toggleVoiceMute = toggleVoiceMute;
window.toggleVoiceDeafen = toggleVoiceDeafen;
window.startScreenShare = startScreenShare;
window.stopScreenShare = stopScreenShare;
window.bindVoiceScreenVideos = bindVoiceScreenVideos;

window.showAuth = showAuth;
window.hideAuth = hideAuth;
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.normalizeMe = normalizeMe;

window.QUICK_EMOJIS = QUICK_EMOJIS;
window.EMOJI_LIST = EMOJI_LIST;
window.saveQuickEmojis = saveQuickEmojis;
window.setupEmojiPicker = setupEmojiPicker;
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

window.showCtxMenu = showCtxMenu;
window.closeContextMenu = closeContextMenu;
window.showServerContextMenu = showServerContextMenu;
window.showChannelContextMenu = showChannelContextMenu;
window.renameChannel = renameChannel;
window.deleteChannel = deleteChannel;
window.showServerDropdown = showServerDropdown;
window.hideServerDropdown = hideServerDropdown;

window.renderPollHtml = renderPollHtml;
window.attachPollHandlers = attachPollHandlers;
window.openPollCreator = openPollCreator;
window.renderPollAnswerInputs = renderPollAnswerInputs;
window.createThread = createThread;
window.showEventsPanel = showEventsPanel;
window.openCreateEventModal = openCreateEventModal;
window.showWebhooksPanel = showWebhooksPanel;

window.renderServerIcons = renderServerIcons;
window.selectServer = selectServer;
window.renderChannelList = renderChannelList;
window.renderChannelGroup = renderChannelGroup;
window.selectChannel = selectChannel;
window.userHasPermissionClient = userHasPermissionClient;
window.applySelfProfileToCaches = applySelfProfileToCaches;
window.renderMessages = renderMessages;
window.showWelcomeScreen = showWelcomeScreen;
window.loadMessages = loadMessages;
window.sendMessage = sendMessage;
window.msgHtml = msgHtml;
window.attachMsgHandlers = attachMsgHandlers;
window.cancelReply = cancelReply;
window.renderMessageReactions = renderMessageReactions;
window.updateReactions = updateReactions;
window.toggleReaction = toggleReaction;
window.uploadAndSend = uploadAndSend;
window.startEditMessage = startEditMessage;
window.confirmDeleteMessage = confirmDeleteMessage;
window.renderMembersPanel = renderMembersPanel;
window.memberItemHtml = memberItemHtml;
window.showProfileCard = showProfileCard;
window.closeProfileCard = closeProfileCard;
window.showFriendsView = showFriendsView;
window.friendItemHtml = friendItemHtml;
window.renderVoicePanel = renderVoicePanel;
window.setupDragDrop = setupDragDrop;
window.initIcons = initIcons;

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
NotifSound.play = function(title, body) {
  _origNotifPlay();
  if (IS_TAURI && document.hidden) {
    tauriNotify(title || 'Discord Alt', body || t('new_message'));
  }
};

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
window.openLightbox = openLightbox;


async function bootApp() {
  $('app').classList.remove('hidden');
  try { S.servers = await API.get('/api/users/@me/guilds'); } catch { S.servers = []; }
  try { S.dmChannels = await API.get('/api/users/@me/channels'); } catch { S.dmChannels = []; }
  renderServerIcons();
  await selectServer('@me');

  // Load friends in BG
  loadFriendCount();

  connectGateway();
}

function setupDOMEventListeners() {
  $('li-btn').onclick = doLogin;
  $('reg-btn').onclick = doRegister;
  $('goto-register').onclick = () => showAuth('register');
  $('goto-login').onclick = () => showAuth('login');
  $('li-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  $('reg-pass').onkeydown = e => { if (e.key === 'Enter') doRegister(); };

  function openMobileSidebar() { $('app').classList.add('mobile-sidebar-open'); }
  function closeMobileSidebar() { $('app').classList.remove('mobile-sidebar-open'); }
  $('btn-mobile-menu').onclick = openMobileSidebar;
  $('mobile-sidebar-overlay').onclick = closeMobileSidebar;
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
  $('btn-add-server').onclick = openAddServerModal;
  $('sidebar-header').onclick = () => {
    if (S.activeServerId !== '@me') {
      if ($('server-dropdown').classList.contains('hidden')) showServerDropdown();
      else hideServerDropdown();
    }
  };

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
  });

  $('btn-attach').onclick = () => $('file-input').click();
  $('file-input').onchange = e => {
    for (const f of e.target.files) uploadAndSend(f);
    $('file-input').value = '';
  };

  $('reply-close').onclick = cancelReply;
  $('btn-toggle-mute').onclick = () => {
    if (V.channelId) {
      toggleVoiceMute();
    } else {
      V.muted = !V.muted;
    }
    $('btn-toggle-mute').style.color = V.muted ? 'var(--danger)' : '';
  };

  $('btn-settings').onclick = () => openUserSettings('profile');
  $('su-av-wrapper').onclick = (e) => { e.stopPropagation(); document.dispatchEvent(new Event('da:show-status-picker')); };
  $('su-info-click').onclick = () => openUserSettings('profile');

  $('ss-close').onclick = () => $('server-settings').classList.add('hidden');
  $('us-close').onclick = () => $('user-settings').classList.add('hidden');
  $('us-logout').onclick = doLogout;

  $('messages-load-more').onclick = async () => {
    const msgs = S.messages[S.activeChannelId];
    if (!msgs?.length) return;
    await loadMessages(S.activeChannelId, msgs[0].id);
  };
  $('messages-wrapper').addEventListener('scroll', e => {
    if (e.target.scrollTop < 100) $('messages-load-more').click();
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
      await API.post(`/api/guilds/${serverId}/channels`, { name, type: type === 'voice' ? 2 : type === 'announcement' ? 5 : 0, topic, parent_id: categoryId });
      closeModal('modal-create-channel');
      const fresh = await API.get(`/api/guilds/${serverId}`);
      const idx = S.servers.findIndex(s => s.id === serverId);
      if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...fresh };
      renderChannelList();
    } catch (e) { $('cc-error').textContent = e.body?.error || t('error_generic'); }
  };

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

  setupDragDrop();

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
          if (!S.servers.find(s => s.id === srv.id)) S.servers.push(srv);
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
  initIcons();

  if (!window.io) {
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
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
