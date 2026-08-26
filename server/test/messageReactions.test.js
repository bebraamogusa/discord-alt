import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import messagesCoreRoutes from '../routes/messagesCore.js';
import { buildTestApp, createTestDb, makeToken, seedGuild, seedUser, TEST_JWT_SECRET } from './helpers.js';

describe('canonical message reactions', () => {
  let app;
  let db;
  let owner;
  let outsider;
  let guild;
  let events;
  const messageId = 'reaction_message';
  const auth = user => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  before(async () => {
    db = createTestDb();
    owner = seedUser(db, { id: 'reaction_owner', username: 'reaction_owner' });
    outsider = seedUser(db, { id: 'reaction_outsider', username: 'reaction_outsider' });
    guild = seedGuild(db, owner.id, { id: 'reaction_guild' });
    db.prepare(`
      INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at)
      VALUES (?, ?, ?, ?, 'react here', 1)
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

  it('adds and removes through the channel-scoped @me route exactly once', async () => {
    const url = `/api/channels/${guild.channelId}/messages/${messageId}/reactions/%F0%9F%98%80/@me`;
    const firstAdd = await app.inject({ method: 'PUT', url, headers: auth(owner) });
    const duplicateAdd = await app.inject({ method: 'PUT', url, headers: auth(owner) });

    assert.equal(firstAdd.statusCode, 200);
    assert.equal(duplicateAdd.statusCode, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?').get(messageId).count, 1);
    assert.deepEqual(events.map(event => event.name), ['MESSAGE_REACTION_ADD']);
    assert.equal(events[0].room, `guild:${guild.guildId}`);
    assert.deepEqual(events[0].payload.emoji, { name: '😀' });

    const firstRemove = await app.inject({ method: 'DELETE', url, headers: auth(owner) });
    const duplicateRemove = await app.inject({ method: 'DELETE', url, headers: auth(owner) });

    assert.equal(firstRemove.statusCode, 200);
    assert.equal(duplicateRemove.statusCode, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?').get(messageId).count, 0);
    assert.deepEqual(events.map(event => event.name), ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE']);
  });

  it('rejects users without channel access without mutation or events', async () => {
    events.length = 0;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${guild.channelId}/messages/${messageId}/reactions/%F0%9F%94%92/@me`,
      headers: auth(outsider),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?').get(messageId).count, 0);
    assert.equal(events.length, 0);
  });
});
