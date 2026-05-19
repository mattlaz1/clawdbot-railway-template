// Company matching for meetings.
//
// Order of attempts (cheap → expensive):
//   1. Title regex:        "{Company} x SkySuite ..." → companies.name ILIKE
//   2. Attendee email:     calendar_invitees[].email → contacts.email → company_id
//   3. Email domain:       calendar_invitees[].email domain → companies.website / contacts.email domain
//   4. Claude (AI):        send title + attendees + transcript head + active company list
//
// Returns { company_id, method } or { company_id: null, method: 'none' }.

const db = require('./db');

const SKYSUITE_EMAIL_DOMAINS = new Set(['skysuite.ai', 'skycap.ai']);
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'me.com', 'msn.com',
]);

function emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

async function matchByTitle(title) {
  if (!title) return null;
  const m = title.match(/^(.+?)\s*x\s*SkySuite/i);
  if (!m) return null;
  const name = m[1].trim();
  const { rows } = await db.query(
    `SELECT company_id FROM companies WHERE name ILIKE $1 LIMIT 1`,
    [`%${name}%`]
  );
  return rows.length ? rows[0].company_id : null;
}

async function matchByAttendeeEmail(invitees) {
  if (!invitees || !invitees.length) return null;
  const emails = invitees
    .map(i => (typeof i === 'string' ? i : i?.email))
    .filter(Boolean)
    .filter(e => !SKYSUITE_EMAIL_DOMAINS.has(emailDomain(e) || ''));
  if (!emails.length) return null;
  const { rows } = await db.query(
    `SELECT company_id FROM contacts
     WHERE LOWER(email) = ANY($1::text[]) AND company_id IS NOT NULL
     LIMIT 1`,
    [emails.map(e => e.toLowerCase())]
  );
  return rows.length ? rows[0].company_id : null;
}

async function matchByEmailDomain(invitees) {
  if (!invitees || !invitees.length) return null;
  const domains = invitees
    .map(i => emailDomain(typeof i === 'string' ? i : i?.email))
    .filter(Boolean)
    .filter(d => !SKYSUITE_EMAIL_DOMAINS.has(d) && !FREE_EMAIL_DOMAINS.has(d));
  if (!domains.length) return null;
  // Match against other contacts at the same domain (most reliable signal).
  const { rows } = await db.query(
    `SELECT company_id, COUNT(*) AS n
     FROM contacts
     WHERE company_id IS NOT NULL
       AND email IS NOT NULL
       AND LOWER(SPLIT_PART(email, '@', 2)) = ANY($1::text[])
     GROUP BY company_id
     ORDER BY n DESC
     LIMIT 1`,
    [domains]
  );
  return rows.length ? rows[0].company_id : null;
}

// Parse the first N seconds of transcript to pull externally-spoken names/companies.
function transcriptHead(transcript, maxChars = 2000) {
  if (!transcript) return '';
  // transcript can be text[] of JSON strings, or a single text blob.
  let entries = [];
  if (Array.isArray(transcript)) {
    entries = transcript.slice(0, 40).map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
    }).filter(Boolean);
  } else if (typeof transcript === 'string') {
    return transcript.slice(0, maxChars);
  }
  const out = entries.map(e => {
    const name = e?.speaker?.display_name || 'Unknown';
    const text = e?.text || '';
    return `${name}: ${text}`;
  }).join('\n');
  return out.slice(0, maxChars);
}

async function matchByAI({ title, attendees, invitees, transcript, summary }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  } catch {
    return null;
  }

  // Pull companies + their contacts so the model can resolve first-name mentions
  // ("Hey Tim" → Tim Noonan at <company>) without us hardcoding rules.
  const { rows: companies } = await db.query(
    `SELECT slug, name, COALESCE(stage::text, '') AS stage
     FROM companies
     WHERE (stage IS NULL OR stage::text NOT IN ('closed-lost'))
       AND slug != 'skysuite'
     ORDER BY name`
  );
  if (!companies.length) return null;

  const { rows: contacts } = await db.query(
    `SELECT c.name AS contact_name, COALESCE(c.email, '') AS email, co.slug
     FROM contacts c
     JOIN companies co ON co.company_id = c.company_id
     WHERE c.name IS NOT NULL AND co.slug != 'skysuite'
     ORDER BY co.slug, c.name`
  );

  // Group contacts by slug for compact display.
  const contactsBySlug = {};
  for (const c of contacts) {
    (contactsBySlug[c.slug] = contactsBySlug[c.slug] || []).push(
      c.email ? `${c.contact_name} <${c.email}>` : c.contact_name
    );
  }
  const companyList = companies.map(c => {
    const people = contactsBySlug[c.slug];
    const peopleStr = people && people.length ? ` — contacts: ${people.join(', ')}` : '';
    return `${c.slug}\t${c.name}${peopleStr}`;
  }).join('\n');

  const inviteeLines = (invitees || [])
    .map(i => (typeof i === 'string' ? i : `${i?.name || ''} <${i?.email || ''}>`))
    .filter(Boolean);

  // Larger transcript head — speaker names in the first few minutes are the
  // strongest signal we have for old rows that lack invitee emails.
  const userBlock = [
    `Title: ${title || '(none)'}`,
    `Attendees: ${(attendees || []).join(', ') || '(none)'}`,
    `Invitee emails: ${inviteeLines.join('; ') || '(none)'}`,
    summary ? `Summary: ${String(summary).slice(0, 1500)}` : '',
    `Transcript head:\n${transcriptHead(transcript, 6000)}`,
  ].filter(Boolean).join('\n\n');

  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    system:
      `Match a meeting to one company slug from the list, using the title, attendees, and ` +
      `transcript head. The transcript names matter — first names mentioned ("Hey Tim", ` +
      `"thanks Dave") usually identify the external attendee. Cross-reference those names ` +
      `against the contacts roster.\n\n` +
      `Output ONLY a JSON object: {"slug":"<slug-or-none>","reason":"<short reason>"}.\n` +
      `Return "none" only if the meeting is purely internal SkySuite work OR no plausible ` +
      `company is named/implied. Don't refuse just because confidence is medium — if a ` +
      `contact name matches, take it.\n\n` +
      `Companies (slug<TAB>name — contacts: <name <email>, ...>):\n${companyList}`,
    messages: [{ role: 'user', content: userBlock }],
  });

  const text = resp?.content?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!parsed.slug || parsed.slug === 'none') return null;

  const { rows } = await db.query(
    `SELECT company_id FROM companies WHERE slug = $1 LIMIT 1`,
    [parsed.slug]
  );
  return rows.length ? { company_id: rows[0].company_id, reason: parsed.reason } : null;
}

