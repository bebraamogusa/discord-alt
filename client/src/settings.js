import { S, V } from './state.js';
import { API, escHtml, clamp, fmtDatetime, fmtTime, t, showToast, daConfirm, daPrompt, avatarEl, displayNameFor, getLang, setLang, LANG_NAMES } from './utils.js';
import { IC } from './icons.js';
import { getServer, getChannel, selectServer, selectChannel, renderServerIcons, renderChannelList, renderMembersPanel, renderMessages, renderVoicePanel, openCreateEventModal, userHasPermissionClient, applyI18nToHtml } from './ui.js';
import { createInvite, deleteServer, leaveServer, createCategory } from './api_requests.js';

// ─── SERVER SETTINGS ──────────────────────────────────────────────────────────
export function openServerSettings(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  const isOwner = srv.owner_id === S.me?.id;
  const canManageServer = userHasPermissionClient(serverId, 'manage_server');
  const canManageRoles = userHasPermissionClient(serverId, 'manage_roles');
  const canBan = userHasPermissionClient(serverId, 'ban_members');
  const canViewAudit = userHasPermissionClient(serverId, 'view_audit_log') || canManageServer;

  document.getElementById('ss-server-name').textContent = srv.name;
  document.getElementById('ss-leave-server').classList.toggle('hidden', isOwner);
  document.getElementById('ss-delete-server').classList.toggle('hidden', !isOwner);

  const allPages = [
    { id: 'overview', label: t('ss_overview'), icon: IC.overview, show: true },
    { id: 'roles', label: t('ss_roles'), icon: IC.shield, show: canManageRoles },
    { id: 'members', label: t('ss_members'), icon: IC.members, show: true },
    { id: 'bans', label: t('ss_bans'), icon: IC.hammer, show: canBan },
    { id: 'invites', label: t('ss_invites'), icon: IC.link, show: canManageServer },
    { id: 'audit', label: t('ss_audit'), icon: IC.scroll, show: canViewAudit },
  ];
  const pages = allPages.filter(p => p.show);

  document.getElementById('ss-nav-items').innerHTML = pages.map(p => `
    <div class="settings-nav-item ${p.id === 'overview' ? 'active' : ''}" data-ss-page="${p.id}"><span class="nav-icon">${p.icon}</span>${p.label}</div>
  `).join('');

  document.getElementById('ss-nav-items').querySelectorAll('[data-ss-page]').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('ss-nav-items').querySelectorAll('[data-ss-page]').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      renderServerSettingsPage(serverId, el.dataset.ssPage);
    });
  });

  document.getElementById('ss-leave-server').onclick = () => leaveServer(serverId);
  document.getElementById('ss-delete-server').onclick = () => deleteServer(serverId);

  renderServerSettingsPage(serverId, 'overview');
  document.getElementById('server-settings').classList.remove('hidden');
}

async function renderServerSettingsPage(serverId, page) {
  const srv = getServer(serverId);
  if (!srv) return;
  const titleIcons = { overview: IC.overview, roles: IC.shield, members: IC.members, bans: IC.hammer, invites: IC.link, audit: IC.scroll };
  document.getElementById('ss-page-title').innerHTML = `${titleIcons[page] || ''} ${{ overview: t('ss_overview'), roles: t('ss_roles'), members: t('ss_members'), bans: t('ss_bans'), invites: t('ss_invites'), audit: t('ss_audit') }[page] || page}`;
  const body = document.getElementById('ss-page-body');
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
      document.getElementById('ss-icon-upload')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          const result = await API.uploadFile(file);
          document.getElementById('ss-icon').value = result.url;
          showToast('Server icon uploaded', 'success');
        } catch (e) { showToast(e.body?.error || e.message || t('error_generic'), 'error'); }
      });
      document.getElementById('ss-banner-upload')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          const result = await API.uploadFile(file);
          document.getElementById('ss-banner').value = result.url;
          showToast('Server banner uploaded', 'success');
        } catch (e) { showToast(e.body?.error || e.message || t('error_generic'), 'error'); }
      });

      document.getElementById('ss-save-overview').onclick = async () => {
        try {
          const updated = await API.patch(`/api/guilds/${serverId}`, {
            name: document.getElementById('ss-name').value.trim(),
            description: document.getElementById('ss-desc').value.trim(),
            icon_url: document.getElementById('ss-icon').value.trim(),
            banner_url: document.getElementById('ss-banner').value.trim(),
          });
          const idx = S.servers.findIndex(s => s.id === serverId);
          if (idx !== -1) S.servers[idx] = { ...S.servers[idx], ...updated };
          renderServerIcons();
          showToast(t('saved'), 'success');
        } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
      };
    }
    document.getElementById('ss-copy-inv')?.addEventListener('click', () => { navigator.clipboard.writeText(invUrl).catch(() => { }); showToast(t('copied'), 'success'); });
    if (isOwner) document.getElementById('ss-danger-delete')?.addEventListener('click', () => deleteServer(serverId));
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

