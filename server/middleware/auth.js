import jwt from 'jsonwebtoken';

export function buildAuthMiddleware({ db, jwtSecret }) {
  const getUser = db.prepare(
    `SELECT id, username, display_name, email, phone, avatar, banner, accent_color, bio,
            pronouns, status, custom_status_text, custom_status_emoji, custom_status_expires_at,
            locale, theme, message_font_size, mfa_enabled, flags, created_at, updated_at
     FROM users
     WHERE id = ? AND deleted_at IS NULL`
  );

  return async function authenticate(req, reply) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const token = auth.slice('Bearer '.length).trim();
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const user = getUser.get(payload.sub);
    if (!user) return reply.code(401).send({ error: 'Invalid token user' });

    req.user = user;
  };
}
