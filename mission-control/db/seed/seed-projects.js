#!/usr/bin/env node
// seed-projects.js — One-time seed of the `projects` table from current CS state.
//
// Reads:
//   - hardcoded list of known active client projects (below) — derived from
//     companies.next_action, SkySuite/agent/cs/action-queue.md, and the
//     bowery-hotel-model.md project doc.
//   - active tasks in Postgres (for back-linking proposal).
//
// Writes (only with --apply):
//   - INSERTs into `projects` (idempotent via ON CONFLICT on (company_id, slug))
//   - UPDATEs `tasks.project_id` for tasks whose titles match a project's
//     keyword list (Matt confirms the proposed links before --apply).
//
// Usage:
//   node db/seed/seed-projects.js                # dry-run: print plan, no writes
//   node db/seed/seed-projects.js --apply        # actually write
//   node db/seed/seed-projects.js --no-backlink  # only insert projects, skip task back-link

const db = require('../../lib/db');

const APPLY = process.argv.includes('--apply');
const NO_BACKLINK = process.argv.includes('--no-backlink');

// ---------------------------------------------------------------------------
// Project catalog — what to seed.
// Keywords are matched case-insensitive against tasks.title for back-linking.
// Keep them specific enough that a generic "Bowery follow-up" task does NOT
// match the Hotel Template project; back-link sweep prints proposals for review.
// ---------------------------------------------------------------------------
const PROJECTS = [
  {
    company_slug: 'bowery-valuation',
    name: 'Hotel Appraisal Template',
    slug: 'hotel-template',
    kind: 'vba_macro',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'high',
    current_version: '4.15.26_v2',
    context_doc_path: 'SkySuite/agent/analyst/projects/bowery-hotel-model.md',
    summary: 'Rewriting Bowery hotel appraisal Excel template macros. Maren is running second-round testing. Production target end of month. Blocked on Maren Proforma file.',
    blocked_on: 'Waiting on Maren Proforma Excel file for second-round testing',
    keywords: ['hotel template', 'hotel macro', 'penetration module', 'proforma fix', 'cbre import', 'costar import', 'salesforce hotel', 'macro import', 'fix macro'],
  },
  {
    company_slug: 'montgomery',
    name: 'SNF Template',
    slug: 'snf-template',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'high',
    summary: 'Senior housing (SNF) template — classification improvements + dev queue from 5/8 call: row 87 rename, dropdown regression, partial-TTM, cross-year propagation. Andrew + Jeremy.',
    keywords: ['snf template', 'snf', 'senior housing template', 'partial-ttm', 'cross-year propagation', 'row 87', 'dropdown regression', 'classification improvement', 'gl template'],
  },
  {
    company_slug: 'origin-investments',
    name: 'IC Memo',
    slug: 'ic-memo',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'high',
    summary: 'IC Memo template automation. Tom Briney (head of credit) provided handwritten feedback 5/13 via Preston FW. Awaiting transcription / clean scan to incorporate.',
    keywords: ['ic memo', 'ic-memo', 'tom briney', 'briney feedback'],
  },
  {
    company_slug: 'origin-investments',
    name: 'Bridge Model',
    slug: 'bridge-model',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'normal',
    summary: 'Origin bridge model — 7x faster, 50% smaller, INDEX MATCH conversion done. Preston, David Welk, Steven Soltes, Erica Yaguchi running deals through it.',
    keywords: ['bridge model', 'bridge underwriting', 'index match'],
  },
  {
    company_slug: 'origin-investments',
    name: 'Phase 2 Michael',
    slug: 'phase-2-michael',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'paused',
    priority: 'low',
    summary: 'Phase 2 conversation with Michael — parked until week-after-next per 5/13 next_action.',
    blocked_on: 'Parked by Matt — resume week-after-next',
    keywords: ['phase 2 michael', 'phase-2 michael', 'michael conversation'],
  },
  {
    company_slug: 'origin-investments',
    name: 'Carry Item Fixes (Multilytics + Sale Comps + Rent Comps + Pref)',
    slug: 'carry-fixes',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'normal',
    summary: '8 carry items — Multilytics Rank chart, Sale Comps tab, Rent Comps refs, Pref box.',
    keywords: ['multilytics', 'sale comps tab', 'rent comps refs', 'pref box', 'cut 8 carry', 'carry item'],
  },
  {
    company_slug: 'larc-analytics',
    name: 'Supply Build',
    slug: 'supply-build',
    kind: 'excel_model',
    owning_agent: 'analyst',
    status: 'active',
    priority: 'high',
    summary: 'LARC supply build — start post Research Session (Katie Harding + Sarah Bieker LWH + Ryan Meliker). OneDrive permissions resolved 5/12.',
    keywords: ['supply build', 'larc supply', 'lwh supply'],
  },
];

