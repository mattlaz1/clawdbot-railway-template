#!/usr/bin/env node
// Reads JSON dumps from db/seed/notion-dump/*.json and upserts rows into Postgres.
// Dumps are produced by Claude Code (using Notion MCP tools) during Phase 1.
//
// Usage:
//   node db/seed/backfill.js             apply upserts
//   node db/seed/backfill.js --dry-run   parse + validate only, no writes
//   node db/seed/backfill.js --only=companies,tasks
//
// All upserts key on notion_id so re-running is idempotent.

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');

const DUMP_DIR = path.join(__dirname, 'notion-dump');
const LOG_DIR = __dirname;
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  return arg ? arg.split('=')[1].split(',') : null;
})();

// ---------- helpers ----------
function readDump(name) {
  const file = path.join(DUMP_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`  (skip) ${name}.json not found`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Map Notion status text -> canonical stage_enum.
// Fallback: lowercase + strip whitespace, match known values, else 'prospect'.
function mapStage(notionStatus) {
  if (!notionStatus) return 'prospect';
  const s = String(notionStatus).trim().toLowerCase();
  const map = {
    'target': 'target',
    'targets': 'target',
    'engaged': 'target',
    'intro done': 'prospect',
    'prospect': 'prospect',
    'prospects': 'prospect',
    'discovery done': 'discovery',
    'discovery': 'discovery',
    'demo scheduled': 'demo',
    'demo': 'demo',
    'proposal sent': 'proposal',
    'proposal': 'proposal',
    'negotiation': 'negotiation',
    'on hold - warm': 'on-hold-warm',
    'on hold-warm': 'on-hold-warm',
    'on-hold-warm': 'on-hold-warm',
    'old hold - cold': 'closed-lost',
    'closed-lost': 'closed-lost',
    'closed lost': 'closed-lost',
    'clients': 'closed-won',
    'client': 'closed-won',
    'closed-won': 'closed-won',
    'closed won': 'closed-won',
  };
  return map[s] || 'prospect';
}

function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'object' && v.start) return v.start;
  return v;
}

function parseNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseArray(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return null;
}