// Titles that are unambiguously internal — never tied to a company.
// Skip every match attempt (including AI) for these.
function isInternalTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/skysuite\s*dev\s*call/.test(t)) return true;
  if (/matt\s*<>\s*nikola|nikola\s*<>\s*matt/.test(t)) return true;
  if (/matt\s*<>\s*lubisa|lubisa\s*<>\s*matt/.test(t)) return true;
  return false;
}

// Does the transcript contain any speaker other than Matt? If so, the meeting
// likely has an external party even when the title is generic ("Impromptu Zoom").
function hasExternalSpeaker(transcript) {
  if (!transcript) return false;
  let arr = transcript;
  if (typeof transcript === 'string') {
    try { arr = JSON.parse(transcript); } catch { return false; }
  }
  if (!Array.isArray(arr)) return false;
  for (const entry of arr.slice(0, 60)) {
    let obj = entry;
    if (typeof entry === 'string') {
      try { obj = JSON.parse(entry); } catch { continue; }
    }
    const name = obj?.speaker?.display_name || '';
    if (name && !/matt(hew)?\s*lazarus/i.test(name)) return true;
  }
  return false;
}

// Public: try all signals in order. `meeting` is the Fathom payload shape, or a
// plain { title, attendees, calendar_invitees, transcript, summary } object.
async function matchCompany(meeting) {
  if (!meeting) return { company_id: null, method: 'none' };
  const title = meeting.title || meeting.meeting_title;

  // Short-circuit for internal calls — Matt's dev syncs only. Other generic
  // titles ("Impromptu Zoom") fall through to AI if there's an external speaker
  // in the transcript, since those are often customer calls in disguise.
  if (isInternalTitle(title)) {
    return { company_id: null, method: 'internal' };
  }
  const isGenericTitle = title && /^impromptu\s+(zoom|microsoft\s*teams)\s+meeting$/i.test(title);
  if (isGenericTitle && !hasExternalSpeaker(meeting.transcript)) {
    return { company_id: null, method: 'internal' };
  }

  const invitees = meeting.calendar_invitees || meeting.invitees || [];
  const attendees = meeting.attendees || invitees.map(i => i?.name || i?.email).filter(Boolean);

  let id = await matchByTitle(title);
  if (id) return { company_id: id, method: 'title' };

  id = await matchByAttendeeEmail(invitees);
  if (id) return { company_id: id, method: 'attendee_email' };

  id = await matchByEmailDomain(invitees);
  if (id) return { company_id: id, method: 'email_domain' };

  try {
    const ai = await matchByAI({
      title,
      attendees,
      invitees,
      transcript: meeting.transcript,
      summary: meeting.summary || meeting.default_summary,
    });
    if (ai?.company_id) return { company_id: ai.company_id, method: 'ai', reason: ai.reason };
  } catch (err) {
    console.warn('[match-company] AI match failed:', err.message);
  }

  return { company_id: null, method: 'none' };
}

// Infer meeting type from title. Returns one of the canonical types or null.
function inferType(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/skysuite\s*dev\s*call/.test(t)) return 'Internal';
  if (/impromptu/.test(t)) return 'NA';
  if (/\bproposal\b/.test(t)) return 'Proposal';
  if (/\bdemo\b/.test(t)) return 'Demo';
  if (/\bdiscovery\b/.test(t)) return 'Discovery';
  if (/\bintro\b/.test(t)) return 'Intro';
  if (/touch[- ]?base|kick[- ]?off|template review|model review|scoping|onboarding|review/.test(t)) return 'Project';
  return null;
}

module.exports = { matchCompany, inferType, transcriptHead };
