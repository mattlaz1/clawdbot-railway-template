# Proposal Schema

Each agent writes `SkySuite/agent/{slug}/proposals.json` at the end of every scheduled run. The Mission Control dashboard reads these files and renders an approval queue. When Matt approves and clicks Execute, the dashboard spawns a fresh `claude -p` session and passes the approved proposals back to the agent for execution.

## File Path
`SkySuite/agent/{slug}/proposals.json`

Slug-to-folder mapping:
- `cro` → `agent/cro/`
- `cs` → `agent/cs/`
- `bdm-weekly` → `agent/bdm/`
- `bdm-linkedin` → `agent/bdm/proposals-linkedin.json` (shared bdm folder, separate file)
- `finance` → `agent/fin/`
- `debrief` → `agent/debrief/`

## Schema
```json
{
  "generated_at": "2026-04-07T08:27:00Z",
  "agent_id": "cro",
  "proposals": [
    {
      "id": "cro-2026-04-07-01",
      "company_slug": "lotus-capital",
      "title": "Short, scannable headline (max ~60 chars)",
      "rationale": "1-2 sentences explaining WHY Matt should do this. Reference dates, days-silent, deal stage, or specific commitments.",
      "action_type": "draft_email",
      "added_at": "2026-04-07T08:27:00Z",
      "priority": "high",
      "due_date": "2026-06-01",
      "preview": {
        "to": "jane@example.com",
        "subject": "Re: Example x SkySuite",
        "body_snippet": "First ~150 chars of the email body so Matt can sanity-check tone and content"
      },
      "execute_instructions": "Precise instructions for a future Claude Code session to do the work without asking questions. Include thread context, MCP to use, voice rules, timezone, etc."
    }
  ]
}
```

## Field Rules

### `id`
Format: `{agent_id}-{YYYY-MM-DD}-{NN}`. Must be unique within the file.

### `added_at`
Optional ISO timestamp marking when this specific proposal was first generated. If omitted, the dashboard falls back to the file's `generated_at`. Useful when a recurring run carries forward unchanged proposals from previous days — set `added_at` to the *original* day so the UI can show staleness correctly.

### `priority`
**Required.** One of: `urgent`, `high`, `normal`, `low`. Defaults to `normal` if omitted.

- **`urgent`** — must happen today. Overdue follow-ups, time-sensitive responses, expiring commitments.
- **`high`** — should happen by next business day. Active deal momentum, warm replies, promised deliverables.
- **`normal`** — this week. Standard pipeline actions, routine check-ins, scheduled outreach.
- **`low`** — next week or whenever. Nice-to-have research, low-priority updates, long-horizon items.

The dashboard renders a colored dot next to urgent (red), high (amber), and omits the dot for normal/low. Proposals sort by priority first, then by due_date ascending.

### `due_date`
**Effectively required.** ISO date string (`YYYY-MM-DD`, no time component). Every proposal should get a due date based on its priority:

- **`urgent`** → today's date
- **`high`** → next business day
- **`normal`** → end of current week (Friday)
- **`low`** → end of next week

Only omit `due_date` for snoozed/parked items with no specific deadline.

Also used to park a proposal for future action.

- **Who sets it**: either a cron (when Matt's prior guidance says "check back in N weeks/months") or Matt himself via the inline date picker on a Kanban card.
- **Behavior in the dashboard**: when `due_date > today`, the card appears in the **Scheduled** column instead of To do / Pending. When `due_date <= today`, the card auto-surfaces into To do (or Pending if it has thread activity) — no cron run required.
- **Behavior in crons**: every agent's Step 0 reads the current `proposals.json` and indexes future-dated proposals by contact/slug. Before generating a new proposal for any slug, the cron checks this index and skips if there's already a future-dated commitment. This is how crons avoid re-suggesting work that Matt has already parked for later.
- **Carry-forward**: crons must carry forward future-dated proposals unchanged across runs (same `id`, same `due_date`, same thread) until the date arrives or Matt clears it.
- **Clearing**: Matt can clear the field by dragging the card out of Scheduled (the `/move` endpoint strips `due_date` automatically) or by clicking the date chip and cancelling. Completed / executed cards preserve their last `due_date` for the historical record but show it as locked.
- **Archive**: `due_date` flows through to `proposals_archive/{date}-{runid}.json` verbatim — no stripping.

### `title`
Action-oriented, scannable. "Follow up with Lotus on stale proposal" not "Lotus update."

### `rationale`
Must include the *evidence* — days silent, deal value, last touch date, promise made on a call, etc. No fluff.

### `action_type`
Open vocabulary. Common values:
- `draft_email` — create an Outlook draft (in-thread reply or new thread)
- `notion_task` — create a task in the Notion Tasks DB
- `notion_update` — update fields on an existing Notion page (stage, status, notes)
- `linkedin_reply` — send a LinkedIn message draft for review
- `linkedin_invite` — send a LinkedIn connection request
- `qb_invoice` — draft a QuickBooks invoice
- `calendar_event` — create a Zoom + calendar event (always Zoom, never Teams)
- `research` — gather info from a source (web, Notion, Outlook search)

### `preview`
Free-form object whose shape depends on `action_type`. Goal: Matt can scan the card and decide Yes/No without opening anything.

### `execute_instructions`
The most important field. When Matt clicks Execute, the dashboard hands this string back to a fresh `claude -p` session. It must be self-contained: assume the executing Claude has no memory of why this proposal exists.

Bad: `"Send the email to Jane"`
Good: `"Draft an in-thread reply to the most recent thread with jane@lotus.com (last sent 2026-02-23, subject 'Lotus x SkySuite Proposal'). 4 sentences max. Reference the proposal sent 43 days ago, ask if there are blockers, offer a 15-min call this week. Use Matt's voice per .claude/rules/email-rules.md. Always create_reply_draft, never create_draft."`

## Execute Flow
1. Dashboard reads `proposals.json` + `decisions.json`
2. User toggles each proposal to `yes` / `no` and optionally adds a comment
3. User clicks "Execute" → dashboard POSTs to `/api/agents/{id}/execute`
4. Server filters to `decision: "yes"`, builds an execute prompt, and spawns:
   ```
   claude -p "<prompt>" --dangerously-skip-permissions
   ```
5. Execute prompt template:
   ```
   You are the {agent_name} agent. Matt has reviewed your proposals and approved the following actions. Execute each one in order using your MCPs. When done, append a summary line for each to results.json.

   Approved actions:
   <inline JSON of approved proposals with comments>

   For each action:
   - Read execute_instructions exactly
   - If a comment is present, treat it as a modification or additional constraint
   - Use the MCPs and rules you already know from .claude/rules/
   - Do not ask Matt questions — proceed with best judgment
   ```
6. Server archives the original `proposals.json` to `proposals_archive/{YYYY-MM-DD}.json` and clears `decisions.json`

## Notes
- An agent should write 0 proposals when there's nothing to do (empty `proposals` array, not a missing file)
- Stale proposals (>24h old) are flagged in the UI but not deleted
- Comments from Matt should be preserved in the archive so we can review later what was changed
