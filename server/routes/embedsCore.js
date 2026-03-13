export default async function embedsCoreRoutes(fastify, { authenticate, embedService }) {
  fastify.get('/api/embed', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 5, maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const preview = await embedService.getLinkPreview(req.query.url);
    if (!preview) return reply.code(404).send({ error: 'Preview unavailable' });
    return preview;
  });

  fastify.get('/api/proxy/image', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 5, maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const normalized = embedService.normalizeUrl(req.query.url);
    if (!normalized) return reply.code(400).send({ error: 'Invalid image URL' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const upstream = await fetch(normalized, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'DiscordAltBot/1.0 (+self-hosted)',
          accept: 'image/*',
        },
      });

      if (!upstream.ok) return reply.code(404).send({ error: 'Image fetch failed' });

      const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        return reply.code(415).send({ error: 'Unsupported content type' });
      }

      const contentLength = Number.parseInt(upstream.headers.get('content-length') || '0', 10) || 0;
      if (contentLength > 5 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Image too large' });
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (buffer.byteLength > 5 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Image too large' });
      }

      reply.header('content-type', contentType);
      reply.header('cache-control', 'public, max-age=3600');
      return reply.send(buffer);
    } catch {
      return reply.code(502).send({ error: 'Proxy fetch failed' });
    } finally {
      clearTimeout(timeout);
    }
  });
}
