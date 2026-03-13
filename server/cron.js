// server/cron.js
// Scheduled background tasks

const nowSec = () => Math.floor(Date.now() / 1000);

export function startCronJobs({ db, io }) {
    // 1. Thread auto-archive — every 5 minutes
    setInterval(() => {
        try {
            const threads = db.prepare(`
        SELECT c.id, c.default_auto_archive_duration, c.last_message_id, c.guild_id,
               COALESCE(
                 (SELECT created_at FROM messages WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1),
                 c.created_at
               ) AS last_activity
        FROM channels c
        WHERE c.type IN (10, 11, 12)
          AND (c.flags & 2) = 0
          AND c.status IS NULL
      `).all();

            const now = nowSec();
            for (const thread of threads) {
                const archiveDuration = (thread.default_auto_archive_duration || 1440) * 60; // to seconds
                if (thread.last_activity && (now - thread.last_activity) > archiveDuration) {
                    db.prepare(`UPDATE channels SET flags = flags | 2, updated_at = ? WHERE id = ?`).run(now, thread.id);
                    if (io) {
                        io.to(`guild:${thread.guild_id}`).emit('THREAD_UPDATE', { id: thread.id, archived: true });
                    }
                }
            }
        } catch (e) { console.error('[CRON] Thread archive error:', e.message); }
    }, 5 * 60 * 1000);

    // 2. Invite expiration — every minute
    setInterval(() => {
        try {
            const now = nowSec();
            const expired = db.prepare(`SELECT code, guild_id, channel_id FROM invites WHERE expires_at IS NOT NULL AND expires_at <= ?`).all(now);
            if (expired.length) {
                db.prepare(`DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
                for (const inv of expired) {
                    if (io) io.to(`guild:${inv.guild_id}`).emit('INVITE_DELETE', { code: inv.code, guild_id: inv.guild_id, channel_id: inv.channel_id });
                }
            }
        } catch (e) { console.error('[CRON] Invite expiry error:', e.message); }
    }, 60 * 1000);

    // 3. Timeout expiration — every minute
    setInterval(() => {
        try {
            const now = nowSec();
            const timedOut = db.prepare(`
        SELECT guild_id, user_id FROM guild_members
        WHERE communication_disabled_until IS NOT NULL AND communication_disabled_until <= ?
      `).all(now);
            if (timedOut.length) {
                db.prepare(`UPDATE guild_members SET communication_disabled_until = NULL WHERE communication_disabled_until IS NOT NULL AND communication_disabled_until <= ?`).run(now);
                for (const m of timedOut) {
                    if (io) io.to(`guild:${m.guild_id}`).emit('MEMBER_UPDATE', { guild_id: m.guild_id, user_id: m.user_id, communication_disabled_until: null });
                }
            }
        } catch (e) { console.error('[CRON] Timeout expiry error:', e.message); }
    }, 60 * 1000);

    // 4. Custom status expiration — every minute
    setInterval(() => {
        try {
            const now = nowSec();
            const expired = db.prepare(`SELECT id FROM users WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?`).all(now);
            if (expired.length) {
                db.prepare(`UPDATE users SET custom_status_text = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?`).run(now);
                for (const u of expired) {
                    if (io) io.to(`user:${u.id}`).emit('PRESENCE_UPDATE', { user_id: u.id, custom_status: '' });
                }
            }
        } catch (e) { console.error('[CRON] Status expiry error:', e.message); }
    }, 60 * 1000);

    // 5. Session cleanup — every hour
    setInterval(() => {
        try {
            const now = nowSec();
            db.prepare(`DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
            db.prepare(`DELETE FROM mfa_tickets WHERE expires_at <= ?`).run(now);
            db.prepare(`DELETE FROM qr_login_sessions WHERE expires_at <= ?`).run(now);
        } catch (e) { console.error('[CRON] Session cleanup error:', e.message); }
    }, 60 * 60 * 1000);

    // 6. Audit log cleanup — daily (entries older than 45 days)
    setInterval(() => {
        try {
            const cutoff = nowSec() - (45 * 24 * 60 * 60);
            db.prepare(`DELETE FROM audit_log WHERE created_at < ?`).run(cutoff);
        } catch (e) { console.error('[CRON] Audit log cleanup error:', e.message); }
    }, 24 * 60 * 60 * 1000);

    console.log('[CRON] Background jobs started');
}
