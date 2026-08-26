import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionService, Permissions, parsePermissions, serializePermissions, can } from '../services/permissions.js';
import { createTestDb, seedUser, seedGuild, seedRole, seedMember, seedChannel, nextId } from './helpers.js';

const CONNECT = 1n << 20n;

describe('permissions', () => {
  let db, perms;
  let owner, member1, nonMember;
  let guild, channel, everyoneRole;

  before(() => {
    db = createTestDb();
    perms = buildPermissionService(db);

    owner = seedUser(db, { id: 'owner_1', username: 'owner1' });
    member1 = seedUser(db, { id: 'member_1', username: 'member1' });
    nonMember = seedUser(db, { id: 'nonmember_1', username: 'nonmember1' });

    const g = seedGuild(db, owner.id);
    guild = g.guild;
    channel = g.channel;
    everyoneRole = g.everyoneRole;

    seedMember(db, guild.id, member1.id);
  });

  after(() => { db.close(); });

  it('owner gets all permissions', () => {
    const bits = perms.getGuildPermissions(guild.id, owner.id);
    assert.ok(bits !== null);
    assert.ok(can(bits, Permissions.ADMINISTRATOR));
    assert.ok(can(bits, Permissions.MANAGE_GUILD));
    assert.ok(can(bits, Permissions.MANAGE_ROLES));
    assert.ok(can(bits, Permissions.BAN_MEMBERS));
  });

  it('non-member gets null', () => {
    const bits = perms.getGuildPermissions(guild.id, nonMember.id);
    assert.equal(bits, null);
  });

  it('member with @everyone gets base permissions', () => {
    const bits = perms.getGuildPermissions(guild.id, member1.id);
    assert.ok(bits !== null);
    assert.ok(can(bits, Permissions.VIEW_CHANNEL));
    assert.ok(can(bits, Permissions.SEND_MESSAGES));
    assert.ok(can(bits, Permissions.CREATE_INSTANT_INVITE));
    assert.ok(!can(bits, Permissions.MANAGE_GUILD));
    assert.ok(!can(bits, Permissions.MANAGE_ROLES));
  });

  it('role permission aggregation: union of all roles', () => {
    const extraPerms = Permissions.MANAGE_ROLES | Permissions.BAN_MEMBERS;
    const role = seedRole(db, guild.id, { name: 'mod', position: 1, permissions: extraPerms.toString() });
    db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(guild.id, member1.id, role.id);
    perms.clearCache();

    const bits = perms.getGuildPermissions(guild.id, member1.id);
    assert.ok(bits !== null);
    assert.ok(can(bits, Permissions.VIEW_CHANNEL));
    assert.ok(can(bits, Permissions.MANAGE_ROLES));
    assert.ok(can(bits, Permissions.BAN_MEMBERS));
  });

  it('channel VIEW_CHANNEL: role-based deny works', () => {
    db.prepare(`
      INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
      VALUES (?, ?, 0, '0', ?)
      ON CONFLICT(channel_id, target_id) DO UPDATE SET deny = excluded.deny
    `).run(channel.id, everyoneRole.id, Permissions.VIEW_CHANNEL.toString());
    perms.clearCache();

    const bits = perms.getChannelPermissions(channel.id, member1.id);
    assert.ok(!can(bits, Permissions.VIEW_CHANNEL));
  });

  it('channel permission: role-based allow overrides deny', () => {
    db.prepare(`
      INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
      VALUES (?, ?, 0, ?, '0')
      ON CONFLICT(channel_id, target_id) DO UPDATE SET allow = excluded.allow
    `).run(channel.id, everyoneRole.id, Permissions.VIEW_CHANNEL.toString());
    perms.clearCache();

    const bits = perms.getChannelPermissions(channel.id, member1.id);
    assert.ok(can(bits, Permissions.VIEW_CHANNEL));
  });

  it('channel CONNECT permission for voice', () => {
    const voiceChannel = seedChannel(db, guild.id, { name: 'voice', type: 2 });
    perms.clearCache();

    const bits = perms.getChannelPermissions(voiceChannel.id, member1.id);
    assert.ok(!can(bits, CONNECT));
  });

  it('channel CONNECT: allow overwrite grants access', () => {
    const voiceChannel = seedChannel(db, guild.id, { name: 'voice2', type: 2 });
    db.prepare(`
      INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
      VALUES (?, ?, 0, ?, '0')
    `).run(voiceChannel.id, everyoneRole.id, CONNECT.toString());
    perms.clearCache();

    const bits = perms.getChannelPermissions(voiceChannel.id, member1.id);
    assert.ok(can(bits, CONNECT));
  });

  it('member-specific overwrite overrides role overwrites', () => {
    db.prepare(`
      INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
      VALUES (?, ?, 1, '0', ?)
      ON CONFLICT(channel_id, target_id) DO UPDATE SET deny = excluded.deny
    `).run(channel.id, member1.id, Permissions.VIEW_CHANNEL.toString());
    perms.clearCache();

    const bits = perms.getChannelPermissions(channel.id, member1.id);
    assert.ok(!can(bits, Permissions.VIEW_CHANNEL));
  });

  it('hasChannelPermission returns false for non-member', () => {
    const ok = perms.hasChannelPermission(channel.id, nonMember.id, Permissions.VIEW_CHANNEL);
    assert.equal(ok, false);
  });

  it('hasGuildPermission returns false for non-member', () => {
    const ok = perms.hasGuildPermission(guild.id, nonMember.id, Permissions.VIEW_CHANNEL);
    assert.equal(ok, false);
  });
});

describe('permissions utility functions', () => {
  it('parsePermissions handles bigint string', () => {
    assert.equal(parsePermissions('42'), 42n);
  });

  it('parsePermissions handles JSON object', () => {
    const bits = parsePermissions('{"view_channel":true,"send_messages":true}');
    assert.ok(can(bits, Permissions.VIEW_CHANNEL));
    assert.ok(can(bits, Permissions.SEND_MESSAGES));
    assert.ok(!can(bits, Permissions.MANAGE_GUILD));
  });

  it('parsePermissions handles null/empty', () => {
    assert.equal(parsePermissions(null), 0n);
    assert.equal(parsePermissions(''), 0n);
  });

  it('serializePermissions round-trips', () => {
    const bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
    const serialized = serializePermissions(bits);
    assert.equal(parsePermissions(serialized), bits);
  });

  it('can returns true for ADMINISTRATOR even without specific perm', () => {
    assert.ok(can(Permissions.ADMINISTRATOR, Permissions.MANAGE_GUILD));
    assert.ok(can(Permissions.ADMINISTRATOR, Permissions.BAN_MEMBERS));
  });
});
