#!/usr/bin/env node
// Backfills mission-control proposals, decisions, runs, and archives from
// existing JSON files into Postgres. Idempotent — safe to re-run.

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');

const VAULT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AGENT_BASE = path.join(VAULT_ROOT, 'SkySuite', 'agent');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const AGENTS = [
  { id: 'cro',     dir: 'cro' },
  { id: 'cs',      dir: 'cs' },
  { id: 'bdm',     dir: 'bdm' },
  { id: 'fin',     dir: 'fin' },
  { id: 'analyst', dir: 'analyst' },
  { id: 'content', dir: 'content' },
  { id: 'dev',     dir: 'dev' },
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const counters = { proposals: 0, decisions: 0, runs: 0, archives: 0, history: 0 };

async function backfillProposals() {
  console.log('\n→ Proposals + Decisions');
  for (const agent of AGENTS) {
    const propFile = path.join(AGENT_BASE, agent.dir, 'proposals.json');
    const doc = readJson(propFile);
    if (!doc || !doc.proposals) continue;

    const generatedAt = doc.generated_at || new Date().toISOString();
    for (const p of doc.proposals) {
      if (!p.id) continue;
      try {
        await db.query(`
          INSERT INTO proposals (id, agent_id, generated_at, title, rationale, action_type, added_at, due_date, preview, execute_instructions, scope_note, active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
          ON CONFLICT (id) DO UPDATE SET
            title=EXCLUDED.title, rationale=EXCLUDED.rationale, action_type=EXCLUDED.action_type,
            preview=EXCLUDED.preview, execute_instructions=EXCLUDED.execute_instructions,
            due_date=EXCLUDED.due_date, active=true, updated_at=now()
        `, [
          p.id, agent.id, generatedAt, p.title || null, p.rationale || null,
          p.action_type || null, p.added_at || generatedAt, p.due_date || null,
          p.preview ? JSON.stringify(p.preview) : null,
          p.execute_instructions || null, doc.scope_note || null,
        ]);
        counters.proposals++;
      } catch (err) {
        console.error(`  [proposal] ${p.id}: ${err.message}`);
      }
    }

    // Decisions
    const decBase = 'proposals-decisions.json';
    const decFile = path.join(AGENT_BASE, agent.dir, decBase);
    const decisions = readJson(decFile);
    if (!decisions) continue;

    for (const [propId, d] of Object.entries(decisions)) {
      try {
        // Ensure proposal row exists (may be from an older cron run)
        await db.query(`
          INSERT INTO proposals (id, agent_id, active) VALUES ($1, $2, true)
          ON CONFLICT (id) DO NOTHING
        `, [propId, agent.id]);

        const thread = Array.isArray(d.thread) ? d.thread :
          (d.comment ? [{ role: 'matt', ts: d.updated_at || new Date().toISOString(), text: d.comment }] : []);

        await db.query(`
          INSERT INTO proposal_decisions (proposal_id, agent_id, decision, status, thread, edits, queued_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (proposal_id) DO UPDATE SET
            decision=EXCLUDED.decision, status=EXCLUDED.status, thread=EXCLUDED.thread,
            edits=EXCLUDED.edits, queued_at=EXCLUDED.queued_at, updated_at=EXCLUDED.updated_at
        `, [
          propId, agent.id, d.decision || null, d.status || null,
          JSON.stringify(thread), d.edits ? JSON.stringify(d.edits) : null,
          d.queued_at || null, d.updated_at || new Date().toISOString(),
        ]);
        counters.decisions++;

        // Write to decision_history too
        for (const msg of thread) {
          await db.query(`
            INSERT INTO decision_history (proposal_id, agent_id, action, actor, payload, ts)
            VALUES ($1, $2, 'thread_message', $3, $4, $5)
            ON CONFLICT DO NOTHING
          `, [propId, agent.id, msg.role || 'matt', JSON.stringify({ text: msg.text }), msg.ts || new Date().toISOString()]);
          counters.history++;
        }
      } catch (err) {
        console.error(`  [decision] ${propId}: ${err.message}`);
      }
    }
  }
}

async function backfillRuns() {
  console.log('\n→ Runs');
  const runsFile = path.join(DATA_DIR, 'runs.json');
  const runs = readJson(runsFile);
  if (!runs || !Array.isArray(runs)) { console.log('  (no runs.json)'); return; }

  for (const r of runs) {
    if (!r.id) continue;
    try {
      await db.query(`
        INSERT INTO runs (id, agent_id, agent_name, skill, started_at, completed_at, status, duration_s, actions, summary, notion_url, errors)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO NOTHING
      `, [
        r.id, r.agent_id || '', r.agent_name || '', r.skill || '',
        r.started_at || null, r.completed_at || null, r.status || 'success',
        r.duration_s || null, r.actions ? JSON.stringify(r.actions) : null,
        r.summary || null, r.notion_url || null,
        r.errors ? JSON.stringify(r.errors) : '[]',
      ]);
      counters.runs++;
    } catch (err) {
      console.error(`  [run] ${r.id}: ${err.message}`);
    }
  }
}

async function backfillArchives() {
  console.log('\n→ Archives (executions)');
  for (const agent of AGENTS) {
    const archDir = path.join(AGENT_BASE, agent.dir, 'proposals_archive');
    if (!fs.existsSync(archDir)) continue;
    const files = fs.readdirSync(archDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const arch = readJson(path.join(archDir, file));
      if (!arch || !arch.run_id) continue;
      try {
        await db.query(`
          INSERT INTO executions (run_id, agent_id, started_at, completed_at, status, approved, results)
          VALUES ($1,$2,$3,$3,$4,$5,$6)
          ON CONFLICT (run_id) DO NOTHING
        `, [
          arch.run_id, agent.id, arch.executed_at || new Date().toISOString(),
          'completed',
          arch.approved ? JSON.stringify(arch.approved) : null,
          arch.results ? JSON.stringify(arch.results) : '[]',
        ]);
        counters.archives++;

        // Also backfill archived proposals that may not be in active proposals.json
        if (arch.original?.proposals) {
          for (const p of arch.original.proposals) {
            if (!p.id) continue;
            await db.query(`
              INSERT INTO proposals (id, agent_id, generated_at, title, rationale, action_type, preview, execute_instructions, active)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
              ON CONFLICT (id) DO NOTHING
            `, [
              p.id, agent.id, arch.original.generated_at || arch.executed_at,
              p.title || null, p.rationale || null, p.action_type || null,
              p.preview ? JSON.stringify(p.preview) : null,
              p.execute_instructions || null,
            ]);
          }
        }

        // Backfill archived decisions into decision_history
        if (arch.decisions) {
          for (const [propId, d] of Object.entries(arch.decisions)) {
            const action = d.decision === 'yes' ? 'approve' : d.decision === 'no' ? 'reject' : 'comment';
            await db.query(`
              INSERT INTO decision_history (proposal_id, agent_id, action, actor, payload, ts)
              VALUES ($1,$2,$3,'matt',$4,$5)
              ON CONFLICT DO NOTHING
            `, [propId, agent.id, action, JSON.stringify(d), d.updated_at || arch.executed_at]);
          }
        }
      } catch (err) {
        console.error(`  [archive] ${file}: ${err.message}`);
      }
    }
  }
}

async function main() {
  console.log('Mission Control backfill → Postgres');
  await backfillProposals();
  await backfillRuns();
  await backfillArchives();

  console.log('\nResults:');
  for (const [k, v] of Object.entries(counters)) {
    console.log(`  ${k.padEnd(15)} ${v}`);
  }
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
