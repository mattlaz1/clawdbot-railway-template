-- 021_rename_proposals_to_tasks.sql
-- Stage B of the proposals/tasks unification.
--
-- Renames the existing proposals schema to tasks. After this migration:
--   proposals          -> tasks
--   proposal_decisions -> task_decisions  (FK proposal_id -> task_id)
--   proposal_outcomes  -> task_outcomes   (FK proposal_id -> task_id)
--   decision_history.proposal_id -> task_id
--
-- Indexes, constraints, and views are renamed/rebuilt to match. The old
-- `tasks` table from the legacy schema was renamed to `tasks_legacy` in 020.
-- This migration is destructive in the sense that the old `proposals` name is
-- gone; downstream code (server.js, app.js, skills) updates in the same release.

BEGIN;

-- Drop the coverage view first; we rebuild it at the end of this migration
DROP VIEW IF EXISTS company_coverage_view;

-- 1. Rename legacy indexes out of the way first so their target names free up.
--    The old `tasks` (now `tasks_legacy`) still owns tasks_pkey, idx_tasks_*,
--    and tasks_notion_id_key from its original DDL.
ALTER INDEX tasks_pkey RENAME TO tasks_legacy_pkey;
ALTER INDEX idx_tasks_company RENAME TO idx_tasks_legacy_company;
ALTER INDEX idx_tasks_status_due RENAME TO idx_tasks_legacy_status_due;
ALTER INDEX idx_tasks_agent_status RENAME TO idx_tasks_legacy_agent_status;
ALTER INDEX tasks_notion_id_key RENAME TO tasks_legacy_notion_id_key;

-- 2. Rename tables
ALTER TABLE proposals RENAME TO tasks;
ALTER TABLE proposal_decisions RENAME TO task_decisions;
ALTER TABLE proposal_outcomes RENAME TO task_outcomes;

-- 3. Rename FK columns
ALTER TABLE task_decisions RENAME COLUMN proposal_id TO task_id;
ALTER TABLE task_outcomes RENAME COLUMN proposal_id TO task_id;
ALTER TABLE decision_history RENAME COLUMN proposal_id TO task_id;

-- 4. Rename indexes (clean naming)
ALTER INDEX idx_proposals_agent_active RENAME TO idx_tasks_agent_active;
ALTER INDEX idx_proposals_agent_slug_active RENAME TO idx_tasks_agent_slug_active;
ALTER INDEX idx_proposals_due RENAME TO idx_tasks_due;
ALTER INDEX idx_proposals_slug RENAME TO idx_tasks_slug;
ALTER INDEX proposals_pkey RENAME TO tasks_pkey;
ALTER INDEX proposal_decisions_pkey RENAME TO task_decisions_pkey;
ALTER INDEX proposal_outcomes_pkey RENAME TO task_outcomes_pkey;
ALTER INDEX idx_pd_agent_status RENAME TO idx_td_agent_status;
ALTER INDEX idx_outcomes_agent RENAME TO idx_task_outcomes_agent;
ALTER INDEX idx_outcomes_proposal RENAME TO idx_task_outcomes_task;
ALTER INDEX idx_dh_proposal RENAME TO idx_dh_task;

-- 4. Rename CHECK / FK constraints
ALTER TABLE tasks RENAME CONSTRAINT proposals_origin_check TO tasks_origin_check;
ALTER TABLE tasks RENAME CONSTRAINT proposals_contact_id_fkey TO tasks_contact_id_fkey;
ALTER TABLE task_decisions RENAME CONSTRAINT proposal_decisions_proposal_id_fkey TO task_decisions_task_id_fkey;

-- 5. Rebuild company_coverage_view to read from new schema
--    Exposes split counts: tasks_needing_review (untouched / refining) and
--    tasks_in_motion (queued / in_progress / approved). The dashboard surfaces
--    both so Matt can see "3 to review · 2 in motion" instead of one number.
CREATE OR REPLACE VIEW company_coverage_view AS
SELECT
  c.company_id,
  c.slug,
  c.name,
  c.stage,
  c.last_contact,
  cv.days_since_contact,
  cv.risk,
  CASE
    WHEN c.stage IN ('prospect','discovery','demo','proposal','negotiation','on-hold-warm') THEN 'cro'
    WHEN c.stage = 'closed-won' THEN 'cs'
  END AS owning_agent,
  COALESCE(strict.task_count, 0) AS active_task_count,
  COALESCE(loose.loose_count, 0) AS loose_task_count,
  COALESCE(strict.task_count, 0) + COALESCE(loose.loose_count, 0) AS active_task_count_total,
  strict.latest_task_title,
  strict.latest_task_due_date,
  COALESCE(review.review_count, 0) AS tasks_needing_review,
  COALESCE(motion.motion_count, 0) AS tasks_in_motion,
  -- A company is "uncovered" when no active task (strict or loose) exists.
  (COALESCE(strict.task_count, 0)
    + COALESCE(loose.loose_count, 0) = 0) AS is_uncovered
FROM companies c
JOIN companies_view cv ON cv.company_id = c.company_id
LEFT JOIN (
  SELECT
    company_slug,
    COUNT(*) AS task_count,
    (array_agg(title ORDER BY due_date NULLS LAST, added_at DESC))[1] AS latest_task_title,
    MIN(due_date) AS latest_task_due_date
  FROM tasks
  WHERE active = true AND company_slug IS NOT NULL
  GROUP BY company_slug
) strict ON strict.company_slug = c.slug
-- Loose match: company name appears in the title of an active task whose
-- company_slug is NULL (multi-company batch tasks).
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS loose_count
  FROM tasks tk
  WHERE tk.active = true
    AND tk.company_slug IS NULL
    AND tk.title ILIKE '%' || c.name || '%'
) loose ON true
LEFT JOIN (
  SELECT t.company_slug, COUNT(*) AS review_count
  FROM tasks t
  LEFT JOIN task_decisions td ON td.task_id = t.id
  WHERE t.active = true
    AND (td.status IS NULL OR td.status IN ('needs_matt','needs_refinement'))
  GROUP BY t.company_slug
) review ON review.company_slug = c.slug
LEFT JOIN (
  SELECT t.company_slug, COUNT(*) AS motion_count
  FROM tasks t
  JOIN task_decisions td ON td.task_id = t.id
  WHERE t.active = true
    AND td.status IN ('queued','in_progress','approved')
  GROUP BY t.company_slug
) motion ON motion.company_slug = c.slug
WHERE c.stage IN ('prospect','discovery','demo','proposal','negotiation','on-hold-warm','closed-won');

COMMIT;
