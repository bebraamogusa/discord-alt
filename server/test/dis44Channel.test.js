import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import guildsCoreRoutes from '../routes/guildsCore.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedRole, seedMember, seedChannel, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('DIS-44 channel reorder/delete permission checks', () => {
  let app, db;
  let owner, manager, regular, outsider;
  let guild, channel, category, channel2, outsiderGuild;

  before(async () => {
    db = createTestDb();
    const snowflake = new SnowflakeGenerator(1, 1);

    owner = seedUser(db, { id: 'dis44_owner', username: 'dis44_owner' });
    manager = seedUser(db, { id: 'dis44_manager', username: 'dis44_manager' });
    regular = seedUser(db, { id: 'dis44_regular', username: 'dis44_regular' });
    outsider = seedUser(db, { id: 'dis44_outsider', username: 'dis44_outsider' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;

    category = seedChannel(db, guild.id, { name: 'Cat A', type: 4, position: 1 });
    channel2 = seedChannel(db, guild.id, { name: 'second', type: 0, position: 2 });

    const og = seedGuild(db, outsider.id, { id: 'dis44_out_guild', name: 'outsider guild' });
    outsiderGuild = og.guild;

    seedMember(db, guild.id, manager.id);
    seedMember(db, guild.id, regular.id);

    const manRole = seedRole(db, guild.id, { name: 'ChanMan', position: 5, permissions: (1n << 4n).toString() }); // MANAGE_CHANNELS
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, manager.id, manRole.id);

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
    await app.register(guildsCoreRoutes, { db, authenticate, snowflake, io: fakeIo });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  describe('POST /api/guilds/:guildId/channels', () => {
    it('403 without MANAGE_CHANNELS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(regular.id, regular.username)}` },
        payload: { name: 'shouldfail', type: 0 },
      });
      assert.equal(res.statusCode, 403);
    });
    it('201 with MANAGE_CHANNELS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
        payload: { name: 'okchan', type: 0 },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().name, 'okchan');
    });
    it('owner can create stage (13) and forum (15)', async () => {
      const r1 = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'stage-chan', type: 13 },
      });
      assert.equal(r1.statusCode, 201);
      assert.equal(r1.json().type, 13);
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'forum-chan', type: 15 },
      });
      assert.equal(r2.statusCode, 201);
      assert.equal(r2.json().type, 15);
    });
    it('403 for non-member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
        payload: { name: 'outsider', type: 0 },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('PATCH /api/channels/:channelId (rename)', () => {
    it('403 without MANAGE_CHANNELS', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${channel.id}`,
        headers: { authorization: `Bearer ${makeToken(regular.id, regular.username)}` },
        payload: { name: 'hacked' },
      });
      assert.equal(res.statusCode, 403);
    });
    it('200 with MANAGE_CHANNELS (rename category)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${category.id}`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
        payload: { name: 'RenamedCat' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, 'RenamedCat');
    });
    it('200 owner can rename channel', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${channel.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'general-renamed' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, 'general-renamed');
    });
    it('403 for non-member', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${channel.id}`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
        payload: { name: 'x' },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('DELETE /api/channels/:channelId', () => {
    it('403 without MANAGE_CHANNELS', async () => {
      const tmp = seedChannel(db, guild.id, { name: 'todel', type: 0, position: 99 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(regular.id, regular.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('200 with MANAGE_CHANNELS (delete category)', async () => {
      const tmp = seedChannel(db, guild.id, { name: 'catToDel', type: 4, position: 99 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().ok);
    });
    it('200 owner can delete channel', async () => {
      const tmp = seedChannel(db, guild.id, { name: 'chanToDel', type: 0, position: 98 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 200);
    });
    it('403 for non-member', async () => {
      const tmp = seedChannel(db, guild.id, { name: 'nope', type: 0, position: 97 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${tmp.id}`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
    it('404 for unknown channel', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/doesnotexist123`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('PATCH /api/guilds/:guildId/channels (reorder)', () => {
    it('403 without MANAGE_CHANNELS', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(regular.id, regular.username)}` },
        payload: [{ id: channel.id, position: 5, parent_id: null }],
      });
      assert.equal(res.statusCode, 403);
    });
    it('200 with MANAGE_CHANNELS and persists', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
        payload: [
          { id: channel.id, position: 10, parent_id: category.id },
          { id: channel2.id, position: 11, parent_id: null },
          { id: category.id, position: 0, parent_id: null },
        ],
      });
      assert.equal(res.statusCode, 200);
      const updated = res.json();
      const ch = updated.find(c => c.id === channel.id);
      assert.equal(ch.parent_id, category.id);
      assert.equal(ch.position, 10);
      const row = db.prepare('SELECT parent_id, position FROM channels WHERE id = ?').get(channel.id);
      assert.equal(row.parent_id, category.id);
      assert.equal(row.position, 10);
    });
    it('400 for invalid parent (non-category)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
        payload: [{ id: channel.id, position: 0, parent_id: channel2.id }],
      });
      assert.equal(res.statusCode, 400);
    });
    it('400 for channel not in guild', async () => {
      const otherCh = db.prepare('SELECT * FROM channels WHERE guild_id = ? LIMIT 1').get(outsiderGuild.id);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(manager.id, manager.username)}` },
        payload: [{ id: otherCh.id, position: 0, parent_id: null }],
      });
      assert.equal(res.statusCode, 400);
    });
    it('403 for non-member', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
        payload: [{ id: channel.id, position: 0, parent_id: null }],
      });
      assert.equal(res.statusCode, 403);
    });
    it('owner can reorder', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/channels`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: [{ id: channel2.id, position: 99, parent_id: null }],
      });
      assert.equal(res.statusCode, 200);
    });
  });
});
