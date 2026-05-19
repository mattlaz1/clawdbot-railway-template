#!/usr/bin/env node
// Pulls every Notion DB referenced by SkySuite into db/seed/notion-dump/*.json.
// Uses the official Notion REST client with an internal integration token.
// Each dump is a plain array of objects shaped for the backfill script.
//
// Usage:
//   node db/seed/dump-notion.js                 dump all DBs
//   node db/seed/dump-notion.js --only=companies,tasks
//
// Re-running overwrites the JSON files. Safe to run repeatedly.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const DUMP_DIR = path.join(__dirname, 'notion-dump');
if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  return arg ? arg.split('=')[1].split(',') : null;
})();

if (!process.env.NOTION_TOKEN) {
  console.error('NOTION_TOKEN missing from .env');
  process.exit(1);
}
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ---------- Notion data source IDs ----------
const SOURCES = {
  companies:         '1c9a1425-575c-8081-876a-000b0cb7ef48',
  contacts:          'd32be5e5-2f52-4940-9b89-8dab8574ff46',
  tasks:             '2a8a1425-575c-8034-877d-000b0a50bad6',
  meetings:          '2a9a1425-575c-80cd-9311-000b42d093ae',
  linkedin_posts:    '7d1d1517-67ac-4c67-b2c0-0c636a508c15',
  newsletters:       '008888b0-ee83-4b79-87a5-1a07f1b8a73e',
  influencer_intel:  '3886ec0a-73ac-4214-a2ac-8f364025d346',
  daily_reports:     '81641231-dbb3-43c7-9b0b-074616916239',
};

// ---------- property extractors ----------
// Notion's property format is deeply nested; these pull a plain value from
// whatever shape the property is.
function plainText(prop) {
  if (!prop) return null;
  if (prop.type === 'title') return prop.title?.map(t => t.plain_text).join('') || null;
  if (prop.type === 'rich_text') return prop.rich_text?.map(t => t.plain_text).join('') || null;
  return null;
}
function selectName(prop) {
  if (!prop) return null;
  if (prop.type === 'select') return prop.select?.name || null;
  if (prop.type === 'status') return prop.status?.name || null;
  return null;
}
function multiSelectNames(prop) {
  if (!prop) return null;
  if (prop.type === 'multi_select') return prop.multi_select?.map(o => o.name) || [];
  return null;
}
function numberVal(prop) {
  if (!prop) return null;
  if (prop.type === 'number') return prop.number;
  if (prop.type === 'formula' && prop.formula?.type === 'number') return prop.formula.number;
  return null;
}
function dateVal(prop) {
  if (!prop) return null;
  if (prop.type === 'date') return prop.date?.start || null;
  if (prop.type === 'created_time') return prop.created_time || null;
  if (prop.type === 'last_edited_time') return prop.last_edited_time || null;
  return null;
}
function relationIds(prop) {
  if (!prop) return [];
  if (prop.type === 'relation') return prop.relation.map(r => r.id);
  return [];
}
function urlVal(prop) {
  if (!prop) return null;
  if (prop.type === 'url') return prop.url || null;
  return null;
}
function emailVal(prop) {
  if (!prop) return null;
  if (prop.type === 'email') return prop.email || null;
  return null;
}
function phoneVal(prop) {
  if (!prop) return null;
  if (prop.type === 'phone_number') return prop.phone_number || null;
  return null;
}
function formulaString(prop) {
  if (!prop) return null;
  if (prop.type !== 'formula') return null;
  const f = prop.formula;
  if (!f) return null;
  if (f.type === 'string') return f.string;
  if (f.type === 'number') return f.number != null ? String(f.number) : null;
  return null;
}
// Checks every property for an email-typed value (useful since property
// names vary wildly). Returns the first one found.
function firstEmail(props) {
  for (const v of Object.values(props)) {
    if (v?.type === 'email' && v.email) return v.email;
  }
  return null;
}

