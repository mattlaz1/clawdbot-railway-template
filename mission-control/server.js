const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const db = require("./lib/db");

process.on("unhandledRejection", (err) => {
  console.error("[server] unhandled rejection (kept alive):", err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 3700;
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(__dirname, "..", "..");
const AGENT_BASE = path.join(VAULT_ROOT, "SkySuite", "agent");
const EXECUTE_LOG_DIR = path.join(__dirname, "data", "execute-logs");

app.use(express.json({ limit: "1mb" }));

// Auth gate — mount before static/routes so the dashboard shell also requires
// credentials. Webhook routes self-authenticate via HMAC and bypass this.
const basicAuth = require("./middleware/auth");
app.use(basicAuth);
if (basicAuth.enabled) {
  console.log("[auth] Basic Auth enabled");
} else {
  console.log("[auth] Basic Auth DISABLED — set BASIC_AUTH_USER + BASIC_AUTH_PASS to enable");
}

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

if (!IS_RAILWAY) {
  fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
  fs.mkdirSync(EXECUTE_LOG_DIR, { recursive: true });
}

// Phase 1: read-only Postgres browser (see db/README.md)
app.use("/api/db", require("./routes/db"));

// Outlook email integration (Graph API)
app.use("/api/outlook", require("./routes/outlook"));

// Webhooks (Fathom, etc.)
app.use("/api/webhooks", require("./routes/webhooks"));

// GitHub dashboard (read-only view of repos, branches, PRs)
app.use("/api/github", require("./routes/github"));

// Chat — POST /api/agents/:id/chat, GET .../chat/stream (SSE), .../chat/history
// Routes are absolute (`/api/agents/...`) so mounted at root.
app.use(require("./routes/chat"));

// ─── Agent metadata ─────────────────────────────────────────────────────────
const AGENTS = [
  {
    id: "cs",
    name: "CS",
    emoji: "🤝",
    skill: "/cs-daily",
    persona: "/be-cs",
    schedule: "Daily 8:43 AM",
    color: "#10b981",
    pastel: "#d1fae5",
    proposals_file: "proposals.json",
    dir: "cs",
    mcps: ["outlook", "calendar", "notion"],
    tagline: "Client health & delivery",
    skills: ["Check-in emails", "Health scoring", "Delivery tracking", "Expansion signals"],
  },
  {
    id: "cro",
    name: "CRO",
    emoji: "💼",
    skill: "/cro-daily",
    persona: "/be-cro",
    schedule: "Daily 8:27 AM",
    color: "#3b82f6",
    pastel: "#dbeafe",
    proposals_file: "proposals.json",
    dir: "cro",
    mcps: ["outlook", "calendar", "notion"],
    tagline: "Pipeline & deal momentum",
    skills: ["Draft emails", "Notion tasks", "Pipeline audit", "Proposal prep"],
  },
  {
    id: "bdm",
    name: "BDM",
    emoji: "🎯",
    skill: "/bdm-weekly",
    persona: "/be-bdm",
    schedule: "Mon 9:03 AM",
    color: "#f59e0b",
    pastel: "#fef3c7",
    proposals_file: "proposals.json",
    dir: "bdm",
    mcps: ["outlook", "calendar", "linkedin", "notion"],
    tagline: "Outbound & lead gen",
    skills: ["Cold outreach", "LinkedIn DMs", "Sequence management", "Lead research"],
  },
  {
    id: "fin",
    name: "Finance",
    emoji: "💰",
    skill: "/fin-weekly",
    persona: "/be-fin",
    schedule: "Fri 9:03 AM",
    color: "#8b5cf6",
    pastel: "#ede9fe",
    proposals_file: "proposals.json",
    dir: "fin",
    mcps: ["quickbooks", "stripe", "outlook"],
    tagline: "AR, invoicing & collections",
    skills: ["Invoice generation", "Payment follow-up", "Revenue reconciliation", "Stripe sync"],
  },
  {
    id: "analyst",
    name: "Analyst",
    emoji: "📊",
    skill: null,
    persona: "/be-analyst",
    schedule: null,
    color: "#6366f1",
    pastel: "#e0e7ff",
    proposals_file: "proposals.json",
    dir: "analyst",
    mcps: [],
    tagline: "CRE financial modeling",
    skills: ["Model review", "Scenario analysis", "IC memo prep", "Sensitivity tables"],
  },
  {
    id: "content",
    name: "Content",
    emoji: "✍️",
    skill: "/content-weekly",
    persona: "/be-content",
    schedule: "Mon 7:30 AM",
    color: "#ec4899",
    pastel: "#fce7f3",
    proposals_file: "proposals.json",
    dir: "content",
    mcps: ["linkedin", "notion"],
    tagline: "LinkedIn posts & newsletters",
    skills: ["Post drafts", "Newsletter prep", "Influencer scan", "Engagement tracking"],
  },
  {
    id: "dev",
    name: "Dev",
    emoji: "🛠️",
    skill: null,
    persona: "/be-dev",
    schedule: null,
    color: "#64748b",
    pastel: "#e2e8f0",
    proposals_file: "proposals.json",
    dir: "dev",
    mcps: [],
    tagline: "Product development",
    skills: [
      "Feature implementation",
      "Bug fixes",
      "PR review",
      "Ticket management",
    ],
  },
];

function getAgent(id) {
  return AGENTS.find((a) => a.id === id);
}

// Shared map of background `claude -p` runs. Keyed by run_id.
const activeRuns = new Map();

// ─── Notifications feed ───────────────────────────────────────────────────
// Synthesizes a unified event stream from runs + tasks + daily_reports.
// Client polls this, tracks last-seen in localStorage, and renders bell count,
// toasts, and OS notifications for events newer than last-seen.
// Optional ?since=ISO8601 returns only events after that timestamp.
app.get("/api/notifications", async (req, res) => {
  const since = req.query.since;
  const events = [];

  // Cron runs — each completed run is an event
  const runsQuery = since
    ? `SELECT * FROM runs WHERE completed_at > $1 ORDER BY completed_at DESC LIMIT 100`
    : `SELECT * FROM runs ORDER BY completed_at DESC LIMIT 50`;
  const runsRows = (await db.query(runsQuery, since ? [since] : [])).rows;
  for (const r of runsRows) {
    events.push({
      id: `run-${r.id}`,
      type: "run",
      agent_id: r.agent_id,
      timestamp: r.completed_at || r.started_at,
      title: `${r.agent_name || r.agent_id} ran ${r.skill || ""}`.trim(),
      summary: r.summary || "",
      status: r.status,
      severity: r.status === "error" ? "error" : r.status === "partial" ? "warn" : "info",
    });
  }

  // New tasks — each active task is an event (deduped via client last-seen)
  const taskQuery = since
    ? `SELECT id, agent_id, title, priority, added_at, action_type FROM tasks
       WHERE active = true AND added_at > $1 ORDER BY added_at DESC LIMIT 100`
    : `SELECT id, agent_id, title, priority, added_at, action_type FROM tasks
       WHERE active = true ORDER BY added_at DESC LIMIT 50`;
  const taskRows = (await db.query(taskQuery, since ? [since] : [])).rows;
  for (const t of taskRows) {
    events.push({
      id: `task-${t.id}`,
      type: "task",
      agent_id: t.agent_id,
      task_id: t.id,
      timestamp: t.added_at,
      title: t.title,
      priority: t.priority,
      action_type: t.action_type,
      severity: t.priority === "urgent" ? "warn" : "info",
    });
  }

  // New briefings
  const briefQuery = since
    ? `SELECT agent, report_date, title, created_at FROM daily_reports
       WHERE created_at > $1 ORDER BY created_at DESC LIMIT 50`
    : `SELECT agent, report_date, title, created_at FROM daily_reports
       ORDER BY created_at DESC LIMIT 30`;
  const briefRows = (await db.query(briefQuery, since ? [since] : [])).rows;
  for (const b of briefRows) {
    events.push({
      id: `brief-${b.agent}-${b.report_date.toISOString ? b.report_date.toISOString().slice(0,10) : b.report_date}`,
      type: "briefing",
      agent_id: b.agent,
      timestamp: b.created_at,
      title: b.title || `${b.agent} briefing ready`,
      severity: "info",
    });
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events.slice(0, 200));
});

// ─── Briefings (daily_reports table) ──────────────────────────────────────
// Latest briefing for a single agent (used by the per-card "View briefing" modal).
app.get("/api/agents/:id/briefing", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { rows } = await db.query(
    `SELECT agent, report_date, report_type, title, body, created_at
     FROM daily_reports
     WHERE agent = $1
     ORDER BY report_date DESC, created_at DESC
     LIMIT 1`,
    [agent.id]
  );
  if (!rows.length) return res.status(404).json({ error: "No briefing yet" });
  res.json(rows[0]);
});

// All of today's briefings (used by the "Today's Briefings" panel).
// Optional ?days=N query param widens the window — defaults to 1 (today only).
app.get("/api/briefings/today", async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days) || 1);
  const { rows } = await db.query(
    `SELECT DISTINCT ON (agent) agent, report_date, report_type, title, body, created_at
     FROM daily_reports
     WHERE report_date >= (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')
     ORDER BY agent, report_date DESC, created_at DESC`,
    [days]
  );
  res.json(rows);
});

