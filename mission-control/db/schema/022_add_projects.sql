-- 022_add_projects.sql
-- Adds the `projects` table and `project_health_view` that groups tasks by
-- client deliverable stream (Bowery Hotel Template, Origin IC Memo, etc).
--
-- CS-as-PM model: CS owns the project portfolio (creates projects, sets
-- priority/target/status). Analyst (or Dev) is the executor and only updates
-- `current_version` and `last_activity_at` as work moves. See
-- `.claude/rules/postgres-rules.md` § Projects for the full write-ownership
-- table.
--
-- Tasks gain `project_id`/`source`/`source_quote` in 023; this migration is
-- additive and does not touch the `tasks` schema.

BEGIN;

CREATE TABLE projects (
  project_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  company_slug      text NOT NULL,
  name              text NOT NULL,
  slug              text NOT NULL,
  kind              text NOT NULL,
  owning_agent      text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  priority          text NOT NULL DEFAULT 'normal',
  blocked_on        text,
  current_version   text,
  context_doc_path  text,
  summary           text,
  started_at        date NOT NULL DEFAULT CURRENT_DATE,
  target_date       date,
  shipped_at        date,
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT projects_kind_check CHECK (kind IN (
    'excel_model','vba_macro','skysuite_feature','powerpoint',
    'automation','integration','other'
  )),
  CONSTRAINT projects_owning_agent_check CHECK (owning_agent IN ('analyst','dev')),
  CONSTRAINT projects_status_check CHECK (status IN (
    'active','blocked','shipped','paused','cancelled'
  )),
  CONSTRAINT projects_priority_check CHECK (priority IN ('urgent','high','normal','low'))
);

CREATE INDEX idx_projects_company      ON projects(company_id);
CREATE INDEX idx_projects_owning_agent ON projects(owning_agent) WHERE status IN ('active','blocked');
CREATE INDEX idx_projects_status       ON projects(status);
CREATE INDEX idx_projects_company_slug ON projects(company_slug);

COMMIT;
