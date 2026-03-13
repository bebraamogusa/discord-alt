CREATE TABLE IF NOT EXISTS message_nonces (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, channel_id, nonce),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_nonces_message_id ON message_nonces(message_id);
CREATE INDEX IF NOT EXISTS idx_message_nonces_created_at ON message_nonces(created_at);
