import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRateLimiter } from '../middleware/rateLimit.js';

describe('rateLimit', () => {
  it('allows requests under the limit', async () => {
    const limiter = buildRateLimiter({ windowMs: 60000, max: 3 });
    const results = [];
    for (let i = 0; i < 3; i++) {
      const result = await limiter({ ip: '1.2.3.4' }, {
        header() {},
        code() { return this; },
        send() {},
      });
      results.push(result);
    }
    assert.ok(results.every((r) => r === undefined));
  });

  it('returns 429 with Retry-After when over limit', async () => {
    const limiter = buildRateLimiter({ windowMs: 60000, max: 2 });
    let retryAfterValue = null;
    let statusCode = null;
    let body = null;

    const fakeReply = {
      header(name, val) { if (name === 'Retry-After') retryAfterValue = val; },
      code(code) { statusCode = code; return this; },
      send(data) { body = data; },
    };

    await limiter({ ip: '10.0.0.1' }, fakeReply);
    await limiter({ ip: '10.0.0.1' }, fakeReply);
    await limiter({ ip: '10.0.0.1' }, fakeReply);

    assert.equal(statusCode, 429);
    assert.equal(body.error, 'Too many requests');
    assert.ok(retryAfterValue !== null);
    assert.ok(Number(retryAfterValue) >= 0);
  });

  it('window resets after windowMs', async () => {
    const limiter = buildRateLimiter({ windowMs: 50, max: 1 });

    const makeReply = () => {
      let code = null;
      let body = null;
      return {
        code(c) { code = c; return this; },
        header() {},
        send(data) { body = data; },
        getStatusCode() { return code; },
        getBody() { return body; },
      };
    };

    const r1 = makeReply();
    await limiter({ ip: '20.0.0.1' }, r1);
    assert.equal(r1.getStatusCode(), null);

    const r2 = makeReply();
    await limiter({ ip: '20.0.0.1' }, r2);
    assert.equal(r2.getStatusCode(), 429);

    await new Promise((r) => setTimeout(r, 60));

    const r3 = makeReply();
    await limiter({ ip: '20.0.0.1' }, r3);
    assert.equal(r3.getStatusCode(), null);
  });

  it('uses custom keyFunc', async () => {
    const limiter = buildRateLimiter({ windowMs: 60000, max: 1, keyFunc: (req) => req.headers['x-api-key'] || 'anon' });

    const makeReply = () => {
      let code = null;
      return {
        code(c) { code = c; return this; },
        header() {},
        send() {},
        getStatusCode() { return code; },
      };
    };

    const r1 = makeReply();
    await limiter({ ip: '1.1.1.1', headers: { 'x-api-key': 'keyA' } }, r1);
    assert.equal(r1.getStatusCode(), null);

    const r2 = makeReply();
    await limiter({ ip: '1.1.1.1', headers: { 'x-api-key': 'keyB' } }, r2);
    assert.equal(r2.getStatusCode(), null);
  });

  it('defaults key to req.ip', async () => {
    const limiter = buildRateLimiter({ windowMs: 60000, max: 1 });

    const makeReply = () => {
      let code = null;
      return {
        code(c) { code = c; return this; },
        header() {},
        send() {},
        getStatusCode() { return code; },
      };
    };

    const r1 = makeReply();
    await limiter({ ip: '30.0.0.1' }, r1);
    assert.equal(r1.getStatusCode(), null);

    const r2 = makeReply();
    await limiter({ ip: '30.0.0.1' }, r2);
    assert.equal(r2.getStatusCode(), 429);

    const r3 = makeReply();
    await limiter({ ip: '30.0.0.2' }, r3);
    assert.equal(r3.getStatusCode(), null);
  });
});
