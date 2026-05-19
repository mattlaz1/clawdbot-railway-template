-- daily_reports: replaces Notion Daily Reports DB with full-text search
CREATE TABLE IF NOT EXISTS daily_reports (
  report_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent           text NOT NULL,
  report_date     date NOT NULL,
  report_type     text,
  title           text,
  critical_flags  text,
  active_items    text,
  recommendations text,
  draft_count     int,
  body            text,
  body_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body,''))) STORED,
  notion_id       text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_agent_date ON daily_reports(agent, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_reports_fts ON daily_reports USING gin (body_tsv);
