-- decision_history: append-only audit log of every action Matt takes on proposals
CREATE TABLE IF NOT EXISTS decision_history (
  id           bigserial PRIMARY KEY,
  proposal_id  text NOT NULL,
  agent_id     text NOT NULL,
  action       text NOT NULL,   -- 'comment' | 'approve' | 'reject' | 'queue' | 'edit' | 'move' | 'delete' | 'thread_message'
  actor        text NOT NULL DEFAULT 'matt',
  payload      jsonb,           -- action-specific data
  ts           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dh_proposal ON decision_history(proposal_id);
CREATE INDEX IF NOT EXISTS idx_dh_ts ON decision_history(ts DESC);