// ─── Runs (cron log — now in Postgres) ────────────────────────────────────
app.get("/api/runs", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { rows } = await db.query(
    "SELECT * FROM runs ORDER BY started_at DESC LIMIT $1",
    [limit]
  );
  res.json(rows);
});

app.post("/api/runs", async (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const r = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO runs (id, agent_id, agent_name, skill, started_at, completed_at, status, duration_s, actions, summary, notion_url, errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id, r.agent_id, r.agent_name, r.skill,
        r.started_at || new Date().toISOString(),
        r.completed_at || new Date().toISOString(),
        r.status || "success", r.duration_s || 0,
        r.actions ? JSON.stringify(r.actions) : null,
        r.summary || "", r.notion_url || "",
        r.errors ? JSON.stringify(r.errors) : "[]",
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agents list with task/run summary ──────────────────────────────────
app.get("/api/agents", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const agent of AGENTS) {
    // Last run + today count
    const { rows: runRows } = await db.query(
      "SELECT * FROM runs WHERE agent_id=$1 ORDER BY started_at DESC LIMIT 1",
      [agent.id]
    );
    const { rows: todayRows } = await db.query(
      "SELECT COUNT(*)::int as n FROM runs WHERE agent_id=$1 AND started_at::date = $2",
      [agent.id, today]
    );
    const lastRun = runRows[0] || null;
    const runsToday = todayRows[0]?.n || 0;

    // Task counts from DB — touched logic must match UI's isTouched():
    // thread has a matt message, OR comment is non-empty, OR edits is non-null
    const { rows: taskCounts } = await db.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE td.status = 'in_progress')::int as queued,
        COUNT(*) FILTER (WHERE td.task_id IS NOT NULL AND td.status != 'in_progress' AND (
          EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(td.thread,'[]'::jsonb)) m WHERE m->>'role' = 'matt')
          OR (td.comment IS NOT NULL AND td.comment != '')
          OR td.edits IS NOT NULL
        ))::int as touched
      FROM tasks t
      LEFT JOIN task_decisions td ON td.task_id = t.id
      WHERE t.agent_id = $1 AND t.active = true
    `, [agent.id]);
    const pc = taskCounts[0] || { total: 0, queued: 0, in_progress: 0, touched: 0 };

    // Get generated_at from the most recent task
    const { rows: genRows } = await db.query(
      "SELECT generated_at FROM tasks WHERE agent_id=$1 AND active=true ORDER BY generated_at DESC LIMIT 1",
      [agent.id]
    );

    out.push({
      ...agent,
      last_run: lastRun,
      runs_today: runsToday,
      tasks: {
        generated_at: genRows[0]?.generated_at || null,
        total: pc.total,
        touched: pc.touched,
        in_progress: pc.queued,
        todo: pc.total - pc.touched - pc.queued,
      },
    });
  }
  res.json(out);
});

// ─── Tasks endpoints (all DB-backed) ──────────────────────────────────────
// Returns the agent's active tasks plus the per-task decision state. Decisions
// are keyed by task_id. Statuses 'archived' and 'dismissed' are filtered out
// server-side so legacy archives never paint.
app.get("/api/agents/:id/tasks", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });

  const { rows: tasks } = await db.query(
    `SELECT t.*, c.name AS company_name
       FROM tasks t
       LEFT JOIN companies c ON c.slug = t.company_slug
       WHERE t.agent_id=$1 AND t.active=true
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
                t.due_date ASC NULLS LAST, t.added_at ASC`,
    [agent.id]
  );
  const { rows: decRows } = await db.query(
    `SELECT td.* FROM task_decisions td
     JOIN tasks t ON t.id = td.task_id
     WHERE t.agent_id=$1 AND t.active=true
       AND (td.status IS NULL OR td.status NOT IN ('archived','dismissed'))`,
    [agent.id]
  );
  const decisions = {};
  for (const d of decRows) {
    decisions[d.task_id] = {
      decision: d.decision,
      status: d.status,
      thread: d.thread || [],
      edits: d.edits || null,
      queued_at: d.queued_at,
      updated_at: d.updated_at,
    };
  }

  // Get generated_at from the freshest task
  const genAt = tasks[0]?.generated_at || null;

  const mapped = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    rationale: t.rationale,
    action_type: t.action_type,
    added_at: t.added_at,
    due_date: t.due_date,
    priority: t.priority || "normal",
    preview: t.preview,
    execute_instructions: t.execute_instructions,
    company_slug: t.company_slug,
    company_name: t.company_name,
    notes: t.notes,
    origin: t.origin,
    completed_at: t.completed_at,
  }));

  res.json({ generated_at: genAt, tasks: mapped, decisions });
});

// Company coverage — one row per active CRO deal or CS client with active
// task counts (review + in-motion split) and is_uncovered flag. Powers the
// Companies tab and the daily coverage sweep. Read-only.
app.get("/api/companies/coverage", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         company_id, slug, name, stage, last_contact, days_since_contact, risk,
         owning_agent, active_task_count, loose_task_count,
         active_task_count_total, latest_task_title, latest_task_due_date,
         tasks_needing_review, tasks_in_motion, is_uncovered
       FROM company_coverage_view
       ORDER BY
         is_uncovered DESC,
         CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         days_since_contact DESC NULLS LAST,
         name`
    );
    res.json({ companies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-company drill-down: all active tasks for one company, each tagged with a
// `lane` derived from its decision status: review | queued | in_progress | snoozed.
// The frontend groups by lane to render the Customers card body.
app.get("/api/companies/:slug/coverage", async (req, res) => {
  try {
    const { slug } = req.params;
    const { rows: company } = await db.query(
      `SELECT * FROM company_coverage_view WHERE slug=$1`,
      [slug]
    );
    if (!company.length) return res.status(404).json({ error: "company not found or not in active stage" });

    const { rows: tasks } = await db.query(
      `SELECT t.id, t.agent_id, t.title, t.rationale, t.action_type, t.priority,
              t.due_date, t.added_at, t.preview, t.company_slug, t.notes, t.origin,
              t.completed_at, t.contact_id,
              td.decision, td.status AS decision_status, td.thread,
              td.updated_at AS decided_at,
              c.name AS contact_name,
              CASE
                WHEN td.status = 'snoozed' THEN 'snoozed'
                WHEN td.status IN ('queued','in_progress','approved') THEN 'in_motion'
                ELSE 'review'
              END AS lane
         FROM tasks t
         LEFT JOIN task_decisions td ON td.task_id = t.id
         LEFT JOIN contacts c ON c.contact_id = t.contact_id
         WHERE t.active=true
           AND (td.status IS NULL OR td.status NOT IN ('archived','dismissed','executed','rejected'))
           AND (
             t.company_slug=$1
             OR (t.company_slug IS NULL AND t.title ILIKE '%' || $2 || '%')
           )
         ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
                  t.due_date ASC NULLS LAST`,
      [slug, company[0].name]
    );

    res.json({ company: company[0], tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Projects (CS-as-PM model) -----
// CS owns the project portfolio. Analyst executes. See `.claude/rules/postgres-rules.md` § Projects.

// List all active+blocked projects with task-count rollups.
// Query params: ?agent=analyst|dev, ?status=active|blocked, ?company=<slug>
app.get("/api/projects", async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.agent) { params.push(req.query.agent); where.push(`owning_agent = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.company) { params.push(req.query.company); where.push(`company_slug = $${params.length}`); }
    const sql = `
      SELECT *
      FROM project_health_view
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END,
        days_stale DESC,
        company_name`;
    const { rows } = await db.query(sql, params);
    res.json({ projects: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drill-down: project details + all its tasks (active and recently shipped).
app.get("/api/projects/:id", async (req, res) => {
  try {
    const { rows: project } = await db.query(
      `SELECT * FROM project_health_view WHERE project_id = $1`,
      [req.params.id]
    );
    if (!project.length) return res.status(404).json({ error: "project not found" });

    const { rows: tasks } = await db.query(
      `SELECT t.id, t.agent_id, t.title, t.action_type, t.priority, t.due_date,
              t.preview, t.execute_instructions, t.notes, t.source, t.source_quote,
              t.origin, t.active, t.completed_at, t.company_slug,
              td.decision, td.status AS decision_status, td.thread, td.comment,
              td.updated_at AS decided_at,
              CASE
                WHEN t.active = false AND td.status = 'executed' THEN 'shipped'
                WHEN td.status = 'snoozed' THEN 'snoozed'
                WHEN td.status = 'needs_matt' THEN 'kicked_back'
                WHEN td.status IN ('queued','in_progress','approved') THEN 'in_motion'
                ELSE 'review'
              END AS lane
         FROM tasks t
         LEFT JOIN task_decisions td ON td.task_id = t.id
        WHERE t.project_id = $1
          AND (t.active = true OR (t.completed_at IS NOT NULL AND t.completed_at > now() - INTERVAL '14 days'))
        ORDER BY t.active DESC, t.due_date NULLS LAST, t.added_at DESC`,
      [req.params.id]
    );

    res.json({ project: project[0], tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH CS-owned project fields. Analyst-owned fields (current_version,
// last_activity_at) are NOT writable via this endpoint — only the
// `/execute-analyst` skill updates them.
const PROJECT_WRITABLE = new Set([
  'name','slug','kind','owning_agent','status','priority',
  'blocked_on','context_doc_path','summary','target_date','shipped_at'
]);
app.patch("/api/projects/:id", async (req, res) => {
  try {
    const fields = req.body || {};
    const sets = [];
    const params = [];
    for (const [col, val] of Object.entries(fields)) {
      if (!PROJECT_WRITABLE.has(col)) continue;
      params.push(val === '' ? null : val);
      sets.push(`"${col}" = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "no writable fields" });
    sets.push(`updated_at = now()`);
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE project_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "project not found" });
    res.json({ project: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new project (CS-initiated).
app.post("/api/projects", async (req, res) => {
  try {
    const {
      company_slug, name, slug, kind, owning_agent,
      status = 'active', priority = 'normal', blocked_on,
      context_doc_path, summary, target_date
    } = req.body || {};
    if (!company_slug || !name || !slug || !kind || !owning_agent) {
      return res.status(400).json({ error: "company_slug, name, slug, kind, owning_agent required" });
    }
    const { rows: company } = await db.query(
      `SELECT company_id FROM companies WHERE slug = $1`, [company_slug]
    );
    if (!company.length) return res.status(400).json({ error: `unknown company_slug: ${company_slug}` });
    const { rows } = await db.query(
      `INSERT INTO projects (company_id, company_slug, name, slug, kind, owning_agent,
                             status, priority, blocked_on, context_doc_path, summary, target_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [company[0].company_id, company_slug, name, slug, kind, owning_agent,
       status, priority, blocked_on || null, context_doc_path || null,
       summary || null, target_date || null]
    );
    res.json({ project: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Append a message to a task's thread
app.post("/api/agents/:id/tasks/:taskId/message", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { text, role } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Empty message" });

  const taskId = req.params.taskId;
  const now = new Date().toISOString();
  const msg = { role: role || "matt", ts: now, text: text.trim() };

  // Upsert decision
  const { rows } = await db.query(`
    INSERT INTO task_decisions (task_id, agent_id, thread, status, updated_at)
    VALUES ($1, $2, $3::jsonb, 'needs_refinement', $4)
    ON CONFLICT (task_id) DO UPDATE SET
      thread = task_decisions.thread || $3::jsonb,
      status = CASE
        WHEN EXCLUDED.status IN ('rejected','needs_matt') OR task_decisions.status IS NULL
        THEN 'needs_refinement'
        ELSE task_decisions.status
      END,
      updated_at = $4
    RETURNING *
  `, [taskId, agent.id, JSON.stringify([msg]), now]);

  // Audit log
  await db.query(
    `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'thread_message',$3,$4)`,
    [taskId, agent.id, role || "matt", JSON.stringify({ text: text.trim() })]
  );

  res.json({ ok: true, decision: rows[0] });
});

// Ad-hoc freeform task \u2014 Matt typed it directly into the dashboard
app.post("/api/agents/:id/adhoc", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Empty" });

  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const trimmed = text.trim();

  // Find next sequence number for adhoc
  const { rows: seqRows } = await db.query(
    "SELECT COUNT(*)::int as n FROM tasks WHERE id LIKE $1",
    [`${agent.id}-adhoc-${date}%`]
  );
  const seq = (seqRows[0]?.n || 0) + 1;
  const id = `${agent.id}-adhoc-${date}-${String(seq).padStart(2, "0")}`;
  const title = trimmed.length > 72 ? trimmed.slice(0, 69) + "…" : trimmed;

  const execInstructions = `FREEFORM REQUEST from Matt. Do exactly what he asked, using your judgment and whichever MCP tools are appropriate. If the request is ambiguous, pick the most reasonable interpretation and proceed \u2014 do not ask questions. Request:\n\n${trimmed}`;

  // Insert task with origin=manual
  await db.query(`
    INSERT INTO tasks (id, agent_id, generated_at, title, rationale, action_type, added_at, preview, execute_instructions, active, origin)
    VALUES ($1,$2,$3,$4,'Ad-hoc request from Matt via Mission Control.','freeform',$3,$5,$6,true,'manual')
  `, [id, agent.id, now, title, JSON.stringify({ instructions: trimmed }), execInstructions]);

  // Pre-approve
  await db.query(`
    INSERT INTO task_decisions (task_id, agent_id, decision, status, thread, updated_at)
    VALUES ($1,$2,'yes','approved',$3,$4)
  `, [id, agent.id, JSON.stringify([{ role: "matt", ts: now, text: trimmed }]), now]);

  await db.query(
    `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'approve','matt',$3)`,
    [id, agent.id, JSON.stringify({ text: trimmed })]
  );

  res.json({ ok: true, task: { id, title }, decision: { decision: "yes", status: "approved" } });
});

// Move task between kanban columns
app.post("/api/agents/:id/tasks/:taskId/move", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { target } = req.body;
  if (!["todo", "pending", "in_progress", "completed"].includes(target)) {
    return res.status(400).json({ error: "Invalid target" });
  }
  const taskId = req.params.taskId;
  const now = new Date().toISOString();

  // Clear due_date on the task
  await db.query("UPDATE tasks SET due_date = NULL, updated_at = now() WHERE id = $1 AND due_date IS NOT NULL", [taskId]);

  if (target === "completed") {
    await db.query(`
      INSERT INTO task_decisions (task_id, agent_id, status, updated_at)
      VALUES ($1, $2, 'executed', $3)
      ON CONFLICT (task_id) DO UPDATE SET status = 'executed', updated_at = $3
    `, [taskId, agent.id, now]);
    await db.query(
      `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'move','matt',$3)`,
      [taskId, agent.id, JSON.stringify({ target: "completed" })]
    );
    const { rows } = await db.query("SELECT * FROM task_decisions WHERE task_id=$1", [taskId]);
    return res.json({ ok: true, decision: rows[0] || null });
  }

  if (target === "todo") {
    await db.query("DELETE FROM task_decisions WHERE task_id = $1", [taskId]);
    await db.query(
      `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'move','matt',$3)`,
      [taskId, agent.id, JSON.stringify({ target: "todo" })]
    );
    return res.json({ ok: true, decision: null });
  }

  const status = target === "in_progress" ? "in_progress" : null;
  const queuedAt = target === "in_progress" ? now : null;

  await db.query(`
    INSERT INTO task_decisions (task_id, agent_id, status, queued_at, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (task_id) DO UPDATE SET
      status = $3, queued_at = COALESCE($4, task_decisions.queued_at), updated_at = $5
  `, [taskId, agent.id, status, queuedAt, now]);

  await db.query(
    `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'move','matt',$3)`,
    [taskId, agent.id, JSON.stringify({ target })]
  );

  const { rows } = await db.query("SELECT * FROM task_decisions WHERE task_id=$1", [taskId]);
  res.json({ ok: true, decision: rows[0] || null });
});

// Resolve a task: mark complete (Matt did it manually) or dismiss (won't do)
app.post("/api/agents/:id/tasks/:taskId/resolve", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { action } = req.body;
  if (!["completed", "dismissed"].includes(action)) {
    return res.status(400).json({ error: "action must be 'completed' or 'dismissed'" });
  }
  const taskId = req.params.taskId;
  const now = new Date().toISOString();

  if (action === "completed") {
    // Manually completed by Matt: mark the task done with completed_at + status='completed'
    await db.query(
      "UPDATE tasks SET active = false, completed_at = now(), updated_at = now() WHERE id = $1 AND active = true",
      [taskId]
    );
    await db.query(`
      INSERT INTO task_decisions (task_id, agent_id, decision, status, updated_at)
      VALUES ($1, $2, 'yes', 'completed', $3)
      ON CONFLICT (task_id) DO UPDATE SET decision='yes', status = 'completed', updated_at = $3
    `, [taskId, agent.id, now]);
  } else {
    // Dismissed: deactivate the task and mark decision dismissed (not deleted —
    // we keep the row so /measure-outcomes can see the dismissal pattern).
    await db.query(
      "UPDATE tasks SET active = false, updated_at = now() WHERE id = $1",
      [taskId]
    );
    await db.query(`
      INSERT INTO task_decisions (task_id, agent_id, decision, status, updated_at)
      VALUES ($1, $2, 'no', 'dismissed', $3)
      ON CONFLICT (task_id) DO UPDATE SET decision='no', status = 'dismissed', updated_at = $3
    `, [taskId, agent.id, now]);
  }

  await db.query(
    `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,$3,'matt',$4)`,
    [taskId, agent.id, action, JSON.stringify({ action })]
  );

  res.json({ ok: true });
});

// Set or clear due_date
app.put("/api/agents/:id/tasks/:taskId/due_date", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { due_date } = req.body;
  if (due_date !== null && due_date !== undefined) {
    if (typeof due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      return res.status(400).json({ error: "due_date must be YYYY-MM-DD or null" });
    }
  }
  await db.query(
    "UPDATE tasks SET due_date = $1, updated_at = now() WHERE id = $2",
    [due_date || null, req.params.taskId]
  );
  const { rows } = await db.query("SELECT * FROM tasks WHERE id = $1", [req.params.taskId]);
  if (!rows.length) return res.status(404).json({ error: "Unknown task" });
  res.json({ ok: true, task: rows[0] });
});

// Queue all touched tasks
app.post("/api/agents/:id/queue", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const now = new Date().toISOString();

  const { rowCount } = await db.query(`
    UPDATE task_decisions SET status = 'in_progress', queued_at = $1, updated_at = $1
    WHERE agent_id = $2 AND status IS DISTINCT FROM 'in_progress'
      AND task_id IN (SELECT id FROM tasks WHERE agent_id = $2 AND active = true)
      AND (thread != '[]'::jsonb OR edits IS NOT NULL)
  `, [now, agent.id]);

  res.json({ ok: true, in_progress: rowCount });
});

// Update decision (comment/edits)
app.put("/api/agents/:id/tasks/:taskId/decision", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  const { comment, edits } = req.body;
  const taskId = req.params.taskId;
  const now = new Date().toISOString();

  // Check if there's a thread message or edits that make this "touched"
  const hasTouchSignal = (comment && comment.trim()) || (edits && Object.keys(edits).length);

  if (!hasTouchSignal) {
    // Nothing left — delete the decision so it falls back to "to do"
    await db.query("DELETE FROM task_decisions WHERE task_id = $1", [taskId]);
    return res.json({ ok: true, decisions: {} });
  }

  // Build thread entry from comment if provided
  let threadAppend = "[]";
  if (comment && comment.trim()) {
    threadAppend = JSON.stringify([{ role: "matt", ts: now, text: comment.trim() }]);
  }

  await db.query(`
    INSERT INTO task_decisions (task_id, agent_id, comment, thread, edits, status, updated_at)
    VALUES ($1, $2, $6, $3::jsonb, $4, 'needs_refinement', $5)
    ON CONFLICT (task_id) DO UPDATE SET
      comment = COALESCE($6, task_decisions.comment),
      thread = task_decisions.thread || $3::jsonb,
      edits = COALESCE($4, task_decisions.edits),
      status = CASE WHEN task_decisions.status = 'rejected' THEN 'needs_refinement' ELSE COALESCE(task_decisions.status, 'needs_refinement') END,
      updated_at = $5
  `, [taskId, agent.id, threadAppend, edits ? JSON.stringify(edits) : null, now, comment || null]);

  await db.query(
    `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'edit','matt',$3)`,
    [taskId, agent.id, JSON.stringify({ comment, edits })]
  );

  // Return all decisions for this agent (frontend expects this shape)
  const { rows } = await db.query(
    `SELECT td.* FROM task_decisions td JOIN tasks t ON t.id = td.task_id WHERE t.agent_id=$1 AND t.active=true`,
    [agent.id]
  );
  const decisions = {};
  for (const d of rows) decisions[d.task_id] = d;
  res.json({ ok: true, decisions });
});

// ─── Manually trigger an agent's cron skill ──────────────────────────────
app.post("/api/agents/:id/trigger", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  if (!agent.skill || !agent.skill.startsWith("/")) {
    return res.status(400).json({ error: "Agent has no scheduled skill to trigger" });
  }

  // On Railway, return the command for Matt to paste into Claude Code
  if (IS_RAILWAY) {
    return res.json({
      mode: "copy",
      command: agent.skill,
      message: `Paste this into Claude Code: ${agent.skill}`,
    });
  }

  const runId = `${agent.id}-trigger-${Date.now().toString(36)}`;
  const logFile = path.join(EXECUTE_LOG_DIR, `${runId}.log`);
  const prompt = agent.skill;

  fs.writeFileSync(
    logFile,
    `# Manual trigger ${runId}\n# Agent: ${agent.name}\n# Skill: ${agent.skill}\n# Started: ${new Date().toISOString()}\n\n## OUTPUT\n`,
  );

  const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
    cwd: VAULT_ROOT,
    shell: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try { child.stdin.end(); } catch {}

  activeRuns.set(runId, {
    status: "running",
    started_at: new Date().toISOString(),
    agent_id: agent.id,
    kind: "trigger",
    skill: agent.skill,
  });

  child.stdout.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(logFile, `[stderr] ${chunk}`));
  child.on("close", (code) => {
    fs.appendFileSync(
      logFile,
      `\n\n## EXIT CODE: ${code}\n## Completed: ${new Date().toISOString()}\n`,
    );
    activeRuns.set(runId, {
      ...activeRuns.get(runId),
      status: code === 0 ? "completed" : "error",
      completed_at: new Date().toISOString(),
      exit_code: code,
    });
  });
  child.on("error", (err) => {
    fs.appendFileSync(logFile, `\n[spawn error] ${err.message}\n`);
    activeRuns.set(runId, {
      ...activeRuns.get(runId),
      status: "error",
      error: err.message,
    });
  });

  res.status(202).json({ run_id: runId, skill: agent.skill });
});

// ─── Execute approved tasks ─────────────────────────────────────────────────
app.post("/api/agents/:id/execute", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });

  // Get touched tasks from DB — matches isTouched() logic
  const { rows: tasksToExec } = await db.query(`
    SELECT t.*, td.thread, td.edits, td.comment, td.status as dec_status
    FROM tasks t
    JOIN task_decisions td ON td.task_id = t.id
    WHERE t.agent_id = $1 AND t.active = true
      AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(td.thread,'[]'::jsonb)) m WHERE m->>'role' = 'matt')
        OR (td.comment IS NOT NULL AND td.comment != '')
        OR td.edits IS NOT NULL
      )
  `, [agent.id]);

  if (!tasksToExec.length) {
    return res.status(400).json({ error: "Nothing approved" });
  }

  // On Railway, return the command for Matt to paste into Claude Code
  if (IS_RAILWAY) {
    const titles = tasksToExec.map((t) => t.title).join(", ");
    return res.json({
      mode: "copy",
      command: `/execute-${agent.id}`,
      approved_count: tasksToExec.length,
      titles,
      message: `Paste this into Claude Code to execute ${tasksToExec.length} approved actions: /execute-${agent.id}`,
    });
  }

  const approved = tasksToExec.map((t) => {
    const edits = t.edits || {};
    const preview = { ...(t.preview || {}) };
    if (edits.body !== undefined) preview.body = edits.body;
    if (edits.subject !== undefined) preview.subject = edits.subject;
    if (edits.to !== undefined) preview.to = edits.to;
    const wasEdited = Object.keys(edits).length > 0;
    const threadComments = (t.thread || [])
      .filter((m) => m.role === "matt")
      .map((m) => m.text)
      .join("\n");
    const comment = [t.comment, threadComments].filter(Boolean).join("\n");
    return {
      id: t.id,
      title: t.title,
      rationale: t.rationale,
      action_type: t.action_type,
      added_at: t.added_at,
      due_date: t.due_date,
      priority: t.priority || "normal",
      preview,
      execute_instructions: t.execute_instructions,
      comment,
      edited: wasEdited,
      edits: wasEdited ? edits : undefined,
    };
  });

  const runId = `${agent.id}-${Date.now().toString(36)}`;
  const logFile = path.join(EXECUTE_LOG_DIR, `${runId}.log`);

  // Create execution record in DB
  await db.query(`
    INSERT INTO executions (run_id, agent_id, approved, status)
    VALUES ($1, $2, $3, 'running')
  `, [runId, agent.id, JSON.stringify(approved)]);

  // Connection info for Claude to write results directly to Postgres
  const dbUrl = process.env.DATABASE_URL;
  const psqlBin = "C:/Program Files/PostgreSQL/16/bin/psql.exe";

  const prompt = `You are the SkySuite ${agent.name} agent running in EXECUTE MODE. Matt has already reviewed his morning briefing in the Mission Control dashboard and approved the specific actions listed below. Your job is to perform them right now using your MCP tools.

CRITICAL: This is a one-shot headless run. You CANNOT use interactive features. Specifically:
- Do NOT call /be-${agent.id} or any /be-* persona command (those start an interactive briefing).
- Do NOT call /${agent.id}-daily or any *-daily / *-weekly briefing command.
- You CAN call utility slash commands like /cro-draft-proposal if they are referenced in execute_instructions and they exist as commands in .claude/commands/.
- You CAN and SHOULD call MCP tools directly (mcp__outlook__*, mcp__notion__*, mcp__linkedin__*, mcp__quickbooks__*, mcp__stripe__*).

Read the rules in .claude/rules/${agent.id}-rules.md and .claude/rules/email-rules.md silently for context (do not summarize them), then execute the actions.

For each action:
- Read execute_instructions exactly.
- If a comment is present, treat it as a modification or additional constraint that overrides the original instructions. Matt's comment is the source of truth.
- **If the action has "edited": true, Matt has hand-edited the preview (typically the email body). USE THE EDITED VERSION VERBATIM — do not redraft, do not "improve", do not add to it. The preview.body is exactly what Matt wants sent. Open the existing Outlook draft via mcp__outlook and update its body to match preview.body exactly, then leave it for Matt to send.**
- Use the appropriate MCP tools (Outlook for drafts, Notion for tasks, LinkedIn for messages, etc.).
- After completing each action, write the result directly to Postgres by running:
  "${psqlBin}" "${dbUrl}" -c "UPDATE executions SET results = COALESCE(results, '[]'::jsonb) || '[{\\"id\\": \\"<TASK_ID>\\", \\"status\\": \\"done\\", \\"note\\": \\"<brief note>\\"}]'::jsonb, completed_at = now(), status = 'completed' WHERE run_id = '${runId}';"
  Replace <TASK_ID> with the task id and <brief note> with a 1-line summary. Run this after EACH completed action (not at the end).

Approved actions (JSON):
${JSON.stringify(approved, null, 2)}

Begin executing now. When all ${approved.length} actions are complete, reply with a one-line summary of what you did. Do not stop early. Do not ask for confirmation.`;

  fs.writeFileSync(logFile, `# Execute run ${runId}\n# Agent: ${agent.name}\n# Started: ${new Date().toISOString()}\n# Approved: ${approved.length}\n\n## PROMPT\n${prompt}\n\n## OUTPUT\n`);

  const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
    cwd: VAULT_ROOT,
    shell: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try { child.stdin.end(); } catch {}

  activeRuns.set(runId, { status: "running", started_at: new Date().toISOString(), agent_id: agent.id, approved_count: approved.length });

  child.stdout.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(logFile, `[stderr] ${chunk}`));
  child.on("close", async (code) => {
    fs.appendFileSync(logFile, `\n\n## EXIT CODE: ${code}\n## Completed: ${new Date().toISOString()}\n`);

    // Read results from DB (Claude wrote them directly)
    try {
      const { rows } = await db.query("SELECT results FROM executions WHERE run_id=$1", [runId]);
      const results = rows[0]?.results || [];
      const approvedIds = new Set(approved.map((p) => p.id));
      const executedIds = Array.isArray(results)
        ? results.filter((r) => r && r.id && approvedIds.has(r.id) && r.status === "done").map((r) => r.id)
        : [];

      if (code === 0 && executedIds.length > 0) {
        // Mark executed tasks as inactive (auto-close via /execute-*)
        await db.query(
          "UPDATE tasks SET active = false, completed_at = now(), updated_at = now() WHERE id = ANY($1)",
          [executedIds]
        );
        // Flip decisions to 'executed' (don't delete — the Completed column
        // in the Inbox reads these to show recent work for 14 days).
        await db.query(
          `UPDATE task_decisions
             SET status = 'executed', updated_at = now()
           WHERE task_id = ANY($1)`,
          [executedIds]
        );
        // Update execution record
        await db.query(
          "UPDATE executions SET status='completed', completed_at=now(), exit_code=$1 WHERE run_id=$2",
          [code, runId]
        );

        // Log to decision_history
        for (const id of executedIds) {
          await db.query(
            `INSERT INTO decision_history (task_id, agent_id, action, actor, payload) VALUES ($1,$2,'execute','system',$3)`,
            [id, agent.id, JSON.stringify({ run_id: runId, exit_code: code })]
          );
        }

        activeRuns.set(runId, { ...activeRuns.get(runId), status: "completed", completed_at: new Date().toISOString(), exit_code: code, executed_ids: executedIds });
      } else {
        await db.query(
          "UPDATE executions SET status='no-op', completed_at=now(), exit_code=$1 WHERE run_id=$2",
          [code, runId]
        );
        // Reset in_progress decisions for the approved batch back to needs_refinement
        // so they drop out of the queue instead of becoming zombies.
        const approvedIdList = approved.map((p) => p.id);
        if (approvedIdList.length) {
          await db.query(
            `UPDATE task_decisions
               SET status = 'needs_refinement', updated_at = now()
             WHERE task_id = ANY($1) AND status = 'in_progress'`,
            [approvedIdList]
          );
        }
        activeRuns.set(runId, { ...activeRuns.get(runId), status: "no-op", completed_at: new Date().toISOString(), exit_code: code });
        fs.appendFileSync(logFile, `\n[no-op] No done entries in DB results \u2014 reset ${approvedIdList.length} decision(s) to needs_refinement.\n`);
      }
    } catch (err) {
      fs.appendFileSync(logFile, `\n[post-execute error] ${err.message}\n`);
      activeRuns.set(runId, { ...activeRuns.get(runId), status: "error", error: err.message });
    }
  });
  child.on("error", (err) => {
    fs.appendFileSync(logFile, `\n[spawn error] ${err.message}\n`);
    activeRuns.set(runId, { status: "error", error: err.message, agent_id: agent.id });
  });

  res.status(202).json({ run_id: runId, approved_count: approved.length });
});

