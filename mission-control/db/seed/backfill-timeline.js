#!/usr/bin/env node
// Parses vault contacts/{slug}/timeline.md files and upserts into the timeline table.
// Idempotent: uses (company_id, entry_date, md5(title)) unique index to skip dupes.
//
// Usage:
//   node db/seed/backfill-timeline.js              apply
//   node db/seed/backfill-timeline.js --dry-run    parse + validate only
//   node db/seed/backfill-timeline.js --only=origin-investments,larc-analytics

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');

const VAULT = path.resolve(__dirname, '..', '..', '..', 'contacts');
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  return arg ? arg.split('=')[1].split(',') : null;
})();

const counters = { parsed: 0, inserted: 0, skipped: 0, errors: 0 };

// Classify entry type from title/details text
function classifyType(title, details) {
  const t = (title + ' ' + (details || '')).toLowerCase();
  if (t.includes('email') || t.includes('drafted') || t.includes('sent email') || t.includes('follow-up email') || t.includes('reply')) return 'email';
  if (t.includes('call') || t.includes('touch-base') || t.includes('touchbase') || t.includes('demo') || t.includes('discovery') || t.includes('intro') || t.includes('review') || t.includes('walkthrough') || t.includes('check-in') || t.includes('meeting')) return 'meeting';
  if (t.includes('linkedin') || t.includes('dm ')) return 'email';
  if (t.includes('text') || t.includes('sms')) return 'call';
  return 'note';
}

// Parse a single timeline.md file
function parseTimeline(content, slug) {
  const entries = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Format 1: "- 2026-03-19 — Title — Details"
    const dashMatch = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s+[—–-]+\s+(.+)/);
    if (dashMatch) {
      const [, dateStr, rest] = dashMatch;
      // Split on " — " to separate title from details
      const parts = rest.split(/\s+[—–-]+\s+/);
      const title = parts[0]?.trim() || null;
      const details = parts.slice(1).join(' — ').trim() || null;

      // Extract fathom URL
      const fathomMatch = rest.match(/(https:\/\/fathom\.video\/\S+)/);
      const recordingUrl = fathomMatch ? fathomMatch[1] : null;

      // Extract notion meeting ID from HTML comment
      const notionMatch = rest.match(/<!--\s*notion-meeting-id:\s*([^\s>]+)\s*-->/);
      const notionMeetingId = notionMatch ? notionMatch[1] : null;

      // Clean details: remove fathom URL and notion comment
      let cleanDetails = details;
      if (cleanDetails) {
        cleanDetails = cleanDetails
          .replace(/https:\/\/fathom\.video\/\S+/g, '')
          .replace(/<!--[^>]*-->/g, '')
          .trim() || null;
      }

      entries.push({
        date: dateStr,
        title,
        details: cleanDetails,
        recording_url: recordingUrl,
        notion_meeting_id: notionMeetingId,
        entry_type: classifyType(title, cleanDetails),
      });
      continue;
    }

    // Format 2: "## 2026-03-19 — Title" (heading style, with content on following lines)
    const headingMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+[—–-]+\s+(.+)/);
    if (headingMatch) {
      const [, dateStr, title] = headingMatch;
      // Gather subsequent lines until next heading or entry
      const idx = lines.indexOf(line);
      const detailLines = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].match(/^##\s+\d{4}/) || lines[i].match(/^-\s+\d{4}-\d{2}-\d{2}/)) break;
        if (lines[i].trim()) detailLines.push(lines[i].trim());
      }
      const details = detailLines.join('\n') || null;

      const fathomMatch = (title + ' ' + (details || '')).match(/(https:\/\/fathom\.video\/\S+)/);
      const notionMatch = (title + ' ' + (details || '')).match(/<!--\s*notion-meeting-id:\s*([^\s>]+)\s*-->/);

      entries.push({
        date: dateStr,
        title: title.trim(),
        details,
        recording_url: fathomMatch ? fathomMatch[1] : null,
        notion_meeting_id: notionMatch ? notionMatch[1] : null,
        entry_type: classifyType(title, details),
      });
    }
  }

  return entries;
}

async function getCompanyId(slug) {
  // Exact match first
  const { rows } = await db.query(
    'SELECT company_id FROM companies WHERE slug = $1 OR vault_slug = $1',
    [slug]
  );
  if (rows[0]) return rows[0].company_id;

  // Fuzzy: vault slug may be a substring of DB slug or vice versa
  // e.g. vault "mountaintop-group" vs DB "the-mountaintop-group"
  // e.g. vault "omni-development" vs DB "omni-development-corporation"
  // e.g. vault "montgomery-senior-housing" vs DB "montgomery"
  const { rows: fuzzy } = await db.query(
    `SELECT company_id, slug FROM companies
     WHERE slug LIKE '%' || $1 || '%' OR $1 LIKE '%' || slug || '%'
     LIMIT 1`,
    [slug]
  );
  if (fuzzy[0]) {
    console.log(` (matched ${slug} → ${fuzzy[0].slug})`);
    return fuzzy[0].company_id;
  }
  return null;
}

async function main() {
  console.log(`Timeline backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  vault: ${VAULT}`);

  if (!fs.existsSync(VAULT)) {
    console.error('  ERROR: vault contacts dir not found');
    process.exit(1);
  }

  const slugs = fs.readdirSync(VAULT).filter(f => {
    if (ONLY && !ONLY.includes(f)) return false;
    const tlPath = path.join(VAULT, f, 'timeline.md');
    return fs.existsSync(tlPath);
  });

  console.log(`  ${slugs.length} companies with timeline.md\n`);

  for (const slug of slugs) {
    const companyId = await getCompanyId(slug);
    if (!companyId) {
      console.warn(`  [${slug}] no matching company in DB — skipping`);
      counters.skipped++;
      continue;
    }

    const content = fs.readFileSync(path.join(VAULT, slug, 'timeline.md'), 'utf8');
    const entries = parseTimeline(content, slug);

    if (!entries.length) {
      counters.skipped++;
      continue;
    }

    process.stdout.write(`  ${slug}: ${entries.length} entries`);
    let ins = 0, skip = 0;

    for (const e of entries) {
      counters.parsed++;

      if (DRY_RUN) {
        ins++;
        continue;
      }

      try {
        const { rows } = await db.query(`
          INSERT INTO timeline (company_id, entry_date, entry_type, title, details, recording_url, notion_meeting_id, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'vault')
          ON CONFLICT (company_id, entry_date, md5(coalesce(title,'')))
          DO NOTHING
          RETURNING entry_id
        `, [companyId, e.date, e.entry_type, e.title, e.details, e.recording_url, e.notion_meeting_id]);

        if (rows.length) {
          counters.inserted++;
          ins++;
        } else {
          counters.skipped++;
          skip++;
        }
      } catch (err) {
        counters.errors++;
        console.error(`\n    ERR: ${err.message}`);
      }
    }

    console.log(` → ${ins} new, ${skip} existing`);
  }

  console.log(`\nResults: parsed=${counters.parsed} inserted=${counters.inserted} skipped=${counters.skipped} errors=${counters.errors}`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
