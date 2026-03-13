export const Permissions = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  MOVE_MEMBERS: 1n << 24n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MODERATE_MEMBERS: 1n << 40n,
  ADMINISTRATOR: 1n << 3n,
};

const JsonPermissionMap = {
  administrator: Permissions.ADMINISTRATOR,
  manage_guild: Permissions.MANAGE_GUILD,
  manage_server: Permissions.MANAGE_GUILD,
  manage_channels: Permissions.MANAGE_CHANNELS,
  manage_messages: Permissions.MANAGE_MESSAGES,
  manage_roles: Permissions.MANAGE_ROLES,
  kick_members: Permissions.KICK_MEMBERS,
  ban_members: Permissions.BAN_MEMBERS,
  move_members: Permissions.MOVE_MEMBERS,
  mute_members: Permissions.MUTE_MEMBERS,
  deafen_members: Permissions.DEAFEN_MEMBERS,
  change_nickname: Permissions.CHANGE_NICKNAME,
  manage_nicknames: Permissions.MANAGE_NICKNAMES,
  moderate_members: Permissions.MODERATE_MEMBERS,
  view_channel: Permissions.VIEW_CHANNEL,
  send_messages: Permissions.SEND_MESSAGES,
};

export function serializePermissions(bits) {
  return bits.toString();
}

export function parsePermissions(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);

  const text = String(value).trim();
  if (!text) return 0n;

  try {
    return BigInt(text);
  } catch {
  }

  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return 0n;
    let bits = 0n;
    for (const [name, enabled] of Object.entries(obj)) {
      if (enabled === true && JsonPermissionMap[name]) {
        bits |= JsonPermissionMap[name];
      }
    }
    return bits;
  } catch {
    return 0n;
  }
}

function hasPerm(bits, perm) {
  return (bits & perm) === perm;
}

export function can(bits, perm) {
  if (hasPerm(bits, Permissions.ADMINISTRATOR)) return true;
  return hasPerm(bits, perm);
}

export function buildPermissionService(db) {
  const getGuildOwner = db.prepare('SELECT owner_id FROM guilds WHERE id = ?');
  const getGuildMember = db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?');
  const getEveryoneRole = db.prepare('SELECT id, permissions FROM roles WHERE guild_id = ? ORDER BY position ASC LIMIT 1');
  const getMemberRoles = db.prepare(`
    SELECT r.id, r.permissions, r.position
    FROM member_roles mr
    JOIN roles r ON r.id = mr.role_id
    WHERE mr.guild_id = ? AND mr.user_id = ?
    ORDER BY r.position ASC
  `);
  const getChannel = db.prepare('SELECT id, guild_id FROM channels WHERE id = ?');
  const getOverwrites = db.prepare('SELECT target_id, target_type, allow, deny FROM channel_permission_overwrites WHERE channel_id = ?');

  function getGuildPermissions(guildId, userId) {
    const guild = getGuildOwner.get(guildId);
    if (!guild) return null;
    if (guild.owner_id === userId) return (1n << 62n) - 1n;
    if (!getGuildMember.get(guildId, userId)) return null;

    let bits = 0n;

    const everyoneRole = getEveryoneRole.get(guildId);
    if (everyoneRole) bits |= parsePermissions(everyoneRole.permissions);

    const rows = getMemberRoles.all(guildId, userId);
    for (const row of rows) bits |= parsePermissions(row.permissions);

    if (can(bits, Permissions.ADMINISTRATOR)) {
      return (1n << 62n) - 1n;
    }

    return bits;
  }

  function getChannelPermissions(channelId, userId) {
    const channel = getChannel.get(channelId);
    if (!channel) return null;
    if (!channel.guild_id) return null;

    const guildBits = getGuildPermissions(channel.guild_id, userId);
    if (guildBits == null) return null;
    if (can(guildBits, Permissions.ADMINISTRATOR)) return guildBits;

    let bits = guildBits;
    const rows = getOverwrites.all(channelId);

    const everyoneRole = getEveryoneRole.get(channel.guild_id);
    if (everyoneRole) {
      const ov = rows.find((row) => row.target_id === everyoneRole.id && row.target_type === 0);
      if (ov) {
        bits &= ~parsePermissions(ov.deny);
        bits |= parsePermissions(ov.allow);
      }
    }

    const memberRoles = getMemberRoles.all(channel.guild_id, userId);
    let roleAllow = 0n;
    let roleDeny = 0n;
    const roleIds = new Set(memberRoles.map((r) => r.id));
    for (const row of rows) {
      if (row.target_type === 0 && roleIds.has(row.target_id)) {
        roleAllow |= parsePermissions(row.allow);
        roleDeny |= parsePermissions(row.deny);
      }
    }
    bits &= ~roleDeny;
    bits |= roleAllow;

    const memberOw = rows.find((row) => row.target_type === 1 && row.target_id === userId);
    if (memberOw) {
      bits &= ~parsePermissions(memberOw.deny);
      bits |= parsePermissions(memberOw.allow);
    }

    return bits;
  }

  return {
    getGuildPermissions,
    getChannelPermissions,
    hasGuildPermission(guildId, userId, permission) {
      const bits = getGuildPermissions(guildId, userId);
      if (bits == null) return false;
      return can(bits, permission);
    },
    hasChannelPermission(channelId, userId, permission) {
      const bits = getChannelPermissions(channelId, userId);
      if (bits == null) return false;
      return can(bits, permission);
    },
  };
}
