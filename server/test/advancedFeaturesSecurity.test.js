import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import advancedFeaturesRoutes from '../routes/advancedFeatures.js';
import { SnowflakeGenerator } from '../snowflake.js';
import { buildTestApp, createTestDb, seedUser, seedGuild, seedMember, seedRole, seedChannel, makeToken, TEST_JWT_SECRET } from './helpers.js';
import jwt from 'jsonwebtoken';

describe('advanced feature object scoping', () => {
  let app, db, events, owner, attacker, guild, otherGuild, channel, otherChannel;
  const auth = (user) => ({ authorization: `Bearer ${makeToken(user.id, user.username)}` });

  before(async () => {
    db = createTestDb();
    owner = seedUser(db, { id: 'adv_owner', username: 'adv_owner' });
    attacker = seedUser(db, { id: 'adv_attacker', username: 'adv_attacker' });
    guild = seedGuild(db, owner.id, { id: 'adv_guild' });
    otherGuild = seedGuild(db, owner.id, { id: 'adv_other_guild' });
    channel = guild.channel;
    otherChannel = otherGuild.channel;
    seedMember(db, guild.guildId, attacker.id);
    const manager = seedRole(db, guild.guildId, {
      id: 'adv_manager',
      permissions: ((1n << 30n) | (1n << 33n) | (1n << 5n) | (1n << 13n) | (1n << 10n) | (1n << 12n) | (1n << 11n) | (1n << 20n)).toString(),
    });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.guildId, attacker.id, manager.id);

    db.prepare(`INSERT INTO soundboard_sounds (id, guild_id, name, volume, file, created_at) VALUES (?, ?, ?, 1, ?, 1)`).run('adv_sound_other', otherGuild.guildId, 'private sound', 'private.ogg');
    db.prepare(`INSERT INTO stickers (id, guild_id, name, type, format_type, created_at) VALUES (?, ?, ?, 2, 1, 1)`).run('adv_sticker_other', otherGuild.guildId, 'private sticker');
    db.prepare(`INSERT INTO automod_rules (id, guild_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, created_at) VALUES (?, ?, ?, ?, 1, 1, '{}', '[]', 1)`).run('adv_rule_other', otherGuild.guildId, 'private rule', owner.id);
    db.prepare(`INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, scheduled_start_time, entity_type, status, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1)`).run('adv_event_other', otherGuild.guildId, otherChannel.id, owner.id, 'private event');
    db.prepare(`INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) VALUES (?, ?, ?, ?, '', 1)`).run('adv_poll_other', otherChannel.id, otherGuild.guildId, owner.id);
    db.prepare(`INSERT INTO polls (message_id, question, expiry) VALUES (?, ?, 9999999999)`).run('adv_poll_other', 'private poll');
    db.prepare(`INSERT INTO poll_answers (id, message_id, text) VALUES (1, ?, 'yes')`).run('adv_poll_other');

    const testApp = buildTestApp({ db });
    app = testApp.app;
    const authenticate = async (req, reply) => {
      const header = req.headers.authorization || '';
      try {
        const payload = jwt.verify(header.slice(7), TEST_JWT_SECRET);
        req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!req.user) return reply.code(401).send({ error: 'Invalid token user' });
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    };
    events = [];
    const io = {
      emit: (name, payload) => events.push({ name, payload }),
      to: () => ({ emit: (name, payload) => events.push({ name, payload }) }),
    };
    await app.register(advancedFeaturesRoutes, { db, authenticate, snowflake: new SnowflakeGenerator(1, 1), io });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  it('rejects cross-guild object IDs without disclosing objects', async () => {
    const routes = [
      ['PATCH', `/api/guilds/${guild.guildId}/soundboard-sounds/adv_sound_other`, { name: 'changed' }],
      ['DELETE', `/api/guilds/${guild.guildId}/stickers/adv_sticker_other`],
      ['PATCH', `/api/guilds/${guild.guildId}/auto-moderation/rules/adv_rule_other`, { name: 'changed' }],
      ['DELETE', `/api/guilds/${guild.guildId}/scheduled-events/adv_event_other`],
      ['GET', `/api/guilds/${guild.guildId}/scheduled-events/adv_event_other`],
    ];
    for (const [method, url, payload] of routes) {
      const res = await app.inject({ method, url, headers: auth(owner), payload });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
    assert.equal(db.prepare('SELECT name FROM soundboard_sounds WHERE id = ?').get('adv_sound_other').name, 'private sound');
    assert.equal(db.prepare('SELECT name FROM stickers WHERE id = ?').get('adv_sticker_other').name, 'private sticker');
  });

  it('denies guild reads to a user from another guild', async () => {
    for (const url of [
      `/api/guilds/${otherGuild.guildId}/soundboard-sounds`,
      `/api/guilds/${otherGuild.guildId}/stickers`,
      `/api/guilds/${otherGuild.guildId}/auto-moderation/rules`,
      `/api/guilds/${otherGuild.guildId}/scheduled-events`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(attacker) });
      assert.equal(res.statusCode, 403, url);
    }
  });

  it('rejects cross-channel polls and does not emit an event', async () => {
    events.length = 0;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}/polls/adv_poll_other/answers/1/@me`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM poll_votes WHERE message_id = ?').get('adv_poll_other').count, 0);
    assert.equal(events.length, 0);
  });

  it('rejects sound playback from a different guild and does not emit', async () => {
    events.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/soundboard`,
      headers: auth(owner),
      payload: { sound_id: 'adv_sound_other' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(events.length, 0);
  });

  it('rejects RSVP to an event from another guild', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/guilds/${guild.guildId}/scheduled-events/adv_event_other/users/@me`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_event_users WHERE event_id = ?').get('adv_event_other').count, 0);
  });
});
