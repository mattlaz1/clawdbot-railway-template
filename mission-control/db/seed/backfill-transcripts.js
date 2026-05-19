#!/usr/bin/env node
// Backfills meetings.transcript from Notion Fathom Meetings page content.
// Each Notion meeting page has the full Fathom transcript embedded as body text.
//
// Usage:
//   node db/seed/backfill-transcripts.js              apply
//   node db/seed/backfill-transcripts.js --dry-run    show what would change

const db = require('../../lib/db');

const DRY_RUN = process.argv.includes('--dry-run');

// Notion API via the MCP integration isn't available in scripts,
// so we use the Notion internal API directly.
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_API = 'https://api.notion.com/v1';
const FATHOM_DB_ID = '2a9a1425-575c-8072-b791-c4c426399573';

const counters = { updated: 0, skipped: 0, empty: 0, errors: 0 };

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch all pages from the Notion Fathom Meetings database
async function fetchAllNotionMeetings() {
  const pages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${FATHOM_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion query failed: ${res.status} ${err}`);
    }
    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
    if (cursor) await sleep(350); // rate limit
  } while (cursor);
  return pages;
}

// Fetch block children (page content) recursively
async function fetchPageContent(pageId) {
  const blocks = [];
  let cursor = undefined;
  do {
    const url = `${NOTION_API}/blocks/${pageId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!res.ok) {
      if (res.status === 429) {
        await sleep(1000);
        continue;
      }
      return '';
    }
    const data = await res.json();
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
    if (cursor) await sleep(200);
  } while (cursor);

  // Extract text from blocks
  const lines = [];
  for (const block of blocks) {
    const richTexts = block[block.type]?.rich_text || [];
    const text = richTexts.map(t => t.plain_text).join('');
    if (text) lines.push(text);
    // Handle headings, paragraphs, etc.
    if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
      // Already captured above
    }
    if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') {
      // Already captured above with bullet text
    }
  }
  return lines.join('\n');
}

function extractTitle(page) {
  const titleProp = page.properties?.Name;
  if (!titleProp?.title?.length) return '';
  return titleProp.title.map(t => t.plain_text).join('');
}

async function main() {
  console.log(`Backfilling transcripts from Notion... ${DRY_RUN ? '(DRY RUN)' : ''}`);

  if (!NOTION_TOKEN) {
    console.error('NOTION_TOKEN env var required. Get it from https://www.notion.so/my-integrations');
    process.exit(1);
  }

  // Get all meetings from Postgres that have a notion_id
  const { rows: pgMeetings } = await db.query(
    "SELECT meeting_id, notion_id, title, transcript FROM meetings WHERE notion_id IS NOT NULL"
  );
  console.log(`Found ${pgMeetings.length} meetings with notion_id in Postgres`);

  const needsTranscript = pgMeetings.filter(m => !m.transcript || m.transcript.trim() === '');
  console.log(`${needsTranscript.length} are missing transcripts`);

  for (const meeting of needsTranscript) {
    try {
      const content = await fetchPageContent(meeting.notion_id);
      await sleep(300); // rate limit

      if (!content || content.trim().length < 50) {
        counters.empty++;
        console.log(`  EMPTY: ${meeting.title}`);
        continue;
      }

      const wordCount = content.split(/\s+/).length;
      console.log(`  ${meeting.title} -> ${wordCount} words`);

      if (!DRY_RUN) {
        await db.query(
          "UPDATE meetings SET transcript = $1 WHERE meeting_id = $2",
          [content, meeting.meeting_id]
        );
      }
      counters.updated++;
    } catch (err) {
      counters.errors++;
      console.error(`  ERROR: ${meeting.title}: ${err.message}`);
    }
  }

  console.log('\nDone!', counters);
  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
