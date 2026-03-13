import { Permissions, buildPermissionService, serializePermissions } from '../services/permissions.js';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function nonEmptyText(value, min = 1, max = 100) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) return null;
  return text;
}

function mapGuild(row) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    banner: row.banner,
    description: row.description,
    owner_id: row.owner_id,
    preferred_locale: row.preferred_locale,
    features: row.features,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default async function guildsCoreRoutes(fastify, { db, authenticate, snowflake, io }) {
  const permissions = buildPermissionService(db);

  const getGuildById = db.prepare('SELECT * FROM guilds WHERE id = ?');
  const getGuildsForUser = db.prepare(`
    SELECT g.*
    FROM guilds g
    JOIN guild_members gm ON gm.guild_id = g.id
    WHERE gm.user_id = ?
    ORDER BY gm.joined_at ASC
  `);
  const getGuildMember = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?');
  const getUserById = db.prepare('SELECT id, username, display_name, avatar, banner, status FROM users WHERE id = ?');
  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getRoleById = db.prepare('SELECT * FROM roles WHERE id = ?');
  const getInviteByCode = db.prepare('SELECT * FROM invites WHERE code = ?');
  const getInvitesByGuild = db.prepare('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC');
  const getInvitesByChannel = db.prepare('SELECT * FROM invites WHERE channel_id = ? ORDER BY created_at DESC');
  const getFirstTextChannel = db.prepare('SELECT * FROM channels WHERE guild_id = ? AND type = 0 ORDER BY position ASC, created_at ASC LIMIT 1');

  const insertGuild = db.prepare(`
    INSERT INTO guilds (id, name, owner_id, description, preferred_locale, features, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'en-US', '[]', ?, ?)
  `);

  const insertMember = db.prepare(`
    INSERT INTO guild_members (guild_id, user_id, joined_at)
    VALUES (?, ?, ?)
  `);

  const insertRole = db.prepare(`
    INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, managed, mentionable, flags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMemberRole = db.prepare(
    'INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
  );

  const insertChannel = db.prepare(`
    INSERT INTO channels (
      id, guild_id, type, name, topic, position, parent_id, nsfw,
      rate_limit_per_user, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateGuild = db.prepare(`
    UPDATE guilds
    SET name = coalesce(?, name),
        description = ?,
        icon = ?,
        banner = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const updateRole = db.prepare(`
    UPDATE roles
    SET name = coalesce(?, name),
        color = coalesce(?, color),
        hoist = coalesce(?, hoist),
        mentionable = coalesce(?, mentionable),
        permissions = coalesce(?, permissions),
        position = coalesce(?, position)
    WHERE id = ? AND guild_id = ?
  `);

  const updateChannel = db.prepare(`
    UPDATE channels
    SET name = coalesce(?, name),
        topic = coalesce(?, topic),
        parent_id = ?,
        nsfw = coalesce(?, nsfw),
        rate_limit_per_user = coalesce(?, rate_limit_per_user),
        position = coalesce(?, position),
        updated_at = ?
    WHERE id = ?
  `);

  const updateGuildMember = db.prepare(`
    UPDATE guild_members
    SET nickname = ?,
        mute = ?,
        deaf = ?,
        communication_disabled_until = ?
    WHERE guild_id = ? AND user_id = ?
  `);

  const updateGuildMemberNickname = db.prepare(`
    UPDATE guild_members
    SET nickname = ?
    WHERE guild_id = ? AND user_id = ?
  `);

  const clearMemberRoles = db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?');

  const getRolesForMemberDetailed = db.prepare(`
    SELECT r.id, r.position
    FROM member_roles mr
    JOIN roles r ON r.id = mr.role_id
    WHERE mr.guild_id = ? AND mr.user_id = ?
    ORDER BY r.position DESC
  `);

  const getBanForUser = db.prepare('SELECT * FROM bans WHERE guild_id = ? AND user_id = ?');
  const getBansForGuild = db.prepare(`
    SELECT b.guild_id, b.user_id, b.reason, b.banned_by, b.created_at,
           u.username, u.display_name, u.avatar
    FROM bans b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.guild_id = ?
    ORDER BY b.created_at DESC
  `);

  const upsertBan = db.prepare(`
    INSERT INTO bans (guild_id, user_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at
  `);

  const deleteBan = db.prepare('DELETE FROM bans WHERE guild_id = ? AND user_id = ?');
  const deleteRecentMessagesByAuthorInGuild = db.prepare(`
    DELETE FROM messages
    WHERE guild_id = ?
      AND author_id = ?
      AND created_at >= ?
  `);

  const getVoiceState = db.prepare('SELECT * FROM voice_states WHERE guild_id = ? AND user_id = ?');
  const updateVoiceStateChannel = db.prepare('UPDATE voice_states SET channel_id = ? WHERE guild_id = ? AND user_id = ?');

  const deleteGuild = db.prepare('DELETE FROM guilds WHERE id = ?');
  const deleteRole = db.prepare('DELETE FROM roles WHERE id = ? AND guild_id = ?');
  const deleteChannel = db.prepare('DELETE FROM channels WHERE id = ?');
  const deleteInviteByCode = db.prepare('DELETE FROM invites WHERE code = ?');
  const deleteMemberRole = db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?');
  const deleteGuildMember = db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?');
  const deleteOverwritesForTarget = db.prepare('DELETE FROM channel_permission_overwrites WHERE channel_id = ? AND target_id = ?');

  const getRolesForGuild = db.prepare('SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC, created_at ASC');
  const getChannelsForGuild = db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY position ASC, created_at ASC');
  const getMembersForGuild = db.prepare(`
    SELECT
      gm.guild_id, gm.user_id, gm.nickname, gm.joined_at, gm.deaf, gm.mute, gm.pending, gm.communication_disabled_until, gm.flags,
      u.username, u.display_name, u.avatar, u.banner, u.status
    FROM guild_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.guild_id = ?
    ORDER BY gm.joined_at ASC
  `);
  const getRoleIdsForMember = db.prepare('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?');

  const insertInvite = db.prepare(`
    INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_age, max_uses, uses, temporary, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);

  const incrementInviteUse = db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?');

  const upsertOverwrite = db.prepare(`
    INSERT INTO channel_permission_overwrites (channel_id, target_id, target_type, allow, deny)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, target_id)
    DO UPDATE SET target_type = excluded.target_type, allow = excluded.allow, deny = excluded.deny
  `);

  const getOverwrite = db.prepare('SELECT * FROM channel_permission_overwrites WHERE channel_id = ? AND target_id = ?');

  const updateRolePosition = db.prepare('UPDATE roles SET position = ? WHERE id = ? AND guild_id = ?');
  const updateChannelPositionParent = db.prepare('UPDATE channels SET position = ?, parent_id = ?, updated_at = ? WHERE id = ? AND guild_id = ?');

  function highestRolePosition(guildId, userId) {
    const rows = getRolesForMemberDetailed.all(guildId, userId);
    if (!rows.length) return 0;
    return rows[0].position;
  }

  function canActOnMember(guild, actorId, targetId, allowSelf = false) {
    if (actorId === targetId) return allowSelf;
    if (targetId === guild.owner_id) return false;
    if (actorId === guild.owner_id) return true;
    const actorHighest = highestRolePosition(guild.id, actorId);
    const targetHighest = highestRolePosition(guild.id, targetId);
    return actorHighest > targetHighest;
  }

  function canManageRole(guild, actorId, roleId) {
    const role = getRoleById.get(roleId);
    if (!role || role.guild_id !== guild.id) return false;
    if (actorId === guild.owner_id) return true;
    return highestRolePosition(guild.id, actorId) > role.position;
  }

  function randomInviteCode() {
    return snowflake.generate().slice(-8).toLowerCase();
  }

  function inviteSummary(invite) {
    return {
      code: invite.code,
      guild_id: invite.guild_id,
      channel_id: invite.channel_id,
      inviter_id: invite.inviter_id,
      max_age: invite.max_age,
      max_uses: invite.max_uses,
      uses: invite.uses,
      temporary: invite.temporary,
      created_at: invite.created_at,
      expires_at: invite.expires_at,
    };
  }

  function requireGuild(guildId, reply) {
    const guild = getGuildById.get(guildId);
    if (!guild) {
      reply.code(404).send({ error: 'Guild not found' });
      return null;
    }
    return guild;
  }

  function requireGuildMemberAccess(guildId, userId, reply) {
    const guild = requireGuild(guildId, reply);
    if (!guild) return null;
    const member = getGuildMember.get(guildId, userId);
    if (!member) {
      reply.code(403).send({ error: 'Not a guild member' });
      return null;
    }
    return guild;
  }

  function guildSnapshot(guildId) {
    const guild = getGuildById.get(guildId);
    if (!guild) return null;

    const roles = getRolesForGuild.all(guildId).map((row) => ({
      id: row.id,
      guild_id: row.guild_id,
      name: row.name,
      color: row.color,
      hoist: row.hoist,
      position: row.position,
      permissions: row.permissions,
      managed: row.managed,
      mentionable: row.mentionable,
      created_at: row.created_at,
    }));

    const channels = getChannelsForGuild.all(guildId).map((row) => ({
      id: row.id,
      guild_id: row.guild_id,
      type: row.type,
      name: row.name,
      topic: row.topic,
      position: row.position,
      parent_id: row.parent_id,
      nsfw: row.nsfw,
      rate_limit_per_user: row.rate_limit_per_user,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return {
      guild: mapGuild(guild),
      roles,
      channels,
    };
  }

  fastify.post('/api/guilds', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const name = nonEmptyText(req.body.name, 2, 100);
    if (!name) return reply.code(400).send({ error: 'Invalid guild name' });

    const guildId = snowflake.generate();
    const now = nowSec();
    const everyoneRoleId = guildId;
    const generalChannelId = snowflake.generate();

    db.transaction(() => {
      insertGuild.run(guildId, name, req.user.id, req.body.description ? String(req.body.description).slice(0, 500) : null, now, now);
      insertMember.run(guildId, req.user.id, now);

      let everyonePerms = 0n;
      everyonePerms |= Permissions.VIEW_CHANNEL;
      everyonePerms |= Permissions.SEND_MESSAGES;
      everyonePerms |= Permissions.CREATE_INSTANT_INVITE;

      insertRole.run(
        everyoneRoleId,
        guildId,
        '@everyone',
        0,
        0,
        0,
        serializePermissions(everyonePerms),
        0,
        0,
        0,
        now
      );

      insertMemberRole.run(guildId, req.user.id, everyoneRoleId);

      insertChannel.run(
        generalChannelId,
        guildId,
        0,
        'general',
        null,
        0,
        null,
        0,
        0,
        now,
        now
      );
    })();

    const snapshot = guildSnapshot(guildId);
    io?.to(`user:${req.user.id}`)?.emit('guild:create', snapshot);
    return reply.code(201).send(snapshot);
  });

  fastify.get('/api/guilds/@me', { preHandler: authenticate }, async (req) => {
    return getGuildsForUser.all(req.user.id).map(mapGuild);
  });

  fastify.get('/api/guilds/:guildId', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    const snapshot = guildSnapshot(guild.id);
    const myRoleIds = getRoleIdsForMember.all(guild.id, req.user.id).map((row) => row.role_id);

    return {
      ...snapshot,
      my_role_ids: myRoleIds,
    };
  });

  fastify.patch('/api/guilds/:guildId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: ['string', 'null'], maxLength: 500 },
          icon: { type: ['string', 'null'], maxLength: 2048 },
          banner: { type: ['string', 'null'], maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_GUILD)) {
      return reply.code(403).send({ error: 'Missing MANAGE_GUILD permission' });
    }

    const body = req.body || {};
    const nextName = body.name !== undefined ? nonEmptyText(body.name, 2, 100) : null;
    if (body.name !== undefined && !nextName) {
      return reply.code(400).send({ error: 'Invalid guild name' });
    }

    updateGuild.run(
      nextName,
      body.description !== undefined ? body.description : guild.description,
      body.icon !== undefined ? body.icon : guild.icon,
      body.banner !== undefined ? body.banner : guild.banner,
      nowSec(),
      guild.id
    );

    const updated = getGuildById.get(guild.id);
    const payload = mapGuild(updated);
    io?.to(`guild:${guild.id}`)?.emit('guild:update', payload);
    return payload;
  });

  fastify.delete('/api/guilds/:guildId', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuild(req.params.guildId, reply);
    if (!guild) return;

    if (guild.owner_id !== req.user.id) {
      return reply.code(403).send({ error: 'Only guild owner can delete guild' });
    }

    deleteGuild.run(guild.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:delete', { guild_id: guild.id });
    return { ok: true };
  });

  fastify.post('/api/guilds/:guildId/leave', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuild(req.params.guildId, reply);
    if (!guild) return;

    if (guild.owner_id === req.user.id) {
      return reply.code(400).send({ error: 'Owner cannot leave guild' });
    }

    const member = getGuildMember.get(guild.id, req.user.id);
    if (!member) {
      return reply.code(404).send({ error: 'Membership not found' });
    }

    db.transaction(() => {
      deleteGuildMember.run(guild.id, req.user.id);
      db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?').run(guild.id, req.user.id);
    })();

    io?.to(`guild:${guild.id}`)?.emit('guild:member:remove', { guild_id: guild.id, user_id: req.user.id });
    return { ok: true };
  });

  fastify.get('/api/guilds/:guildId/members', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    const rows = getMembersForGuild.all(guild.id);
    const out = rows.map((row) => ({
      guild_id: row.guild_id,
      user: {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        avatar: row.avatar,
        banner: row.banner,
        status: row.status,
      },
      nickname: row.nickname,
      joined_at: row.joined_at,
      deaf: row.deaf,
      mute: row.mute,
      pending: row.pending,
      communication_disabled_until: row.communication_disabled_until,
      flags: row.flags,
      role_ids: getRoleIdsForMember.all(guild.id, row.user_id).map((r) => r.role_id),
    }));

    return out;
  });

  fastify.get('/api/guilds/:guildId/members/:userId', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    const member = getGuildMember.get(guild.id, req.params.userId);
    if (!member) return reply.code(404).send({ error: 'Member not found' });

    const user = getUserById.get(req.params.userId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    return {
      guild_id: guild.id,
      user,
      nickname: member.nickname,
      joined_at: member.joined_at,
      deaf: member.deaf,
      mute: member.mute,
      pending: member.pending,
      communication_disabled_until: member.communication_disabled_until,
      flags: member.flags,
      role_ids: getRoleIdsForMember.all(guild.id, req.params.userId).map((r) => r.role_id),
    };
  });

  fastify.patch('/api/guilds/:guildId/members/:userId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nickname: { type: ['string', 'null'], maxLength: 32 },
          roles: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 256 },
          mute: { type: 'integer', minimum: 0, maximum: 1 },
          deaf: { type: 'integer', minimum: 0, maximum: 1 },
          channel_id: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          communication_disabled_until: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    const targetMember = getGuildMember.get(guild.id, req.params.userId);
    if (!targetMember) return reply.code(404).send({ error: 'Target member not found' });

    const body = req.body || {};
    const isSelf = req.params.userId === req.user.id;

    if ((body.roles !== undefined || body.mute !== undefined || body.deaf !== undefined || body.communication_disabled_until !== undefined || body.channel_id !== undefined) &&
      !canActOnMember(guild, req.user.id, req.params.userId, false)) {
      return reply.code(403).send({ error: 'Role hierarchy violation' });
    }

    if (body.nickname !== undefined) {
      const canManageNick = permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_NICKNAMES);
      const canChangeOwnNick = isSelf && permissions.hasGuildPermission(guild.id, req.user.id, Permissions.CHANGE_NICKNAME);
      if (!canManageNick && !canChangeOwnNick) {
        return reply.code(403).send({ error: 'Missing nickname permission' });
      }
      if (!isSelf && !canActOnMember(guild, req.user.id, req.params.userId, false)) {
        return reply.code(403).send({ error: 'Role hierarchy violation' });
      }
    }

    if (body.roles !== undefined) {
      if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
        return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
      }

      const uniqRoleIds = [...new Set(body.roles.map((v) => String(v)))];
      for (const roleId of uniqRoleIds) {
        if (!canManageRole(guild, req.user.id, roleId)) {
          return reply.code(403).send({ error: `Cannot assign role ${roleId}` });
        }
      }

      db.transaction(() => {
        clearMemberRoles.run(guild.id, req.params.userId);
        for (const roleId of uniqRoleIds) {
          insertMemberRole.run(guild.id, req.params.userId, roleId);
        }
      })();
    }

    if (body.mute !== undefined && !permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MUTE_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing MUTE_MEMBERS permission' });
    }

    if (body.deaf !== undefined && !permissions.hasGuildPermission(guild.id, req.user.id, Permissions.DEAFEN_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing DEAFEN_MEMBERS permission' });
    }

    if (body.channel_id !== undefined) {
      if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MOVE_MEMBERS)) {
        return reply.code(403).send({ error: 'Missing MOVE_MEMBERS permission' });
      }
      if (body.channel_id !== null) {
        const targetChannel = getChannelById.get(body.channel_id);
        if (!targetChannel || targetChannel.guild_id !== guild.id || (targetChannel.type !== 2 && targetChannel.type !== 13)) {
          return reply.code(400).send({ error: 'Invalid target voice channel' });
        }
        const voiceState = getVoiceState.get(guild.id, req.params.userId);
        if (!voiceState) return reply.code(400).send({ error: 'Target member is not connected to voice' });
        updateVoiceStateChannel.run(targetChannel.id, guild.id, req.params.userId);
      }
    }

    if (body.communication_disabled_until !== undefined) {
      if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MODERATE_MEMBERS)) {
        return reply.code(403).send({ error: 'Missing MODERATE_MEMBERS permission' });
      }
    }

    const nextNickname = body.nickname !== undefined
      ? (body.nickname === null ? null : String(body.nickname).trim().slice(0, 32))
      : targetMember.nickname;

    const nextMute = body.mute !== undefined ? body.mute : targetMember.mute;
    const nextDeaf = body.deaf !== undefined ? body.deaf : targetMember.deaf;
    const nextTimeout = body.communication_disabled_until !== undefined
      ? body.communication_disabled_until
      : targetMember.communication_disabled_until;

    if (body.nickname !== undefined || body.mute !== undefined || body.deaf !== undefined || body.communication_disabled_until !== undefined) {
      updateGuildMember.run(nextNickname, nextMute, nextDeaf, nextTimeout, guild.id, req.params.userId);
    }

    const updatedMember = getGuildMember.get(guild.id, req.params.userId);
    const updated = {
      guild_id: guild.id,
      user_id: req.params.userId,
      nickname: updatedMember.nickname,
      mute: updatedMember.mute,
      deaf: updatedMember.deaf,
      communication_disabled_until: updatedMember.communication_disabled_until,
      role_ids: getRoleIdsForMember.all(guild.id, req.params.userId).map((r) => r.role_id),
    };

    io?.to(`guild:${guild.id}`)?.emit('member:update', updated);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:update', updated);

    return updated;
  });

  fastify.patch('/api/guilds/:guildId/members/@me', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['nickname'],
        additionalProperties: false,
        properties: {
          nickname: { type: ['string', 'null'], maxLength: 32 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.CHANGE_NICKNAME) &&
      !permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_NICKNAMES)) {
      return reply.code(403).send({ error: 'Missing CHANGE_NICKNAME permission' });
    }

    const nickname = req.body.nickname === null ? null : String(req.body.nickname).trim().slice(0, 32);
    updateGuildMemberNickname.run(nickname, guild.id, req.user.id);

    const member = getGuildMember.get(guild.id, req.user.id);
    const payload = {
      guild_id: guild.id,
      user_id: req.user.id,
      nickname: member.nickname,
      role_ids: getRoleIdsForMember.all(guild.id, req.user.id).map((r) => r.role_id),
    };
    io?.to(`guild:${guild.id}`)?.emit('member:update', payload);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:update', payload);

    return payload;
  });

  fastify.delete('/api/guilds/:guildId/members/:userId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.KICK_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing KICK_MEMBERS permission' });
    }

    if (!canActOnMember(guild, req.user.id, req.params.userId, false)) {
      return reply.code(403).send({ error: 'Role hierarchy violation' });
    }

    const targetMember = getGuildMember.get(guild.id, req.params.userId);
    if (!targetMember) return reply.code(404).send({ error: 'Target member not found' });

    db.transaction(() => {
      clearMemberRoles.run(guild.id, req.params.userId);
      deleteGuildMember.run(guild.id, req.params.userId);
    })();

    const payload = { guild_id: guild.id, user_id: req.params.userId };
    io?.to(`guild:${guild.id}`)?.emit('member:remove', payload);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:remove', payload);
    return { ok: true };
  });

  fastify.put('/api/guilds/:guildId/members/:userId/timeout', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['communication_disabled_until'],
        additionalProperties: false,
        properties: {
          communication_disabled_until: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MODERATE_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing MODERATE_MEMBERS permission' });
    }
    if (!canActOnMember(guild, req.user.id, req.params.userId, false)) {
      return reply.code(403).send({ error: 'Role hierarchy violation' });
    }

    const targetMember = getGuildMember.get(guild.id, req.params.userId);
    if (!targetMember) return reply.code(404).send({ error: 'Target member not found' });

    updateGuildMember.run(
      targetMember.nickname,
      targetMember.mute,
      targetMember.deaf,
      req.body.communication_disabled_until,
      guild.id,
      req.params.userId
    );

    const updatedMember = getGuildMember.get(guild.id, req.params.userId);
    const payload = {
      guild_id: guild.id,
      user_id: req.params.userId,
      communication_disabled_until: updatedMember.communication_disabled_until,
    };
    io?.to(`guild:${guild.id}`)?.emit('member:update', payload);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:update', payload);

    return payload;
  });

  fastify.get('/api/guilds/:guildId/bans', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.BAN_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing BAN_MEMBERS permission' });
    }

    return getBansForGuild.all(guild.id).map((row) => ({
      guild_id: row.guild_id,
      user_id: row.user_id,
      reason: row.reason,
      banned_by: row.banned_by,
      created_at: row.created_at,
      user: row.username ? {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        avatar: row.avatar,
      } : null,
    }));
  });

  fastify.put('/api/guilds/:guildId/bans/:userId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', maxLength: 1024 },
          delete_message_seconds: { type: 'integer', minimum: 0, maximum: 604800 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.BAN_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing BAN_MEMBERS permission' });
    }

    const targetUser = getUserById.get(req.params.userId);
    if (!targetUser) return reply.code(404).send({ error: 'User not found' });

    if (!canActOnMember(guild, req.user.id, req.params.userId, false) && req.params.userId !== req.user.id) {
      return reply.code(403).send({ error: 'Role hierarchy violation' });
    }

    const now = nowSec();
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 1024) : null;
    const deleteMessageSeconds = req.body?.delete_message_seconds ?? 0;

    db.transaction(() => {
      upsertBan.run(guild.id, req.params.userId, reason, req.user.id, now);

      const targetMember = getGuildMember.get(guild.id, req.params.userId);
      if (targetMember) {
        clearMemberRoles.run(guild.id, req.params.userId);
        deleteGuildMember.run(guild.id, req.params.userId);
      }

      if (deleteMessageSeconds > 0) {
        const cutoff = now - deleteMessageSeconds;
        deleteRecentMessagesByAuthorInGuild.run(guild.id, req.params.userId, cutoff);
      }
    })();

    const payload = { guild_id: guild.id, user_id: req.params.userId, reason, banned_by: req.user.id, created_at: now };
    io?.to(`guild:${guild.id}`)?.emit('guild:ban:add', payload);
    io?.to(`guild:${guild.id}`)?.emit('member:remove', { guild_id: guild.id, user_id: req.params.userId });
    return payload;
  });

  fastify.delete('/api/guilds/:guildId/bans/:userId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.BAN_MEMBERS)) {
      return reply.code(403).send({ error: 'Missing BAN_MEMBERS permission' });
    }

    const existing = getBanForUser.get(guild.id, req.params.userId);
    if (!existing) return reply.code(404).send({ error: 'Ban not found' });

    deleteBan.run(guild.id, req.params.userId);
    const payload = { guild_id: guild.id, user_id: req.params.userId };
    io?.to(`guild:${guild.id}`)?.emit('guild:ban:remove', payload);
    return { ok: true };
  });

  fastify.post('/api/guilds/:guildId/roles', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          color: { type: 'integer', minimum: 0, maximum: 16777215 },
          hoist: { type: 'integer', minimum: 0, maximum: 1 },
          mentionable: { type: 'integer', minimum: 0, maximum: 1 },
          position: { type: 'integer' },
          permissions: { type: 'string', minLength: 1, maxLength: 30 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    const now = nowSec();
    const roleId = snowflake.generate();
    const rows = getRolesForGuild.all(guild.id);
    const highest = rows.length ? rows[0].position : 0;

    insertRole.run(
      roleId,
      guild.id,
      String(req.body.name).trim().slice(0, 100),
      req.body.color ?? 0,
      req.body.hoist ?? 0,
      req.body.position ?? (highest + 1),
      req.body.permissions ?? '0',
      0,
      req.body.mentionable ?? 0,
      0,
      now
    );

    const role = getRoleById.get(roleId);
    io?.to(`guild:${guild.id}`)?.emit('guild:role:create', role);
    return reply.code(201).send(role);
  });

  fastify.patch('/api/guilds/:guildId/roles/:roleId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    const role = getRoleById.get(req.params.roleId);
    if (!role || role.guild_id !== guild.id) return reply.code(404).send({ error: 'Role not found' });

    const body = req.body || {};

    updateRole.run(
      body.name !== undefined ? String(body.name).trim().slice(0, 100) : null,
      body.color,
      body.hoist,
      body.mentionable,
      body.permissions,
      body.position,
      role.id,
      guild.id
    );

    const updated = getRoleById.get(role.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:role:update', updated);
    return updated;
  });

  fastify.delete('/api/guilds/:guildId/roles/:roleId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    const role = getRoleById.get(req.params.roleId);
    if (!role || role.guild_id !== guild.id) return reply.code(404).send({ error: 'Role not found' });

    deleteRole.run(role.id, guild.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:role:delete', { guild_id: guild.id, role_id: role.id });
    return { ok: true };
  });

  fastify.put('/api/guilds/:guildId/members/:userId/roles/:roleId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    const targetMember = getGuildMember.get(guild.id, req.params.userId);
    if (!targetMember) return reply.code(404).send({ error: 'Target member not found' });

    const role = getRoleById.get(req.params.roleId);
    if (!role || role.guild_id !== guild.id) return reply.code(404).send({ error: 'Role not found' });

    insertMemberRole.run(guild.id, req.params.userId, role.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:role:add', {
      guild_id: guild.id,
      user_id: req.params.userId,
      role_id: role.id,
    });
    return { ok: true };
  });

  fastify.delete('/api/guilds/:guildId/members/:userId/roles/:roleId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    const targetMember = getGuildMember.get(guild.id, req.params.userId);
    if (!targetMember) return reply.code(404).send({ error: 'Target member not found' });

    deleteMemberRole.run(guild.id, req.params.userId, req.params.roleId);
    io?.to(`guild:${guild.id}`)?.emit('guild:member:role:remove', {
      guild_id: guild.id,
      user_id: req.params.userId,
      role_id: req.params.roleId,
    });
    return { ok: true };
  });

  fastify.post('/api/guilds/:guildId/channels', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'type'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'integer', minimum: 0, maximum: 15 },
          topic: { type: ['string', 'null'], maxLength: 1024 },
          parent_id: { type: ['string', 'null'], minLength: 1, maxLength: 32 },
          position: { type: 'integer' },
          nsfw: { type: 'integer', minimum: 0, maximum: 1 },
          rate_limit_per_user: { type: 'integer', minimum: 0, maximum: 21600 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    const now = nowSec();
    const id = snowflake.generate();
    insertChannel.run(
      id,
      guild.id,
      req.body.type,
      String(req.body.name).trim().slice(0, 100),
      req.body.topic ?? null,
      req.body.position ?? 0,
      req.body.parent_id ?? null,
      req.body.nsfw ?? 0,
      req.body.rate_limit_per_user ?? 0,
      now,
      now
    );

    const channel = getChannelById.get(id);
    io?.to(`guild:${guild.id}`)?.emit('guild:channel:create', channel);
    return reply.code(201).send(channel);
  });

  fastify.patch('/api/channels/:channelId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    const body = req.body || {};
    updateChannel.run(
      body.name !== undefined ? String(body.name).trim().slice(0, 100) : null,
      body.topic,
      body.parent_id !== undefined ? body.parent_id : channel.parent_id,
      body.nsfw,
      body.rate_limit_per_user,
      body.position,
      nowSec(),
      channel.id
    );

    const updated = getChannelById.get(channel.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:channel:update', updated);
    return updated;
  });

  fastify.delete('/api/channels/:channelId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;

    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    deleteChannel.run(channel.id);
    io?.to(`guild:${guild.id}`)?.emit('guild:channel:delete', { guild_id: guild.id, channel_id: channel.id });
    return { ok: true };
  });

  fastify.patch('/api/guilds/:guildId/channels', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: {
          type: 'object',
          required: ['id', 'position'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            position: { type: 'integer' },
            parent_id: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    const now = nowSec();
    for (const item of req.body) {
      const channel = getChannelById.get(item.id);
      if (!channel || channel.guild_id !== guild.id) {
        return reply.code(400).send({ error: `Channel ${item.id} is invalid for this guild` });
      }
      if (item.parent_id !== undefined && item.parent_id !== null) {
        const parent = getChannelById.get(item.parent_id);
        if (!parent || parent.guild_id !== guild.id || parent.type !== 4) {
          return reply.code(400).send({ error: `Parent ${item.parent_id} is invalid` });
        }
      }
    }

    db.transaction(() => {
      for (const item of req.body) {
        const channel = getChannelById.get(item.id);
        updateChannelPositionParent.run(item.position, item.parent_id !== undefined ? item.parent_id : channel.parent_id, now, item.id, guild.id);
      }
    })();

    const updated = getChannelsForGuild.all(guild.id).map((row) => ({
      id: row.id,
      guild_id: row.guild_id,
      type: row.type,
      name: row.name,
      topic: row.topic,
      position: row.position,
      parent_id: row.parent_id,
      nsfw: row.nsfw,
      rate_limit_per_user: row.rate_limit_per_user,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    io?.to(`guild:${guild.id}`)?.emit('guild:channels:reorder', { guild_id: guild.id, channels: updated });
    return updated;
  });

  fastify.patch('/api/guilds/:guildId/roles', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: {
          type: 'object',
          required: ['id', 'position'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            position: { type: 'integer' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission' });
    }

    for (const item of req.body) {
      const role = getRoleById.get(item.id);
      if (!role || role.guild_id !== guild.id) {
        return reply.code(400).send({ error: `Role ${item.id} is invalid for this guild` });
      }
      if (!canManageRole(guild, req.user.id, item.id)) {
        return reply.code(403).send({ error: `Cannot reorder role ${item.id}` });
      }
    }

    db.transaction(() => {
      for (const item of req.body) {
        updateRolePosition.run(item.position, item.id, guild.id);
      }
    })();

    const updated = getRolesForGuild.all(guild.id).map((row) => ({
      id: row.id,
      guild_id: row.guild_id,
      name: row.name,
      color: row.color,
      hoist: row.hoist,
      position: row.position,
      permissions: row.permissions,
      managed: row.managed,
      mentionable: row.mentionable,
      created_at: row.created_at,
    }));
    io?.to(`guild:${guild.id}`)?.emit('guild:roles:reorder', { guild_id: guild.id, roles: updated });
    return updated;
  });

  fastify.put('/api/channels/:channelId/permissions/:targetId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['type', 'allow', 'deny'],
        additionalProperties: false,
        properties: {
          type: { type: 'integer', minimum: 0, maximum: 1 },
          allow: { type: 'string', minLength: 1, maxLength: 64 },
          deny: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    if (req.body.type === 0) {
      const role = getRoleById.get(req.params.targetId);
      if (!role || role.guild_id !== guild.id) {
        return reply.code(400).send({ error: 'Target role not found in guild' });
      }
    } else {
      const member = getGuildMember.get(guild.id, req.params.targetId);
      if (!member) return reply.code(400).send({ error: 'Target member not found in guild' });
    }

    upsertOverwrite.run(channel.id, req.params.targetId, req.body.type, req.body.allow, req.body.deny);
    const payload = getOverwrite.get(channel.id, req.params.targetId);
    io?.to(`guild:${guild.id}`)?.emit('channel:overwrite:update', payload);
    return payload;
  });

  fastify.delete('/api/channels/:channelId/permissions/:targetId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing MANAGE_CHANNELS permission' });
    }

    deleteOverwritesForTarget.run(channel.id, req.params.targetId);
    io?.to(`guild:${guild.id}`)?.emit('channel:overwrite:delete', {
      channel_id: channel.id,
      target_id: req.params.targetId,
    });
    return { ok: true };
  });

  fastify.post('/api/channels/:channelId/invites', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 2, maxLength: 32 },
          max_age: { type: 'integer', minimum: 0, maximum: 2592000 },
          max_uses: { type: 'integer', minimum: 0, maximum: 1000000 },
          temporary: { type: 'integer', minimum: 0, maximum: 1 },
          unique: { type: 'integer', minimum: 0, maximum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.CREATE_INSTANT_INVITE) &&
      !permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_GUILD)) {
      return reply.code(403).send({ error: 'Missing CREATE_INSTANT_INVITE permission' });
    }

    const body = req.body || {};
    if (body.unique === 0) {
      const existing = getInvitesByChannel.all(channel.id).find((row) => row.inviter_id === req.user.id && (row.expires_at == null || row.expires_at > nowSec()));
      if (existing) return existing;
    }

    const code = (body.code ? String(body.code).trim() : randomInviteCode()).toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
      return reply.code(400).send({ error: 'Invalid invite code format' });
    }
    if (getInviteByCode.get(code)) {
      return reply.code(409).send({ error: 'Invite code already exists' });
    }

    const maxAge = body.max_age ?? 86400;
    const maxUses = body.max_uses ?? 0;
    const temporary = body.temporary ?? 0;
    const createdAt = nowSec();
    const expiresAt = maxAge === 0 ? null : createdAt + maxAge;

    insertInvite.run(code, guild.id, channel.id, req.user.id, maxAge, maxUses, temporary, createdAt, expiresAt);
    const invite = getInviteByCode.get(code);
    io?.to(`guild:${guild.id}`)?.emit('invite:create', inviteSummary(invite));
    return reply.code(201).send(inviteSummary(invite));
  });

  fastify.post('/api/guilds/:guildId/invites', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channel_id: { type: 'string', minLength: 1, maxLength: 64 },
          code: { type: 'string', minLength: 2, maxLength: 32 },
          max_age: { type: 'integer', minimum: 0, maximum: 2592000 },
          max_uses: { type: 'integer', minimum: 0, maximum: 1000000 },
          temporary: { type: 'integer', minimum: 0, maximum: 1 },
          unique: { type: 'integer', minimum: 0, maximum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;
    const body = req.body || {};
    const targetChannelId = body.channel_id || getFirstTextChannel.get(guild.id)?.id;
    if (!targetChannelId) {
      return reply.code(400).send({ error: 'Guild has no suitable text channel for invite' });
    }
    req.params.channelId = targetChannelId;
    return fastify.inject({
      method: 'POST',
      url: `/api/channels/${targetChannelId}/invites`,
      headers: {
        authorization: req.headers.authorization,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    }).then((res) => {
      reply.code(res.statusCode);
      const parsed = res.body ? JSON.parse(res.body) : null;
      return parsed;
    });
  });

  fastify.get('/api/guilds/:guildId/invites', { preHandler: authenticate }, async (req, reply) => {
    const guild = requireGuildMemberAccess(req.params.guildId, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_GUILD)) {
      return reply.code(403).send({ error: 'Missing MANAGE_GUILD permission' });
    }
    return getInvitesByGuild.all(guild.id).map(inviteSummary);
  });

  fastify.get('/api/channels/:channelId/invites', { preHandler: authenticate }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels supported in this endpoint' });

    const guild = requireGuildMemberAccess(channel.guild_id, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_GUILD) &&
      !permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_CHANNELS)) {
      return reply.code(403).send({ error: 'Missing permission to view channel invites' });
    }
    return getInvitesByChannel.all(channel.id).map(inviteSummary);
  });

  fastify.get('/api/invites/:code', async (req, reply) => {
    const invite = getInviteByCode.get(String(req.params.code).toLowerCase());
    if (!invite) return reply.code(404).send({ error: 'Invite not found' });

    if (invite.expires_at != null && invite.expires_at <= nowSec()) {
      deleteInviteByCode.run(invite.code);
      return reply.code(404).send({ error: 'Invite expired' });
    }
    if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
      return reply.code(410).send({ error: 'Invite max uses reached' });
    }

    const guild = getGuildById.get(invite.guild_id);
    const channel = getChannelById.get(invite.channel_id);
    if (!guild || !channel) return reply.code(404).send({ error: 'Invite target not found' });

    return {
      ...inviteSummary(invite),
      guild: mapGuild(guild),
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
      },
      approximate_member_count: db.prepare('SELECT COUNT(*) AS c FROM guild_members WHERE guild_id = ?').get(guild.id)?.c || 0,
    };
  });

  fastify.post('/api/invites/:code', { preHandler: authenticate }, async (req, reply) => {
    const invite = getInviteByCode.get(String(req.params.code).toLowerCase());
    if (!invite) return reply.code(404).send({ error: 'Invite not found' });

    const guild = getGuildById.get(invite.guild_id);
    if (!guild) return reply.code(404).send({ error: 'Guild not found' });

    if (invite.expires_at != null && invite.expires_at <= nowSec()) {
      deleteInviteByCode.run(invite.code);
      return reply.code(404).send({ error: 'Invite expired' });
    }
    if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
      return reply.code(410).send({ error: 'Invite max uses reached' });
    }

    if (getBanForUser.get(guild.id, req.user.id)) {
      return reply.code(403).send({ error: 'You are banned from this guild' });
    }

    const existingMember = getGuildMember.get(guild.id, req.user.id);
    if (!existingMember) {
      db.transaction(() => {
        insertMember.run(guild.id, req.user.id, nowSec());
        insertMemberRole.run(guild.id, req.user.id, guild.id);
        incrementInviteUse.run(invite.code);
      })();

      io?.to(`guild:${guild.id}`)?.emit('guild:member_join', {
        guild_id: guild.id,
        member: {
          user_id: req.user.id,
          joined_at: nowSec(),
        },
      });
    } else {
      incrementInviteUse.run(invite.code);
    }

    return {
      ok: true,
      guild: guildSnapshot(guild.id),
    };
  });

  fastify.delete('/api/invites/:code', { preHandler: authenticate }, async (req, reply) => {
    const invite = getInviteByCode.get(String(req.params.code).toLowerCase());
    if (!invite) return reply.code(404).send({ error: 'Invite not found' });

    const guild = requireGuildMemberAccess(invite.guild_id, req.user.id, reply);
    if (!guild) return;
    if (!permissions.hasGuildPermission(guild.id, req.user.id, Permissions.MANAGE_GUILD) && invite.inviter_id !== req.user.id) {
      return reply.code(403).send({ error: 'Missing permission to delete invite' });
    }

    deleteInviteByCode.run(invite.code);
    io?.to(`guild:${guild.id}`)?.emit('invite:delete', { code: invite.code, guild_id: guild.id, channel_id: invite.channel_id });
    return { ok: true };
  });
}
