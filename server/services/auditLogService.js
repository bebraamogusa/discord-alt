// server/services/auditLogService.js
// Centralized audit log creation

export function buildAuditLogService({ db, snowflake, io }) {
    const insert = db.prepare(`
    INSERT INTO audit_log (id, guild_id, user_id, target_id, action_type, changes, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

    return {
        /**
         * @param {string} guildId
         * @param {string} userId - who performed the action
         * @param {number} actionType - action_type enum
         * @param {string|null} targetId - target of the action
         * @param {Array|null} changes - [{ key, old_value, new_value }]
         * @param {string|null} reason
         */
        create(guildId, userId, actionType, targetId = null, changes = null, reason = null) {
            const id = snowflake.generate();
            const now = Math.floor(Date.now() / 1000);
            insert.run(id, guildId, userId, targetId, actionType, changes ? JSON.stringify(changes) : null, reason, now);

            // Broadcast to users with VIEW_AUDIT_LOG permission
            if (io) {
                io.to(`guild:${guildId}`).emit('AUDIT_LOG_ENTRY_CREATE', {
                    id, guild_id: guildId, user_id: userId, target_id: targetId,
                    action_type: actionType, changes, reason, created_at: now,
                });
            }

            return id;
        },
    };
}

// Action type constants matching Discord's
export const AuditLogActions = {
    GUILD_UPDATE: 1,
    CHANNEL_CREATE: 10,
    CHANNEL_UPDATE: 11,
    CHANNEL_DELETE: 12,
    CHANNEL_OVERWRITE_CREATE: 13,
    CHANNEL_OVERWRITE_UPDATE: 14,
    CHANNEL_OVERWRITE_DELETE: 15,
    MEMBER_KICK: 20,
    MEMBER_PRUNE: 21,
    MEMBER_BAN_ADD: 22,
    MEMBER_BAN_REMOVE: 23,
    MEMBER_UPDATE: 24,
    MEMBER_ROLE_UPDATE: 25,
    MEMBER_MOVE: 26,
    MEMBER_DISCONNECT: 27,
    BOT_ADD: 28,
    ROLE_CREATE: 30,
    ROLE_UPDATE: 31,
    ROLE_DELETE: 32,
    INVITE_CREATE: 40,
    INVITE_UPDATE: 41,
    INVITE_DELETE: 42,
    WEBHOOK_CREATE: 50,
    WEBHOOK_UPDATE: 51,
    WEBHOOK_DELETE: 52,
    EMOJI_CREATE: 60,
    EMOJI_UPDATE: 61,
    EMOJI_DELETE: 62,
    MESSAGE_DELETE: 72,
    MESSAGE_BULK_DELETE: 73,
    MESSAGE_PIN: 74,
    MESSAGE_UNPIN: 75,
    STAGE_INSTANCE_CREATE: 83,
    STAGE_INSTANCE_UPDATE: 84,
    STAGE_INSTANCE_DELETE: 85,
    STICKER_CREATE: 90,
    STICKER_UPDATE: 91,
    STICKER_DELETE: 92,
    SCHEDULED_EVENT_CREATE: 100,
    SCHEDULED_EVENT_UPDATE: 101,
    SCHEDULED_EVENT_DELETE: 102,
    THREAD_CREATE: 110,
    THREAD_UPDATE: 111,
    THREAD_DELETE: 112,
    AUTOMOD_RULE_CREATE: 121,
    AUTOMOD_RULE_UPDATE: 122,
    AUTOMOD_RULE_DELETE: 123,
    AUTOMOD_BLOCK_MESSAGE: 124,
    ONBOARDING_UPDATE: 140,
    SOUNDBOARD_SOUND_CREATE: 143,
    SOUNDBOARD_SOUND_UPDATE: 144,
    SOUNDBOARD_SOUND_DELETE: 145,
};
