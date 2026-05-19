#!/usr/bin/env node
// Final vault → Postgres migration. Captures ALL remaining vault data:
//   1. Deal notes (deal.md body below frontmatter) → companies.notes
//   2. Company overview (profile.md body) → companies.company_overview
//   3. Meeting notes (meetings/*.md) → meeting_notes table
//   4. Email drafts (emails/*.md) → email_drafts table
//   5. Image/binary files → company_files table
//
// Only writes to NULL/empty fields — never overwrites existing Postgres data.
// Idempotent via unique indexes and NULL checks.
//
// Usage:
//   node db/seed/backfill-vault-all.js              apply
//   node db/seed/backfill-vault-all.js --dry-run    show what would change

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const db = require('../../lib/db');

const VAULT = path.resolve(__dirname, '..', '..', '..', 'contacts');
const DRY_RUN = process.argv.includes('--dry-run');

const counters = {
  deal_notes: 0,
  company_overview: 0,
  meeting_notes: 0,
  email_drafts: 0,
  files: 0,
  skipped: 0,
  errors: 0,
};

// ---------- helpers ----------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { fm: null, body: content };
  try {
    const fm = yaml.parse(match[1]);
    const body = content.slice(match[0].length).trim();
    return { fm, body };
  } catch {
    return { fm: null, body: content };
  }
}

