-- influencer_intel: replaces Notion Influencer Intel DB
CREATE TABLE IF NOT EXISTS influencer_intel (
  entry_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   text,
  influencer    text,
  topic_tags    text[],
  key_insight   text,
  source_url    text,
  relevance     text,
  lane          text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  notion_id     text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_intel_tags ON influencer_intel USING gin (topic_tags);
CREATE INDEX IF NOT EXISTS idx_intel_discovered ON influencer_intel(discovered_at DESC);