// ─── Unified history feed (all from Postgres) ────────────────────────────
app.get("/api/history", async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const events = [];

  // Cron runs
  const { rows: runs } = await db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT 500");
  for (const r of runs) {
    const agent = AGENTS.find((a) => a.id === r.agent_id);
    events.push({
      type: "cron",
      timestamp: r.completed_at || r.started_at,
      agent_id: r.agent_id,
      agent_name: r.agent_name || agent?.name || r.agent_id,
      agent_color: agent?.color,
      agent_emoji: agent?.emoji,
      title: `${agent?.name || r.agent_id} ran ${r.skill || ""}`.trim(),
      summary: r.summary || "",
      status: r.status,
      duration_s: r.duration_s,
      meta: { actions: r.actions, errors: r.errors },
    });
  }

  // Build a title lookup from the tasks table (covers active + archived)
  const { rows: allTasks } = await db.query("SELECT id, title, action_type FROM tasks WHERE title IS NOT NULL AND title != ''");
  const titleLookup = {};
  for (const t of allTasks) titleLookup[t.id] = t;

  // Executions + their results
  const { rows: execs } = await db.query("SELECT * FROM executions ORDER BY started_at DESC LIMIT 200");
  for (const ex of execs) {
    const agent = AGENTS.find((a) => a.id === ex.agent_id);
    const results = ex.results || [];
    const executedIds = results.filter((r) => r?.status === "done").map((r) => r.id);

    events.push({
      type: "execute",
      timestamp: ex.started_at,
      agent_id: ex.agent_id,
      agent_name: agent?.name || ex.agent_id,
      agent_color: agent?.color,
      agent_emoji: agent?.emoji,
      title: `Executed ${executedIds.length || (ex.approved || []).length} action${(executedIds.length || (ex.approved || []).length) === 1 ? "" : "s"}`,
      summary: `${executedIds.length} done`,
      run_id: ex.run_id,
    });

    // Per-task decision events
    for (const r of results) {
      if (!r || !r.id) continue;
      // Find title: approved snapshot first, then DB lookup, then ID as fallback
      const fromApproved = (ex.approved || []).find((a) => a.id === r.id) || {};
      const fromDb = titleLookup[r.id] || {};
      const title = fromApproved.title || fromDb.title || r.note || null;
      if (!title) continue; // Skip history entries with no recoverable title
      events.push({
        type: "decision",
        timestamp: ex.completed_at || ex.started_at,
        agent_id: ex.agent_id,
        agent_name: agent?.name || ex.agent_id,
        agent_color: agent?.color,
        agent_emoji: agent?.emoji,
        title,
        summary: fromApproved.comment || r.note || "",
        decision: "yes",
        action_type: fromApproved.action_type || fromDb.action_type || null,
        executed: r.status === "done",
        run_id: ex.run_id,
      });
    }
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events.slice(0, limit));
});