export function openRoleEditor(serverId, roleId, roles, perms) {
  const role = roles.find(r => r.id === roleId);
  if (!role) return;
  let currentPerms = {};
  try { currentPerms = JSON.parse(role.permissions || '{}'); } catch { }

  const body = document.getElementById('ss-page-body');
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
  document.getElementById('back-to-roles').onclick = () => renderServerSettingsPage(serverId, 'roles');
  document.getElementById('save-role-btn').onclick = async () => {
    const newPerms = {};
    for (const p of perms) { newPerms[p] = !!document.getElementById(`perm-${p}`)?.checked; }
    try {
      await API.patch(`/api/guilds/${serverId}/roles/${roleId}`, { name: document.getElementById('re-name').value.trim(), color: Number.parseInt((document.getElementById('re-color').value || '#000000').replace('#', ''), 16) || 0, permissions: newPerms });
      renderServerSettingsPage(serverId, 'roles');
      showToast(t('role_updated'), 'success');
    } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
  };
}

// ─── USER SETTINGS ────────────────────────────────────────────────────────────
export function openUserSettings(page = 'profile') {
  renderUserSettingsPage(page);
  document.getElementById('user-settings').classList.remove('hidden');
  document.getElementById('us-nav-items').querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
    el.onclick = () => { document.getElementById('us-nav-items').querySelectorAll('[data-page]').forEach(e => e.classList.remove('active')); el.classList.add('active'); renderUserSettingsPage(el.dataset.page); };
  });
}

const EMOJI_LIST = ['😀', '😂', '😍', '😎', '🥺', '😭', '😡', '🤔', '🙏', '👍', '👎', '❤️', '🔥', '✅', '❌', '⭐',
  '🎉', '🚀', '💯', '🤩', '😴', '🥳', '😤', '🤣', '😱', '🥰', '🤯', '😏', '🙈', '🎮', '🎵', '🍕', '☕', '🌟', '💎', '🏆'];
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

// Ensure normalizeMe or equivalent is defined if needed elsewhere, here we use inline mapping
export function renderUserSettingsPage(page) {
  const content = document.getElementById('us-content');
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
    document.getElementById('us-save').onclick = async () => {
      try {
        const updated = await API.patch('/api/users/@me', {
          avatar: document.getElementById('us-avatar').value.trim(),
          banner: document.getElementById('us-banner').value.trim(),
          accent_color: document.getElementById('us-av-color').value,
          bio: document.getElementById('us-about').value.trim(),
          custom_status_text: document.getElementById('us-status').value.trim(),
        });
        S.me = {
           id: updated.id, username: updated.username, email: updated.email,
           avatar_url: updated.avatar_url || updated.avatar, banner_url: updated.banner_url || updated.banner,
           avatar_color: updated.avatar_color || updated.accent_color, banner_color: updated.banner_color,
           about_me: updated.about_me || updated.bio, custom_status: updated.custom_status_text || updated.custom_status
        };
        // applySelfProfileToCaches omitted, assume part of S.me binding
        // updateSidebarUser omitted
        renderChannelList();
        if (S.activeServerId !== '@me') renderMembersPanel();
        if (getChannel(S.activeChannelId)?.type === 'voice') renderVoicePanel();
        else if (S.activeChannelId && S.activeChannelId !== 'friends') renderMessages();
        window.socket?.emit('UPDATE_STATUS', { status: localStorage.getItem('da_status') || 'online', custom_status: S.me.custom_status });
        showToast(t('saved'), 'success');
      } catch (e) { showToast(e.body?.error || t('error_generic'), 'error'); }
    };
    // Avatar upload handler
    document.getElementById('us-avatar-upload').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const result = await API.uploadFile(file);
        document.getElementById('us-avatar').value = result.url;
        showToast('Avatar uploaded!', 'success');
      } catch (err) { showToast(err.body?.error || err.message || t('error_generic'), 'error'); }
    };
    document.getElementById('us-banner-upload').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const result = await API.uploadFile(file);
        document.getElementById('us-banner').value = result.url;
        showToast('Banner uploaded!', 'success');
      } catch (err) { showToast(err.body?.error || t('error_generic'), 'error'); }
    };
    document.getElementById('us-change-pass').onclick = async () => {
      const cur = document.getElementById('us-cur-pass').value;
      const nw = document.getElementById('us-new-pass').value;
      const cnf = document.getElementById('us-confirm-pass').value;
      if (!cur || !nw) { showToast(t('fill_all_fields'), 'error'); return; }
      if (nw.length < 6) { showToast(t('password_min_6'), 'error'); return; }
      if (nw !== cnf) { showToast(t('passwords_mismatch'), 'error'); return; }
      try {
        await API.patch('/api/users/@me/password', { current_password: cur, new_password: nw });
        showToast(t('password_changed'), 'success');
        document.getElementById('us-cur-pass').value = '';
        document.getElementById('us-new-pass').value = '';
        document.getElementById('us-confirm-pass').value = '';
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
    document.getElementById('us-theme').onchange = e => {
      document.documentElement.dataset.theme = e.target.value;
      localStorage.setItem('da_theme', e.target.value);
    };
    document.getElementById('us-fontsize').oninput = e => {
      const v = e.target.value;
      document.documentElement.style.fontSize = v + 'px';
      localStorage.setItem('da_fontSize', v);
      document.getElementById('us-fs-preview').textContent = v + 'px';
    };

    const listEl = document.getElementById('qr-list');
    const presetEl = document.getElementById('qr-preset');
    const inputEl = document.getElementById('qr-input');
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

    document.getElementById('qr-add').onclick = () => tryAddQuickReaction(inputEl.value);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAddQuickReaction(inputEl.value);
      }
    });
    document.getElementById('qr-reset').onclick = () => {
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

export async function openNotificationSettings(guildId) {
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
