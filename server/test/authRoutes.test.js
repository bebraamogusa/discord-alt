import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import speakeasy from 'speakeasy';
import authRoutes from '../routes/auth.js';
import { buildAuthService } from '../services/authService.js';
import { buildRateLimiter } from '../middleware/rateLimit.js';
import { buildAuthMiddleware } from '../middleware/auth.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('authRoutes', () => {
  let app, db, snowflake, authService;

  const testConfig = {
    jwtSecret: TEST_JWT_SECRET,
    jwtAccessTtlSec: 900,
    jwtRefreshTtlSec: 60 * 60 * 24 * 30,
    cookieSecure: false,
    env: 'test',
    mfaMaxAttempts: 5,
  };

  before(async () => {
    db = createTestDb();
    snowflake = new SnowflakeGenerator(1, 1);
    authService = buildAuthService({ db, snowflake, config: testConfig });
    const authenticate = buildAuthMiddleware({ db, jwtSecret: TEST_JWT_SECRET });
    const authRateLimit = buildRateLimiter({ windowMs: 60_000, max: 20 });

    const testApp = buildTestApp({ db });
    app = testApp.app;

    await app.register(authRoutes, { authService, config: testConfig, authenticate, authRateLimit });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  describe('register', () => {
    it('creates user with valid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'new@test.com', username: 'newuser', password: 'securepass123' },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.token);
      assert.ok(body.user);
      assert.equal(body.user.email, 'new@test.com');
      assert.equal(body.user.username, 'newuser');
    });

    it('rejects short email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'a@b', username: 'validuser', password: 'securepass123' },
      });
      assert.ok(res.statusCode >= 400);
    });

    it('rejects short password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'valid@test.com', username: 'validuser2', password: 'short' },
      });
      assert.ok(res.statusCode >= 400);
    });

    it('rejects missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'only@test.com' },
      });
      assert.ok(res.statusCode >= 400);
    });

    it('rejects duplicate email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'new@test.com', username: 'another', password: 'securepass123' },
      });
      assert.equal(res.statusCode, 409);
      assert.ok(res.json().error.includes('Email already in use'));
    });

    it('rejects invalid username chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'fresh@test.com', username: 'bad user!', password: 'securepass123' },
      });
      assert.ok(res.statusCode >= 400);
    });
  });

  describe('login', () => {
    it('logs in with valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'new@test.com', password: 'securepass123' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.token);
      assert.ok(body.user);
    });

    it('rejects wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'new@test.com', password: 'wrongpassword' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('rejects non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@test.com', password: 'securepass123' },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('refresh', () => {
    it('refreshes with valid refresh token', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'new@test.com', password: 'securepass123' },
      });
      const cookies = loginRes.cookies;
      const refreshCookie = cookies.find((c) => c.name === 'da_refresh');
      assert.ok(refreshCookie);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { da_refresh: refreshCookie.value },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().token);
    });

    it('rejects invalid refresh token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { da_refresh: 'nonexistent_token' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('rotates refresh tokens and revokes the session when a used token is reused', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'new@test.com', password: 'securepass123' },
      });
      const oldToken = loginRes.cookies.find((c) => c.name === 'da_refresh').value;
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { da_refresh: oldToken },
      });
      assert.equal(rotated.statusCode, 200);

      const reused = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { da_refresh: oldToken },
      });
      assert.equal(reused.statusCode, 401);
      const revoked = db.prepare('SELECT revoked_at FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?) AND revoked_at IS NOT NULL').get('new@test.com');
      assert.ok(revoked);
    });

    it('stores new refresh tokens as keyed hashes and upgrades a legacy session on use', async () => {
      const result = await authService.register({
        email: 'legacy@test.com', username: 'legacyuser', password: 'securepass123',
      });
      const session = db.prepare('SELECT * FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').get('legacy@test.com');
      assert.equal(session.refresh_token, '');
      assert.ok(session.refresh_token_hash);
      assert.notEqual(session.refresh_token_hash, result.refreshToken);

      db.prepare('UPDATE user_sessions SET refresh_token = ?, refresh_token_hash = NULL WHERE id = ?').run('legacy-token', session.id);
      const refreshed = await authService.refresh('legacy-token', {});
      assert.ok(refreshed.refreshToken);
      const upgraded = db.prepare('SELECT refresh_token, refresh_token_hash FROM user_sessions WHERE id = ?').get(session.id);
      assert.equal(upgraded.refresh_token, '');
      assert.ok(upgraded.refresh_token_hash);
    });
  });

  describe('MFA ticket security', () => {
    it('limits failed codes and invalidates the ticket', async () => {
      const registered = await authService.register({
        email: 'mfa@test.com', username: 'mfauser', password: 'securepass123',
      });
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get('mfa@test.com');
      const secret = speakeasy.generateSecret().base32;
      db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run(secret, user.id);
      const login = await authService.login({ email: 'mfa@test.com', password: 'securepass123' });
      assert.ok(login.ticket);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          authService.verifyMfaTicket({ ticket: login.ticket, code: '000000' }),
          { statusCode: 401 }
        );
      }
      assert.equal(db.prepare('SELECT 1 FROM mfa_tickets WHERE ticket = ?').get(login.ticket), undefined);
      const validCode = speakeasy.totp({ secret, encoding: 'base32' });
      await assert.rejects(
        authService.verifyMfaTicket({ ticket: login.ticket, code: validCode }),
        { statusCode: 401 }
      );
      assert.ok(registered.refreshToken);
    });
  });

  describe('logout', () => {
    it('clears cookie on logout', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'new@test.com', password: 'securepass123' },
      });
      const cookies = loginRes.cookies;
      const refreshCookie = cookies.find((c) => c.name === 'da_refresh');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { da_refresh: refreshCookie?.value || '' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().ok);
    });
  });

  describe('rate limit', () => {
    it('returns 429 after max requests', async () => {
      const rlApp = buildTestApp({ db });
      const rlDb = createTestDb();
      const rlSnowflake = new SnowflakeGenerator(2, 1);
      const rlAuthService = buildAuthService({ db: rlDb, snowflake: rlSnowflake, config: testConfig });
      const rlAuth = buildAuthMiddleware({ db: rlDb, jwtSecret: TEST_JWT_SECRET });
      const rlRateLimit = buildRateLimiter({ windowMs: 60_000, max: 3 });

      await rlApp.app.register(authRoutes, { authService: rlAuthService, config: testConfig, authenticate: rlAuth, authRateLimit: rlRateLimit });
      await rlApp.app.ready();

      for (let i = 0; i < 3; i++) {
        await rlApp.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `rl${i}@test.com`, username: `rluser${i}`, password: 'securepass123' } });
      }

      const res = await rlApp.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'rl_overflow@test.com', username: 'overflow', password: 'securepass123' } });
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().error, 'Too many requests');

      await rlApp.app.close();
      rlDb.close();
    });
  });

  describe('schema validation', () => {
    it('strips additional properties (removeAdditional)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'extra@test.com', username: 'extrauser', password: 'securepass123', admin: true },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().user.flags, 0);
    });
  });

  it('uses a generic production error with a request ID', async () => {
    testConfig.env = 'production';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'new@test.com', username: 'anotherprod', password: 'securepass123' },
      });
      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.error, 'Conflict');
      assert.match(body.request_id, /^req-/);
      assert.doesNotMatch(res.body, /already in use/);
    } finally {
      testConfig.env = 'test';
    }
  });
});
