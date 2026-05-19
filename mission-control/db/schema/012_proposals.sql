-- proposals: one row per agent proposal, upserted each cron run
CREATE TABLE IF NOT EXISTS proposals (
  id                   text PRIMARY KEY,          -- e.g. cro-2026-04-09-01
  agent_id             text NOT NULL,
  generated_at         timestamptz,
  title                text,
  rationale            text,
  action_type          text,
  added_at             timestamptz,
  due_date             date,
  preview              jsonb,
  execute_instructions text,
  scope_note           text,
  active               boolean NOT NULL DEFAULT true,  -- false = archived/superseded
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  -- company_slug ties a proposal to a specific company (CRO deal or CS client).
  -- REQUIRED on every proposal that targets one company. Leave NULL only for
  -- multi-company batch proposals, content posts, or orchestrator/cron proposals.
  company_slug         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_agent_active ON proposals(agent_id, active);
CREATE INDEX IF NOT EXISTS idx_proposals_due ON proposals(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_slug ON proposals(company_slug) WHERE company_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_agent_slug_active ON proposals(agent_id, company_slug, active) WHERE active = true;
