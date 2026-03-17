-- server/migrations/004_add_reactions.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL,
  emoji_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji_name, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
