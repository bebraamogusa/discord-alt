import { S, V } from './state.js';
import { API, escHtml, clamp, daConfirm, daPrompt, t, showToast } from './utils.js';
import { IC } from './icons.js';
import { confirmDeleteMessage, editMessage, renameChannel, deleteChannel, createInvite } from './api_requests.js';
import { openChannelSettings, showProfileCard, showNewDmModal } from './modals.js';
import { renderServerIcons, renderChannelList, renderMessages, selectChannel, userHasPermissionClient } from './ui.js';

let _ctxActive = null;

// ─── CONTEXT MENUS ────────────────────────────────────────────────────────────

export function showContextMenu(e, type, data) {
  e.preventDefault();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = buildContextMenuHtml(type, data);
  if (!menu.innerHTML) return;

  document.body.appendChild(menu);
  _ctxActive = menu;

  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = e.clientX, top = e.clientY;
  if (left + w > window.innerWidth) left -= w;
  if (top + h > window.innerHeight) top -= h;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handleCtxAction(item.dataset.action, data);
      closeContextMenu();
    });
  });
}

export function closeContextMenu() {
  if (_ctxActive) { _ctxActive.remove(); _ctxActive = null; }
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
    html += `<div class="ctx-item" data-action="ch_mute">🔇 ${t('mute_channel')}</div>`;
    const isGuild = !!S.activeServerId && S.activeServerId !== '@me';
    if (isGuild && userHasPermissionClient(S.activeServerId, 'manage_channels')) {
      html += `<div class="ctx-item" data-action="ch_edit">${IC.settings} ${t('edit_channel')}</div>`;
      html += `<div class="ctx-item" data-action="ch_rename">✏️ ${t('rename')}</div>`;
      html += `<div class="ctx-divider"></div>`;
      html += `<div class="ctx-item danger" data-action="ch_delete">${IC.trash} ${t('delete_channel')}</div>`;
    }
  } else if (type === 'server') {
    const srv = getServer(data.serverId);
    if (!srv) return '';
    const isOwner = srv.owner_id === S.me?.id;
    html += `<div class="ctx-item" data-action="srv_invite">📨 ${t('invite_people')}</div>`;
    html += `<div class="ctx-item" data-action="srv_settings">${IC.settings} ${t('server_settings')}</div>`;
    html += `<div class="ctx-divider"></div>`;
    if (isOwner) html += `<div class="ctx-item danger" data-action="srv_delete">${IC.trash} ${t('delete_server')}</div>`;
    else html += `<div class="ctx-item danger" data-action="srv_leave">${IC.leave} ${t('leave_server')}</div>`;
  }
  return html;
}

function handleCtxAction(action, data) {
  if (action === 'msg_reply') {
    S.replyingTo = data.msgId;
    const msg = (S.messages[S.activeChannelId] || []).find(m => m.id === data.msgId);
    if (msg) {
      document.getElementById('reply-preview').classList.remove('hidden');
      document.getElementById('reply-text').textContent = t('replying_to', { name: msg.author?.username || '?' }) + ': ' + (msg.content?.slice(0, 50) || 'Attachment');
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
    try { 
      API.put(`/api/channels/${S.activeChannelId}/pins/${data.msgId}`);
      showToast('Pinned/Unpinned', 'success');
    } catch { }
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
  
  // Server Actions
  else if (action === 'srv_invite') createInvite(data.serverId);
  else if (action === 'srv_settings') document.dispatchEvent(new CustomEvent('da:open-server-settings', { detail: { serverId: data.serverId } }));
  else if (action === 'srv_leave') document.dispatchEvent(new CustomEvent('da:leave-server', { detail: { serverId: data.serverId } }));
  else if (action === 'srv_delete') document.dispatchEvent(new CustomEvent('da:delete-server', { detail: { serverId: data.serverId } }));
}
