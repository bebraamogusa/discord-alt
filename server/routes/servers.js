/**
 * servers.js — Stage 3: Server API
 * Routes: servers, members, invites, bans, roles, audit-log
 */
import { nanoid } from 'nanoid';
import { authenticate } from '../auth.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function auditLog(db, { server_id, actor_id, target_id = null, action, changes = {}, reason = null }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, server_id, actor_id, target_id, action, changes, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(16), server_id, actor_id, target_id, action, JSON.stringify(changes), reason);
  } catch {}
}

export function requireMember(db, serverId, userId) {
  const m = db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (!m) { const e = new Error('Not a member'); e.statusCode = 403; throw e; }
  return m;
}

export function requireOwner(db, serverId, userId) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!s) { const e = new Error('Server not found'); e.statusCode = 404; throw e; }
  if (s.owner_id !== userId) { const e = new Error('Insufficient permissions'); e.statusCode = 403; throw e; }
  return s;
}

export function userHasPermission(db, serverId, userId, flag) {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return false;
  if (server.owner_id === userId) return true;
  const roles = db.prepare(`
    SELECT r.permissions FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.server_id = ?
  `).all(userId, serverId);
  const everyone = db.prepare(`SELECT permissions FROM roles WHERE server_id = ? AND is_default = 1`).get(serverId);
  if (everyone) roles.push(everyone);
  for (const r of roles) {
    try {
      const p = JSON.parse(r.permissions || '{}');
      if (p[flag] || p.manage_server || p.administrator) return true;
    } catch {}
  }
  return false;
}

function publicServer(s) {
  return {
    id: s.id, name: s.name, icon_url: s.icon_url, banner_url: s.banner_url,
    owner_id: s.owner_id, invite_code: s.invite_code, description: s.description,
    created_at: s.created_at,
  };
}

function fullServer(db, serverId, userId = null) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!s) return null;
  const channels   = db.prepare('SELECT * FROM channels   WHERE server_id = ? ORDER BY position ASC').all(serverId);
  const categories = db.prepare('SELECT * FROM categories WHERE server_id = ? ORDER BY position ASC').all(serverId);
  const roles      = db.prepare('SELECT * FROM roles      WHERE server_id = ? ORDER BY position DESC').all(serverId);
  const result = { ...publicServer(s), channels, categories, roles };
  if (userId) {
    result.my_roles = db.prepare('SELECT role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.server_id = ?').all(userId, serverId).map(r => r.role_id);
  }
  return result;
}

// ─── Route registration ───────────────────────────────────────────────────────