// Recently-completed tasks for the Inbox "Completed" column.
// Returns tasks (including archived) whose decision is executed/completed within
// the window. Catches adhocs and archived items that `/api/history` misses
// because they never wrote to the executions table.
app.get("/api/completed", async (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const { rows } = await db.query(
    `SELECT t.id, t.agent_id, t.title, t.rationale, t.action_type, t.preview,
            t.due_date, t.added_at,
            td.status, td.updated_at AS executed_at, td.thread
     FROM tasks t
     JOIN task_decisions td ON td.task_id = t.id
     WHERE td.status IN ('executed','completed')
       AND td.updated_at > NOW() - ($1 || ' days')::interval
     ORDER BY td.updated_at DESC`,
    [String(days)]
  );
  const items = rows.map((r) => {
    const agent = AGENTS.find((a) => a.id === r.agent_id) || { id: r.agent_id, name: r.agent_id };
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        pastel: agent.pastel,
        emoji: agent.emoji,
      },
      task: {
        id: r.id,
        title: r.title,
        rationale: r.rationale || "",
        action_type: r.action_type,
        preview: r.preview || {},
        due_date: r.due_date,
        added_at: r.added_at,
      },
      decision: {
        decision: "yes",
        status: r.status,
        thread: r.thread || [],
        executed_at: r.executed_at,
      },
      generatedAt: r.executed_at,
    };
  });
  res.json(items);
});

app.get("/api/execute/:runId/status", async (req, res) => {
  // Check in-memory first (active runs)
  const info = activeRuns.get(req.params.runId);
  // Also check DB
  const { rows } = await db.query("SELECT * FROM executions WHERE run_id=$1", [req.params.runId]);
  const dbInfo = rows[0] || null;

  let tail = "";
  if (!IS_RAILWAY) {
    const logFile = path.join(EXECUTE_LOG_DIR, `${req.params.runId}.log`);
    try {
      const buf = fs.readFileSync(logFile, "utf8");
      tail = buf.slice(-4000);
    } catch {}
  }

  if (info) {
    res.json({ ...info, log_tail: tail, db_results: dbInfo?.results || [] });
  } else if (dbInfo) {
    res.json({ status: dbInfo.status, agent_id: dbInfo.agent_id, started_at: dbInfo.started_at, completed_at: dbInfo.completed_at, log_tail: tail, db_results: dbInfo.results || [] });
  } else {
    res.status(404).json({ error: "Unknown run" });
  }
});

app.listen(PORT, () => {
  console.log(`Mission Control running at http://localhost:${PORT}`);
  console.log(`Vault root: ${VAULT_ROOT}`);
});
