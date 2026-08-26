import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import guildsCoreRoutes from '../routes/guildsCore.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedRole, seedMember, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('guildSecurity', () => {
  let app, db, snowflake;
  let owner, manageRolesUser, regularUser, nonOwnerAdmin;
  let guild, channel, everyoneRole;

  before(async () => {
    db = createTestDb();
    snowflake = new SnowflakeGenerator(1, 1);

    owner = seedUser(db, { id: 'gowner_1', username: 'gowner1' });
    manageRolesUser = seedUser(db, { id: 'gmod_1', username: 'gmod1' });
    regularUser = seedUser(db, { id: 'gregular_1', username: 'gregular1' });
    nonOwnerAdmin = seedUser(db, { id: 'gadmin_1', username: 'gadmin1' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;
    everyoneRole = g.everyoneRole;

    seedMember(db, guild.id, manageRolesUser.id);
    seedMember(db, guild.id, regularUser.id);
    seedMember(db, guild.id, nonOwnerAdmin.id);

    const modRole = seedRole(db, guild.id, {
      name: 'Moderator',
      position: 1,
      permissions: ((1n << 28n) | (1n << 29n)).toString(), // MANAGE_ROLES + MANAGE_WEBHOOKS
    });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, manageRolesUser.id, modRole.id);

    const adminRole = seedRole(db, guild.id, {
      name: 'Admin',
      position: 5,
      permissions: ((1n << 28n) | (1n << 5n) | (1n << 29n)).toString(), // MANAGE_ROLES + MANAGE_GUILD + MANAGE_WEBHOOKS
    });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, nonOwnerAdmin.id, adminRole.id);

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
    await app.register(guildsCoreRoutes, { db, authenticate, snowflake, io: fakeIo });

    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  describe('owner role management', () => {
    it('owner can create roles', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/roles`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'New Role', permissions: '0' },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().name, 'New Role');
    });

    it('owner can modify roles', async () => {
      const role = seedRole(db, guild.id, { name: 'Editable', position: 2 });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/roles/${role.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'Renamed' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, 'Renamed');
    });

    it('owner can delete roles', async () => {
      const role = seedRole(db, guild.id, { name: 'Deletable', position: 2 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/roles/${role.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().ok);
    });

    it('owner can delete guild', async () => {
      const g2 = seedGuild(db, owner.id, { id: 'del_guild_1', name: 'to delete' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${g2.guildId}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().ok);
    });
  });

  describe('cannot modify @everyone role', () => {
    it('owner cannot modify @everyone', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guild.id}/roles/${everyoneRole.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
        payload: { name: 'Hacked' },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes('@everyone'));
    });

    it('owner cannot delete @everyone', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}/roles/${everyoneRole.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes('@everyone'));
    });
  });

  describe('MANAGE_ROLES restrictions', () => {
    it('cannot assign role higher than own highest', async () => {
      const highRole = seedRole(db, guild.id, { name: 'SuperHigh', position: 10 });
      const res = await app.inject({
        method: 'PUT',
        url: `/api/guilds/${guild.id}/members/${regularUser.id}/roles/${highRole.id}`,
        headers: { authorization: `Bearer ${makeToken(manageRolesUser.id, manageRolesUser.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });

    it('cannot grant permissions above own', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guild.id}/roles`,
        headers: { authorization: `Bearer ${makeToken(manageRolesUser.id, manageRolesUser.username)}` },
        payload: { name: 'SuperAdmin', permissions: '8' }, // 8 = ADMINISTRATOR
      });
      assert.equal(res.statusCode, 201);
      const created = res.json();
      const parsedPerms = BigInt(created.permissions);
      assert.ok((parsedPerms & (1n << 3n)) === 0n, 'ADMINISTRATOR bit should not be set in role permissions');
    });
  });

  describe('non-owner restrictions', () => {
    it('non-owner cannot delete guild', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/guilds/${guild.id}`,
        headers: { authorization: `Bearer ${makeToken(nonOwnerAdmin.id, nonOwnerAdmin.username)}` },
      });
      assert.equal(res.statusCode, 403);
      assert.ok(res.json().error.includes('Only guild owner'));
    });
  });

  describe('cross-guild role ID rejected', () => {
    it('rejects role from different guild', async () => {
      const g2 = seedGuild(db, owner.id, { id: 'cross_guild_1', name: 'cross' });
      const otherRole = seedRole(db, g2.guildId, { name: 'OtherGuildRole', position: 1 });
      const res = await app.inject({
        method: 'PUT',
        url: `/api/guilds/${guild.id}/members/${regularUser.id}/roles/${otherRole.id}`,
        headers: { authorization: `Bearer ${makeToken(owner.id, owner.username)}` },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('non-member denial', () => {
    it('non-member cannot access guild endpoints', async () => {
      const outsider = seedUser(db, { id: 'outsider_g', username: 'outsider_g' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/guilds/${guild.id}`,
        headers: { authorization: `Bearer ${makeToken(outsider.id, outsider.username)}` },
      });
      assert.equal(res.statusCode, 403);
    });
  });
});
