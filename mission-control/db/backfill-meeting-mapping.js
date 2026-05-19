#!/usr/bin/env node
// Backfill company_id and meeting type for existing meetings.
//
// Usage:
//   node db/backfill-meeting-mapping.js            # apply changes
//   node db/backfill-meeting-mapping.js --dry-run  # show what would change
//
// Fixes two problems:
//   1. company_id is NULL on 42 meetings — try title regex, attendee email,
//      email domain, then Claude AI.
//   2. status = 'completed' is meaningless — replace with inferred type
//      (Internal/Demo/Discovery/Proposal/Project/NA).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../lib/db');
const { matchCompany, inferType } = require('../lib/match-company');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log(`[backfill] mode: ${DRY_RUN ? 'dry-run' : 'apply'}`);

  // 1. Fix status='completed' → inferred type
  const { rows: completedRows } = await db.query(
    `SELECT meeting_id, title FROM meetings WHERE status = 'completed'`
  );
  console.log(`[backfill] meetings with status='completed': ${completedRows.length}`);

  let typeFixed = 0;
  for (const m of completedRows) {
    const newType = inferType(m.title) || 'NA';
    console.log(`  ${m.title}  →  ${newType}`);
    if (!DRY_RUN) {
      await db.query(`UPDATE meetings SET status = $2 WHERE meeting_id = $1`, [m.meeting_id, newType]);
    }
    typeFixed++;
  }

  // 2. Fill in NULL company_id
  const { rows: unmapped } = await db.query(
    `SELECT m.meeting_id, m.title, m.attendees, m.transcript, m.summary
     FROM meetings m
     WHERE m.company_id IS NULL
     ORDER BY m.meeting_date DESC NULLS LAST`
  );
  console.log(`\n[backfill] meetings with NULL company_id: ${unmapped.length}`);

  const stats = { title: 0, attendee_email: 0, email_domain: 0, ai: 0, none: 0 };

  for (const m of unmapped) {
    const result = await matchCompany({
      title: m.title,
      attendees: m.attendees,
      // No calendar_invitees on old rows — only attendee names. AI fills this gap.
      transcript: m.transcript,
      summary: m.summary,
    });
    stats[result.method] = (stats[result.method] || 0) + 1;
    let companyName = null;
    if (result.company_id) {
      const { rows } = await db.query(`SELECT name, slug FROM companies WHERE company_id = $1`, [result.company_id]);
      companyName = rows[0] ? `${rows[0].name} (${rows[0].slug})` : result.company_id;
    }
    const label = result.company_id ? `→ ${result.method}` : result.method;
    const right = companyName ? `→ ${companyName}` : '';
    const reason = result.reason ? `  // ${result.reason}` : '';
    console.log(`  [${label.padEnd(18)}] ${m.title.padEnd(50)} ${right}${reason}`);
    if (!DRY_RUN && result.company_id) {
      await db.query(
        `UPDATE meetings SET company_id = $2 WHERE meeting_id = $1`,
        [m.meeting_id, result.company_id]
      );
    }
  }

  console.log(`\n[backfill] summary:`);
  console.log(`  status normalized: ${typeFixed}`);
  console.log(`  company matched via title:         ${stats.title || 0}`);
  console.log(`  company matched via attendee email: ${stats.attendee_email || 0}`);
  console.log(`  company matched via email domain:   ${stats.email_domain || 0}`);
  console.log(`  company matched via AI:             ${stats.ai || 0}`);
  console.log(`  still unmatched:                    ${stats.none || 0}`);

  await db.end?.();
}

run().catch(err => { console.error(err); process.exit(1); });
