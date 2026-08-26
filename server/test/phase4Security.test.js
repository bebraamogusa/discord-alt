import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import phase4Routes from '../routes/phase4Core.js';
import { SnowflakeGenerator } from '../snowflake.js';
import {
  buildTestApp,
  createTestDb,
  makeToken,
  seedGuild,
  seedUser,
  TEST_JWT_SECRET,
} from './helpers.js';

describe('phase 4 cross-guild security', () => {
  let app;
  let db;
  let events;
  let attacker;
  let owner;
  let guild;
  let otherGuild;
  let message;
  let otherMessage;

  const auth = (user) => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  before(async () => {
    db = createTestDb();
    attacker = seedUser(db, { id: 'phase4_attacker', username: 'phase4_attacker' });
    owner = seedUser(db, { id: 'phase4_owner', username: 'phase4_owner' });
    guild = seedGuild(db, attacker.id, { id: 'phase4_guild' });
    otherGuild = seedGuild(db, owner.id, { id: 'phase4_other_guild' });

    message = { id: 'phase4_message', channelId: guild.channelId, guildId: guild.guildId, authorId: attacker.id };
    otherMessage = { id: 'phase4_other_message', channelId: otherGuild.channelId, guildId: otherGuild.guildId, authorId: owner.id };
    const insertMessage = db.prepare(`
      INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at)
      VALUES (?, ?, ?, ?, '', 1)
    `);
    insertMessage.run(message.id, message.channelId, message.guildId, message.authorId);
    insertMessage.run(otherMessage.id, otherMessage.channelId, otherMessage.guildId, otherMessage.authorId);

    const testApp = buildTestApp({ db });
    app = testApp.app;
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
    const io = {
      to: () => ({ emit: (name, payload) => events.push({ name, payload }) }),
    };
    await app.register(phase4Routes, {
      prefix: '/api/v1',
      db,
      authenticate,
      snowflake: new SnowflakeGenerator(1, 1),
      io,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('rejects cross-guild emoji reads and creation without mutation or events', async () => {
    events.length = 0;
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/guilds/${otherGuild.guildId}/emojis`,
      headers: auth(attacker),
    });
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/guilds/${otherGuild.guildId}/emojis`,
      headers: auth(attacker),
      payload: { name: 'private', image_url: 'data:image/png;base64,abc' },
    });

    assert.equal(read.statusCode, 403);
    assert.equal(create.statusCode, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM emojis WHERE guild_id = ?').get(otherGuild.guildId).count, 0);
    assert.equal(events.length, 0);
  });

  it('rejects cross-guild thread creation without mutation or events', async () => {
    events.length = 0;
    const before = db.prepare('SELECT COUNT(*) AS count FROM channels WHERE guild_id = ?').get(otherGuild.guildId).count;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${otherGuild.channelId}/messages/${otherMessage.id}/threads`,
      headers: auth(attacker),
      payload: { name: 'private thread' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM channels WHERE guild_id = ?').get(otherGuild.guildId).count, before);
    assert.equal(events.length, 0);
  });

  it('rejects cross-guild AutoMod creation without mutation or events', async () => {
    events.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/guilds/${otherGuild.guildId}/automod/rules`,
      headers: auth(attacker),
      payload: { name: 'private rule', event_type: 1, trigger_type: 1, actions: [] },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM automod_rules WHERE guild_id = ?').get(otherGuild.guildId).count, 0);
    assert.equal(events.length, 0);
  });
});
