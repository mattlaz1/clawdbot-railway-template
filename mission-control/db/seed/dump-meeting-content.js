#!/usr/bin/env node
// Fetches full page content for every Fathom Meeting in Notion.
// Uses the Notion MCP-style page retrieval to get body text + properties.
// Outputs meeting-content.json with {notion_id, title, content, recording_url, share_url}

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const DUMP_DIR = path.join(__dirname, 'notion-dump');
const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function getPageContent(pageId) {
  // Get page properties
  const page = await notion.pages.retrieve({ page_id: pageId });

  // Get page blocks (the body content)
  const blocks = [];
  let cursor;
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  // Extract text from blocks
  const textParts = [];
  for (const block of blocks) {
    const richTexts = block[block.type]?.rich_text || block[block.type]?.text || [];
    if (Array.isArray(richTexts)) {
      const text = richTexts.map(t => t.plain_text || '').join('');
      if (text.trim()) textParts.push(text);
    }
    // Handle child blocks (toggles, etc.)
    if (block.has_children) {
      try {
        const children = await notion.blocks.children.list({ block_id: block.id, page_size: 100 });
        for (const child of children.results) {
          const crt = child[child.type]?.rich_text || child[child.type]?.text || [];
          if (Array.isArray(crt)) {
            const ct = crt.map(t => t.plain_text || '').join('');
            if (ct.trim()) textParts.push(ct);
          }
        }
      } catch {}
    }
  }

  // Extract URLs from properties
  const props = page.properties;
  let recordingUrl = null;
  let shareUrl = null;
  for (const [key, val] of Object.entries(props)) {
    if (val.type === 'url' && val.url) {
      if (key.toLowerCase().includes('share')) shareUrl = val.url;
      else if (key.toLowerCase().includes('note') || key.toLowerCase().includes('meeting')) recordingUrl = val.url;
      else if (!recordingUrl) recordingUrl = val.url;
    }
  }

  return {
    content: textParts.join('\n\n'),
    recording_url: recordingUrl,
    share_url: shareUrl,
    block_count: blocks.length,
  };
}

async function main() {
  const meetings = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, 'meetings.json'), 'utf8'));
  console.log(`Fetching page content for ${meetings.length} meetings...\n`);

  const results = [];
  let withContent = 0;
  let withUrl = 0;

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    process.stdout.write(`\r  ${i + 1}/${meetings.length}: ${(m.title || 'untitled').slice(0, 40).padEnd(40)}`);

    try {
      const { content, recording_url, share_url, block_count } = await getPageContent(m.notion_id);

      results.push({
        notion_id: m.notion_id,
        title: m.title,
        meeting_date: m.meeting_date,
        content: content || null,
        recording_url: recording_url || m.recording_url || null,
        share_url: share_url || null,
        block_count,
        word_count: content ? content.split(/\s+/).length : 0,
      });

      if (content && content.length > 50) withContent++;
      if (recording_url || share_url) withUrl++;

    } catch (err) {
      console.error(`\n  ERR ${m.notion_id}: ${err.message}`);
      results.push({
        notion_id: m.notion_id,
        title: m.title,
        meeting_date: m.meeting_date,
        content: null,
        recording_url: null,
        share_url: null,
        block_count: 0,
        word_count: 0,
        error: err.message,
      });
    }

    // Rate limit: ~3 req/sec to stay under Notion limits
    await new Promise(r => setTimeout(r, 350));
  }

  const outFile = path.join(DUMP_DIR, 'meeting-content.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  console.log(`\n\nDone:`);
  console.log(`  Total meetings:     ${results.length}`);
  console.log(`  With page content:  ${withContent}`);
  console.log(`  With Fathom URL:    ${withUrl}`);
  console.log(`  Saved to:           ${outFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
