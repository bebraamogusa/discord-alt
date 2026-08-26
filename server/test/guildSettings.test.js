import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import guildsCoreRoutes from '../routes/guildsCore.js';
import { Permissions, buildPermissionService } from '../services/permissions.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedMember, makeToken, TEST_JWT_SECRET } from './helpers.js';

describe('guildSettings', () => {
  let app, db;
  let owner, manager, regularUser;
  let guildId, channelId, everyoneRoleId;

  async function setupSuite() {
    db = createTestDb();
    const snowflake = new SnowflakeGenerator(1, 1);

    owner = seedUser(db, { id: 'gs_owner_1', username: 'gsowner1' });
    manager = seedUser(db, { id: 'gs_manager_1', username: 'gsmanager1' });
    regularUser = seedUser(db, { id: 'gs_regular_1', username: 'gsregular1' });

    const g = seedGuild(db, owner.id);
    guildId = g.guildId;
    channelId = g.channelId;
    everyoneRoleId = g.everyoneRoleId;

    seedMember(db, guildId, regularUser.id);
    seedMember(db, guildId, manager.id);

    db.prepare(`
      INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, managed, mentionable, flags, created_at)
      VALUES (?, ?, ?, 0, 0, 1, ?, 0, 0, 0, ?)
    `).run('gs_manager_role_1', guildId, 'Manager', (Permissions.MANAGE_GUILD | Permissions.MANAGE_CHANNELS).toString(), Math.floor(Date.now() / 1000));
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guildId, manager.id, 'gs_manager_role_1');

    const testApp = buildTestApp({ db });
    app = testApp.app;

    const authenticate = async (req, reply) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        const payload = jwt.verify(auth.slice(7).trim(), TEST_JWT_SECRET);
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.sub);
        if (!user) return reply.code(401).send({ error: 'Invalid token user' });
        req.user = user;
      } catch {
        return reply.code(401).send({ error: 'Invalid token' });
      }
    };

    await app.register(guildsCoreRoutes, { db, authenticate, snowflake, io: null });
    await app.ready();
  }

  before(() => setupSuite());

  after(async () => {
    await app.close();
    db.close();
  });

  const tokenFor = user => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  describe('guild icon/banner persistence', () => {
    it('persists icon and banner and returns them on read', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guildId}`,
        headers: tokenFor(owner),
        payload: { icon: 'https://cdn.example.test/icon.png', banner: 'https://cdn.example.test/banner.png' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().icon, 'https://cdn.example.test/icon.png');
      assert.equal(res.json().banner, 'https://cdn.example.test/banner.png');

      const get = await app.inject({ method: 'GET', url: `/api/guilds/${guildId}`, headers: tokenFor(regularUser) });
      assert.equal(get.statusCode, 200);
      assert.equal(get.json().icon, 'https://cdn.example.test/icon.png');
      assert.equal(get.json().banner, 'https://cdn.example.test/banner.png');
    });

    it('legacy icon_url/banner_url keys are stripped, not persisted', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guildId}`,
        headers: tokenFor(owner),
        payload: { icon_url: 'https://cdn.example.test/wrong.png' },
      });
      assert.equal(res.statusCode, 200);
      assert.notEqual(res.json().icon, 'https://cdn.example.test/wrong.png');
      assert.equal(res.json().icon, 'https://cdn.example.test/icon.png');
    });

    it('member without MANAGE_GUILD gets explicit denial', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guildId}`,
        headers: tokenFor(regularUser),
        payload: { name: 'Renamed Guild' },
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.json().error, /MANAGE_GUILD/);
    });

    it('member with MANAGE_GUILD can edit', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guildId}`,
        headers: tokenFor(manager),
        payload: { description: 'updated by manager' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().description, 'updated by manager');
    });
  });

  describe('role color round trip', () => {
    it('creates a role with an integer color and returns it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guildId}/roles`,
        headers: tokenFor(owner),
        payload: { name: 'Colored', color: 0x99aab5 },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().color, 0x99aab5);
    });

    it('edits role color as integer and persists it', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guildId}/roles`,
        headers: tokenFor(owner),
        payload: { name: 'Recolorable', color: 0 },
      });
      const roleId = createRes.json().id;

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/guilds/${guildId}/roles/${roleId}`,
        headers: tokenFor(owner),
        payload: { color: 0xff5500 },
      });
      assert.equal(patchRes.statusCode, 200);
      assert.equal(patchRes.json().color, 0xff5500);

      const listRes = await app.inject({ method: 'GET', url: `/api/guilds/${guildId}`, headers: tokenFor(owner) });
      const listed = listRes.json().roles.find(r => r.id === roleId);
      assert.equal(listed.color, 0xff5500);
    });

    it('rejects out-of-range colors', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guildId}/roles`,
        headers: tokenFor(owner),
        payload: { name: 'TooBright', color: 16777216 },
      });
      assert.equal(res.statusCode, 400);
    });

    it('member without MANAGE_ROLES cannot create roles', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/guilds/${guildId}/roles`,
        headers: tokenFor(regularUser),
        payload: { name: 'Sneaky', color: 1 },
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.json().error, /MANAGE_ROLES/);
    });
  });

  describe('channel permission overwrites CRUD', () => {
    it('owner creates a role overwrite', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(owner),
        payload: { type: 0, allow: '0', deny: String(1n << 11n) },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().target_id, everyoneRoleId);
      assert.equal(res.json().deny, String(1n << 11n));
    });

    it('lists overwrites with resolved target names', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/permissions`,
        headers: tokenFor(owner),
      });
      assert.equal(res.statusCode, 200);
      const rows = res.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, '@everyone');
      assert.equal(rows[0].target_type, 0);
    });

    it('upserts the same target instead of duplicating', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(manager),
        payload: { type: 0, allow: String((1n << 10n) | (1n << 11n)), deny: '0' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().allow, String((1n << 10n) | (1n << 11n)));

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/permissions`,
        headers: tokenFor(owner),
      });
      const everyoneRows = listRes.json().filter(row => row.target_id === everyoneRoleId);
      assert.equal(everyoneRows.length, 1);
      assert.equal(everyoneRows[0].deny, '0');
    });

    it('creates a member overwrite with resolved username', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${regularUser.id}`,
        headers: tokenFor(owner),
        payload: { type: 1, allow: String(1n << 11n), deny: '0' },
      });
      assert.equal(res.statusCode, 200);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/permissions`,
        headers: tokenFor(owner),
      });
      const memberRow = listRes.json().find(row => row.target_id === regularUser.id);
      assert.ok(memberRow);
      assert.equal(memberRow.name, regularUser.username);
    });

    it('rejects overwrite targets outside the guild', async () => {
      const badRole = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/nonexistent_role`,
        headers: tokenFor(owner),
        payload: { type: 0, allow: '0', deny: '0' },
      });
      assert.equal(badRole.statusCode, 400);

      const outsider = seedUser(db, { id: 'gs_outsider_1', username: 'gsoutsider1' });
      const badMember = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${outsider.id}`,
        headers: tokenFor(owner),
        payload: { type: 1, allow: '0', deny: '0' },
      });
      assert.equal(badMember.statusCode, 400);
    });

    it('deletes an overwrite', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/permissions/${regularUser.id}`,
        headers: tokenFor(owner),
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().ok);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/permissions`,
        headers: tokenFor(owner),
      });
      assert.equal(listRes.json().some(row => row.target_id === regularUser.id), false);
    });

    it('member without MANAGE_CHANNELS gets explicit denials', async () => {
      const get = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/permissions`,
        headers: tokenFor(regularUser),
      });
      assert.equal(get.statusCode, 403);
      assert.match(get.json().error, /MANAGE_CHANNELS/);

      const put = await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(regularUser),
        payload: { type: 0, allow: '0', deny: '0' },
      });
      assert.equal(put.statusCode, 403);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(regularUser),
      });
      assert.equal(del.statusCode, 403);
    });
  });

  describe('effective access after overwrites (two accounts)', () => {
    it('deny SEND_MESSAGES blocks member but not owner, delete restores it', async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(owner),
        payload: { type: 0, allow: '0', deny: String(Permissions.SEND_MESSAGES) },
      });

      const perms = buildPermissionService(db);
      assert.equal(perms.hasChannelPermission(channelId, regularUser.id, Permissions.SEND_MESSAGES), false);
      assert.equal(perms.hasChannelPermission(channelId, regularUser.id, Permissions.VIEW_CHANNEL), true);
      assert.equal(perms.hasChannelPermission(channelId, owner.id, Permissions.SEND_MESSAGES), true);

      await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/permissions/${everyoneRoleId}`,
        headers: tokenFor(owner),
      });

      const permsAfter = buildPermissionService(db);
      assert.equal(permsAfter.hasChannelPermission(channelId, regularUser.id, Permissions.SEND_MESSAGES), true);
    });
  });
});