async function getCompanyId(slug) {
  const { rows } = await db.query('SELECT company_id FROM companies WHERE slug = $1', [slug]);
  return rows[0]?.company_id || null;
}

async function projectExists(companyId, slug) {
  const { rows } = await db.query(
    'SELECT project_id FROM projects WHERE company_id = $1 AND slug = $2',
    [companyId, slug]
  );
  return rows[0]?.project_id || null;
}

async function upsertProject(p, companyId) {
  const { rows } = await db.query(
    `INSERT INTO projects (
       company_id, company_slug, name, slug, kind, owning_agent, status,
       priority, blocked_on, current_version, context_doc_path, summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (company_id, slug) DO UPDATE SET
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       owning_agent = EXCLUDED.owning_agent,
       status = EXCLUDED.status,
       priority = EXCLUDED.priority,
       blocked_on = EXCLUDED.blocked_on,
       current_version = EXCLUDED.current_version,
       context_doc_path = EXCLUDED.context_doc_path,
       summary = EXCLUDED.summary,
       updated_at = now()
     RETURNING project_id`,
    [companyId, p.company_slug, p.name, p.slug, p.kind, p.owning_agent, p.status,
     p.priority, p.blocked_on || null, p.current_version || null,
     p.context_doc_path || null, p.summary || null]
  );
  return rows[0].project_id;
}

// Find candidate tasks to back-link to a project by keyword match against title.
async function findBacklinkCandidates(project) {
  const { rows } = await db.query(
    `SELECT id, title, agent_id, company_slug, project_id
     FROM tasks
     WHERE active = true AND company_slug = $1 AND project_id IS NULL`,
    [project.company_slug]
  );
  return rows.filter(r => {
    const lc = r.title.toLowerCase();
    return project.keywords.some(k => lc.includes(k.toLowerCase()));
  });
}

async function main() {
  console.log(`\n=== Project Seed ${APPLY ? '(APPLY MODE)' : '(DRY RUN — no writes)'} ===\n`);

  // Phase 1: project creation
  const projectIds = {}; // (company_slug, slug) -> project_id

  for (const p of PROJECTS) {
    const companyId = await getCompanyId(p.company_slug);
    if (!companyId) {
      console.log(`✗ SKIP ${p.company_slug}/${p.slug} — company not found`);
      continue;
    }

    const existing = await projectExists(companyId, p.slug);
    if (existing) {
      console.log(`  EXISTS ${p.company_slug}/${p.slug} → ${existing.substring(0,8)} (will update fields on --apply)`);
      projectIds[`${p.company_slug}/${p.slug}`] = existing;
    } else {
      console.log(`+ CREATE ${p.company_slug}/${p.slug} — ${p.name} (${p.kind}, ${p.owning_agent}, ${p.priority})`);
      if (APPLY) {
        const pid = await upsertProject(p, companyId);
        projectIds[`${p.company_slug}/${p.slug}`] = pid;
      } else {
        projectIds[`${p.company_slug}/${p.slug}`] = 'DRY-RUN';
      }
    }
    if (APPLY && existing) {
      await upsertProject(p, companyId);
    }
  }

  if (NO_BACKLINK) {
    console.log('\n(skipping back-link sweep per --no-backlink)');
    await db.end();
    return;
  }

  // Phase 2: back-link existing tasks
  console.log('\n--- Task Back-Link Proposals ---\n');
  let proposedLinks = 0;
  let proposalsByProject = {};

  for (const p of PROJECTS) {
    const candidates = await findBacklinkCandidates(p);
    if (!candidates.length) continue;
    proposalsByProject[`${p.company_slug}/${p.slug}`] = candidates;
    console.log(`\n  → ${p.company_slug}/${p.slug} (${p.name})`);
    for (const c of candidates) {
      proposedLinks++;
      console.log(`    [${c.agent_id}] ${c.id}  "${c.title.substring(0, 80)}"`);
    }
  }

  if (proposedLinks === 0) {
    console.log('  (no matches — nothing to back-link)');
  } else {
    console.log(`\n  Total: ${proposedLinks} back-link(s) proposed.`);
  }

  // Apply back-links
  if (APPLY && proposedLinks > 0) {
    console.log('\n--- Applying back-links ---');
    for (const key of Object.keys(proposalsByProject)) {
      const projectId = projectIds[key];
      if (!projectId || projectId === 'DRY-RUN') continue;
      const ids = proposalsByProject[key].map(c => c.id);
      const { rowCount } = await db.query(
        `UPDATE tasks SET project_id = $1, updated_at = now() WHERE id = ANY($2)`,
        [projectId, ids]
      );
      console.log(`  ${key}: linked ${rowCount} task(s)`);
    }
  }

  console.log('\n=== Done ===');
  if (!APPLY) console.log('Re-run with --apply to write to Postgres.\n');
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
