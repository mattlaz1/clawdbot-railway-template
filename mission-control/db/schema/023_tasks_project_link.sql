-- 023_tasks_project_link.sql
-- Links tasks to projects (additive only — nothing breaks).
--
--   project_id   — task belongs to this project (NULL = standalone, current behavior)
--   source       — "meeting:<id>" | "email:<id>" | "manual" | "chain:<task_id>"
--   source_quote — literal commitment text from transcript/email
--
-- After this migration, also creates `project_health_view` for dashboard
-- consumption.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN project_id   uuid REFERENCES projects(project_id) ON DELETE SET NULL,
  ADD COLUMN source       text,
  ADD COLUMN source_quote text;

CREATE INDEX idx_tasks_project ON tasks(project_id) WHERE active = true;

-- project_health_view: one row per active project with task-count rollups.
-- Powers the Mission Control Projects tab and the CS portfolio-management
-- step in /cs-daily.
--
-- Counts use task_decisions.status:
--   in_progress     — Matt approved, Analyst is working on it
--   needs_matt      — kicked back to CS (or pending CS classification)
--   recently_shipped — completed within last 14 days
--   overdue         — active and past due_date

CREATE OR REPLACE VIEW project_health_view AS
SELECT
  p.project_id,
  p.company_slug,
  c.name AS company_name,
  p.name AS project_name,
  p.slug AS project_slug,
  p.kind,
  p.owning_agent,
  p.status,
  p.priority,
  p.blocked_on,
  p.current_version,
  p.target_date,
  p.last_activity_at,
  p.summary,
  p.context_doc_path,
  COUNT(t.*) FILTER (WHERE t.active = true)                                   AS open_task_count,
  COUNT(t.*) FILTER (WHERE t.active = true AND pd.status = 'in_progress')     AS in_progress,
  COUNT(t.*) FILTER (WHERE t.active = true AND pd.status = 'needs_matt')      AS needs_matt,
  COUNT(t.*) FILTER (WHERE t.active = false AND pd.status = 'executed'
                          AND t.completed_at > now() - INTERVAL '14 days')    AS recently_shipped,
  COUNT(t.*) FILTER (WHERE t.active = true AND t.due_date < CURRENT_DATE)     AS overdue,
  EXTRACT(day FROM now() - p.last_activity_at)::int                           AS days_stale
FROM projects p
JOIN companies c ON c.company_id = p.company_id
LEFT JOIN tasks t ON t.project_id = p.project_id
LEFT JOIN task_decisions pd ON pd.task_id = t.id
WHERE p.status IN ('active','blocked')
GROUP BY p.project_id, p.company_slug, c.name, p.name, p.slug, p.kind, p.owning_agent,
         p.status, p.priority, p.blocked_on, p.current_version, p.target_date,
         p.last_activity_at, p.summary, p.context_doc_path;

COMMIT;
