-- Persistent chat transcript between Matt and each agent's long-lived
-- OpenClaw session. Postgres is the durable store; OpenClaw holds live
-- working memory. Designed so Phase 2 cron triggers can write into the
-- same table with source='cron'|'trigger' and the brain has one unified
-- history regardless of who initiated.

CREATE TABLE IF NOT EXISTS chat_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text NOT NULL,
  session_key  text NOT NULL,
  role         text NOT NULL CHECK (role IN ('user','assistant','system')),
  text         text NOT NULL,
  run_id       text,
  source       text NOT NULL DEFAULT 'chat'
                 CHECK (source IN ('chat','cron','trigger','inject')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_agent_recent
  ON chat_messages (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_messages_session
  ON chat_messages (session_key, created_at);