// ---------- paginator ----------
async function queryAll(dataSourceId, label) {
  const rows = [];
  let cursor;
  let page = 0;
  while (true) {
    page++;
    process.stdout.write(`\r  ${label}: fetching page ${page} (${rows.length} so far)...`);
    const resp = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });
    rows.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  process.stdout.write(`\r  ${label}: ${rows.length} rows                          \n`);
  return rows;
}

// ---------- per-DB transformers ----------
// Each transformer reads raw Notion pages and returns objects matching the
// shape that db/seed/backfill.js expects.

function transformCompanies(pages) {
  return pages.map(p => {
    const P = p.properties;
    return {
      notion_id: p.id,
      notion_url: p.url,
      name: plainText(P.Name),
      stage: selectName(P.Status),
      field: selectName(P.Field),
      action_status: selectName(P.Action),
      last_contact: dateVal(P['Last Contact']),
      next_action: plainText(P['Next Touch']),
      notes: plainText(P.Notes),
      licenses: numberVal(P.Licenses),
      avg_license_cost: numberVal(P['Avg License Cost']),
      company_size: plainText(P['Company Size']),
      tags: null, // no tags field in Notion schema
    };
  });
}

function transformContacts(pages, companiesByNotionId) {
  return pages.map(p => {
    const P = p.properties;
    const companyRelations = Object.values(P)
      .filter(v => v?.type === 'relation')
      .flatMap(v => v.relation.map(r => r.id));
    // first company relation wins
    const firstCompanyId = companyRelations[0] || null;
    return {
      notion_id: p.id,
      name: plainText(P.Name) || plainText(P['Full Name']) || 'Unknown',
      email: firstEmail(P),
      title: plainText(P.Title) || plainText(P.Role) || null,
      phone: phoneVal(P.Mobile) || phoneVal(P.Office) || Object.values(P).find(v => v?.type === 'phone_number')?.phone_number || null,
      phone_office: phoneVal(P.Office) || null,
      role: selectName(P.Role) || selectName(P.Type),
      source: selectName(P.Source),
      notes: plainText(P.Notes),
      last_contacted: dateVal(P['Last Contacted']),
      linkedin_url: urlVal(P.LinkedIn) || urlVal(P['LinkedIn URL']),
      company_notion_id: firstCompanyId,
    };
  });
}

function transformTasks(pages) {
  return pages.map(p => {
    const P = p.properties;
    const companyRelations = Object.values(P)
      .filter(v => v?.type === 'relation' && v.relation.length > 0);
    const firstCompanyId = companyRelations[0]?.relation[0]?.id || null;
    return {
      notion_id: p.id,
      name: plainText(P.Name) || plainText(P.Task) || 'Untitled task',
      status: selectName(P.Status),
      action_type: selectName(P['Action Type']) || selectName(P.Type),
      due_date: dateVal(P['Due Date']) || dateVal(P.Due),
      notes: plainText(P.Notes),
      company_notion_id: firstCompanyId,
    };
  });
}

function transformMeetings(pages) {
  return pages.map(p => {
    const P = p.properties;
    const companyRel = Object.values(P).find(v => v?.type === 'relation' && v.relation.length > 0);
    return {
      notion_id: p.id,
      title: plainText(P.Name) || plainText(P.Title) || plainText(P.Meeting),
      meeting_date: dateVal(P.Date) || dateVal(P['Meeting Date']),
      duration_minutes: numberVal(P.Duration) || numberVal(P['Duration (min)']),
      recording_url: urlVal(P['Recording URL']) || urlVal(P.Recording),
      summary: plainText(P.Summary) || plainText(P.Notes),
      status: selectName(P.Status),
      source: 'fathom',
      company_notion_id: companyRel?.relation[0]?.id || null,
    };
  });
}