// ---------- upsert executors ----------
const counters = {};
function track(table, kind) {
  counters[table] ||= { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  counters[table][kind]++;
}

async function upsert(table, row, conflictCol, logLabel) {
  const cols = Object.keys(row);
  const vals = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter(c => c !== conflictCol)
    .map(c => `${c}=EXCLUDED.${c}`);

  const sql = `
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${vals.join(', ')})
    ON CONFLICT (${conflictCol}) DO UPDATE SET
      ${updates.join(', ')},
      updated_at = now()
    RETURNING (xmax = 0) AS inserted;
  `;

  if (DRY_RUN) {
    track(table, 'skipped');
    return null;
  }

  try {
    const { rows } = await db.query(sql, cols.map(c => row[c]));
    const wasInsert = rows[0]?.inserted;
    track(table, wasInsert ? 'inserted' : 'updated');
    return rows[0];
  } catch (err) {
    track(table, 'errors');
    console.error(`  [${table}] ${logLabel || ''}: ${err.message}`);
    return null;
  }
}

// Some tables (contacts, tasks, meetings) don't have updated_at on all rows
// or need a lighter upsert without the `updated_at = now()` tail.
async function upsertNoStamp(table, row, conflictCol, logLabel) {
  const cols = Object.keys(row);
  const vals = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter(c => c !== conflictCol)
    .map(c => `${c}=EXCLUDED.${c}`);

  const sql = `
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${vals.join(', ')})
    ON CONFLICT (${conflictCol}) DO UPDATE SET ${updates.join(', ')}
    RETURNING (xmax = 0) AS inserted;
  `;

  if (DRY_RUN) {
    track(table, 'skipped');
    return null;
  }

  try {
    const { rows } = await db.query(sql, cols.map(c => row[c]));
    track(table, rows[0]?.inserted ? 'inserted' : 'updated');
    return rows[0];
  } catch (err) {
    track(table, 'errors');
    console.error(`  [${table}] ${logLabel || ''}: ${err.message}`);
    return null;
  }
}

// ---------- per-table loaders ----------
// Each loader reads a dump file and transforms rows. The dump format is a
// plain JSON array of objects. Each object should have a `notion_id` field
// and the Notion property values we care about.

async function loadCompanies() {
  const rows = readDump('companies');
  if (!rows) return;
  console.log(`\n→ companies (${rows.length} rows)`);

  // Dedupe by slug — Notion occasionally has dupes with different notion_ids.
  const seenSlugs = new Set();
  for (const r of rows) {
    const name = r.name || r.Name || r.company || r.title;
    if (!name) { track('companies', 'skipped'); continue; }

    let slug = r.slug || slugify(name);
    if (seenSlugs.has(slug)) slug = `${slug}-${(r.notion_id || '').slice(0, 6)}`;
    seenSlugs.add(slug);

    const row = {
      name,
      slug,
      stage: mapStage(r.stage || r.status || r.Status),
      deal_value: parseNumber(r.deal_value),
      billing_cadence: r.billing_cadence || null,
      decision_maker: r.decision_maker || null,
      champion: r.champion || null,
      next_action: r.next_action || r.action || null,
      next_action_due: parseDate(r.next_action_due || r.next_touch),
      last_contact: parseDate(r.last_contact),
      field: r.field || null,
      licenses: parseNumber(r.licenses),
      avg_license_cost: parseNumber(r.avg_license_cost),
      action_status: r.action_status || null,
      tags: parseArray(r.tags),
      notion_url: r.notion_url || null,
      notion_id: r.notion_id,
      vault_slug: slug,
      health_score: parseNumber(r.health_score),
      health_tier: r.health_tier || null,
      onboarding_status: r.onboarding_status || null,
      primary_workflow: r.primary_workflow || null,
      mrr: parseNumber(r.mrr),
      project_type: r.project_type || null,
      implementation_total: parseNumber(r.implementation_total),
      implementation_invoiced: parseNumber(r.implementation_invoiced),
      sample_files_status: r.sample_files_status || null,
      blocked_on: r.blocked_on || null,
      last_synced: new Date().toISOString(),
    };
    await upsert('companies', row, 'notion_id', name);
  }
}

async function companyIdByNotion(notionId) {
  if (!notionId) return null;
  const { rows } = await db.query(
    'SELECT company_id FROM companies WHERE notion_id=$1',
    [notionId]
  );
  return rows[0]?.company_id || null;
}

async function companyIdByName(name) {
  if (!name) return null;
  const { rows } = await db.query(
    'SELECT company_id FROM companies WHERE lower(name)=lower($1) LIMIT 1',
    [name]
  );
  return rows[0]?.company_id || null;
}

async function loadContacts() {
  const rows = readDump('contacts');
  if (!rows) return;
  console.log(`\n→ contacts (${rows.length} rows)`);

  for (const r of rows) {
    const name = r.name || r.Name;
    if (!name) { track('contacts', 'skipped'); continue; }

    let company_id =
      (r.company_notion_id ? await companyIdByNotion(r.company_notion_id) : null) ||
      (r.company ? await companyIdByName(r.company) : null);

    if (!company_id) { track('contacts', 'skipped'); continue; }

    const row = {
      company_id,
      name,
      email: r.email || null,
      title: r.title || null,
      phone: r.phone || null,
      phone_office: r.phone_office || null,
      role: r.role || null,
      source: r.source || null,
      tags: parseArray(r.tags),
      notes: r.notes || null,
      last_contacted: parseDate(r.last_contacted),
      notion_id: r.notion_id,
      linkedin_url: r.linkedin_url || null,
    };
    await upsertNoStamp('contacts', row, 'notion_id', name);
  }
}

async function loadTasks() {
  const rows = readDump('tasks');
  if (!rows) return;
  console.log(`\n→ tasks (${rows.length} rows)`);

  for (const r of rows) {
    const name = r.name || r.title || r.Name;
    if (!name) { track('tasks', 'skipped'); continue; }

    const company_id =
      (r.company_notion_id ? await companyIdByNotion(r.company_notion_id) : null) ||
      (r.company ? await companyIdByName(r.company) : null);

    const row = {
      name,
      company_id,
      contact_id: null,
      agent: r.agent || null,
      action_type: r.action_type || r.type || null,
      status: r.status || 'Not started',
      due_date: parseDate(r.due_date),
      notes: r.notes || null,
      notion_id: r.notion_id,
      completed_at: r.status === 'Done' ? (parseDate(r.completed_at) || new Date().toISOString()) : null,
    };
    await upsertNoStamp('tasks', row, 'notion_id', name);
  }
}

async function loadMeetings() {
  const rows = readDump('meetings');
  if (!rows) return;
  console.log(`\n→ meetings (${rows.length} rows)`);

  for (const r of rows) {
    const company_id =
      (r.company_notion_id ? await companyIdByNotion(r.company_notion_id) : null) ||
      (r.company ? await companyIdByName(r.company) : null);

    const row = {
      company_id,
      title: r.title || null,
      meeting_date: parseDate(r.meeting_date),
      duration_minutes: parseNumber(r.duration_minutes),
      recording_url: r.recording_url || null,
      summary: r.summary || null,
      transcript: r.transcript || null,
      attendees: parseArray(r.attendees),
      status: r.status || null,
      source: r.source || 'fathom',
      fathom_id: r.fathom_id || null,
      notion_id: r.notion_id,
      synced_at: new Date().toISOString(),
    };
    if (!row.notion_id) { track('meetings', 'skipped'); continue; }
    await upsertNoStamp('meetings', row, 'notion_id', r.title);
  }
}

async function loadLinkedinPosts() {
  const rows = readDump('linkedin_posts');
  if (!rows) return;
  console.log(`\n→ linkedin_posts (${rows.length} rows)`);

  for (const r of rows) {
    const row = {
      title: r.title || null,
      lane: r.lane || null,
      status: r.status || null,
      topic_tags: parseArray(r.topic_tags),
      thesis: r.thesis || null,
      post_type: r.post_type || null,
      body: r.body || null,
      posted_at: parseDate(r.posted_at),
      linkedin_url: r.linkedin_url || null,
      engagement_json: r.engagement_json || null,
      source_reference: r.source_reference || null,
      rejection_reason: r.rejection_reason || null,
      notion_id: r.notion_id,
    };
    if (!row.notion_id) { track('linkedin_posts', 'skipped'); continue; }
    await upsert('linkedin_posts', row, 'notion_id', r.title);
  }
}

async function loadNewsletters() {
  const rows = readDump('newsletters');
  if (!rows) return;
  console.log(`\n→ newsletters (${rows.length} rows)`);

  for (const r of rows) {
    const row = {
      title: r.title || null,
      series: r.series || null,
      status: r.status || null,
      target_date: parseDate(r.target_date),
      published_at: parseDate(r.published_at),
      substack_url: r.substack_url || null,
      body: r.body || null,
      rejection_reason: r.rejection_reason || null,
      notion_id: r.notion_id,
    };
    if (!row.notion_id) { track('newsletters', 'skipped'); continue; }
    await upsert('newsletters', row, 'notion_id', r.title);
  }
}

async function loadInfluencerIntel() {
  const rows = readDump('influencer_intel');
  if (!rows) return;
  console.log(`\n→ influencer_intel (${rows.length} rows)`);

  for (const r of rows) {
    const row = {
      source_type: r.source_type || null,
      influencer: r.influencer || null,
      topic_tags: parseArray(r.topic_tags),
      key_insight: r.key_insight || null,
      source_url: r.source_url || null,
      relevance: r.relevance || null,
      lane: r.lane || null,
      discovered_at: parseDate(r.discovered_at) || new Date().toISOString(),
      notion_id: r.notion_id,
    };
    if (!row.notion_id) { track('influencer_intel', 'skipped'); continue; }
    await upsertNoStamp('influencer_intel', row, 'notion_id', r.influencer);
  }
}

async function loadDailyReports() {
  const rows = readDump('daily_reports');
  if (!rows) return;
  console.log(`\n→ daily_reports (${rows.length} rows)`);

  for (const r of rows) {
    const row = {
      agent: r.agent || 'cro',
      report_date: parseDate(r.report_date) || new Date().toISOString().slice(0, 10),
      report_type: r.report_type || 'daily',
      title: r.title || null,
      critical_flags: r.critical_flags || null,
      active_items: r.active_items || null,
      recommendations: r.recommendations || null,
      draft_count: parseNumber(r.draft_count),
      body: r.body || null,
      notion_id: r.notion_id,
    };
    if (!row.notion_id) { track('daily_reports', 'skipped'); continue; }
    await upsertNoStamp('daily_reports', row, 'notion_id', r.title);
  }
}

// ---------- orchestrator ----------
const LOADERS = [
  ['companies', loadCompanies],
  ['contacts', loadContacts],
  ['tasks', loadTasks],
  ['meetings', loadMeetings],
  ['linkedin_posts', loadLinkedinPosts],
  ['newsletters', loadNewsletters],
  ['influencer_intel', loadInfluencerIntel],
  ['daily_reports', loadDailyReports],
];

async function main() {
  console.log(`\nSkySuite backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  dump dir: ${DUMP_DIR}`);
  if (!fs.existsSync(DUMP_DIR)) {
    console.error(`  ERROR: dump dir missing. Create it and add JSON files first.`);
    process.exit(1);
  }

  for (const [name, fn] of LOADERS) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      await fn();
    } catch (err) {
      console.error(`  [${name}] fatal:`, err);
    }
  }

  console.log('\nResults:');
  for (const [table, c] of Object.entries(counters)) {
    console.log(
      `  ${table.padEnd(20)}  inserted=${c.inserted}  updated=${c.updated}  skipped=${c.skipped}  errors=${c.errors}`
    );
  }

  const logFile = path.join(LOG_DIR, `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(logFile, JSON.stringify({ dry_run: DRY_RUN, counters, at: new Date().toISOString() }, null, 2));
  console.log(`\n  log: ${path.relative(process.cwd(), logFile)}`);

  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
