-- companies: replaces Notion Companies DB + vault deal.md frontmatter
CREATE TABLE IF NOT EXISTS companies (
  company_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE,
  slug               text NOT NULL UNIQUE,
  stage              stage_enum NOT NULL,
  deal_value         numeric(12,2),
  billing_cadence    text,
  decision_maker     text,
  champion           text,
  next_action        text,
  next_action_due    date,
  last_contact       date,
  -- days_since_contact and risk are exposed via companies_view (not stored,
  -- since CURRENT_DATE is not immutable and can't be used in STORED columns)
  field              text,
  licenses           int,
  avg_license_cost   numeric(10,2),
  action_status      text,
  tags               text[],
  notion_url         text,
  notion_id          text UNIQUE,
  vault_slug         text,
  -- CS-only
  health_score       smallint CHECK (health_score BETWEEN 0 AND 100),
  health_tier        text,
  onboarding_status  text,
  primary_workflow   text,
  mrr                numeric(10,2),
  -- Delivery (closed-won)
  project_type             text,
  implementation_total     numeric(10,2),
  implementation_invoiced  numeric(10,2),
  implementation_remaining numeric(10,2) GENERATED ALWAYS AS (
    COALESCE(implementation_total,0) - COALESCE(implementation_invoiced,0)
  ) STORED,
  sample_files_status text,
  blocked_on          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_synced         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_companies_stage ON companies(stage);
CREATE INDEX IF NOT EXISTS idx_companies_last_contact ON companies(last_contact);
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_companies_tags ON companies USING gin (tags);

-- View with computed days_since_contact + risk. Use this instead of the raw
-- table when you need those fields. Writes still go to `companies`.
CREATE OR REPLACE VIEW companies_view AS
SELECT
  c.*,
  CASE
    WHEN c.last_contact IS NULL THEN NULL
    ELSE (CURRENT_DATE - c.last_contact)
  END AS days_since_contact,
  CASE
    WHEN c.last_contact IS NULL THEN 'unknown'
    WHEN (CURRENT_DATE - c.last_contact) <= 7 THEN 'low'
    WHEN (CURRENT_DATE - c.last_contact) <= 30 THEN 'medium'
    ELSE 'high'
  END AS risk
FROM companies c;
