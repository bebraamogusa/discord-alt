-- server/migrations/006_drop_legacy_reactions.sql
-- Legacy reaction storage replaced by message_reactions (004_add_reactions.sql).
DROP TABLE IF EXISTS reactions;
