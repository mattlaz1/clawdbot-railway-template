-- proposal_decisions: latest decision state per proposal (1:1 with proposals)
CREATE TABLE IF NOT EXISTS proposal_decisions (
  proposal_id   text PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  agent_id      text NOT NULL,
  decision      text,                -- 'yes' | 'no' | null
  status        text,                -- null | 'needs_refinement' | 'approved' | 'queued' | 'rejected'
  thread        jsonb DEFAULT '[]',  -- array of {role, ts, text}
  edits         jsonb,               -- {body, subject, to, ...} Matt's inline edits
  queued_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pd_agent_status ON proposal_decisions(agent_id, status);
