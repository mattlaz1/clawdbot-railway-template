// /api/db/* routes for mission-control's Database tab.
const express = require('express');
const db = require('../lib/db');

const router = express.Router();

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------- table metadata for write safety ----------
const TABLE_META = {
  companies:        { pk: 'company_id',  writable: ['name','slug','stage','deal_value','billing_cadence','decision_maker','champion','next_action','next_action_due','last_contact','field','licenses','avg_license_cost','action_status','tags','health_score','health_tier','onboarding_status','primary_workflow','mrr','project_type','implementation_total','implementation_invoiced','sample_files_status','blocked_on'] },
  contacts:         { pk: 'contact_id',  writable: ['company_id','name','email','title','phone','phone_office','role','source','tags','notes','last_contacted','linkedin_url'] },
  tasks:            { pk: 'id',          writable: ['title','company_slug','contact_id','agent_id','action_type','due_date','notes','completed_at','priority','origin','active'] },
  meetings:         { pk: 'meeting_id',  writable: ['company_id','title','meeting_date','duration_minutes','recording_url','share_url','summary','transcript','attendees','status','source'] },
  linkedin_posts:   { pk: 'post_id',    writable: ['title','lane','status','topic_tags','thesis','post_type','body','posted_at','linkedin_url','engagement_json','source_reference','rejection_reason'] },
  newsletters:      { pk: 'edition_id', writable: ['title','series','status','target_date','published_at','substack_url','body','rejection_reason'] },
  influencer_intel: { pk: 'entry_id',   writable: ['source_type','influencer','topic_tags','key_insight','source_url','relevance','lane'] },
  daily_reports:    { pk: 'report_id',   writable: ['agent','report_date','report_type','title','critical_flags','active_items','recommendations','draft_count','body'] },
  timeline:         { pk: 'entry_id',   writable: ['company_id','entry_date','entry_type','title','details','recording_url','source'] },
  meeting_notes:    { pk: 'note_id',    writable: ['company_id','meeting_id','title','meeting_date','body','source_file'] },
};

