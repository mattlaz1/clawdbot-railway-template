-- Canonical stage enum — replaces messy Notion<->vault mapping.
DO $$ BEGIN
  CREATE TYPE stage_enum AS ENUM (
    'target',
    'prospect',
    'discovery',
    'demo',
    'proposal',
    'negotiation',
    'on-hold-warm',
    'closed-won',
    'closed-lost'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
