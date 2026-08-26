import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { buildAuthMiddleware } from '../middleware/auth.js';
import { buildTestApp, createTestDb, seedUser, makeToken, makeExpiredToken, TEST_JWT_SECRET, nextId } from './helpers.js';

describe('authMiddleware', () => {
  let app, db, user;

  before(async () => {
    db = createTestDb();
    user = seedUser(db);
    const authenticate = buildAuthMiddleware({ db, jwtSecret: TEST_JWT_SECRET });

    const testApp = buildTestApp({ db });
    app = testApp.app;

    app.decorateRequest('user', null);

    app.addHook('preHandler', async (req) => {
      req.user = null;
    });

    app.get('/protected', { preHandler: authenticate }, async (req) => {
      return { userId: req.user.id };
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('rejects missing Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    assert.equal(res.statusCode, 401);
    assert.deepStrictEqual(res.json(), { error: 'Unauthorized' });
  });

  it('rejects malformed Authorization header (no Bearer prefix)', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Token abc' } });
    assert.equal(res.statusCode, 401);
  });

  it('rejects empty token after Bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer ' } });
    assert.equal(res.statusCode, 401);
  });

  it('rejects expired JWT', async () => {
    const token = makeExpiredToken(user.id, user.username);
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid token');
  });

  it('rejects tampered JWT (wrong secret)', async () => {
    const token = makeToken(user.id, user.username);
    const tampered = token.split('.').map((seg, i) => {
      if (i === 2) return 'tampered_signature';
      return seg;
    }).join('.');
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${tampered}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid token');
  });

  it('rejects JWT signed with a different algorithm', async () => {
    const token = jwt.sign({ sub: user.id, username: user.username }, TEST_JWT_SECRET, {
      algorithm: 'HS384',
      expiresIn: '1h',
    });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid token');
  });

  it('rejects valid JWT for deleted user', async () => {
    const deletedUser = seedUser(db, { id: 'del_' + nextId() });
    db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), deletedUser.id);
    const token = makeToken(deletedUser.id, deletedUser.username);
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid token user');
  });

  it('rejects valid JWT for non-existent user', async () => {
    const token = makeToken('nonexistent_id', 'ghost');
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid token user');
  });

  it('accepts valid JWT and sets req.user', async () => {
    const token = makeToken(user.id, user.username);
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().userId, user.id);
  });
});
