// Builds a fresh situational briefing for an agent and injects it into the
// agent's OpenClaw session via chat.inject. Called by routes/chat.js when
// the last inject is missing or >2h stale, so the agent's brain starts each
// conversation knowing what's true right now without re-prepending on every
// turn.
//
// The persona files (IDENTITY/AGENTS/USER/SOUL) are already loaded by
// OpenClaw at workspace start — this layer adds the live Postgres state
// that the persona files reference but cannot know on their own.

const db = require('./db');
const { getClient } = require('./openclaw');

const AGENT_NAMES = {
  cro: 'CRO',
  cs: 'CS',
  bdm: 'BDM',
  fin: 'Finance',
  analyst: 'Analyst',
  content: 'Content',
  dev: 'Dev',
};

async function buildBriefingText(agentId) {
  const now = new Date().toISOString();
  const lines = [`Situational briefing for ${AGENT_NAMES[agentId] || agentId} at ${now}.`];

  // Active tasks — top 5 by priority then due date.
  const tasksRes = await db.query(
    `SELECT t.title, t.priority, t.due_date, t.action_type, t.company_slug,
            co.name AS company_name
       FROM tasks t
       LEFT JOIN companies co ON co.slug = t.company_slug
      WHERE t.agent_id = $1 AND t.active = true
      ORDER BY CASE t.priority
                 WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
                 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5
               END,
               t.due_date NULLS LAST
      LIMIT 5`,
    [agentId]
  );
  const taskCount = (await db.query(
    `SELECT COUNT(*)::int AS n FROM tasks WHERE agent_id = $1 AND active = true`,
    [agentId]
  )).rows[0].n;

  if (taskCount > 0) {
    lines.push(`\nActive tasks (${taskCount} total). Top ${tasksRes.rows.length}:`);
    for (const t of tasksRes.rows) {
      const co = t.company_name ? ` [${t.company_name}]` : '';
      const due = t.due_date ? ` (due ${t.due_date.toISOString().slice(0, 10)})` : '';
      lines.push(`  - [${t.priority}] ${t.title}${co}${due}`);
    }
  } else {
    lines.push(`\nActive tasks: 0.`);
  }

  // Uncovered companies — no plan in motion, this agent owns.
  try {
    const coverageRes = await db.query(
      `SELECT slug, name, days_since_contact, risk
         FROM company_coverage_view
        WHERE owning_agent = $1 AND is_uncovered = true
        ORDER BY risk, days_since_contact DESC NULLS LAST
        LIMIT 5`,
      [agentId]
    );
    if (coverageRes.rows.length > 0) {
      lines.push(`\nUncovered companies (no plan in motion), top ${coverageRes.rows.length}:`);
      for (const c of coverageRes.rows) {
        const days = c.days_since_contact != null ? `${c.days_since_contact}d quiet` : 'no contact yet';
        lines.push(`  - ${c.name} [${c.slug}] — ${days}, risk=${c.risk || 'n/a'}`);
      }
    }
  } catch (err) {
    // Coverage view may not exist on dev DBs; not fatal.
    console.warn('[briefing] coverage query skipped:', err.message);
  }

  // Last run summary.
  const lastRunRes = await db.query(
    `SELECT skill, summary, completed_at
       FROM runs
      WHERE agent_id = $1 AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1`,
    [agentId]
  );
  if (lastRunRes.rows.length > 0) {
    const r = lastRunRes.rows[0];
    const when = r.completed_at ? r.completed_at.toISOString().slice(0, 16).replace('T', ' ') : '';
    lines.push(`\nLast run (${r.skill || 'n/a'} @ ${when}): ${r.summary || '(no summary)'}`);
  }

  lines.push('\nUse this state when answering — quote task titles and company slugs as written above.');
  return lines.join('\n');
}

/**
 * Build the briefing and push it into the agent's session as a system note.
 * Caller is responsible for recording the inject into chat_messages.
 * Returns the briefing text so caller can persist it.
 */
async function buildAndInject(agentId, sessionKey) {
  const text = await buildBriefingText(agentId);
  const client = getClient();
  try {
    await client.inject(sessionKey, text, 'briefing');
  } catch (err) {
    console.error('[briefing] inject failed:', err.message);
    throw err;
  }
  return text;
}

module.exports = { buildBriefingText, buildAndInject };
