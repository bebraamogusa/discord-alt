import { S, V } from './state.js';
import { API, daConfirm, t, showToast, getServer } from './utils.js';
import { IC } from './icons.js';
import { confirmDeleteMessage, renameChannel, deleteChannel, createInvite } from './api_requests.js';
import { openChannelSettings, showProfileCard, showNewDmModal } from './modals.js';
import { openNotificationSettings } from './settings.js';
import { openGuildEventsModal } from './events.js';
import { renderServerIcons, renderChannelList, selectServer, selectChannel, userHasPermissionClient } from './ui.js';

let _ctxActive = null;

// ─── CONTEXT MENUS ────────────────────────────────────────────────────────────

export function showContextMenu(e, type, data) {
  e.preventDefault();
  closeContextMenu();
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = buildContextMenuHtml(type, data);
  if (!menu.innerHTML) return;

  menu.classList.remove('hidden');
  _ctxActive = menu;

  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = e.clientX, top = e.clientY;
  if (left + w > window.innerWidth) left -= w;
  if (top + h > window.innerHeight) top -= h;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

   menu.querySelectorAll('.ctx-item').forEach(item => {
      item.setAttribute('role', 'menuitem');
     item.setAttribute('tabindex', '0');
     item.addEventListener('keydown', ev => {
       if (ev.key === 'Enter' || ev.key === ' ') {
         ev.preventDefault();
         item.click();
       }
     });
      item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handleCtxAction(item.dataset.action, data);
      closeContextMenu();
   });
  menu.querySelector('.ctx-item')?.focus();
  });
}

export function closeContextMenu() {
  if (_ctxActive) {
    _ctxActive.classList.add('hidden');
    _ctxActive.innerHTML = '';
    _ctxActive.removeAttribute('role');
    _ctxActive = null;
  }
}

function buildContextMenuHtml(type, data) {
  let html = '';
  if (type === 'message') {
    const isMine = data.authorId === S.me?.id;
    const isGuild = !!S.activeServerId && S.activeServerId !== '@me';
    const canManageMsgs = isGuild && userHasPermissionClient(S.activeServerId, 'manage_messages');
    
    // Check if the user ID matches the context menu's message ID to show DM button (if not me)
    if (data.authorId !== S.me?.id) html += `<div class="ctx-item" data-action="msg_profile">${IC.members} ${t('ctx_profile')}</div>`;
    html += `<div class="ctx-item" data-action="msg_reply">${IC.reply} ${t('reply')}</div>`;
    html += `<div class="ctx-item" data-action="msg_copy">${IC.copy} ${t('copy_text')}</div>`;
    if (isMine) html += `<div class="ctx-item" data-action="msg_edit">${IC.edit} ${t('edit')}</div>`;
    if (isGuild && canManageMsgs) html += `<div class="ctx-item" data-action="msg_pin">${data.pinned ? '📌 ' + t('unpin') : '📌 ' + t('pin')}</div>`;
    html += `<div class="ctx-item" data-action="msg_thread">🧵 Создать ветку</div>`;
    html += `<div class="ctx-divider"></div>`;
    if (isMine || canManageMsgs) html += `<div class="ctx-item danger" data-action="msg_delete">${IC.trash} ${t('delete_message')}</div>`;
  } else if (type === 'channel') {
    const isGuild = !!S.activeServerId && S.activeServerId !== '@me';
    const canManageChannels = isGuild && userHasPermissionClient(S.activeServerId, 'manage_channels');
    if (isGuild) {
      html += `<div class="ctx-item" data-action="ch_edit">${IC.settings} ${t('edit_channel')}</div>`;
      if (canManageChannels) {
        html += `<div class="ctx-item" data-action="ch_rename">✏️ ${t('rename')}</div>`;
        html += `<div class="ctx-divider"></div>`;
        html += `<div class="ctx-item danger" data-action="ch_delete">${IC.trash} ${t('delete_channel')}</div>`;
      }
    }
  } else if (type === 'category') {
    const isGuild = !!S.activeServerId && S.activeServerId !== '@me';
    const canManageChannels = isGuild && userHasPermissionClient(S.activeServerId, 'manage_channels');
    if (!canManageChannels) return '';
    html += `<div class="ctx-item" data-action="cat_rename">✏️ ${t('rename')}</div>`;
    html += `<div class="ctx-divider"></div>`;
    html += `<div class="ctx-item danger" data-action="cat_delete">${IC.trash} ${t('delete')}</div>`;
  } else if (type === 'server') {
    const srv = getServer(data.serverId);
    if (!srv) return '';
    const isOwner = srv.owner_id === S.me?.id;
    html += `<div class="ctx-item" data-action="srv_invite">📨 ${t('invite_people')}</div>`;
    html += `<div class="ctx-item" data-action="srv_events">📅 ${t('events_title')}</div>`;
    html += `<div class="ctx-item" data-action="srv_notifications">${IC.bell} ${t('ctx_notifications')}</div>`;
    html += `<div class="ctx-item" data-action="srv_settings">${IC.settings} ${t('server_settings')}</div>`;
    html += `<div class="ctx-divider"></div>`;
    if (isOwner) html += `<div class="ctx-item danger" data-action="srv_delete">${IC.trash} ${t('delete_server')}</div>`;
    else html += `<div class="ctx-item danger" data-action="srv_leave">${IC.leave} ${t('leave_server')}</div>`;
  } else if (type === 'member') {
    const serverId = S.activeServerId;
    const srv = getServer(serverId);
    const target = (S.members[serverId] || []).find(m => m.user_id === data.userId || m.id === data.userId);
    if (!srv || !target) return '';
    const isSelf = data.userId === S.me?.id;
    html += `<div class="ctx-item" data-action="mem_profile">${IC.members} ${t('ctx_profile')}</div>`;
    const canModerate = userHasPermissionClient(serverId, 'moderate_members');
    const targetIsOwner = srv.owner_id === data.userId;
    if (!isSelf && !targetIsOwner && canModerate) {
      const activeTimeout = Number(target.communication_disabled_until) > Date.now() / 1000;
      html += `<div class="ctx-item" data-action="mem_timeout">⏳ ${activeTimeout ? t('timeout_change') : t('ctx_timeout')}</div>`;
    }
  } else if (type === 'dm') {
    const ch = S.dmChannels.find(c => c.id === data.channelId);
    if (ch?.type === 'group') {
      html += `<div class="ctx-item danger" data-action="dm_leave_group">${IC.leave} ${t('group_leave')}</div>`;
    }
  }
  return html;
}

