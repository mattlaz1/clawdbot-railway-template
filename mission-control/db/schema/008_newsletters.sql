-- newsletters: replaces Notion Newsletter Tracker
CREATE TABLE IF NOT EXISTS newsletters (
  edition_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text,
  series           text,
  status           text,
  target_date      date,
  published_at     timestamptz,
  substack_url     text,
  body             text,
  rejection_reason text,
  notion_id        text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletters_series_status ON newsletters(series, status);
