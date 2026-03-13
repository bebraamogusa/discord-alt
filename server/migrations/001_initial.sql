PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  avatar TEXT,
  banner TEXT,
  accent_color TEXT,
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 190),
  pronouns TEXT,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','idle','dnd','invisible','offline')),
  custom_status_text TEXT,
  custom_status_emoji TEXT,
  custom_status_expires_at INTEGER,
  locale TEXT NOT NULL DEFAULT 'en-US',
  theme TEXT NOT NULL DEFAULT 'dark',
  message_font_size INTEGER NOT NULL DEFAULT 16,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  flags INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  deleted_at INTEGER,
  username_normalized TEXT GENERATED ALWAYS AS (lower(username)) VIRTUAL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  compact_mode INTEGER NOT NULL DEFAULT 0,
  developer_mode INTEGER NOT NULL DEFAULT 0,
  render_embeds INTEGER NOT NULL DEFAULT 1,
  render_reactions INTEGER NOT NULL DEFAULT 1,
  animate_emoji INTEGER NOT NULL DEFAULT 1,
  animate_stickers INTEGER NOT NULL DEFAULT 1,
  enable_tts INTEGER NOT NULL DEFAULT 1,
  show_current_game INTEGER NOT NULL DEFAULT 1,
  inline_attachment_media INTEGER NOT NULL DEFAULT 1,
  inline_embed_media INTEGER NOT NULL DEFAULT 1,
  gif_auto_play INTEGER NOT NULL DEFAULT 1,
  notification_desktop INTEGER NOT NULL DEFAULT 1,
  notification_sounds INTEGER NOT NULL DEFAULT 1,
  notification_flash INTEGER NOT NULL DEFAULT 1,
  afk_timeout INTEGER NOT NULL DEFAULT 300,
  zoom_level INTEGER NOT NULL DEFAULT 100,
  guild_folders TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  device TEXT,
  ip TEXT,
  created_at INTEGER,
  expires_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_mfa_backup_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mfa_tickets (
  ticket TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type INTEGER NOT NULL CHECK (type IN (1,2,3,4)),
  nickname TEXT,
  created_at INTEGER,
  UNIQUE(user_id, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_notes (
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY(user_id, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  banner TEXT,
  splash TEXT,
  description TEXT,
  owner_id TEXT NOT NULL,
  default_message_notifications INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter INTEGER NOT NULL DEFAULT 0,
  verification_level INTEGER NOT NULL DEFAULT 0,
  afk_channel_id TEXT,
  afk_timeout INTEGER NOT NULL DEFAULT 300,
  system_channel_id TEXT,
  system_channel_flags INTEGER NOT NULL DEFAULT 0,
  rules_channel_id TEXT,
  vanity_url_code TEXT UNIQUE,
  preferred_locale TEXT NOT NULL DEFAULT 'en-US',
  features TEXT NOT NULL DEFAULT '[]',
  max_members INTEGER NOT NULL DEFAULT 500000,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  banner TEXT,
  bio TEXT,
  joined_at INTEGER NOT NULL,
  deaf INTEGER NOT NULL DEFAULT 0,
  mute INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  communication_disabled_until INTEGER,
  flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  unicode_emoji TEXT,
  position INTEGER NOT NULL,
  permissions TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY(guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  type INTEGER NOT NULL,
  name TEXT,
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 64000,
  user_limit INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  owner_id TEXT,
  last_message_id TEXT,
  last_pin_timestamp INTEGER,
  rtc_region TEXT,
  default_auto_archive_duration INTEGER NOT NULL DEFAULT 1440,
  default_thread_rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
  default_sort_order INTEGER,
  default_forum_layout INTEGER,
  default_reaction_emoji TEXT,
  flags INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES channels(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS channel_permission_overwrites (
  channel_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type INTEGER NOT NULL CHECK (target_type IN (0,1)),
  allow TEXT NOT NULL DEFAULT '0',
  deny TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY(channel_id, target_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dm_participants (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER,
  closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT,
  type INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0,
  tts INTEGER NOT NULL DEFAULT 0,
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  reference_message_id TEXT,
  reference_channel_id TEXT,
  thread_id TEXT,
  webhook_id TEXT,
  embeds TEXT NOT NULL DEFAULT '[]',
  components TEXT NOT NULL DEFAULT '[]',
  sticker_ids TEXT NOT NULL DEFAULT '[]',
  poll TEXT,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reference_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (reference_channel_id) REFERENCES channels(id) ON DELETE SET NULL,
  FOREIGN KEY (thread_id) REFERENCES channels(id) ON DELETE SET NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  url TEXT NOT NULL,
  proxy_url TEXT,
  width INTEGER,
  height INTEGER,
  duration_secs REAL,
  waveform TEXT,
  description TEXT,
  spoiler INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_mention_roles (
  message_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY(message_id, role_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_mention_channels (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY(message_id, channel_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY(message_id, emoji, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id, message_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER,
  flags INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT,
  PRIMARY KEY(thread_id, user_id),
  FOREIGN KEY (thread_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  inviter_id TEXT,
  max_age INTEGER NOT NULL DEFAULT 86400,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  temporary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bans (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  banned_by TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY(guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS emojis (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  creator_id TEXT,
  animated INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  require_colons INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 0,
  roles_allowed TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT,
  type INTEGER,
  format_type INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  creator_id TEXT,
  sort_value INTEGER,
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  creator_id TEXT,
  name TEXT,
  avatar TEXT,
  token TEXT UNIQUE,
  type INTEGER NOT NULL DEFAULT 1,
  source_guild_id TEXT,
  source_channel_id TEXT,
  url TEXT,
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (source_guild_id) REFERENCES guilds(id) ON DELETE SET NULL,
  FOREIGN KEY (source_channel_id) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  target_id TEXT,
  action_type INTEGER NOT NULL,
  changes TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS automod_rules (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  event_type INTEGER NOT NULL,
  trigger_type INTEGER NOT NULL,
  trigger_metadata TEXT NOT NULL,
  actions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  exempt_roles TEXT NOT NULL DEFAULT '[]',
  exempt_channels TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scheduled_events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  image TEXT,
  scheduled_start_time INTEGER NOT NULL,
  scheduled_end_time INTEGER,
  entity_type INTEGER NOT NULL,
  entity_metadata TEXT,
  status INTEGER NOT NULL,
  recurrence_rule TEXT,
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scheduled_event_users (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES scheduled_events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS soundboard_sounds (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji_name TEXT,
  emoji_id TEXT,
  volume REAL NOT NULL DEFAULT 1.0,
  file TEXT NOT NULL,
  user_id TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (emoji_id) REFERENCES emojis(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  allow_multiselect INTEGER NOT NULL DEFAULT 0,
  expiry INTEGER NOT NULL,
  layout_type INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_answers (
  id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  text TEXT,
  emoji TEXT,
  PRIMARY KEY(id, message_id),
  FOREIGN KEY (message_id) REFERENCES polls(message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL,
  answer_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(message_id, answer_id, user_id),
  FOREIGN KEY (message_id, answer_id) REFERENCES poll_answers(message_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guild_notification_settings (
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  mute_until INTEGER,
  message_notifications INTEGER NOT NULL DEFAULT -1,
  suppress_everyone INTEGER NOT NULL DEFAULT 0,
  suppress_roles INTEGER NOT NULL DEFAULT 0,
  mobile_push INTEGER NOT NULL DEFAULT 1,
  channel_overrides TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(user_id, guild_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_read_message_id TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, channel_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS guild_templates (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL,
  serialized_guild TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS guild_onboarding (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  default_channel_ids TEXT NOT NULL DEFAULT '[]',
  prompts TEXT NOT NULL DEFAULT '[]',
  mode INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forum_tags (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  moderated INTEGER NOT NULL DEFAULT 0,
  emoji_id TEXT,
  emoji_name TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (emoji_id) REFERENCES emojis(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS thread_applied_tags (
  thread_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY(thread_id, tag_id),
  FOREIGN KEY (thread_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES forum_tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  visibility INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS voice_states (
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deaf INTEGER NOT NULL DEFAULT 0,
  mute INTEGER NOT NULL DEFAULT 0,
  self_deaf INTEGER NOT NULL DEFAULT 0,
  self_mute INTEGER NOT NULL DEFAULT 0,
  self_video INTEGER NOT NULL DEFAULT 0,
  self_stream INTEGER NOT NULL DEFAULT 0,
  suppress INTEGER NOT NULL DEFAULT 0,
  request_to_speak_timestamp INTEGER,
  PRIMARY KEY(guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qr_login_sessions (
  qr_id TEXT PRIMARY KEY,
  desktop_socket_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scanned','confirmed','expired')),
  scanned_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (scanned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created_at ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);
CREATE INDEX IF NOT EXISTS idx_relationships_user ON relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_roles_guild ON roles(guild_id);
CREATE INDEX IF NOT EXISTS idx_invites_guild ON invites(guild_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_guild_created_at ON audit_log(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_emojis_guild ON emojis(guild_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON user_sessions(refresh_token);
CREATE INDEX IF NOT EXISTS idx_mfa_tickets_user ON mfa_tickets(user_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=rowid,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, coalesce(new.content, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, coalesce(new.content, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_bd BEFORE DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
