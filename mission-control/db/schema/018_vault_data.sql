-- Add columns and tables for vault data that has no Postgres home yet.

-- 1. Company notes (deal.md body content: deal notes, objections, deliverables)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_overview text;

-- 2. Meeting notes table — detailed call notes from vault meetings/ folders.
--    These are separate from the meetings table (which tracks Fathom recordings).
--    One vault meeting note may correspond to a meetings row, linked by date + company.
CREATE TABLE IF NOT EXISTS meeting_notes (
  note_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  meeting_id     uuid REFERENCES meetings(meeting_id) ON DELETE SET NULL,
  title          text,
  meeting_date   date NOT NULL,
  body           text NOT NULL,
  source_file    text,          -- original vault path for audit trail
  word_count     int,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_company ON meeting_notes(company_id, meeting_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_notes_dedup
  ON meeting_notes(company_id, meeting_date, md5(coalesce(title,'')));

-- 3. Email drafts
CREATE TABLE IF NOT EXISTS email_drafts (
  draft_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  title          text,
  draft_date     date,
  recipient      text,
  subject        text,
  status         text,          -- 'Drafted', 'Sent', 'Approved'
  body           text NOT NULL,
  source_file    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_company ON email_drafts(company_id, draft_date DESC);

-- 4. Company files (images, attachments from vault)
CREATE TABLE IF NOT EXISTS company_files (
  file_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  filename       text NOT NULL,
  file_type      text,          -- 'image/png', 'application/pdf', etc.
  file_data      bytea,         -- binary content
  source_path    text,          -- original vault path
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_files_company ON company_files(company_id);
