-- 020_unify_legacy_tasks.sql
-- Stage A of the proposals/tasks unification.
--
-- The legacy `tasks` table is renamed to `tasks_legacy` (kept read-only for one
-- week as a safety net), and its rows are migrated into `proposals`. The
-- proposals table gains the columns it needs to absorb the task concept.
-- Stage B (021) renames proposals -> tasks. Stage C drops tasks_legacy.
--
-- Idempotency: safe to re-run. Uses ON CONFLICT DO NOTHING and IF NOT EXISTS.
-- Wrap in transaction for atomicity.

BEGIN;

-- 1. Rename legacy tasks table out of the way (skip if already done)
DO $rename$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='tasks')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='tasks_legacy')
  THEN
    EXECUTE 'ALTER TABLE tasks RENAME TO tasks_legacy';
  END IF;
END
$rename$;

-- 2. Add the columns proposals needs to absorb tasks
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(contact_id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'ai_suggested';

-- Origin CHECK constraint (idempotent: drop + re-add)
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_origin_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_origin_check
  CHECK (origin IN ('ai_suggested','ai_committed','manual','migrated'));

-- 3. Migrate open legacy rows (status not Done/Completed) into proposals
INSERT INTO proposals (id, agent_id, generated_at, title, action_type, added_at, due_date,
                       company_slug, contact_id, notes, origin, active, priority,
                       created_at, updated_at)
SELECT
  'migrated-' || COALESCE(t.notion_id, t.task_id::text),
  COALESCE(NULLIF(LOWER(t.agent),''), 'cro'),
  t.created_at,
  t.name,
  CASE LOWER(COALESCE(t.action_type,''))
    WHEN 'email'    THEN 'draft_email'
    WHEN 'call'     THEN 'calendar_event'
    WHEN 'meeting'  THEN 'calendar_event'
    WHEN 'text'     THEN 'draft_email'
    WHEN 'research' THEN 'research'
    ELSE 'notion_task'
  END,
  t.created_at,
  t.due_date,
  co.slug,
  t.contact_id,
  t.notes,
  'migrated',
  true,
  'normal',
  t.created_at,
  t.updated_at
FROM tasks_legacy t
LEFT JOIN companies co ON co.company_id = t.company_id
WHERE LOWER(TRIM(t.status)) NOT IN ('done','completed')
ON CONFLICT (id) DO NOTHING;

-- 4. Pre-decide migrated rows so they skip the review queue (queued/in_progress)
INSERT INTO proposal_decisions (proposal_id, agent_id, decision, status, thread, queued_at, created_at, updated_at)
SELECT
  p.id,
  p.agent_id,
  'yes',
  CASE LOWER(TRIM(t.status))
    WHEN 'in progress' THEN 'in_progress'
    ELSE 'queued'
  END,
  jsonb_build_array(jsonb_build_object(
    'role','system',
    'ts', now(),
    'text','Migrated from legacy tasks table',
    'orphan', t.agent IS NULL OR t.agent = ''
  )),
  t.created_at,
  now(),
  now()
FROM proposals p
JOIN tasks_legacy t ON ('migrated-' || COALESCE(t.notion_id, t.task_id::text)) = p.id
WHERE p.origin = 'migrated' AND p.active = true
ON CONFLICT (proposal_id) DO NOTHING;

-- 5. Archive Done legacy rows (preserves /measure-outcomes history)
INSERT INTO proposals (id, agent_id, title, action_type, added_at, due_date, company_slug,
                       contact_id, notes, origin, active, completed_at, priority,
                       created_at, updated_at)
SELECT
  'archived-' || COALESCE(t.notion_id, t.task_id::text),
  COALESCE(NULLIF(LOWER(t.agent),''), 'cro'),
  t.name,
  'notion_task',
  t.created_at,
  t.due_date,
  co.slug,
  t.contact_id,
  t.notes,
  'migrated',
  false,
  COALESCE(t.completed_at, t.updated_at),
  'normal',
  t.created_at,
  t.updated_at
FROM tasks_legacy t
LEFT JOIN companies co ON co.company_id = t.company_id
WHERE LOWER(TRIM(t.status)) IN ('done','completed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO proposal_decisions (proposal_id, agent_id, decision, status, updated_at)
SELECT
  'archived-' || COALESCE(t.notion_id, t.task_id::text),
  COALESCE(NULLIF(LOWER(t.agent),''), 'cro'),
  'yes',
  'archived',
  t.updated_at
FROM tasks_legacy t
WHERE LOWER(TRIM(t.status)) IN ('done','completed')
ON CONFLICT (proposal_id) DO NOTHING;

-- 6. Sanity check before commit
DO $check$
DECLARE
  open_legacy int;
  migrated_count int;
  done_legacy int;
  archived_count int;
BEGIN
  SELECT COUNT(*) INTO open_legacy FROM tasks_legacy WHERE LOWER(TRIM(status)) NOT IN ('done','completed');
  SELECT COUNT(*) INTO migrated_count FROM proposals WHERE origin = 'migrated' AND active = true;
  SELECT COUNT(*) INTO done_legacy FROM tasks_legacy WHERE LOWER(TRIM(status)) IN ('done','completed');
  SELECT COUNT(*) INTO archived_count FROM proposals WHERE origin = 'migrated' AND active = false;

  RAISE NOTICE 'open_legacy=%, migrated=%, done_legacy=%, archived=%',
    open_legacy, migrated_count, done_legacy, archived_count;

  IF open_legacy <> migrated_count THEN
    RAISE EXCEPTION 'Open-tasks migration mismatch: % open vs % migrated', open_legacy, migrated_count;
  END IF;
  IF done_legacy <> archived_count THEN
    RAISE EXCEPTION 'Done-tasks archive mismatch: % done vs % archived', done_legacy, archived_count;
  END IF;
END
$check$;

COMMIT;
