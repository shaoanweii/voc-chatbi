-- One-time migration for intelligent chat structured artifacts.
-- Execute once against the existing PostgreSQL database before enabling artifact context.

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id VARCHAR(36) REFERENCES chat_messages(id) ON DELETE CASCADE,
  artifact_type VARCHAR(30) NOT NULL,
  title TEXT,
  summary TEXT,
  sql_text TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
  measures JSONB NOT NULL DEFAULT '[]'::jsonb,
  data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_artifacts_session_idx ON chat_artifacts(session_id);
CREATE INDEX IF NOT EXISTS chat_artifacts_message_idx ON chat_artifacts(message_id);
CREATE INDEX IF NOT EXISTS chat_artifacts_type_idx ON chat_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS chat_artifacts_session_created_at_idx ON chat_artifacts(session_id, created_at DESC);
