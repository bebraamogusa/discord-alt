import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import advancedFeaturesRoutes from '../routes/advancedFeatures.js';
import { buildRateLimiter } from '../middleware/rateLimit.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedChannel, seedWebhook, seedRole, seedMember, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('DIS-43 webhook and event CRUD permission checks', () => {
  let app, db, snowflake;
  let owner, adminWebhook, adminEvents, noPermsUser, outsider;
  let guild, channel, channel2, anotherGuild, anotherChannel;
  let webhook;

  before(async () => {
    db = createTestDb();
    snowflake = new SnowflakeGenerator(1, 1);

    owner = seedUser(db, { id: 'dis43_owner', username: 'dis43_owner' });
    adminWebhook = seedUser(db, { id: 'dis43_whadmin', username: 'dis43_whadmin' });
    adminEvents = seedUser(db, { id: 'dis43_evadmin', username: 'dis43_evadmin' });
    noPermsUser = seedUser(db, { id: 'dis43_noperm', username: 'dis43_noperm' });
    outsider = seedUser(db, { id: 'dis43_outsider', username: 'dis43_outsider' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;
    channel2 = seedChannel(db, guild.id, { name: 'text2', type: 0 });
    // ensure voice channel for events
    seedChannel(db, guild.id, { name: 'voice1', type: 2 });

    anotherGuild = seedGuild(db, owner.id, { id: 'dis43_otherguild', name: 'other' });
    anotherChannel = anotherGuild.channel;

    seedMember(db, guild.id, adminWebhook.id);
    seedMember(db, guild.id, adminEvents.id);
    seedMember(db, guild.id, noPermsUser.id);

    const whRole = seedRole(db, guild.id, { name: 'WH', position: 1, permissions: (1n << 29n).toString() });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, adminWebhook.id, whRole.id);

    const evRole = seedRole(db, guild.id, { name: 'EV', position: 2, permissions: (1n << 33n).toString() });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, adminEvents.id, evRole.id);

    webhook = seedWebhook(db, channel.id, guild.id, owner.id, { name: 'DIS43Hook' });

    const testApp = buildTestApp({ db });
    app = testApp.app;

    const authenticate = async (req, reply) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized' });
      const token = auth.slice('Bearer '.length).trim();
      if (!token) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        const payload = jwt.verify(token, TEST_JWT_SECRET);
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.sub);
        if (!user) return reply.code(401).send({ error: 'Invalid token user' });
        req.user = user;
      } catch { return reply.code(401).send({ error: 'Invalid token' }); }
    };

    const fakeIo = { to: () => ({ emit: () => {} }) };
    const webhookRateLimit = buildRateLimiter({ windowMs: 60_000, max: 100 });
    await app.register(advancedFeaturesRoutes, { db, authenticate, snowflake, io: fakeIo, webhookRateLimit });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  // ── WEBHOOK CRUD permission ──
  describe('webhook CRUD requires MANAGE_WEBHOOKS', () => {
    it('POST /api/channels/:channelId/webhooks 403 without MANAGE_WEBHOOKS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
        payload: { name: 'shouldfail' },
      });
      assert.equal(res.statusCode, 403);
    });
    it('POST /api/channels/:channelId/webhooks 201 with MANAGE_WEBHOOKS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(adminWebhook.id, adminWebhook.username)}` },
        payload: { name: 'okhook' },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().name, 'okhook');
    });
    it('POST /api/channels/:channelId/webhooks 403 for outsider (not member -> 403 via permission check)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
        payload: { name: 'outsider' },
      });
      assert.equal(res.statusCode, 403);
    });
    it('GET /api/channels/:channelId/webhooks 403 without perm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channel.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('GET /api/guilds/:guildId/webhooks 403 without perm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/webhooks`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('GET /api/webhooks/:webhookId 403 without perm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('PATCH /api/webhooks/:webhookId 403 without perm', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
        payload: { name: 'hacked' },
      });
      assert.equal(res.statusCode, 403);
    });
    it('PATCH /api/webhooks/:webhookId 200 with perm', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminWebhook.id, adminWebhook.username)}` },
        payload: { name: 'patched' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, 'patched');
    });
    it('POST /api/webhooks/:webhookId/regenerate-token 403 without perm', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${webhook.id}/regenerate-token`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('POST /api/webhooks/:webhookId/regenerate-token 200 with perm and rotates token', async () => {
      const before = db.prepare('SELECT token FROM webhooks WHERE id = ?').get(webhook.id).token;
      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${webhook.id}/regenerate-token`,
        headers: { authorization: `Bearer ${makeToken(adminWebhook.id, adminWebhook.username)}` },
      });
      assert.equal(res.statusCode, 200);
      const after = db.prepare('SELECT token FROM webhooks WHERE id = ?').get(webhook.id).token;
      assert.notEqual(before, after);
      assert.match(after, /^[A-Za-z0-9]{68}$/);
    });
    it('DELETE /api/webhooks/:webhookId 403 without perm', async () => {
      const tmp = seedWebhook(db, channel.id, guild.id, owner.id, { name: 'todelete' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('DELETE /api/webhooks/:webhookId 200 with perm', async () => {
      const tmp = seedWebhook(db, channel.id, guild.id, owner.id, { name: 'todelete2' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(adminWebhook.id, adminWebhook.username)}` },
      });
      assert.equal(res.statusCode, 200);
    });
    it('PATCH cross-guild channel move is 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${makeToken(adminWebhook.id, adminWebhook.username)}` },
        payload: { channel_id: anotherChannel.id },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  // ── SCHEDULED EVENTS CRUD permission ──
  describe('scheduled events CRUD requires MANAGE_EVENTS', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const future2 = Math.floor(Date.now() / 1000) + 7200;

    it('POST /api/guilds/:guildId/scheduled-events 403 without MANAGE_EVENTS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
        payload: { name: 'ev', entity_type: 3, scheduled_start_time: future, entity_metadata: JSON.stringify({ location: 'here' }) },
      });
      assert.equal(res.statusCode, 403);
    });
    it('POST with MANAGE_EVENTS 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'Party', entity_type: 3, scheduled_start_time: future, entity_metadata: JSON.stringify({ location: 'park' }) },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().name, 'Party');
    });
    it('POST 400 when channel not in same guild', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'bad', entity_type: 2, scheduled_start_time: future, channel_id: anotherChannel.id },
      });
      assert.equal(res.statusCode, 400);
    });
    it('GET /api/guilds/:guildId/scheduled-events requires VIEW_CHANNEL (member can list)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.json()));
    });
    it('GET outsider (non-member) gets 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('PATCH /api/guilds/:guildId/scheduled-events/:eventId 403 without MANAGE_EVENTS', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'toPatch', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'loc' }) },
      });
      const evId = created.json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
        payload: { name: 'hacked' },
      });
      assert.equal(res.statusCode, 403);
    });
    it('PATCH with MANAGE_EVENTS 200', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'toPatch2', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'loc2' }) },
      });
      const evId = created.json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'patchedEvent' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, 'patchedEvent');
    });
    it('DELETE 403 without MANAGE_EVENTS', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'toDel', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'loc' }) },
      });
      const evId = created.json().id;
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('DELETE 200 with MANAGE_EVENTS', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'toDel2', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'loc' }) },
      });
      const evId = created.json().id;
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
      });
      assert.equal(res.statusCode, 200);
      const check = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
      });
      assert.equal(check.statusCode, 404);
    });
    it('owner can CRUD events without explicit role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'ownerEvent', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'ownerloc' }) },
      });
      assert.equal(res.statusCode, 201);
      const evId = res.json().id;
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(del.statusCode, 200);
    });
    it('RSVP requires VIEW_CHANNEL and succeeds for member', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/scheduled-events`,
        headers: { authorization: `Bearer ${makeToken(adminEvents.id, adminEvents.username)}` },
        payload: { name: 'rsvpEvent', entity_type: 3, scheduled_start_time: future2, entity_metadata: JSON.stringify({ location: 'loc' }) },
      });
      const evId = created.json().id;
      const put = await app.inject({
        method: 'PUT',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}/users/@me`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(put.statusCode, 200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/scheduled-events/${evId}/users/@me`,
        headers: { authorization: `Bearer ${makeToken(noPermsUser.id, noPermsUser.username)}` },
      });
      assert.equal(del.statusCode, 200);
    });
  });
});