export default function registerServerRoutes(app, db, io) {

  /* ── SERVERS ─────────────────────────────────────────────────────────────── */

  // POST /api/servers — create server
  app.post('/api/servers', { preHandler: authenticate }, async (req, reply) => {
    const { name, description = '', icon_url = '' } = req.body || {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const serverId   = nanoid(16);
    const inviteCode = nanoid(8);
    const userId     = req.user.id;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO servers (id, name, icon_url, description, owner_id, invite_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(serverId, name.trim().slice(0, 100), icon_url.slice(0, 2048), description.slice(0, 500), userId, inviteCode);

      db.prepare(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`).run(serverId, userId);

      const roleId = nanoid(16);
      db.prepare(`
        INSERT INTO roles (id, server_id, name, color, permissions, position, is_default)
        VALUES (?, ?, '@everyone', '#99aab5', '{"send_messages":true,"view_channel":true}', 0, 1)
      `).run(roleId, serverId);

      const catId = nanoid(16);
      db.prepare(`INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, 'General', 0)`).run(catId, serverId);
      db.prepare(`
        INSERT INTO channels (id, server_id, category_id, name, type, position)
        VALUES (?, ?, ?, 'general', 'text', 0)
      `).run(nanoid(16), serverId, catId);
    })();

    return reply.code(201).send(fullServer(db, serverId, userId));
  });

  // GET /api/servers/@me — list my servers
  app.get('/api/servers/@me', { preHandler: authenticate }, (req, reply) => {
    const servers = db.prepare(`
      SELECT s.* FROM servers s
      JOIN server_members sm ON sm.server_id = s.id
      WHERE sm.user_id = ?
      ORDER BY sm.joined_at ASC
    `).all(req.user.id);
    return reply.send(servers.map(publicServer));
  });

  // GET /api/servers/:id — full server info
  app.get('/api/servers/:id', { preHandler: authenticate }, (req, reply) => {
    try { requireMember(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    const server = fullServer(db, req.params.id, req.user.id);
    if (!server) return reply.code(404).send({ error: 'Server not found' });
    return reply.send(server);
  });

  // PATCH /api/servers/:id
  app.patch('/api/servers/:id', { preHandler: authenticate }, async (req, reply) => {
    try { requireMember(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_server')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const allowed = ['name', 'icon_url', 'banner_url', 'description'];
    const fields = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) fields[k] = String(req.body[k]).slice(0, 2048);
    if (!Object.keys(fields).length) return reply.code(400).send({ error: 'No fields' });
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE servers SET ${sets} WHERE id = ?`).run(...Object.values(fields), req.params.id);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, action: 'server_update', changes: fields });
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    io.to(`server:${req.params.id}`).emit('SERVER_UPDATE', publicServer(s));
    return reply.send(publicServer(s));
  });

  // DELETE /api/servers/:id
  app.delete('/api/servers/:id', { preHandler: authenticate }, async (req, reply) => {
    try { requireOwner(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
    io.to(`server:${req.params.id}`).emit('SERVER_DELETE', { server_id: req.params.id });
    return reply.send({ ok: true });
  });

  /* ── MEMBERS ─────────────────────────────────────────────────────────────── */

  // POST /api/servers/:id/join
  app.post('/api/servers/:id/join', { preHandler: authenticate }, async (req, reply) => {
    const { invite_code } = req.body || {};
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'Server not found' });

    const banCheck = db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
    if (banCheck) return reply.code(403).send({ error: 'You are banned from this server' });

    const existing = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
    if (existing) return reply.code(200).send(fullServer(db, server.id, req.user.id));

    // Validate custom invite if provided; otherwise allow via server's built-in code
    if (invite_code) {
      const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(invite_code);
      if (!invite || invite.server_id !== server.id) return reply.code(404).send({ error: 'Invalid invite' });
      const now = Math.floor(Date.now() / 1000);
      if (invite.expires_at && invite.expires_at < now) return reply.code(410).send({ error: 'Invite expired' });
      if (invite.max_uses && invite.uses >= invite.max_uses) return reply.code(410).send({ error: 'Invite max uses reached' });
      db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(invite.code);
    }

    db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(server.id, req.user.id);
    const user = db.prepare('SELECT id, username, discriminator, avatar_url, avatar_color FROM users WHERE id = ?').get(req.user.id);
    io.to(`server:${server.id}`).emit('MEMBER_JOIN', { server_id: server.id, member: { ...user, nickname: null, joined_at: Math.floor(Date.now() / 1000) } });
    return reply.code(201).send(fullServer(db, server.id, req.user.id));
  });

  // POST /api/servers/:id/leave
  app.post('/api/servers/:id/leave', { preHandler: authenticate }, async (req, reply) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'Server not found' });
    if (server.owner_id === req.user.id) return reply.code(400).send({ error: 'Owner cannot leave — delete the server instead' });
    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(server.id, req.user.id);
    io.to(`server:${server.id}`).emit('MEMBER_LEAVE', { server_id: server.id, user_id: req.user.id });
    return reply.send({ ok: true });
  });

  // GET /api/servers/:id/members
  app.get('/api/servers/:id/members', { preHandler: authenticate }, (req, reply) => {
    try { requireMember(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    const members = db.prepare(`
      SELECT u.id, u.username, u.discriminator, u.avatar_url, u.avatar_color, u.last_seen, u.custom_status,
             sm.nickname, sm.joined_at
      FROM server_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ?
      ORDER BY sm.joined_at ASC
    `).all(req.params.id);
    const roleRows = db.prepare(`
      SELECT ur.user_id, r.id as role_id, r.name, r.color
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE r.server_id = ?
    `).all(req.params.id);
    const roleMap = {};
    for (const r of roleRows) {
      if (!roleMap[r.user_id]) roleMap[r.user_id] = [];
      roleMap[r.user_id].push({ id: r.role_id, name: r.name, color: r.color });
    }
    return reply.send(members.map(m => ({ ...m, roles: roleMap[m.id] || [] })));
  });

  // PATCH /api/servers/:id/members/:userId — nickname change
  app.patch('/api/servers/:id/members/:userId', { preHandler: authenticate }, async (req, reply) => {
    const { id: serverId } = req.params;
    const targetId = req.params.userId === '@me' ? req.user.id : req.params.userId;
    const canManage =
      req.user.id === targetId ||
      userHasPermission(db, serverId, req.user.id, 'manage_server') ||
      userHasPermission(db, serverId, req.user.id, 'manage_roles') ||
      userHasPermission(db, serverId, req.user.id, 'kick_members');
    if (!canManage) return reply.code(403).send({ error: 'Insufficient permissions' });

    const exists = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, targetId);
    if (!exists) return reply.code(404).send({ error: 'Member not found' });

    const { nickname } = req.body || {};
    db.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?')
      .run(nickname ? String(nickname).slice(0, 32) : null, serverId, targetId);

    const member = db.prepare(`
      SELECT u.id, u.username, u.discriminator, u.avatar_url, u.avatar_color, u.last_seen, u.custom_status,
             sm.nickname, sm.joined_at
      FROM server_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ? AND sm.user_id = ?
    `).get(serverId, targetId);

    io.to(`server:${serverId}`).emit('MEMBER_UPDATE', { server_id: serverId, member });
    return reply.send(member || { ok: true });
  });

  // DELETE /api/servers/:id/members/:userId — kick
  app.delete('/api/servers/:id/members/:userId', { preHandler: authenticate }, async (req, reply) => {
    const { id: serverId, userId: targetId } = req.params;
    if (!userHasPermission(db, serverId, req.user.id, 'kick_members')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
    if (server?.owner_id === targetId) return reply.code(400).send({ error: 'Cannot kick server owner' });
    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
    auditLog(db, { server_id: serverId, actor_id: req.user.id, target_id: targetId, action: 'kick' });
    io.to(`server:${serverId}`).emit('MEMBER_LEAVE', { server_id: serverId, user_id: targetId });
    const sockets = await io.in(`user:${targetId}`).fetchSockets();
    for (const s of sockets) s.leave(`server:${serverId}`);
    return reply.send({ ok: true });
  });

  /* ── INVITES ─────────────────────────────────────────────────────────────── */

  // GET /api/invites/:code
  app.get('/api/invites/:code', (req, reply) => {
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
    if (!inv) return reply.code(404).send({ error: 'Invite not found' });
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(inv.server_id);
    const creator = db.prepare('SELECT id, username, discriminator, avatar_url FROM users WHERE id = ?').get(inv.creator_id);
    const member_count = db.prepare('SELECT COUNT(*) as c FROM server_members WHERE server_id = ?').get(inv.server_id).c;
    return reply.send({ ...inv, server: publicServer(server), creator, member_count });
  });

  // POST /api/servers/:id/invites
  app.post('/api/servers/:id/invites', { preHandler: authenticate }, async (req, reply) => {
    try { requireMember(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    const { max_uses = null, ttl_seconds = null } = req.body || {};
    const code = nanoid(8);
    const expires_at = ttl_seconds ? Math.floor(Date.now() / 1000) + Number(ttl_seconds) : null;
    db.prepare('INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, req.params.id, req.user.id, max_uses ? Number(max_uses) : null, expires_at);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, action: 'invite_create', changes: { code } });
    return reply.code(201).send(db.prepare('SELECT * FROM invites WHERE code = ?').get(code));
  });

  // DELETE /api/invites/:code
  app.delete('/api/invites/:code', { preHandler: authenticate }, async (req, reply) => {
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
    if (!inv) return reply.code(404).send({ error: 'Not found' });
    if (inv.creator_id !== req.user.id && !userHasPermission(db, inv.server_id, req.user.id, 'manage_server'))
      return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM invites WHERE code = ?').run(req.params.code);
    auditLog(db, { server_id: inv.server_id, actor_id: req.user.id, action: 'invite_delete', changes: { code: req.params.code } });
    return reply.send({ ok: true });
  });

  // GET /api/servers/:id/invites
  app.get('/api/servers/:id/invites', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_server')) return reply.code(403).send({ error: 'Insufficient permissions' });
    return reply.send(db.prepare(`
      SELECT i.*, u.username as creator_username
      FROM invites i JOIN users u ON u.id = i.creator_id
      WHERE i.server_id = ? ORDER BY i.created_at DESC
    `).all(req.params.id));
  });

  /* ── BANS ────────────────────────────────────────────────────────────────── */

  // POST /api/servers/:id/bans/:userId
  app.post('/api/servers/:id/bans/:userId', { preHandler: authenticate }, async (req, reply) => {
    const { id: serverId, userId: targetId } = req.params;
    if (!userHasPermission(db, serverId, req.user.id, 'ban_members')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const { reason = null } = req.body || {};
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO bans (server_id, user_id, banned_by, reason) VALUES (?, ?, ?, ?)').run(serverId, targetId, req.user.id, reason);
      db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
    })();
    auditLog(db, { server_id: serverId, actor_id: req.user.id, target_id: targetId, action: 'ban', changes: { reason } });
    io.to(`server:${serverId}`).emit('MEMBER_LEAVE', { server_id: serverId, user_id: targetId });
    return reply.send({ ok: true });
  });

  // DELETE /api/servers/:id/bans/:userId
  app.delete('/api/servers/:id/bans/:userId', { preHandler: authenticate }, async (req, reply) => {
    const { id: serverId, userId: targetId } = req.params;
    if (!userHasPermission(db, serverId, req.user.id, 'ban_members')) return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM bans WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
    auditLog(db, { server_id: serverId, actor_id: req.user.id, target_id: targetId, action: 'unban' });
    return reply.send({ ok: true });
  });

  // GET /api/servers/:id/bans
  app.get('/api/servers/:id/bans', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'ban_members')) return reply.code(403).send({ error: 'Insufficient permissions' });
    return reply.send(db.prepare(`
      SELECT b.*, u.username, u.avatar_url, u.discriminator
      FROM bans b JOIN users u ON u.id = b.user_id
      WHERE b.server_id = ? ORDER BY b.created_at DESC
    `).all(req.params.id));
  });

  /* ── ROLES ───────────────────────────────────────────────────────────────── */

  app.get('/api/servers/:id/roles', { preHandler: authenticate }, (req, reply) => {
    try { requireMember(db, req.params.id, req.user.id); } catch (e) { return reply.code(e.statusCode).send({ error: e.message }); }
    return reply.send(db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, created_at ASC').all(req.params.id));
  });

  app.post('/api/servers/:id/roles', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_roles')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const { name, color = '#99aab5', permissions = {} } = req.body || {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const roleId = nanoid(16);
    db.prepare('INSERT INTO roles (id, server_id, name, color, permissions) VALUES (?, ?, ?, ?, ?)')
      .run(roleId, req.params.id, name.slice(0, 50), color, JSON.stringify(permissions));
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, action: 'role_create', changes: { name } });
    return reply.code(201).send(db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId));
  });

  app.patch('/api/servers/:id/roles/:roleId', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_roles')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const { name, color, permissions, position } = req.body || {};
    const fields = {};
    if (name       !== undefined) fields.name        = String(name).slice(0, 50);
    if (color      !== undefined) fields.color       = String(color);
    if (permissions!== undefined) fields.permissions = JSON.stringify(permissions);
    if (position   !== undefined) fields.position    = Number(position);
    if (!Object.keys(fields).length) return reply.code(400).send({ error: 'No fields' });
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE roles SET ${sets} WHERE id = ? AND server_id = ?`)
      .run(...Object.values(fields), req.params.roleId, req.params.id);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, action: 'role_update', changes: fields });
    return reply.send(db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId));
  });

  app.delete('/api/servers/:id/roles/:roleId', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_roles')) return reply.code(403).send({ error: 'Insufficient permissions' });
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, req.params.id);
    if (!role) return reply.code(404).send({ error: 'Role not found' });
    if (role.is_default) return reply.code(400).send({ error: 'Cannot delete @everyone' });
    db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.roleId);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, action: 'role_delete', changes: { name: role.name } });
    return reply.send({ ok: true });
  });

  app.post('/api/servers/:id/members/:userId/roles/:roleId', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_roles')) return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(req.params.userId, req.params.roleId);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, target_id: req.params.userId, action: 'member_update', changes: { added_role: req.params.roleId } });
    return reply.send({ ok: true });
  });

  app.delete('/api/servers/:id/members/:userId/roles/:roleId', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'manage_roles')) return reply.code(403).send({ error: 'Insufficient permissions' });
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(req.params.userId, req.params.roleId);
    auditLog(db, { server_id: req.params.id, actor_id: req.user.id, target_id: req.params.userId, action: 'member_update', changes: { removed_role: req.params.roleId } });
    return reply.send({ ok: true });
  });

  /* ── AUDIT LOG ───────────────────────────────────────────────────────────── */

  app.get('/api/servers/:id/audit-log', { preHandler: authenticate }, (req, reply) => {
    if (!userHasPermission(db, req.params.id, req.user.id, 'view_audit_log') &&
        !userHasPermission(db, req.params.id, req.user.id, 'manage_server'))
      return reply.code(403).send({ error: 'Insufficient permissions' });
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const rows = before
      ? db.prepare(`SELECT al.*, u.username as actor_username, u.avatar_url as actor_avatar FROM audit_log al JOIN users u ON u.id = al.actor_id WHERE al.server_id = ? AND al.created_at < ? ORDER BY al.created_at DESC LIMIT ?`).all(req.params.id, before, limit)
      : db.prepare(`SELECT al.*, u.username as actor_username, u.avatar_url as actor_avatar FROM audit_log al JOIN users u ON u.id = al.actor_id WHERE al.server_id = ?                              ORDER BY al.created_at DESC LIMIT ?`).all(req.params.id, limit);
    return reply.send(rows);
  });
}
