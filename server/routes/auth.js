function setRefreshCookie(reply, token, config) {
  reply.setCookie('da_refresh', token, {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.jwtRefreshTtlSec,
  });
}

function clearRefreshCookie(reply) {
  reply.clearCookie('da_refresh', { path: '/api/auth' });
}

export default async function authRoutes(fastify, { authService, config, authenticate }) {
  fastify.post('/api/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'username', 'password'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', minLength: 5, maxLength: 320 },
          username: { type: 'string', minLength: 3, maxLength: 32 },
          password: { type: 'string', minLength: 8, maxLength: 1024 },
          date_of_birth: { type: 'string', minLength: 8, maxLength: 40 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await authService.register({
        ...req.body,
        meta: {
          ip: req.ip,
          device: req.headers['user-agent'] || 'unknown',
        },
      });
      setRefreshCookie(reply, result.refreshToken, config);
      return reply.code(201).send({ token: result.token, user: result.user });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', minLength: 5, maxLength: 320 },
          password: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await authService.login({
        ...req.body,
        meta: {
          ip: req.ip,
          device: req.headers['user-agent'] || 'unknown',
        },
      });

      if (result.mfa) {
        return reply.send(result);
      }

      setRefreshCookie(reply, result.refreshToken, config);
      return reply.send({ token: result.token, user: result.user });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/mfa/totp', {
    schema: {
      body: {
        type: 'object',
        required: ['ticket', 'code'],
        additionalProperties: false,
        properties: {
          ticket: { type: 'string', minLength: 10, maxLength: 128 },
          code: { type: 'string', minLength: 6, maxLength: 12 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await authService.verifyMfaTicket({
        ...req.body,
        meta: {
          ip: req.ip,
          device: req.headers['user-agent'] || 'unknown',
        },
      });
      setRefreshCookie(reply, result.refreshToken, config);
      return reply.send({ token: result.token, user: result.user });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/refresh', async (req, reply) => {
    try {
      const refreshToken = req.cookies.da_refresh;
      const result = await authService.refresh(refreshToken, {
        ip: req.ip,
        device: req.headers['user-agent'] || 'unknown',
      });
      setRefreshCookie(reply, result.refreshToken, config);
      return reply.send({ token: result.token, user: result.user });
    } catch (error) {
      clearRefreshCookie(reply);
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const refreshToken = req.cookies.da_refresh;
    authService.logout(refreshToken);
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  fastify.post('/api/auth/mfa/enable', {
    preHandler: authenticate,
  }, async (req, reply) => {
    try {
      const payload = await authService.beginEnableMfa(req.user.id);
      return reply.send(payload);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/mfa/confirm', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 6, maxLength: 12 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await authService.confirmEnableMfa(req.user.id, req.body.code);
      return reply.send(result);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/api/auth/mfa/disable', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 6, maxLength: 12 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      await authService.disableMfaForUser(req.user.id, req.body.code);
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });
}
