-- company_coverage_view: one row per active CRO deal or CS client with
-- joined active-proposal count, latest proposal title, and open-task count.
-- Powers the Mission Control "Companies" tab and the CRO/CS daily coverage
-- sweep (auto-generates a "no plan in motion" proposal when both counts are 0).
--
-- A company is "uncovered" when:
--   active_proposal_count_total = 0 AND open_task_count = 0
--
-- active_proposal_count_total = strict matches (proposals.company_slug = c.slug)
--                              + loose matches (company name appears in any active
--                                proposal title, e.g. batch proposals like
--                                "Close-out batch: Spring11, Gantry, Townhouse").
-- This prevents the coverage sweep from generating duplicate "no plan" proposals
-- for companies that ARE covered by a multi-company batch proposal.
--
-- owning_agent is derived from stage:
--   prospect|discovery|demo|proposal|negotiation|on-hold-warm  -> 'cro'
--   closed-won                                                 -> 'cs'
--
-- Closed-lost and target stages are intentionally excluded — CRO/CS don't own them.

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
  COALESCE(p.active_proposal_count, 0) AS active_proposal_count,
  COALESCE(loose.loose_proposal_count, 0) AS loose_proposal_count,
  COALESCE(p.active_proposal_count, 0) + COALESCE(loose.loose_proposal_count, 0) AS active_proposal_count_total,
  p.latest_proposal_title,
  p.latest_proposal_due_date,
  COALESCE(t.open_task_count, 0) AS open_task_count,
  -- convenience flag for the daily coverage sweep — true when nothing is in motion
  (COALESCE(p.active_proposal_count, 0) = 0
    AND COALESCE(loose.loose_proposal_count, 0) = 0
    AND COALESCE(t.open_task_count, 0) = 0) AS is_uncovered
FROM companies c
JOIN companies_view cv ON cv.company_id = c.company_id
LEFT JOIN (
  SELECT
    company_slug,
    COUNT(*) AS active_proposal_count,
    (array_agg(title ORDER BY due_date NULLS LAST, added_at DESC))[1] AS latest_proposal_title,
    MIN(due_date) AS latest_proposal_due_date
  FROM proposals
  WHERE active = true AND company_slug IS NOT NULL
  GROUP BY company_slug
) p ON p.company_slug = c.slug
-- Loose match: company name mentioned in an active proposal title (covers
-- multi-company batch proposals where company_slug is correctly NULL).
-- Case-insensitive substring on c.name. Only counts proposals where slug IS NULL
-- so we don't double-count strict matches.
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS loose_proposal_count
  FROM proposals pr
  WHERE pr.active = true
    AND pr.company_slug IS NULL
    AND pr.title ILIKE '%' || c.name || '%'
) loose ON true
LEFT JOIN (
  SELECT company_id, COUNT(*) AS open_task_count
  FROM tasks
  WHERE status != 'Done'
  GROUP BY company_id
) t ON t.company_id = c.company_id
WHERE c.stage IN ('prospect','discovery','demo','proposal','negotiation','on-hold-warm','closed-won');
