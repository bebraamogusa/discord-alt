import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import messagesCoreRoutes from '../routes/messagesCore.js';
import { buildTestApp, createTestDb, makeToken, seedGuild, seedMember, seedRole, seedUser, TEST_JWT_SECRET } from './helpers.js';

const GRIN = '%F0%9F%98%80';
const JOY = '%F0%9F%98%84';
const WAVE = '%F0%9F%91%8B';

describe('reaction state convergence across clients', () => {
  let app;
  let db;
  let owner;
  let reactor;
  let outsider;
  let guild;
  let messageId;
  let events;
  const auth = user => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  function reactionState(messages) {
    const message = messages.find(m => m.id === messageId);
    return (message?.reactions || []).map(r => ({ emoji: r.emoji.name, count: r.count, me: r.me }));
  }

  function reactionMap(view) {
    return new Map(view.map(r => [r.emoji, { count: r.count, me: r.me }]));
  }

  async function refetch(user) {
    const res = await app.inject({ method: 'GET', url: `/api/channels/${guild.channelId}/messages`, headers: auth(user) });
    assert.equal(res.statusCode, 200);
    return reactionState(res.json());
  }

  async function react(user, method, emoji) {
    return app.inject({
      method,
      url: `/api/channels/${guild.channelId}/messages/${messageId}/reactions/${emoji}/@me`,
      headers: auth(user),
    });
  }

  before(async () => {
    db = createTestDb();
    owner = seedUser(db, { id: 'conv_owner', username: 'conv_owner' });
    reactor = seedUser(db, { id: 'conv_reactor', username: 'conv_reactor' });
    outsider = seedUser(db, { id: 'conv_outsider', username: 'conv_outsider' });
    guild = seedGuild(db, owner.id, { id: 'conv_guild' });
    seedMember(db, guild.guildId, reactor.id);
    const perms = (1n << 10n) | (1n << 11n) | (1n << 12n); // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY
    const role = seedRole(db, guild.guildId, { permissions: perms.toString() });
    db.prepare('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.guildId, reactor.id, role.id);

    messageId = 'convergence_message';
    db.prepare(`
      INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at)
      VALUES (?, ?, ?, ?, 'react to converge', 1)
    `).run(messageId, guild.channelId, guild.guildId, owner.id);

    const testApp = buildTestApp({ db });
    app = testApp.app;
    app.decorate('embedService', { generateEmbedsFromContent: async () => [] });
    const authenticate = async (req, reply) => {
      try {
        const payload = jwt.verify((req.headers.authorization || '').slice(7), TEST_JWT_SECRET);
        req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!req.user) return reply.code(401).send({ error: 'Invalid token user' });
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    };
    events = [];
    const io = { to: room => ({ emit: (name, payload) => events.push({ room, name, payload }) }) };
    await app.register(messagesCoreRoutes, {
      db,
      authenticate,
      snowflake: { generate: () => 'unused' },
      io,
      config: {},
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('two clients converge on shared counts and per-viewer me flags after refetch', async () => {
    for (let replay = 0; replay < 2; replay += 1) {
      assert.equal((await react(owner, 'PUT', GRIN)).statusCode, 200);
      assert.equal((await react(reactor, 'PUT', GRIN)).statusCode, 200);
      assert.equal((await react(reactor, 'PUT', JOY)).statusCode, 200);
      assert.equal((await react(owner, 'PUT', WAVE)).statusCode, 200);
    }

    const ownerView = await refetch(owner);
    const reactorView = await refetch(reactor);
    assert.deepEqual(reactionMap(ownerView), new Map([
      ['😀', { count: 2, me: true }],
      ['😄', { count: 1, me: false }],
      ['👋', { count: 1, me: true }],
    ]));
    assert.deepEqual(reactionMap(reactorView), new Map([
      ['😀', { count: 2, me: true }],
      ['😄', { count: 1, me: true }],
      ['👋', { count: 1, me: false }],
    ]));
    assert.deepEqual(ownerView.map(r => `${r.emoji}:${r.count}`), reactorView.map(r => `${r.emoji}:${r.count}`));

    assert.deepEqual(await refetch(owner), ownerView);
    assert.deepEqual(await refetch(reactor), reactorView);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?').get(messageId).count, 4);
  });

  it('removals propagate to both clients without duplicates or stale flags', async () => {
    assert.equal((await react(reactor, 'DELETE', JOY)).statusCode, 200);
    assert.equal((await react(reactor, 'DELETE', JOY)).statusCode, 200);
    assert.equal((await react(reactor, 'DELETE', GRIN)).statusCode, 200);

    const ownerView = await refetch(owner);
    const reactorView = await refetch(reactor);
    assert.deepEqual(reactionMap(ownerView), new Map([
      ['😀', { count: 1, me: true }],
      ['👋', { count: 1, me: true }],
    ]));
    assert.deepEqual(reactionMap(reactorView), new Map([
      ['😀', { count: 1, me: false }],
      ['👋', { count: 1, me: false }],
    ]));
    assert.deepEqual(ownerView.map(r => `${r.emoji}:${r.count}`), reactorView.map(r => `${r.emoji}:${r.count}`));
    assert.deepEqual(await refetch(reactor), reactorView);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ? AND user_id = ?').get(messageId, reactor.id).count, 0);
  });

  it('unauthorized and unauthenticated reactions fail cleanly without mutation or events', async () => {
    events.length = 0;

    assert.equal((await react(outsider, 'PUT', GRIN)).statusCode, 403);
    const anonymous = await app.inject({ method: 'PUT', url: `/api/channels/${guild.channelId}/messages/${messageId}/reactions/${GRIN}/@me` });
    assert.equal(anonymous.statusCode, 401);
    assert.equal((await react(outsider, 'DELETE', GRIN)).statusCode, 403);

    assert.equal(events.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ? AND user_id = ?').get(messageId, outsider.id).count, 0);

    assert.deepEqual(reactionMap(await refetch(owner)), new Map([
      ['😀', { count: 1, me: true }],
      ['👋', { count: 1, me: true }],
    ]));
    assert.deepEqual(reactionMap(await refetch(reactor)), new Map([
      ['😀', { count: 1, me: false }],
      ['👋', { count: 1, me: false }],
    ]));
  });

  it('emits only the canonical MESSAGE_REACTION_* family to the guild room', async () => {
    events.length = 0;
    assert.equal((await react(owner, 'PUT', JOY)).statusCode, 200);
    assert.equal((await react(owner, 'DELETE', JOY)).statusCode, 200);

    assert.deepEqual(events.map(event => event.name), ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE']);
    for (const event of events) {
      assert.equal(event.room, `guild:${guild.guildId}`);
      assert.equal(event.payload.user_id, owner.id);
      assert.deepEqual(event.payload.emoji, { name: '😄' });
    }
  });
});
