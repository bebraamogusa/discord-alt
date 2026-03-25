import { S, V } from './state.js';
import { API, t } from './utils.js';
import { showToast, daConfirm, daPrompt, getChannel, getServer } from './utils.js';
import { renderServerIcons, renderChannelList, renderMembersPanel, selectServer, renderVoicePanel, renderMessages } from './ui.js';

export async function toggleReaction(msgId, emoji) {
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

export async function sendMessage(content, replyToId) {
  if (!content || !S.activeChannelId) return;
  try {
    await API.post(`/api/channels/${S.activeChannelId}/messages`, {
      content,
      reply_to_id: replyToId || null,
    });
  } catch (e) {
    showToast(e.body?.error || t('error_send'), 'error');
    throw e;
  }
}

export async function uploadAndSend(file, progressBarHtmlCallback) {
  if (!S.activeChannelId) return;
  try {
    const data = await API.uploadFile(file, progressBarHtmlCallback);
    await API.post(`/api/channels/${S.activeChannelId}/messages`, {
      content: '',
      attachments: [{ url: data.url, filename: file.name, size: file.size, mime_type: file.type }],
    });
  } catch (e) {
    showToast(e.message || t('error_upload'), 'error');
    throw e;
  }
}

export async function editMessage(msgId, newContent) {
  try {
    await API.patch(`/api/messages/${msgId}`, { content: newContent });
  } catch (err) {
    showToast(err.body?.error || t('error_generic'), 'error');
    throw err;
  }
}

export async function confirmDeleteMessage(msgId) {
  if (!await daConfirm(t('confirm_delete_message'), { title: t('confirm_delete_message_title'), danger: true })) return;
  try {
    await API.del(`/api/messages/${msgId}`);
  } catch (e) {
    showToast(e.body?.error || t('error_generic'), 'error');
  }
}

export async function renameChannel(ch) {
  const name = await daPrompt(t('channel_name'), { title: t('rename_channel'), placeholder: ch.name, confirmText: t('ok') });
  if (!name || name === ch.name) return;
  try {
    await API.patch(`/api/channels/${ch.id}`, { name: name.trim() });
    showToast(t('renamed'), 'success');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function deleteChannel(channelId) {
  if (!await daConfirm(t('confirm_delete_channel_msg'), { title: t('delete_channel'), danger: true })) return;
  try { await API.del(`/api/channels/${channelId}`); }
  catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function createInvite(serverId) {
  try {
    const inv = await API.post(`/api/guilds/${serverId}/invites`, { max_age: 7 * 24 * 3600 });
    const code = inv.code || (inv.invite && inv.invite.code) || inv;
    const url = `${location.origin}/app?invite=${code}`;
    await navigator.clipboard.writeText(url).catch(() => { });
    showToast(t('invite_copied', { url }), 'success');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function leaveServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_leave_server', { name: srv?.name || '?' }), { title: t('leave_server'), danger: true, confirmText: t('confirm_leave_server_btn') })) return;
  try {
    await API.post(`/api/guilds/${serverId}/leave`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function deleteServer(serverId) {
  const srv = getServer(serverId);
  if (!await daConfirm(t('confirm_delete_server', { name: srv?.name || '?' }), { title: t('delete_server'), danger: true })) return;
  try {
    await API.del(`/api/guilds/${serverId}`);
    S.servers = S.servers.filter(s => s.id !== serverId);
    renderServerIcons();
    selectServer('@me');
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function createCategory(serverId) {
  const name = await daPrompt(t('category_name'), { title: t('create_category'), confirmText: t('create') });
  if (!name) return;
  try {
    await API.post(`/api/guilds/${serverId}/channels`, { name, type: 4 });
    const srv = await API.get(`/api/guilds/${serverId}`);
    const idx = S.servers.findIndex(s => s.id === serverId);
    if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...srv };
    renderChannelList();
  } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
}

export async function loadFriendCount() {
  try {
    S.friends = await API.get('/api/users/@me/relationships');
  } catch {
    S.friends = [];
  }
  S._friendRequestCount = S.friends.filter(f => f.status === 'pending' && f.direction === 'incoming').length;
  if (S.activeServerId === '@me') renderChannelList();
}
