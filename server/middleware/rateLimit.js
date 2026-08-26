export function buildRateLimiter({ windowMs = 60000, max = 60, keyFunc = (req) => req.ip } = {}) {
  const hits = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }

  const timer = setInterval(cleanup, windowMs);
  if (timer.unref) timer.unref();

  return async function rateLimit(req, reply) {
    const key = keyFunc(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({ error: 'Too many requests', retry_after: retryAfter });
    }
  };
}
