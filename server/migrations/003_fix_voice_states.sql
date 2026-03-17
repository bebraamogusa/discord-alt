-- Fix voice_states: add UNIQUE(user_id) so ON CONFLICT(user_id) works,
-- and remove the NOT NULL session_id column (not used by socket.js).

DROP TABLE IF EXISTS voice_states;

CREATE TABLE IF NOT EXISTS voice_states (
  guild_id   TEXT,
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  session_id TEXT,
  deaf       INTEGER NOT NULL DEFAULT 0,
  mute       INTEGER NOT NULL DEFAULT 0,
  self_deaf  INTEGER NOT NULL DEFAULT 0,
  self_mute  INTEGER NOT NULL DEFAULT 0,
  self_video INTEGER NOT NULL DEFAULT 0,
  self_stream INTEGER NOT NULL DEFAULT 0,
  suppress   INTEGER NOT NULL DEFAULT 0,
  request_to_speak_timestamp INTEGER,
  UNIQUE(user_id),
  FOREIGN KEY (guild_id)   REFERENCES guilds(id)   ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
);
