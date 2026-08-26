ALTER TABLE user_sessions ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE user_sessions ADD COLUMN previous_refresh_token_hash TEXT;
ALTER TABLE user_sessions ADD COLUMN refresh_token_family_id TEXT;
ALTER TABLE user_sessions ADD COLUMN revoked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_token_hash
  ON user_sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS user_session_token_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
);

ALTER TABLE mfa_tickets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
