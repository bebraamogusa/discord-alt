import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthMiddleware } from '../middleware/auth.js';
import { buildPermissionService } from '../services/permissions.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedChannel, seedMember, seedRole, makeToken } from './helpers.js';

const CONNECT = 1n << 20n;

describe('voiceSecurity', () => {
  let app, db;
  let owner, member, nonMember;
  let guild, channel;

  before(async () => {
    db = createTestDb();

    owner = seedUser(db, { id: 'vowner', username: 'vowner' });
    member = seedUser(db, { id: 'vmember', username: 'vmember' });
    nonMember = seedUser(db, { id: 'voutsider', username: 'voutsider' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;

    seedMember(db, guild.id, member.id);

    const authenticate = buildAuthMiddleware({ db, jwtSecret: 'test-jwt-secret-that-is-at-least-32-chars-long!!' });
    const permissions = buildPermissionService(db);

    const testApp = buildTestApp({ db });
    app = testApp.app;

    const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
    const getGuildMember = db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?');

    function requireVoiceAccess(channelId, userId, res) {
      const ch = getChannelById.get(channelId);
      if (!ch || !ch.guild_id) { res.code(404).send({ error: 'Channel not found' }); return null; }
      const m = getGuildMember.get(ch.guild_id, userId);
      if (!m) { res.code(403).send({ error: 'Not a guild member' }); return null; }
      if (!permissions.hasChannelPermission(ch.id, userId, CONNECT)) {
        res.code(403).send({ error: 'Missing CONNECT permission' }); return null;
      }
      return ch;
    }

    app.post('/api/voice/join', { preHandler: [authenticate] }, async (req, res) => {
      const { channel_id } = req.body;
      if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });
      const ch = requireVoiceAccess(channel_id, req.user.id, res);
      if (!ch) return;
      return { ok: true };
    });

    app.post('/api/voice/transport/create', { preHandler: [authenticate] }, async (req, res) => {
      const { channel_id } = req.body;
      if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });
      const ch = requireVoiceAccess(channel_id, req.user.id, res);
      if (!ch) return;
      return { ok: true };
    });

    app.post('/api/voice/transport/connect', { preHandler: [authenticate] }, async (req, res) => {
      return { ok: true };
    });

    app.post('/api/voice/produce', { preHandler: [authenticate] }, async (req, res) => {
      return { ok: true };
    });

    app.post('/api/voice/consume', { preHandler: [authenticate] }, async (req, res) => {
      return { ok: true };
    });

    app.post('/api/voice/resume', { preHandler: [authenticate] }, async (req, res) => {
      return { ok: true };
    });

    app.post('/api/voice/leave', { preHandler: [authenticate] }, async (req, res) => {
      return { ok: true };
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  describe('authentication boundary', () => {
    const voiceEndpoints = [
      '/api/voice/join',
      '/api/voice/transport/create',
      '/api/voice/transport/connect',
      '/api/voice/produce',
      '/api/voice/consume',
      '/api/voice/resume',
      '/api/voice/leave',
    ];

    for (const endpoint of voiceEndpoints) {
      it(`${endpoint} rejects unauthenticated requests`, async () => {
        const res = await app.inject({ method: 'POST', url: endpoint, payload: {} });
        assert.equal(res.statusCode, 401);
      });

      it(`${endpoint} rejects invalid JWT`, async () => {
        const res = await app.inject({
          method: 'POST',
          url: endpoint,
          headers: { authorization: 'Bearer invalid.token.here' },
          payload: {},
        });
        assert.equal(res.statusCode, 401);
      });
    }
  });

  describe('non-member denial', () => {
    it('join rejects non-member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/join',
        headers: { authorization: `Bearer ${makeToken(nonMember.id, nonMember.username)}` },
        payload: { channel_id: channel.id },
      });
      assert.equal(res.statusCode, 403);
      assert.ok(res.json().error.includes('Not a guild member'));
    });
  });

  describe('missing channel', () => {
    it('join rejects non-existent channel', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/join',
        headers: { authorization: `Bearer ${makeToken(member.id, member.username)}` },
        payload: { channel_id: 'nonexistent_channel' },
      });
      assert.equal(res.statusCode, 404);
    });

    it('join rejects missing channel_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/join',
        headers: { authorization: `Bearer ${makeToken(member.id, member.username)}` },
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('wrong transport denied', () => {
    it('transport/create rejects non-existent channel', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/transport/create',
        headers: { authorization: `Bearer ${makeToken(member.id, member.username)}` },
        payload: { channel_id: 'no_such_channel' },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('missing CONNECT permission', () => {
    it('member without CONNECT is denied', async () => {
      const noConnectChannel = seedChannel(db, guild.id, { name: 'noconnect', type: 2 });
      db.prepare(`
        INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
        VALUES (?, ?, 0, '0', ?)
      `).run(noConnectChannel.id, guild.id, CONNECT.toString());

      const member2 = seedUser(db, { id: 'vmember2', username: 'vmember2' });
      seedMember(db, guild.id, member2.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/join',
        headers: { authorization: `Bearer ${makeToken(member2.id, member2.username)}` },
        payload: { channel_id: noConnectChannel.id },
      });
      assert.equal(res.statusCode, 403);
      assert.ok(res.json().error.includes('CONNECT'));
    });
  });
});
