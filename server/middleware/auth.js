import jwt from 'jsonwebtoken';

export function buildAuthMiddleware({ db, jwtSecret, env }) {
  const getUser = db.prepare(
    `SELECT id, username, display_name, email, phone, avatar, banner, accent_color, bio,
            pronouns, status, custom_status_text, custom_status_emoji, custom_status_expires_at,
            locale, theme, message_font_size, mfa_enabled, flags, created_at, updated_at
     FROM users
     WHERE id = ? AND deleted_at IS NULL`
  );

  return async function authenticate(req, reply) {
    const unauthorized = () => reply.code(401).send({
      error: env === 'production' ? 'Unauthorized' : 'Invalid token',
      ...(env === 'production' ? { request_id: req.id } : {}),
    });
    const logUnauthorized = () => req.log?.warn({ requestId: req.id }, 'authentication rejected');
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      logUnauthorized();
      return reply.code(401).send({ error: 'Unauthorized', ...(env === 'production' ? { request_id: req.id } : {}) });
    }

    const token = auth.slice('Bearer '.length).trim();
    if (!token) {
      logUnauthorized();
      return reply.code(401).send({ error: 'Unauthorized', ...(env === 'production' ? { request_id: req.id } : {}) });
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    } catch {
      logUnauthorized();
      return unauthorized();
    }

    const user = getUser.get(payload.sub);
    if (!user) {
      logUnauthorized();
      return env === 'production'
        ? unauthorized()
        : reply.code(401).send({ error: 'Invalid token user' });
    }

    req.user = user;
  };
}
