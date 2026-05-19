#!/usr/bin/env node
// Nightly pg_dump wrapper. Writes a gzipped custom-format dump to backups/.
// Designed to be called from Windows Task Scheduler:
//   node "c:\...\mission-control\db\backup.js"
//
// Keeps the last 14 dumps and deletes older ones.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP = 14;
const PG_DUMP = process.env.PG_DUMP || 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(BACKUP_DIR, `skysuite-${ts}.dump`);

console.log(`Backing up to ${outFile}...`);
const result = spawnSync(
  PG_DUMP,
  ['-Fc', '--no-owner', '--no-acl', '-f', outFile, process.env.DATABASE_URL],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  console.error('pg_dump failed');
  process.exit(result.status || 1);
}

const stats = fs.statSync(outFile);
console.log(`OK (${(stats.size / 1024).toFixed(1)} KB)`);

// Prune old dumps
const dumps = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => f.startsWith('skysuite-') && f.endsWith('.dump'))
  .sort();
const stale = dumps.slice(0, Math.max(0, dumps.length - KEEP));
for (const f of stale) {
  fs.unlinkSync(path.join(BACKUP_DIR, f));
  console.log(`pruned ${f}`);
}
