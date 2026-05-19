-- tasks: replaces Notion Tasks DB
CREATE TABLE IF NOT EXISTS tasks (
  task_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  company_id   uuid REFERENCES companies(company_id) ON DELETE SET NULL,
  contact_id   uuid REFERENCES contacts(contact_id) ON DELETE SET NULL,
  agent        text,
  action_type  text,
  status       text NOT NULL DEFAULT 'Not started',
  due_date     date,
  notes        text,
  notion_id    text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent, status);
