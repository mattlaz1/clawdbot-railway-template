-- timeline: per-company interaction log parsed from vault timeline.md files.
-- Tracks every touchpoint (meetings, emails, calls, notes) to surface stale deals.
CREATE TABLE IF NOT EXISTS timeline (
  entry_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  entry_date     date NOT NULL,
  entry_type     text,          -- 'meeting', 'email', 'call', 'note', 'other'
  title          text,
  details        text,
  recording_url  text,          -- fathom video link if present
  notion_meeting_id text,       -- from <!-- notion-meeting-id: ... --> comments
  source         text NOT NULL DEFAULT 'vault',  -- 'vault', 'agent', 'manual'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_company_date ON timeline(company_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline(entry_date DESC);

-- Unique constraint to prevent duplicate entries from re-imports
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
  ON timeline(company_id, entry_date, md5(coalesce(title,'')));

-- View: latest interaction per company for staleness detection
CREATE OR REPLACE VIEW company_last_touch AS
  SELECT DISTINCT ON (company_id)
    company_id,
    entry_date AS last_touch_date,
    title AS last_touch_title,
    entry_type AS last_touch_type,
    CURRENT_DATE - entry_date AS days_since_touch
  FROM timeline
  ORDER BY company_id, entry_date DESC;
