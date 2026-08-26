import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import advancedFeaturesRoutes from '../routes/advancedFeatures.js';
import { buildRateLimiter } from '../middleware/rateLimit.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedChannel, seedWebhook, seedRole, seedMember, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('webhookSecurity', () => {
  let app, db, snowflake;
  let owner, adminUser, noPermsUser;
  let guild, channel, channel2, anotherGuild, anotherChannel;
  let webhook;

  before(async () => {
    db = createTestDb();
    snowflake = new SnowflakeGenerator(1, 1);

    owner = seedUser(db, { id: 'whowner', username: 'whowner' });
    adminUser = seedUser(db, { id: 'whadmin', username: 'whadmin' });
    noPermsUser = seedUser(db, { id: 'whnoperm', username: 'whnoperm' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;

    channel2 = seedChannel(db, guild.id, { name: 'other' });

    anotherGuild = seedGuild(db, owner.id, { id: 'otherguild', name: 'other' });
    anotherChannel = anotherGuild.channel;

    seedMember(db, guild.id, adminUser.id);
    seedMember(db, guild.id, noPermsUser.id);

    const adminRole = seedRole(db, guild.id, {
      name: 'WebhookAdmin',
      position: 1,
      permissions: (1n << 29n).toString(), // MANAGE_WEBHOOKS
    });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, adminUser.id, adminRole.id);

    webhook = seedWebhook(db, channel.id, guild.id, owner.id, { name: 'TestHook' });

    const testApp = buildTestApp({ db });
    app = testApp.app;

    const authenticate = async (req, reply) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const token = auth.slice('Bearer '.length).trim();
      if (!token) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        const payload = jwt.verify(token, TEST_JWT_SECRET);
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.sub);
        if (!user) return reply.code(401).send({ error: 'Invalid token user' });
        req.user = user;
      } catch {
        return reply.code(401).send({ error: 'Invalid token' });
      }
    };

    const fakeIo = { to: () => ({ emit: () => {} }) };
    const webhookRateLimit = buildRateLimiter({ windowMs: 60_000, max: 50 });
    await app.register(advancedFeaturesRoutes, { db, authenticate, snowflake, io: fakeIo, webhookRateLimit });

    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  describe('GET webhook requires MANAGE_WEBHOOKS', () => {
    it('returns 403 for user without MANAGE_WEBHOOKS', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });

    it('returns webhook for user with MANAGE_WEBHOOKS', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.name, 'TestHook');
    });

    it('never returns token field', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().token, undefined);
    });
  });

  describe('webhook token generation', () => {
    it('uses a nontrivial alphanumeric token and does not use Math.random', async () => {
      const source = readFileSync(new URL('../routes/advancedFeatures.js', import.meta.url), 'utf8');
      assert.equal(source.includes('Math.random'), false);

      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
        payload: { name: 'GeneratedTokenHook' },
      });
      assert.equal(res.statusCode, 201);

      const token = db.prepare('SELECT token FROM webhooks WHERE id = ?').get(res.json().id)?.token;
      assert.match(token, /^[A-Za-z0-9]{68}$/);
      assert.notEqual(new Set(token).size, 1);
    });
  });

  describe('GET channel webhooks', () => {
    it('returns 403 for user without permission', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/channels/nonexistent/webhooks',
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET guild webhooks', () => {
    it('requires membership', async () => {
      const outsider = seedUser(db, { id: 'outsider_wh', username: 'outsider_wh' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
      });
      assert.equal(res.statusCode, 404);
    });

    it('returns 403 for non-MANAGE_WEBHOOKS member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('PATCH webhook cross-guild rejection', () => {
    it('cannot move webhook to channel in different guild', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
        payload: { channel_id: anotherChannel.id },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes('same guild'));
    });

    it('can move webhook to channel in same guild', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminUser.id, adminUser.username)}` },
        payload: { channel_id: channel2.id },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('webhook send rate limit', () => {
    it('returns 429 after exceeding rate limit', async () => {
      const whToken = db.prepare('SELECT token FROM webhooks WHERE id = ?').get(webhook.id)?.token;
      if (!whToken) return;

      const rlApp = buildTestApp({ db });
      const rlRateLimit = buildRateLimiter({ windowMs: 60_000, max: 2 });
      await rlApp.app.register(advancedFeaturesRoutes, { db, authenticate: async () => {}, snowflake, io: { to: () => ({ emit: () => {} }) }, webhookRateLimit: rlRateLimit });
      await rlApp.app.ready();

      for (let i = 0; i < 2; i++) {
        await rlApp.app.inject({
          method: 'POST',
          url: `/api/webhooks/${webhook.id}/${whToken}`,
          payload: { content: `msg ${i}` },
        });
      }

      const res = await rlApp.app.inject({
        method: 'POST',
        url: `/api/webhooks/${webhook.id}/${whToken}`,
        payload: { content: 'rate limited' },
      });
      assert.equal(res.statusCode, 429);

      await rlApp.app.close();
    });
  });

  describe('DELETE webhook', () => {
    it('non-member cannot delete', async () => {
      const outsider = seedUser(db, { id: 'del_outsider', username: 'del_outsider' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
  });
});
