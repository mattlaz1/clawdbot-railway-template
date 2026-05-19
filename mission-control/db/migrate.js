#!/usr/bin/env node
// Tiny migration runner. Applies every .sql file in db/schema/ in lexicographic
// order and records each in a `schema_migrations` table so it's idempotent.
//
// Usage:
//   node db/migrate.js         apply pending migrations
//   node db/migrate.js --list  show applied + pending without running anything

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const SCHEMA_DIR = path.join(__dirname, 'schema');

async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied() {
  const { rows } = await db.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(rows.map(r => r.filename));
}

function listFiles() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function main() {
  const listOnly = process.argv.includes('--list');

  await ensureMigrationsTable();
  const applied = await getApplied();
  const files = listFiles();
  const pending = files.filter(f => !applied.has(f));

  if (listOnly) {
    console.log('Applied:');
    for (const f of files.filter(f => applied.has(f))) console.log('  ✓', f);
    console.log('Pending:');
    for (const f of pending) console.log('  •', f);
    await db.end();
    return;
  }

  if (!pending.length) {
    console.log('No pending migrations.');
    await db.end();
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    process.stdout.write(`Applying ${file}... `);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('✓');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('✗');
      console.error(err.message);
      client.release();
      await db.end();
      process.exit(1);
    }
    client.release();
  }

  console.log(`Applied ${pending.length} migration(s).`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
