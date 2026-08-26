import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import fileRoutes from '../routes/files.js';
import { buildAuthMiddleware } from '../middleware/auth.js';
import { buildTestApp, createTestDb, makeToken, seedUser, TEST_JWT_SECRET } from './helpers.js';

describe('file route security', () => {
  let app;
  let db;
  let uploadsRoot;
  let tmpDir;
  let user;

  before(async () => {
    db = createTestDb();
    user = seedUser(db, { id: 'file_route_user', username: 'file_route_user' });
    tmpDir = mkdtempSync(join(tmpdir(), 'fileroute-'));
    uploadsRoot = join(tmpDir, 'uploads');
    const tempDir = join(uploadsRoot, 'attachments', 'temp', user.id);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'private.txt'), 'private');

    const testApp = buildTestApp({ db });
    app = testApp.app;
    await app.register(fileRoutes, {
      db,
      config: { uploadsRoot },
      authenticate: buildAuthMiddleware({ db, jwtSecret: TEST_JWT_SECRET }),
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated direct access to temp uploads', async () => {
    const response = await app.inject({ method: 'GET', url: `/files/attachments/temp/${user.id}/private.txt` });
    assert.equal(response.statusCode, 401);
  });

  it('serves authorized files with safe response headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/files/attachments/temp/${user.id}/private.txt`,
      headers: { authorization: `Bearer ${makeToken(user.id, user.username)}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'private');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-disposition'], /^inline; filename="private\.txt"$/);
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
  });
});
