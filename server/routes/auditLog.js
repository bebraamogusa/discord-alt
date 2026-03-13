// server/routes/auditLog.js
import { buildPermissionService, Permissions } from '../services/permissions.js';

const nowSec = () => Math.floor(Date.now() / 1000);

export default async function auditLogRoutes(fastify, { db, authenticate }) {
    const perms = buildPermissionService(db);

    // GET /api/guilds/:guildId/audit-logs
    fastify.get('/api/guilds/:guildId/audit-logs', { preHandler: [authenticate] }, async (req, reply) => {
        const { guildId } = req.params;
        const { user_id, action_type, before, after, limit: rawLimit } = req.query;
        const limit = Math.min(parseInt(rawLimit) || 50, 100);

        if (!perms.hasGuildPermission(guildId, req.user.id, Permissions.VIEW_CHANNEL)) {
            return reply.code(403).send({ error: 'Missing permissions' });
        }

        let sql = 'SELECT * FROM audit_log WHERE guild_id = ?';
        const params = [guildId];

        if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
        if (action_type != null) { sql += ' AND action_type = ?'; params.push(parseInt(action_type)); }
        if (before) { sql += ' AND created_at < ?'; params.push(parseInt(before)); }
        if (after) { sql += ' AND created_at > ?'; params.push(parseInt(after)); }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const entries = db.prepare(sql).all(...params);

        // Enrich with user data
        const userIds = new Set();
        for (const e of entries) {
            if (e.user_id) userIds.add(e.user_id);
            if (e.target_id) userIds.add(e.target_id);
        }

        const users = {};
        for (const uid of userIds) {
            const u = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(uid);
            if (u) users[uid] = u;
        }

        return {
            audit_log_entries: entries.map(e => ({
                ...e,
                changes: e.changes ? JSON.parse(e.changes) : null,
            })),
            users,
        };
    });
}