async function handleCtxAction(action, data) {
  if (action === 'msg_reply') {
    const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === data.msgId);
    if (msg) {
      const username = msg.author?.username || '?';
      S.replyTo = { id: msg.id, username, content: msg.content || 'Attachment' };
      document.getElementById('reply-name').textContent = username;
      document.getElementById('reply-preview').textContent = S.replyTo.content.slice(0, 80);
      document.getElementById('reply-bar').classList.add('visible');
      document.getElementById('msg-input').focus();
    }
  } else if (action === 'msg_copy') {
    const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === data.msgId);
    if (msg?.content) { navigator.clipboard.writeText(msg.content); showToast(t('copied'), 'success'); }
  } else if (action === 'msg_edit') {
    const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === data.msgId);
    if (msg) {
      import('./ui.js').then(({ replaceWithEditInput }) => replaceWithEditInput(data.msgId, msg.content));
    }
  } else if (action === 'msg_delete') {
    confirmDeleteMessage(data.msgId);
  } else if (action === 'msg_pin') {
    const msg = (S.messages[S.activeChannelId] || []).find(item => item.id === data.msgId);
    const pinnedNow = !!(msg ? msg.pinned : data.pinned);
    try {
      const res = pinnedNow
        ? await API.del(`/api/channels/${S.activeChannelId}/pins/${data.msgId}`)
        : await API.put(`/api/channels/${S.activeChannelId}/pins/${data.msgId}`);
      if (msg) msg.pinned = !!res?.pinned;
      showToast(pinnedNow ? t('unpin') : t('pin'), 'success');
    } catch (error) {
      showToast(error.body?.error || t('error_generic'), 'error');
    }
  } else if (action === 'msg_profile') {
    // If we passed the target element that was clicked
    const userElementId = `msg-user-${data.authorId}`; 
    // Usually it's better to render the profile directly if we have the auth ID
    // but the profile mod function requires an anchor element.. let's try finding the message DOM element.
    const msgEl = document.querySelector(`[data-msg-id="${data.msgId}"] .msg-avatar`);
    if (msgEl) showProfileCard(data.authorId, msgEl);
  } else if (action === 'msg_thread') {
    document.dispatchEvent(new CustomEvent('da:create-thread', { detail: { channelId: S.activeChannelId, messageId: data.msgId } }));
  }

  // Channel Actions
  else if (action === 'ch_edit') openChannelSettings(data.channelId);
  else if (action === 'ch_rename') {
    const ch = getServer(S.activeServerId)?.channels?.find(c => c.id === data.channelId);
    if (ch) renameChannel(ch);
  } else if (action === 'ch_delete') deleteChannel(data.channelId);
  else if (action === 'cat_rename') {
    const cat = getServer(S.activeServerId)?.categories?.find(c => c.id === data.categoryId);
    if (!cat) return;
    const name = await daPrompt(t('category_name'), { title: t('rename'), placeholder: cat.name, confirmText: t('ok') });
    if (!name || name.trim() === cat.name) return;
    try {
      await API.patch(`/api/channels/${cat.id}`, { name: name.trim() });
      showToast(t('renamed'), 'success');
      const fresh = await API.get(`/api/guilds/${S.activeServerId}`);
      const idx = S.servers.findIndex(s => s.id === S.activeServerId);
      if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...fresh };
      renderChannelList();
    } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
  } else if (action === 'cat_delete') {
    const cat = getServer(S.activeServerId)?.categories?.find(c => c.id === data.categoryId);
    if (!cat) return;
    if (!await daConfirm(t('confirm_delete_channel_msg'), { title: t('delete'), danger: true })) return;
    try {
      await API.del(`/api/channels/${cat.id}`);
      showToast(t('delete'), 'success');
    } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
  }
  
  // Server Actions
  else if (action === 'srv_invite') createInvite(data.serverId);
  else if (action === 'srv_notifications') openNotificationSettings(data.serverId);
  else if (action === 'srv_settings') document.dispatchEvent(new CustomEvent('da:open-server-settings', { detail: { serverId: data.serverId } }));
  else if (action === 'srv_leave') document.dispatchEvent(new CustomEvent('da:leave-server', { detail: { serverId: data.serverId } }));
  else if (action === 'srv_delete') document.dispatchEvent(new CustomEvent('da:delete-server', { detail: { serverId: data.serverId } }));

  // DM Actions
  else if (action === 'dm_leave_group') await leaveGroupDm(data.channelId);
}

async function leaveGroupDm(channelId) {
  try {
    await API.del(`/api/channels/${channelId}/recipients/@me`);
    S.dmChannels = S.dmChannels.filter(c => c.id !== channelId);
    showToast(t('group_left'), 'success');
    if (S.activeChannelId === channelId) {
      S.activeChannelId = null;
      await selectServer('@me');
    } else {
      renderChannelList();
    }
  } catch (e) {
    showToast(e.body?.error || t('error_generic'), 'error');
  }
}
