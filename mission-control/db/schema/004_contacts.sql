-- contacts: replaces Notion Contacts DB. People, linked to companies.
CREATE TABLE IF NOT EXISTS contacts (
  contact_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name           text NOT NULL,
  email          text,
  title          text,
  phone          text,
  role           text,
  source         text,
  tags           text[],
  notes          text,
  last_contacted date,
  notion_id      text UNIQUE,
  linkedin_url   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm ON contacts USING gin (name gin_trgm_ops);
