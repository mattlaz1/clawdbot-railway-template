-- linkedin_posts: replaces Notion LinkedIn Content Tracker
CREATE TABLE IF NOT EXISTS linkedin_posts (
  post_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text,
  lane             text,
  status           text,
  topic_tags       text[],
  thesis           text,
  post_type        text,
  body             text,
  posted_at        timestamptz,
  linkedin_url     text,
  engagement_json  jsonb,
  source_reference text,
  rejection_reason text,
  notion_id        text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_lane_status ON linkedin_posts(lane, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_tags ON linkedin_posts USING gin (topic_tags);
