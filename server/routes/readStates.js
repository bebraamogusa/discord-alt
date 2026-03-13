// server/routes/readStates.js
// Read states, notification settings, and ack endpoints

const nowSec = () => Math.floor(Date.now() / 1000);

export default async function readStateRoutes(fastify, { db, authenticate, io }) {
    // GET /api/users/@me/read-states
    fastify.get('/api/users/@me/read-states', { preHandler: [authenticate] }, async (req, reply) => {
        return db.prepare('SELECT channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = ?').all(req.user.id);
    });

    // PATCH /api/users/@me/guilds/:guildId/settings (notification settings)
    fastify.patch('/api/users/@me/guilds/:guildId/settings', { preHandler: [authenticate] }, async (req, reply) => {
        const { guildId } = req.params;
        const userId = req.user.id;
        const { muted, mute_until, message_notifications, suppress_everyone, suppress_roles, mobile_push, channel_overrides } = req.body;

        // Upsert notification settings
        db.prepare(`
      INSERT INTO guild_notification_settings (user_id, guild_id, muted, mute_until, message_notifications, suppress_everyone, suppress_roles, mobile_push, channel_overrides)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id)
      DO UPDATE SET
        muted = COALESCE(?, muted),
        mute_until = COALESCE(?, mute_until),
        message_notifications = COALESCE(?, message_notifications),
        suppress_everyone = COALESCE(?, suppress_everyone),
        suppress_roles = COALESCE(?, suppress_roles),
        mobile_push = COALESCE(?, mobile_push),
        channel_overrides = COALESCE(?, channel_overrides)
    `).run(
            userId, guildId,
            muted ?? 0, mute_until ?? null, message_notifications ?? -1,
            suppress_everyone ?? 0, suppress_roles ?? 0, mobile_push ?? 1,
            channel_overrides ? JSON.stringify(channel_overrides) : '{}',
            muted, mute_until, message_notifications,
            suppress_everyone, suppress_roles, mobile_push,
            channel_overrides ? JSON.stringify(channel_overrides) : null
        );

        return db.prepare('SELECT * FROM guild_notification_settings WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
    });

    // GET /api/users/@me/guilds/:guildId/settings
    fastify.get('/api/users/@me/guilds/:guildId/settings', { preHandler: [authenticate] }, async (req, reply) => {
        const settings = db.prepare('SELECT * FROM guild_notification_settings WHERE user_id = ? AND guild_id = ?').get(req.user.id, req.params.guildId);
        return settings || { muted: 0, message_notifications: -1, suppress_everyone: 0, suppress_roles: 0, mobile_push: 1, channel_overrides: '{}' };
    });
}
