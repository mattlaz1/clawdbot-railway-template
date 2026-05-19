-- meetings: replaces Notion Fathom Meetings DB
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES companies(company_id) ON DELETE SET NULL,
  title            text,
  meeting_date     timestamptz,
  duration_minutes int,
  recording_url    text,
  share_url        text,
  summary          text,
  transcript       text,
  attendees        text[],
  status           text,
  source           text,
  fathom_id        text UNIQUE,
  notion_id        text UNIQUE,
  synced_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_meetings_company ON meetings(company_id);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(meeting_date DESC);