function transformLinkedinPosts(pages) {
  return pages.map(p => {
    const P = p.properties;
    return {
      notion_id: p.id,
      title: plainText(P.Name) || plainText(P.Title),
      lane: selectName(P.Lane),
      status: selectName(P.Status),
      topic_tags: multiSelectNames(P['Topic Tags']) || multiSelectNames(P.Tags),
      thesis: plainText(P.Thesis),
      post_type: selectName(P['Post Type']) || selectName(P.Type),
      body: plainText(P.Body) || plainText(P.Content) || plainText(P.Post),
      posted_at: dateVal(P['Posted Date']) || dateVal(P.Posted),
      linkedin_url: urlVal(P['LinkedIn URL']) || urlVal(P.URL),
      source_reference: plainText(P['Inspiration Source']) || plainText(P.Source),
    };
  });
}

function transformNewsletters(pages) {
  return pages.map(p => {
    const P = p.properties;
    return {
      notion_id: p.id,
      title: plainText(P.Name) || plainText(P.Title),
      series: selectName(P.Series),
      status: selectName(P.Status),
      target_date: dateVal(P['Target Date']),
      published_at: dateVal(P['Published Date']) || dateVal(P.Published),
      substack_url: urlVal(P['Substack URL']) || urlVal(P.URL),
      body: plainText(P.Body) || plainText(P.Content),
    };
  });
}

function transformInfluencerIntel(pages) {
  return pages.map(p => {
    const P = p.properties;
    return {
      notion_id: p.id,
      source_type: selectName(P['Source Type']) || selectName(P.Type),
      influencer: plainText(P.Influencer) || plainText(P.Name),
      topic_tags: multiSelectNames(P['Topic Tags']) || multiSelectNames(P.Tags),
      key_insight: plainText(P['Key Insight']) || plainText(P.Insight) || plainText(P.Notes),
      source_url: urlVal(P['Source URL']) || urlVal(P.URL),
      relevance: selectName(P.Relevance),
      lane: selectName(P.Lane),
      discovered_at: dateVal(P['Discovered Date']) || p.created_time,
    };
  });
}

function transformDailyReports(pages) {
  return pages.map(p => {
    const P = p.properties;
    return {
      notion_id: p.id,
      title: plainText(P.Name) || plainText(P.Title),
      agent: selectName(P.Agent) || 'cro',
      report_date: dateVal(P.Date) || p.created_time?.slice(0, 10),
      report_type: selectName(P['Report Type']) || 'daily',
      critical_flags: plainText(P['Critical Flags']),
      active_items: plainText(P['Active Items']),
      recommendations: plainText(P.Recommendations),
      body: plainText(P.Body) || plainText(P.Content) || plainText(P.Notes),
    };
  });
}

// ---------- orchestrator ----------
const JOBS = [
  ['companies',        SOURCES.companies,        transformCompanies],
  ['contacts',         SOURCES.contacts,         transformContacts],
  ['tasks',            SOURCES.tasks,            transformTasks],
  ['meetings',         SOURCES.meetings,         transformMeetings],
  ['linkedin_posts',   SOURCES.linkedin_posts,   transformLinkedinPosts],
  ['newsletters',      SOURCES.newsletters,      transformNewsletters],
  ['influencer_intel', SOURCES.influencer_intel, transformInfluencerIntel],
  ['daily_reports',    SOURCES.daily_reports,    transformDailyReports],
];

async function main() {
  console.log('SkySuite Notion dump → db/seed/notion-dump/');
  const summary = {};
  for (const [name, id, transform] of JOBS) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      const pages = await queryAll(id, name);
      const rows = transform(pages);
      const out = path.join(DUMP_DIR, `${name}.json`);
      fs.writeFileSync(out, JSON.stringify(rows, null, 2));
      summary[name] = rows.length;
    } catch (err) {
      console.error(`\n  ${name} FAILED: ${err.code || err.status || ''} ${err.message}`);
      summary[name] = `ERR: ${err.message}`;
    }
  }
  console.log('\nDone:');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${v}`);
}

main().catch(err => { console.error(err); process.exit(1); });
