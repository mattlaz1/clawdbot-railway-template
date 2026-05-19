# SkySuite Postgres — Phase 1

Local Postgres 16 database that mirrors Notion. Phase 1 is **read-only** — agents and workflows are NOT pointed at it yet. This is just the schema, the backfill, and a read-only browser tab in mission-control.

## What's here

```
db/
├── schema/             11 numbered SQL migrations (extensions → enums → tables → views)
├── seed/
│   ├── dump-notion.js  Pulls all 8 Notion DBs to JSON via the Notion REST API
│   ├── backfill.js     Reads JSON dumps and upserts to Postgres (idempotent on notion_id)
│   └── notion-dump/    .gitignored — JSON snapshots from the last dump
├── migrate.js          Runs pending .sql files in order; tracks in schema_migrations table
├── backup.js           Nightly pg_dump wrapper for Windows Task Scheduler
└── README.md           This file
```

Plus, in the parent directory:

- `lib/db.js` — shared `pg.Pool` singleton, used by everything
- `routes/db.js` — read-only `/api/db/*` Express routes mounted by `server.js`
- `.env` — `DATABASE_URL` and `NOTION_TOKEN` (gitignored)

## Setup (first time)

Postgres is already installed via Chocolatey (`postgresql16` package). The service runs as `postgresql-x64-16`. The `skysuite` user and `skysuite` database are created.

```bash
# Verify
psql -h localhost -U skysuite -d skysuite -c "SELECT 1;"
```

If the password ever needs resetting, both the superuser and `skysuite` use `skysuite_local_dev`.

## Run migrations

```bash
cd mission-control
node db/migrate.js          # apply pending
node db/migrate.js --list   # show applied + pending
```

Migrations are idempotent and tracked in the `schema_migrations` table. To add a new migration, drop a numbered file in `db/schema/` and re-run.

## Backfill from Notion

Two-step process: dump → import.

```bash
# 1. Pull every Notion DB to JSON (overwrites previous dumps)
node db/seed/dump-notion.js
node db/seed/dump-notion.js --only=companies,tasks   # subset

# 2. Import the dumps into Postgres
node db/seed/backfill.js --dry-run   # parse-only, no writes
node db/seed/backfill.js             # for real
node db/seed/backfill.js --only=companies,contacts
```

The backfill is idempotent: every row keys on `notion_id` so re-running updates instead of duplicating. Safe to run as often as you want.

The Notion token in `.env` (`NOTION_TOKEN`) needs access to all 8 source DBs. If new DBs get added in Notion, share them with the same internal integration.

## Read it from mission-control

The Database tab at `http://localhost:3700/#/db` browses everything live.

API endpoints (all read-only):

- `GET /api/db/stats`
- `GET /api/db/companies?stage=...&risk=...&q=...&limit=200`
- `GET /api/db/companies/:id_or_slug` — joined detail (contacts + tasks + meetings)
- `GET /api/db/contacts?company=slug&q=...`
- `GET /api/db/tasks?status=...&agent=...&company=slug`
- `GET /api/db/meetings?company=slug`
- `GET /api/db/content/linkedin?lane=...&status=...`
- `GET /api/db/content/newsletters`
- `GET /api/db/content/intel?lane=...`
- `GET /api/db/reports?agent=...&date=...&q=full-text`
- `GET /api/db/reports/:id`

## Stage enum (canonical)

The Notion → Postgres migration normalizes 9 messy Notion status names down to:

`target` · `prospect` · `discovery` · `demo` · `proposal` · `negotiation` · `on-hold-warm` · `closed-won` · `closed-lost`

Mapping is in `db/seed/backfill.js` `mapStage()`.

## `companies_view`

`days_since_contact` and `risk` are computed via a view, not stored columns
(Postgres won't allow `CURRENT_DATE` in a STORED generated column). Always read
from `companies_view` when you need those fields. Writes still go to `companies`.

## Backups

```bash
node db/backup.js          # one-off
```

To schedule nightly via Task Scheduler:

```
schtasks /create /sc daily /st 02:30 /tn "SkySuite DB Backup" ^
  /tr "node \"c:\path\to\mission-control\db\backup.js\""
```

Backups land in `mission-control/backups/` (gitignored). Last 14 are kept.

## When you eventually move to Supabase (Phase 3)

The schema avoids everything Supabase doesn't support (no pg_cron, no superuser
extensions, no LISTEN/NOTIFY, no Windows-specific paths). To migrate:

```bash
pg_dump --clean --if-exists -Fc skysuite > skysuite.dump
# create Supabase project, copy connection string
pg_restore -d "postgresql://postgres:..." skysuite.dump
# update DATABASE_URL in .env
# restart mission-control
```

That's it. ~30 minutes, zero code changes.

## What's NOT in Phase 1

- No writes to Postgres from agents or daily-sync — Notion is still source of truth
- No `proposals` or `decisions` table population — those come in Phase 2
- No vault sync (deal.md frontmatter still exists; Postgres mirrors it but doesn't replace it yet)
- No cutover. Everything in `agent/`, `cron/`, and `.claude/commands/` still talks to Notion via MCP.

Phase 2 will rewire workflows to read/write Postgres and shut down the daily Notion sync.
