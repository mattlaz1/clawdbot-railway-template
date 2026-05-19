-- runs: cron run log (replaces data/runs.json)
CREATE TABLE IF NOT EXISTS runs (
  id            text PRIMARY KEY,
  agent_id      text NOT NULL,
  agent_name    text,
  skill         text,
  started_at    timestamptz,
  completed_at  timestamptz,
  status        text,            -- 'success' | 'error'
  duration_s    int,
  actions       jsonb,           -- {drafts_created, tasks_created, ...}
  summary       text,
  notion_url    text,
  errors        jsonb DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, started_at DESC);