// ---------- generic PATCH (update single row) ----------
router.patch('/:table/:id', async (req, res) => {
  const meta = TABLE_META[req.params.table];
  if (!meta) return res.status(400).json({ error: `unknown table: ${req.params.table}` });
  const fields = req.body;
  if (!fields || !Object.keys(fields).length) return res.status(400).json({ error: 'no fields' });

  // Only allow whitelisted columns
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    if (!meta.writable.includes(col)) continue;
    params.push(val === '' ? null : val);
    sets.push(`"${col}" = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no writable fields' });

  // Add updated_at only for tables that have the column.
  const NO_UPDATED_AT = new Set(['meetings', 'meeting_notes', 'daily_reports', 'influencer_intel']);
  if (!NO_UPDATED_AT.has(req.params.table)) {
    sets.push(`updated_at = now()`);
  }
  params.push(req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE ${req.params.table} SET ${sets.join(', ')} WHERE "${meta.pk}" = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ row: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- generic POST (create row) ----------
router.post('/:table', async (req, res) => {
  const meta = TABLE_META[req.params.table];
  if (!meta) return res.status(400).json({ error: `unknown table: ${req.params.table}` });
  const fields = req.body;
  const cols = [];
  const params = [];

  // Tasks use a string PK — auto-generate an id for manual creates so the UI
  // can POST without choosing one. Format: <agent>-manual-<yyyymmdd>-<rand>
  if (req.params.table === 'tasks' && !fields.id) {
    const agent = (fields.agent_id || 'cro').toLowerCase();
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).slice(2, 6);
    cols.push('"id"');
    params.push(`${agent}-manual-${day}-${rand}`);
    cols.push('"origin"');
    params.push(fields.origin || 'manual');
    cols.push('"active"');
    params.push(true);
    cols.push('"added_at"');
    params.push(new Date().toISOString());
    cols.push('"generated_at"');
    params.push(new Date().toISOString());
  }

  for (const [col, val] of Object.entries(fields)) {
    if (!meta.writable.includes(col)) continue;
    if (cols.includes(`"${col}"`)) continue; // skip duplicates from auto-fill
    cols.push(`"${col}"`);
    params.push(val === '' ? null : val);
  }
  if (!cols.length) return res.status(400).json({ error: 'no writable fields' });

  try {
    const placeholders = params.map((_, i) => `$${i + 1}`);
    const { rows } = await db.query(
      `INSERT INTO ${req.params.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      params
    );

    // For manually-created tasks, pre-decide them as queued so they skip the
    // review queue and land directly in "Queued / In motion."
    if (req.params.table === 'tasks' && rows[0]?.id && rows[0]?.origin === 'manual') {
      await db.query(`
        INSERT INTO task_decisions (task_id, agent_id, decision, status, queued_at, updated_at)
        VALUES ($1, $2, 'yes', 'queued', now(), now())
        ON CONFLICT (task_id) DO NOTHING
      `, [rows[0].id, rows[0].agent_id]);
    }

    res.status(201).json({ row: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- generic DELETE ----------
router.delete('/:table/:id', async (req, res) => {
  const meta = TABLE_META[req.params.table];
  if (!meta) return res.status(400).json({ error: `unknown table: ${req.params.table}` });
  try {
    const { rowCount } = await db.query(
      `DELETE FROM ${req.params.table} WHERE "${meta.pk}" = $1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- stats (for the tab sidebar) ----------
router.get('/stats', async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 'companies' AS table_name, COUNT(*)::int AS n FROM companies
      UNION ALL SELECT 'contacts',         COUNT(*)::int FROM contacts
      UNION ALL SELECT 'tasks',            COUNT(*)::int FROM tasks
      UNION ALL SELECT 'meetings',         COUNT(*)::int FROM meetings
      UNION ALL SELECT 'linkedin_posts',   COUNT(*)::int FROM linkedin_posts
      UNION ALL SELECT 'newsletters',      COUNT(*)::int FROM newsletters
      UNION ALL SELECT 'influencer_intel', COUNT(*)::int FROM influencer_intel
      UNION ALL SELECT 'daily_reports',    COUNT(*)::int FROM daily_reports
      UNION ALL SELECT 'timeline',         COUNT(*)::int FROM timeline
      UNION ALL SELECT 'meeting_notes',    COUNT(*)::int FROM meeting_notes
    `);
    res.json({ tables: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- companies ----------
router.get('/companies', async (req, res) => {
  try {
    const { stage, risk, q, limit } = req.query;
    const where = [];
    const params = [];
    if (stage) { params.push(stage); where.push(`cv.stage = $${params.length}`); }
    if (risk)  { params.push(risk);  where.push(`cv.risk = $${params.length}`); }
    if (q)     { params.push(`%${q}%`); where.push(`cv.name ILIKE $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 200));
    const { rows } = await db.query(
      `SELECT cv.company_id, cv.name, cv.slug, cv.stage, cv.last_contact, cv.days_since_contact, cv.risk,
              cv.next_action, cv.next_action_due, cv.field, cv.mrr, cv.deal_value, cv.action_status,
              ccv.owning_agent,
              COALESCE(ccv.active_task_count_total, 0) AS open_task_count,
              COALESCE(ccv.is_uncovered, false) AS is_uncovered
       FROM companies_view cv
       LEFT JOIN company_coverage_view ccv ON ccv.company_id = cv.company_id
       ${whereSql}
       ORDER BY cv.last_contact DESC NULLS LAST
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const { rows: co } = await db.query(
      isUuid
        ? 'SELECT * FROM companies_view WHERE company_id = $1 LIMIT 1'
        : 'SELECT * FROM companies_view WHERE slug = $1 LIMIT 1',
      [id]
    );
    if (!co.length) return res.status(404).json({ error: 'not found' });
    const company = co[0];

    const [contacts, tasks, meetings, timeline] = await Promise.all([
      db.query(
        `SELECT contact_id, name, email, title, role, phone, phone_office, linkedin_url, last_contacted
         FROM contacts WHERE company_id = $1 ORDER BY name`,
        [company.company_id]
      ),
      db.query(
        `SELECT t.id AS task_id, t.title AS name, t.action_type, t.due_date,
                t.agent_id AS agent, t.notes, t.created_at, t.completed_at,
                t.priority, t.origin, t.active,
                COALESCE(td.status,
                  CASE WHEN t.completed_at IS NOT NULL THEN 'completed' ELSE 'todo' END
                ) AS status
         FROM tasks t
         LEFT JOIN task_decisions td ON td.task_id = t.id
         WHERE t.company_slug = $1
         ORDER BY (NOT t.active), t.due_date ASC NULLS LAST
         LIMIT 50`,
        [company.slug]
      ),
      db.query(
        `SELECT * FROM (
           SELECT m.meeting_id, m.title, m.meeting_date, m.duration_minutes, m.recording_url,
                  (m.transcript IS NOT NULL AND m.transcript != '') AS has_transcript,
                  (m.summary IS NOT NULL AND m.summary != '') AS has_summary,
                  m.status,
                  mn.note_id, mn.word_count AS note_words
           FROM meetings m
           LEFT JOIN LATERAL (
             SELECT mn2.note_id, mn2.word_count
             FROM meeting_notes mn2
             WHERE mn2.company_id = m.company_id AND mn2.meeting_date = m.meeting_date::date
             ORDER BY mn2.word_count DESC NULLS LAST
             LIMIT 1
           ) mn ON true
           WHERE m.company_id = $1
           UNION ALL
           SELECT NULL, mn3.title, mn3.meeting_date::timestamptz, NULL, NULL,
                  false, false, NULL,
                  mn3.note_id, mn3.word_count
           FROM meeting_notes mn3
           WHERE mn3.company_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM meetings m2
               WHERE m2.company_id = mn3.company_id AND m2.meeting_date::date = mn3.meeting_date
             )
         ) combined
         ORDER BY meeting_date DESC NULLS LAST LIMIT 40`,
        [company.company_id]
      ),
      db.query(
        `SELECT entry_id, entry_date, entry_type, title, details, recording_url, source
         FROM timeline WHERE company_id = $1
         ORDER BY entry_date DESC LIMIT 50`,
        [company.company_id]
      ),
    ]);

    res.json({
      company,
      contacts: contacts.rows,
      tasks: tasks.rows,
      meetings: meetings.rows,
      timeline: timeline.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- contacts: grouped by company ----------
// Returns active companies plus their contacts, with a derived `last_touch`
// (max of contact.last_contacted and the company's most recent meeting_date).
// Used by the grouped-cards view in the Contacts tab.
router.get('/contacts/grouped', async (req, res) => {
  try {
    const { q, role } = req.query;
    const params = [];
    const contactWhere = [];
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      contactWhere.push(`(c.name ILIKE $${i} OR c.email ILIKE $${i} OR c.title ILIKE $${i} OR co.name ILIKE $${i})`);
    }
    if (role) {
      params.push(role);
      contactWhere.push(`lower(c.role) = lower($${params.length})`);
    }
    const whereSql = contactWhere.length ? 'WHERE ' + contactWhere.join(' AND ') : '';

    const { rows } = await db.query(
      `WITH last_meeting AS (
         SELECT company_id, MAX(meeting_date) AS last_meeting_date
         FROM meetings GROUP BY company_id
       )
       SELECT
         co.company_id, co.slug AS company_slug, co.name AS company_name,
         co.stage, co.risk,
         c.contact_id, c.name, c.email, c.title, c.role,
         c.phone, c.phone_office, c.linkedin_url, c.last_contacted,
         GREATEST(c.last_contacted, lm.last_meeting_date::date) AS last_touch
       FROM contacts c
       JOIN companies_view co ON co.company_id = c.company_id
       LEFT JOIN last_meeting lm ON lm.company_id = co.company_id
       ${whereSql}
       ORDER BY co.name, c.name`,
      params
    );

    // Group server-side so the client doesn't have to.
    const byCompany = new Map();
    for (const r of rows) {
      if (!byCompany.has(r.company_id)) {
        byCompany.set(r.company_id, {
          company_id: r.company_id,
          company_slug: r.company_slug,
          company_name: r.company_name,
          stage: r.stage,
          risk: r.risk,
          contacts: [],
        });
      }
      byCompany.get(r.company_id).contacts.push({
        contact_id: r.contact_id,
        name: r.name,
        email: r.email,
        title: r.title,
        role: r.role,
        phone: r.phone,
        phone_office: r.phone_office,
        linkedin_url: r.linkedin_url,
        last_contacted: r.last_contacted,
        last_touch: r.last_touch,
      });
    }

    // Distinct roles for the filter dropdown (case-insensitive, non-null).
    const { rows: roleRows } = await db.query(
      `SELECT DISTINCT initcap(lower(role)) AS role
       FROM contacts WHERE role IS NOT NULL AND role <> '' ORDER BY 1`
    );

    res.json({
      groups: Array.from(byCompany.values()),
      roles: roleRows.map((r) => r.role),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- contacts ----------
router.get('/contacts', async (req, res) => {
  try {
    const { company, q, limit } = req.query;
    const where = [];
    const params = [];
    if (company) { params.push(company); where.push(`c.company_id::text = $${params.length} OR co.slug = $${params.length}`); }
    if (q)       { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 200));
    const { rows } = await db.query(
      `SELECT c.contact_id, c.name, c.email, c.title, c.role, c.phone, c.phone_office, c.linkedin_url,
              c.last_contacted, co.name AS company_name, co.slug AS company_slug
       FROM contacts c
       LEFT JOIN companies co ON co.company_id = c.company_id
       ${whereSql}
       ORDER BY c.name
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- tasks ----------
// Browses the unified tasks table. `status` filters on the decision lifecycle
// (needs_matt, queued, in_progress, executed, completed, dismissed, archived);
// `agent` filters on agent_id; `company` matches company_slug. Active-only by
// default — pass `?include_archived=1` to also see active=false rows.
router.get('/tasks', async (req, res) => {
  try {
    const { status, agent, company, include_archived, limit } = req.query;
    const where = [];
    const params = [];
    if (!include_archived) where.push(`t.active = true`);
    if (status)  { params.push(status);  where.push(`COALESCE(td.status, 'todo') = $${params.length}`); }
    if (agent)   { params.push(agent);   where.push(`t.agent_id = $${params.length}`); }
    if (company) { params.push(company); where.push(`t.company_slug = $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 200));
    const { rows } = await db.query(
      `SELECT t.id AS task_id, t.title AS name, t.action_type, t.due_date,
              t.agent_id AS agent, t.priority, t.origin, t.active, t.completed_at,
              t.company_slug,
              co.name AS company_name,
              COALESCE(td.status,
                CASE WHEN t.completed_at IS NOT NULL THEN 'completed' ELSE 'todo' END
              ) AS status
       FROM tasks t
       LEFT JOIN task_decisions td ON td.task_id = t.id
       LEFT JOIN companies co ON co.slug = t.company_slug
       ${whereSql}
       ORDER BY (NOT t.active), t.due_date ASC NULLS LAST
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- meetings ----------
router.get('/meetings', async (req, res) => {
  try {
    const { company, limit } = req.query;
    const params = [];
    let companyFilter = '';
    if (company) { params.push(company); companyFilter = `co.slug = $${params.length}`; }
    const lim = asInt(limit, 200);
    params.push(lim);
    const limIdx = params.length;

    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT m.meeting_id, m.title, m.meeting_date, m.duration_minutes, m.recording_url, m.share_url,
                (m.transcript IS NOT NULL AND m.transcript != '') AS has_transcript,
                (m.summary IS NOT NULL AND m.summary != '') AS has_summary,
                m.status, m.attendees,
                co.name AS company_name, co.slug AS company_slug,
                mn.note_id, mn.word_count AS note_words
         FROM meetings m
         LEFT JOIN companies co ON co.company_id = m.company_id
         LEFT JOIN LATERAL (
           SELECT mn2.note_id, mn2.word_count
           FROM meeting_notes mn2
           WHERE mn2.company_id = m.company_id AND mn2.meeting_date = m.meeting_date::date
           ORDER BY mn2.word_count DESC NULLS LAST
           LIMIT 1
         ) mn ON true
         ${companyFilter ? 'WHERE ' + companyFilter : ''}
         UNION ALL
         SELECT NULL, mn3.title, mn3.meeting_date::timestamptz, NULL, NULL, NULL,
                false, false, NULL, NULL,
                co2.name, co2.slug,
                mn3.note_id, mn3.word_count
         FROM meeting_notes mn3
         LEFT JOIN companies co2 ON co2.company_id = mn3.company_id
         WHERE NOT EXISTS (
           SELECT 1 FROM meetings m2
           WHERE m2.company_id = mn3.company_id AND m2.meeting_date::date = mn3.meeting_date
         )
         ${companyFilter ? 'AND ' + companyFilter.replace('co.', 'co2.') : ''}
       ) combined
       ORDER BY meeting_date DESC NULLS LAST
       LIMIT $${limIdx}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- single meeting content (lazy-loaded) ----------
router.get('/meetings/:id/content', async (req, res) => {
  try {
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-/i.test(id);

    if (isUuid) {
      // Try meeting first
      const { rows: mRows } = await db.query(
        "SELECT transcript, summary FROM meetings WHERE meeting_id = $1", [id]
      );
      if (mRows.length && (mRows[0].transcript || mRows[0].summary)) {
        return res.json({ body: mRows[0].transcript || mRows[0].summary });
      }
      // Try meeting note
      const { rows: nRows } = await db.query(
        "SELECT body FROM meeting_notes WHERE note_id = $1", [id]
      );
      if (nRows.length) {
        return res.json({ body: nRows[0].body });
      }
    }
    res.status(404).json({ error: 'not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- re-match company via AI for a single meeting ----------
router.post('/meetings/:id/match', async (req, res) => {
  try {
    const { matchCompany } = require('../lib/match-company');
    const { rows } = await db.query(
      `SELECT meeting_id, title, attendees, transcript, summary FROM meetings WHERE meeting_id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const m = rows[0];
    const result = await matchCompany({
      title: m.title,
      attendees: m.attendees,
      transcript: m.transcript,
      summary: m.summary,
    });
    if (result.company_id) {
      await db.query(`UPDATE meetings SET company_id = $2 WHERE meeting_id = $1`, [m.meeting_id, result.company_id]);
      const { rows: co } = await db.query(`SELECT name, slug FROM companies WHERE company_id = $1`, [result.company_id]);
      return res.json({ matched: true, method: result.method, reason: result.reason, company: co[0] || null });
    }
    res.json({ matched: false, method: result.method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- single meeting (full row for detail view) ----------
router.get('/meetings/:id/full', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT m.*, co.name AS company_name, co.slug AS company_slug
       FROM meetings m
       LEFT JOIN companies co ON co.company_id = m.company_id
       WHERE m.meeting_id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ row: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- content: linkedin_posts, newsletters, influencer_intel ----------
router.get('/content/linkedin', async (req, res) => {
  try {
    const { lane, status, limit } = req.query;
    const where = [];
    const params = [];
    if (lane)   { params.push(lane);   where.push(`lane = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 100));
    const { rows } = await db.query(
      `SELECT post_id, title, lane, status, topic_tags, thesis, post_type,
              posted_at, linkedin_url, created_at
       FROM linkedin_posts ${whereSql}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/content/newsletters', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT edition_id, title, series, status, target_date, published_at, substack_url
       FROM newsletters ORDER BY COALESCE(published_at, target_date::timestamptz) DESC LIMIT 100`
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/content/intel', async (req, res) => {
  try {
    const { lane, limit } = req.query;
    const where = [];
    const params = [];
    if (lane) { params.push(lane); where.push(`lane = $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 100));
    const { rows } = await db.query(
      `SELECT entry_id, source_type, influencer, topic_tags, key_insight, source_url,
              relevance, lane, discovered_at
       FROM influencer_intel ${whereSql}
       ORDER BY discovered_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- daily reports ----------
router.get('/reports', async (req, res) => {
  try {
    const { agent, date, q, limit } = req.query;
    const where = [];
    const params = [];
    if (agent) { params.push(agent); where.push(`agent = $${params.length}`); }
    if (date)  { params.push(date);  where.push(`report_date = $${params.length}`); }
    if (q) {
      params.push(q);
      where.push(`body_tsv @@ plainto_tsquery('english', $${params.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 100));
    const { rows } = await db.query(
      `SELECT report_id, agent, report_date, report_type, title,
              critical_flags, active_items, recommendations, draft_count, created_at
       FROM daily_reports ${whereSql}
       ORDER BY report_date DESC, created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM daily_reports WHERE report_id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ report: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- timeline ----------
router.get('/timeline', async (req, res) => {
  try {
    const { company, type, limit } = req.query;
    const where = [];
    const params = [];
    if (company) { params.push(company); where.push(`co.slug = $${params.length}`); }
    if (type)    { params.push(type);    where.push(`t.entry_type = $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 200));
    const { rows } = await db.query(
      `SELECT t.entry_id, t.entry_date, t.entry_type, t.title, t.details,
              t.recording_url, t.source, t.created_at,
              co.name AS company_name, co.slug AS company_slug
       FROM timeline t
       LEFT JOIN companies co ON co.company_id = t.company_id
       ${whereSql}
       ORDER BY t.entry_date DESC, t.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- meeting notes ----------
router.get('/meeting_notes', async (req, res) => {
  try {
    const { company, limit } = req.query;
    const where = [];
    const params = [];
    if (company) { params.push(company); where.push(`co.slug = $${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(asInt(limit, 200));
    const { rows } = await db.query(
      `SELECT mn.note_id, mn.title, mn.meeting_date, mn.body, mn.source_file,
              mn.word_count, mn.created_at,
              co.name AS company_name, co.slug AS company_slug
       FROM meeting_notes mn
       LEFT JOIN companies co ON co.company_id = mn.company_id
       ${whereSql}
       ORDER BY mn.meeting_date DESC, mn.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/meeting_notes/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM meeting_notes WHERE note_id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ note: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
