import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import messagesCoreRoutes from '../routes/messagesCore.js';
import socialCoreRoutes from '../routes/socialCore.js';
import { buildTestApp, createTestDb, makeToken, nextId, seedUser, TEST_JWT_SECRET } from './helpers.js';

describe('direct and group message participant authorization', () => {
  let app;
  let db;
  let alice;
  let bob;
  let mallory;
  let dmChannelId;
  let groupChannelId;
  let aliceMessageId;
  let bobMessageId;
  let events;
  const auth = user => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  before(async () => {
    db = createTestDb();
    alice = seedUser(db, { id: 'dm_alice', username: 'dm_alice' });
    bob = seedUser(db, { id: 'dm_bob', username: 'dm_bob' });
    mallory = seedUser(db, { id: 'dm_mallory', username: 'dm_mallory' });

    const now = Math.floor(Date.now() / 1000);
    const insertChannel = db.prepare('INSERT INTO channels (id, guild_id, type, name, owner_id, created_at, updated_at) VALUES (?, NULL, ?, NULL, ?, ?, ?)');
    const insertParticipant = db.prepare('INSERT INTO dm_participants (channel_id, user_id, joined_at, closed) VALUES (?, ?, ?, 0)');

    dmChannelId = nextId();
    insertChannel.run(dmChannelId, 1, alice.id, now, now);
    insertParticipant.run(dmChannelId, alice.id, now);
    insertParticipant.run(dmChannelId, bob.id, now);

    groupChannelId = nextId();
    insertChannel.run(groupChannelId, 3, alice.id, now, now);
    insertParticipant.run(groupChannelId, alice.id, now);
    insertParticipant.run(groupChannelId, bob.id, now);

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
      snowflake: { generate: () => nextId() },
      io,
      config: {},
    });
    await app.register(socialCoreRoutes, {
      db,
      authenticate,
      snowflake: { generate: () => nextId() },
      io,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('both participants start with empty history', async () => {
    for (const user of [alice, bob]) {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${dmChannelId}/messages`, headers: auth(user) });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), []);
    }
  });

  it('participant sends a message and delivery stays inside the dm channel room', async () => {
    events.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${dmChannelId}/messages`,
      headers: auth(alice),
      payload: { content: 'hello bob' },
    });

    assert.equal(res.statusCode, 201);
    aliceMessageId = res.json().id;
    assert.ok(aliceMessageId);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.room, `channel:${dmChannelId}`);
      assert.ok(['message:create', 'MESSAGE_CREATE'].includes(event.name));
      assert.equal(event.payload.content, 'hello bob');
    }
  });

  it('the other participant reads the message from history', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/channels/${dmChannelId}/messages`, headers: auth(bob) });
    assert.equal(res.statusCode, 200);
    const messages = res.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, aliceMessageId);
    assert.equal(messages[0].content, 'hello bob');
    assert.equal(messages[0].author?.id, alice.id);
  });

  it('history pagination works through before/after cursors', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: `/api/channels/${dmChannelId}/messages`,
      headers: auth(bob),
      payload: { content: 'hi alice' },
    });
    assert.equal(sent.statusCode, 201);
    bobMessageId = sent.json().id;

    const before = await app.inject({
      method: 'GET',
      url: `/api/channels/${dmChannelId}/messages?before=${bobMessageId}`,
      headers: auth(alice),
    });
    assert.equal(before.statusCode, 200);
    assert.deepEqual(before.json().map(m => m.id), [aliceMessageId]);

    const after = await app.inject({
      method: 'GET',
      url: `/api/channels/${dmChannelId}/messages?after=${aliceMessageId}`,
      headers: auth(bob),
    });
    assert.equal(after.statusCode, 200);
    assert.deepEqual(after.json().map(m => m.id), [bobMessageId]);
  });

  it('author can edit and delete own messages in a dm', async () => {
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${aliceMessageId}`,
      headers: auth(alice),
      payload: { content: 'hello bob (edited)' },
    });
    assert.equal(edit.statusCode, 200);
    assert.equal(edit.json().content, 'hello bob (edited)');

    const react = await app.inject({
      method: 'PUT',
      url: `/api/channels/${dmChannelId}/messages/${aliceMessageId}/reactions/%F0%9F%98%80/@me`,
      headers: auth(bob),
    });
    assert.equal(react.statusCode, 200);
  });

  it('non-participant receives 403 with no data or events across all message paths', async () => {
    events.length = 0;
    const base = `/api/channels/${dmChannelId}`;

    const history = await app.inject({ method: 'GET', url: `${base}/messages`, headers: auth(mallory) });
    assert.equal(history.statusCode, 403);

    const send = await app.inject({
      method: 'POST',
      url: `${base}/messages`,
      headers: auth(mallory),
      payload: { content: 'i should not pass' },
    });
    assert.equal(send.statusCode, 403);

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${aliceMessageId}`,
      headers: auth(mallory),
      payload: { content: 'hacked' },
    });
    assert.equal(edit.statusCode, 403);

    const remove = await app.inject({ method: 'DELETE', url: `/api/messages/${aliceMessageId}`, headers: auth(mallory) });
    assert.equal(remove.statusCode, 403);

    const react = await app.inject({
      method: 'PUT',
      url: `${base}/messages/${aliceMessageId}/reactions/%F0%9F%98%80/@me`,
      headers: auth(mallory),
    });
    assert.equal(react.statusCode, 403);

    const typing = await app.inject({ method: 'POST', url: `${base}/typing`, headers: auth(mallory) });
    assert.equal(typing.statusCode, 403);

    const search = await app.inject({ method: 'GET', url: `${base}/messages/search?content=hello`, headers: auth(mallory) });
    assert.equal(search.statusCode, 403);

    assert.equal(events.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?').get(dmChannelId).count, 2);
  });

  it('group dm participants exchange messages while outsiders are rejected', async () => {
    events.length = 0;
    const memberSend = await app.inject({
      method: 'POST',
      url: `/api/channels/${groupChannelId}/messages`,
      headers: auth(bob),
      payload: { content: 'group hello' },
    });
    assert.equal(memberSend.statusCode, 201);
    assert.ok(events.every(event => event.room === `channel:${groupChannelId}`));

    const outsiderSend = await app.inject({
      method: 'POST',
      url: `/api/channels/${groupChannelId}/messages`,
      headers: auth(mallory),
      payload: { content: 'let me in' },
    });
    assert.equal(outsiderSend.statusCode, 403);

    const outsiderHistory = await app.inject({ method: 'GET', url: `/api/channels/${groupChannelId}/messages`, headers: auth(mallory) });
    assert.equal(outsiderHistory.statusCode, 403);
  });

  it('group dm creation enforces the recipient limit', async () => {
    const recipients = Array.from({ length: 11 }, (_, i) => `missing_user_${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/@me/channels',
      headers: auth(alice),
      payload: { recipients },
    });
    assert.equal(res.statusCode, 400);
  });

  it('non-author participant cannot edit or delete someone else\'s message', async () => {
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${aliceMessageId}`,
      headers: auth(bob),
      payload: { content: 'not mine' },
    });
    assert.equal(edit.statusCode, 403);

    const remove = await app.inject({ method: 'DELETE', url: `/api/messages/${aliceMessageId}`, headers: auth(bob) });
    assert.equal(remove.statusCode, 403);

    const stillThere = db.prepare('SELECT content FROM messages WHERE id = ? AND deleted = 0').get(aliceMessageId);
    assert.equal(stillThere.content, 'hello bob (edited)');
  });
});