function hasContent(text) {
  if (!text) return false;
  // Strip empty headers and whitespace
  const cleaned = text
    .replace(/^##?\s+.+$/gm, '')  // remove markdown headers
    .replace(/\n+/g, '\n')
    .trim();
  return cleaned.length > 10;  // more than just whitespace/punctuation
}

async function getCompanyId(slug) {
  const { rows } = await db.query(
    'SELECT company_id FROM companies WHERE slug = $1 OR vault_slug = $1', [slug]
  );
  if (rows[0]) return rows[0].company_id;
  // Fuzzy match
  const { rows: fuzzy } = await db.query(
    `SELECT company_id, slug FROM companies
     WHERE slug LIKE '%' || $1 || '%' OR $1 LIKE '%' || slug || '%'
     LIMIT 1`, [slug]
  );
  return fuzzy[0]?.company_id || null;
}

// ---------- 1. Deal notes ----------

async function backfillDealNotes(slug, dir) {
  const dealPath = path.join(dir, 'deal.md');
  if (!fs.existsSync(dealPath)) return;

  const { body } = parseFrontmatter(fs.readFileSync(dealPath, 'utf8'));
  if (!hasContent(body)) return;

  const companyId = await getCompanyId(slug);
  if (!companyId) return;

  // Only fill if notes column is NULL
  const { rows: [row] } = await db.query(
    'SELECT notes FROM companies WHERE company_id = $1', [companyId]
  );
  if (row?.notes) { counters.skipped++; return; }

  if (DRY_RUN) {
    console.log(`  [${slug}] deal notes: ${body.length} chars`);
    counters.deal_notes++;
    return;
  }

  await db.query('UPDATE companies SET notes = $1, updated_at = now() WHERE company_id = $2', [body, companyId]);
  console.log(`  [${slug}] deal notes → companies.notes (${body.length} chars)`);
  counters.deal_notes++;
}

// ---------- 2. Company overview from profile.md ----------

async function backfillCompanyOverview(slug, dir) {
  const profilePath = path.join(dir, 'profile.md');
  if (!fs.existsSync(profilePath)) return;

  const content = fs.readFileSync(profilePath, 'utf8');

  // Extract Company Overview section
  const overviewMatch = content.match(/## Company Overview\n([\s\S]*?)(?=\n## |$)/);
  const icpMatch = content.match(/## ICP Fit\n([\s\S]*?)(?=\n## |$)/);

  let overview = '';
  if (overviewMatch && hasContent(overviewMatch[1])) overview += overviewMatch[1].trim();
  if (icpMatch && hasContent(icpMatch[1])) overview += (overview ? '\n\n## ICP Fit\n' : '') + icpMatch[1].trim();

  if (!overview) return;

  const companyId = await getCompanyId(slug);
  if (!companyId) return;

  const { rows: [row] } = await db.query(
    'SELECT company_overview FROM companies WHERE company_id = $1', [companyId]
  );
  if (row?.company_overview) { counters.skipped++; return; }

  if (DRY_RUN) {
    console.log(`  [${slug}] company overview: ${overview.length} chars`);
    counters.company_overview++;
    return;
  }

  await db.query('UPDATE companies SET company_overview = $1, updated_at = now() WHERE company_id = $2', [overview, companyId]);
  console.log(`  [${slug}] profile → companies.company_overview (${overview.length} chars)`);
  counters.company_overview++;
}

// ---------- 3. Meeting notes ----------

async function backfillMeetingNotes(slug, dir) {
  const meetingsDir = path.join(dir, 'meetings');
  if (!fs.existsSync(meetingsDir)) return;

  const files = fs.readdirSync(meetingsDir).filter(f => f.endsWith('.md'));
  if (!files.length) return;

  const companyId = await getCompanyId(slug);
  if (!companyId) return;

  for (const file of files) {
    const content = fs.readFileSync(path.join(meetingsDir, file), 'utf8');
    if (!hasContent(content)) continue;

    // Extract date from filename (YYYY-MM-DD_*)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const meetingDate = dateMatch ? dateMatch[1] : null;
    if (!meetingDate) { counters.errors++; continue; }

    // Extract title from first heading or filename
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '').replace(/_/g, ' ');

    const wordCount = content.split(/\s+/).length;
    const sourcePath = `contacts/${slug}/meetings/${file}`;

    if (DRY_RUN) {
      console.log(`  [${slug}] meeting note: ${file} (${wordCount} words)`);
      counters.meeting_notes++;
      continue;
    }

    try {
      const { rows } = await db.query(`
        INSERT INTO meeting_notes (company_id, title, meeting_date, body, source_file, word_count)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (company_id, meeting_date, md5(coalesce(title,'')))
        DO NOTHING
        RETURNING note_id
      `, [companyId, title, meetingDate, content, sourcePath, wordCount]);

      if (rows.length) {
        counters.meeting_notes++;
        console.log(`  [${slug}] ${file} → meeting_notes (${wordCount} words)`);
      } else {
        counters.skipped++;
      }
    } catch (err) {
      counters.errors++;
      console.error(`  [${slug}] ${file} ERR: ${err.message}`);
    }
  }
}

// ---------- 4. Email drafts ----------

async function backfillEmailDrafts(slug, dir) {
  const emailsDir = path.join(dir, 'emails');
  if (!fs.existsSync(emailsDir)) return;

  const files = fs.readdirSync(emailsDir).filter(f => f.endsWith('.md'));
  if (!files.length) return;

  const companyId = await getCompanyId(slug);
  if (!companyId) return;

  for (const file of files) {
    const content = fs.readFileSync(path.join(emailsDir, file), 'utf8');
    if (!hasContent(content)) continue;

    const { fm, body } = parseFrontmatter(content);

    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const draftDate = dateMatch ? dateMatch[1] : (fm?.date || null);
    const title = fm?.title || file.replace(/\.md$/, '').replace(/_/g, ' ');
    const recipient = fm?.to || fm?.recipient || null;
    const subject = fm?.subject || null;
    const status = fm?.status || 'Drafted';
    const sourcePath = `contacts/${slug}/emails/${file}`;

    if (DRY_RUN) {
      console.log(`  [${slug}] email draft: ${file}`);
      counters.email_drafts++;
      continue;
    }

    try {
      await db.query(`
        INSERT INTO email_drafts (company_id, title, draft_date, recipient, subject, status, body, source_file)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [companyId, title, draftDate, recipient, subject, status, body || content, sourcePath]);
      counters.email_drafts++;
      console.log(`  [${slug}] ${file} → email_drafts`);
    } catch (err) {
      counters.errors++;
      console.error(`  [${slug}] ${file} ERR: ${err.message}`);
    }
  }
}

// ---------- 5. Binary files (images, etc.) ----------

async function backfillFiles(slug, dir) {
  const filesDir = path.join(dir, 'files');
  if (!fs.existsSync(filesDir)) return;

  const companyId = await getCompanyId(slug);
  if (!companyId) return;

  // Recursively find all files
  function walk(d) {
    const items = [];
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) items.push(...walk(full));
      else items.push(full);
    }
    return items;
  }

  const allFiles = walk(filesDir);
  for (const filePath of allFiles) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const fileType = mimeMap[ext] || 'application/octet-stream';
    const relativePath = `contacts/${slug}/files/${path.relative(filesDir, filePath).replace(/\\/g, '/')}`;

    if (DRY_RUN) {
      console.log(`  [${slug}] file: ${relativePath}`);
      counters.files++;
      continue;
    }

    try {
      const data = fs.readFileSync(filePath);
      await db.query(`
        INSERT INTO company_files (company_id, filename, file_type, file_data, source_path)
        VALUES ($1, $2, $3, $4, $5)
      `, [companyId, filename, fileType, data, relativePath]);
      counters.files++;
      console.log(`  [${slug}] ${filename} → company_files (${data.length} bytes)`);
    } catch (err) {
      counters.errors++;
      console.error(`  [${slug}] ${filename} ERR: ${err.message}`);
    }
  }
}

// ---------- orchestrator ----------

async function main() {
  console.log(`Vault → Postgres final migration${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  vault: ${VAULT}\n`);

  const slugs = fs.readdirSync(VAULT).filter(f =>
    fs.statSync(path.join(VAULT, f)).isDirectory()
  );

  for (const slug of slugs) {
    const dir = path.join(VAULT, slug);
    await backfillDealNotes(slug, dir);
    await backfillCompanyOverview(slug, dir);
    await backfillMeetingNotes(slug, dir);
    await backfillEmailDrafts(slug, dir);
    await backfillFiles(slug, dir);
  }

  console.log('\n=== Results ===');
  console.log(`  deal_notes:       ${counters.deal_notes}`);
  console.log(`  company_overview:  ${counters.company_overview}`);
  console.log(`  meeting_notes:     ${counters.meeting_notes}`);
  console.log(`  email_drafts:      ${counters.email_drafts}`);
  console.log(`  files:             ${counters.files}`);
  console.log(`  skipped:           ${counters.skipped}`);
  console.log(`  errors:            ${counters.errors}`);

  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
