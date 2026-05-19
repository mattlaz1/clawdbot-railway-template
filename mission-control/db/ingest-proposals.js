#!/usr/bin/env node
// DEPRECATED 2026-04-16.
//
// This script used to read agent/{id}/proposals.json from disk and upsert
// into Postgres at the end of each cron run. The vault has since moved to
// Postgres as the single source of truth — skills now INSERT directly into
// the `proposals` table (see .claude/rules/postgres-rules.md § Writing proposals),
// and the disk JSON files have been removed.
//
// The file is left here as a no-op so any stale cron or runbook that still
// calls it gets a clear message instead of silently succeeding on missing input.

console.error('[ingest-proposals] DEPRECATED: proposals are written directly to Postgres.');
console.error('[ingest-proposals] See .claude/rules/postgres-rules.md § Writing proposals.');
console.error('[ingest-proposals] No action taken. Update your skill/runbook to skip this call.');
process.exit(0);
