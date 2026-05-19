-- executions: one row per Execute click, holds results that Claude writes directly
CREATE TABLE IF NOT EXISTS executions (
  run_id        text PRIMARY KEY,
  agent_id      text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  status        text DEFAULT 'running',   -- 'running' | 'completed' | 'error' | 'no-op'
  exit_code     int,
  approved      jsonb,                    -- snapshot of approved proposals at execute time
  results       jsonb DEFAULT '[]',       -- [{id, status, note}, ...] written by Claude
  log_tail      text,                     -- last N chars of execute log
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exec_agent ON executions(agent_id, started_at DESC);
