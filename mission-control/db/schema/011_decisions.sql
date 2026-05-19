-- decisions: audit log of Matt's corrections on mission-control proposals.
-- Phase 1 creates the table; Phase 2 wires writes from /api/.../proposals/:id/decision.
CREATE TABLE IF NOT EXISTS decisions (
  decision_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text,
  proposal_id  text,
  company_id   uuid REFERENCES companies(company_id) ON DELETE SET NULL,
  decision     text,
  status       text,
  comment      text,
  edits_json   jsonb,
  thread_json  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_agent_created ON decisions(agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_proposal ON decisions(proposal_id);
