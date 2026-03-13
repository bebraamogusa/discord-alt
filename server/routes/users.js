import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

const USERNAME_RE = /^[a-z0-9._]{3,32}$/;

function sanitizeHexColor(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

export default async function usersRoutes(fastify, { db, authenticate, authService, config }) {
  const getUserSettings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');

  const updateUser = db.prepare(`
    UPDATE users
    SET username = coalesce(?, username),
        display_name = coalesce(?, display_name),
        bio = ?,
        pronouns = ?,
        accent_color = ?,
        updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `);

  const getUserByUsername = db.prepare('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL');
  const getUserById = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL');

  const updateSettings = db.prepare(`
    UPDATE user_settings
    SET compact_mode = coalesce(?, compact_mode),
        developer_mode = coalesce(?, developer_mode),
        render_embeds = coalesce(?, render_embeds),
        render_reactions = coalesce(?, render_reactions),
        animate_emoji = coalesce(?, animate_emoji),
        animate_stickers = coalesce(?, animate_stickers),
        enable_tts = coalesce(?, enable_tts),
        show_current_game = coalesce(?, show_current_game),
        inline_attachment_media = coalesce(?, inline_attachment_media),
        inline_embed_media = coalesce(?, inline_embed_media),
        gif_auto_play = coalesce(?, gif_auto_play),
        notification_desktop = coalesce(?, notification_desktop),
        notification_sounds = coalesce(?, notification_sounds),
        notification_flash = coalesce(?, notification_flash),
        afk_timeout = coalesce(?, afk_timeout),
        zoom_level = coalesce(?, zoom_level)
    WHERE user_id = ?
  `);

  const upsertNote = db.prepare(`
    INSERT INTO user_notes (user_id, target_id, note)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, target_id) DO UPDATE SET note = excluded.note
  `);
  const getNote = db.prepare('SELECT note FROM user_notes WHERE user_id = ? AND target_id = ?');

  const softDeleteUser = db.prepare(`
    UPDATE users
    SET username = 'deleted_' || id,
        display_name = 'Deleted User',
        email = 'deleted_' || id || '@example.invalid',
        phone = NULL,
        avatar = NULL,
        banner = NULL,
        accent_color = NULL,
        bio = NULL,
        pronouns = NULL,
        status = 'offline',
        custom_status_text = NULL,
        custom_status_emoji = NULL,
        custom_status_expires_at = NULL,
        mfa_enabled = 0,
        mfa_secret = NULL,
        deleted_at = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const deleteSessionsByUser = db.prepare('DELETE FROM user_sessions WHERE user_id = ?');

  const countMutualGuilds = db.prepare(`
    SELECT COUNT(*) AS c
    FROM guild_members a
    JOIN guild_members b ON a.guild_id = b.guild_id
    WHERE a.user_id = ? AND b.user_id = ?
  `);

  const countMutualFriends = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT CASE WHEN user_id = ? THEN target_id ELSE user_id END AS friend_id
      FROM relationships
      WHERE (user_id = ? OR target_id = ?) AND type = 1
    ) f1
    JOIN (
      SELECT CASE WHEN user_id = ? THEN target_id ELSE user_id END AS friend_id
      FROM relationships
      WHERE (user_id = ? OR target_id = ?) AND type = 1
    ) f2 ON f1.friend_id = f2.friend_id
  `);

  fastify.get('/api/users/@me', { preHandler: authenticate }, async (req) => {
    const settings = getUserSettings.get(req.user.id);
    return { ...authService.publicUser(req.user), settings };
  });

  fastify.patch('/api/users/@me', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 32 },
          display_name: { type: 'string', minLength: 1, maxLength: 64 },
          bio: { type: 'string', minLength: 0, maxLength: 190 },
          pronouns: { type: 'string', minLength: 0, maxLength: 40 },
          accent_color: { type: 'string', minLength: 7, maxLength: 7 },
        },
      },
    },
  }, async (req, reply) => {
    const payload = req.body || {};

    let nextUsername = null;
    if (payload.username != null) {
      nextUsername = String(payload.username).trim().toLowerCase();
      if (!USERNAME_RE.test(nextUsername)) {
        return reply.code(400).send({ error: 'Invalid username format' });
      }
      const existing = getUserByUsername.get(nextUsername);
      if (existing && existing.id !== req.user.id) {
        return reply.code(409).send({ error: 'Username already in use' });
      }
    }

    const accentColor = payload.accent_color !== undefined
      ? sanitizeHexColor(payload.accent_color)
      : req.user.accent_color;

    if (payload.accent_color !== undefined && payload.accent_color !== null && !accentColor) {
      return reply.code(400).send({ error: 'Invalid accent_color format' });
    }

    updateUser.run(
      nextUsername,
      payload.display_name != null ? String(payload.display_name).trim() : null,
      payload.bio != null ? String(payload.bio).slice(0, 190) : req.user.bio,
      payload.pronouns != null ? String(payload.pronouns).slice(0, 40) : req.user.pronouns,
      accentColor,
      Math.floor(Date.now() / 1000),
      req.user.id
    );

    const updated = getUserById.get(req.user.id);
    return authService.publicUser(updated);
  });

  fastify.patch('/api/users/@me/settings', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const b = req.body || {};
    updateSettings.run(
      b.compact_mode,
      b.developer_mode,
      b.render_embeds,
      b.render_reactions,
      b.animate_emoji,
      b.animate_stickers,
      b.enable_tts,
      b.show_current_game,
      b.inline_attachment_media,
      b.inline_embed_media,
      b.gif_auto_play,
      b.notification_desktop,
      b.notification_sounds,
      b.notification_flash,
      b.afk_timeout,
      b.zoom_level,
      req.user.id
    );

    return getUserSettings.get(req.user.id);
  });

  fastify.put('/api/users/@me/notes/:userId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['note'],
        additionalProperties: false,
        properties: {
          note: { type: 'string', maxLength: 1024 },
        },
      },
    },
  }, async (req) => {
    upsertNote.run(req.user.id, req.params.userId, String(req.body.note || ''));
    return { ok: true };
  });

  fastify.get('/api/users/@me/notes/:userId', {
    preHandler: authenticate,
  }, async (req) => {
    const row = getNote.get(req.user.id, req.params.userId);
    return { note: row?.note || '' };
  });

  fastify.get('/api/users/:id', async (req, reply) => {
    const user = getUserById.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const publicData = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: user.avatar,
      banner: user.banner,
      bio: user.bio,
      accent_color: user.accent_color,
      flags: user.flags,
      created_at: user.created_at,
    };

    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const token = auth.slice('Bearer '.length).trim();
        const payload = jwt.verify(token, config.jwtSecret);
        if (payload?.sub && payload.sub !== user.id) {
          publicData.mutual_guilds = countMutualGuilds.get(payload.sub, user.id)?.c || 0;
          publicData.mutual_friends = countMutualFriends.get(
            payload.sub,
            payload.sub,
            payload.sub,
            user.id,
            user.id,
            user.id
          )?.c || 0;
        }
      } catch {
      }
    }

    return publicData;
  });

  fastify.delete('/api/users/@me', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        additionalProperties: false,
        properties: {
          password: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
    },
  }, async (req, reply) => {
    const fullUser = getUserById.get(req.user.id);
    if (!fullUser) return reply.code(404).send({ error: 'User not found' });

    const ok = await argon2.verify(fullUser.password_hash, req.body.password);
    if (!ok) return reply.code(401).send({ error: 'Invalid password' });

    const ts = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      softDeleteUser.run(ts, ts, req.user.id);
      deleteSessionsByUser.run(req.user.id);
      db.prepare('DELETE FROM dm_participants WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM guild_members WHERE user_id = ?').run(req.user.id);
    })();

    return { ok: true };
  });
}
