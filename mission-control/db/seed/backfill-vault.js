#!/usr/bin/env node
// Enriches Postgres companies and contacts with data from vault deal.md + profile.md.
// Only fills NULL fields — never overwrites existing Postgres data.
//
// Usage:
//   node db/seed/backfill-vault.js              apply
//   node db/seed/backfill-vault.js --dry-run    show what would change
//   node db/seed/backfill-vault.js --only=origin-investments,larc-analytics

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const db = require('../../lib/db');

const VAULT = path.resolve(__dirname, '..', '..', '..', 'contacts');
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  return arg ? arg.split('=')[1].split(',') : null;
})();

const counters = { companies_enriched: 0, contacts_added: 0, skipped: 0, errors: 0 };

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return yaml.parse(match[1]);
  } catch {
    return null;
  }
}

function parseContacts(content) {
  const contacts = [];
  const contactSection = content.match(/## Contacts\n([\s\S]*?)(?=\n## |$)/);
  if (!contactSection) return contacts;

  const text = contactSection[1];
  // Split by ### headers (each is a contact)
  const parts = text.split(/### /).filter(Boolean);

  for (const part of parts) {
    const lines = part.trim().split('\n');
    const name = lines[0]?.trim();
    if (!name) continue;

    const contact = { name };
    for (const line of lines.slice(1)) {
      const roleMatch = line.match(/\*\*Role\*\*[:\s]*(.+)/);
      if (roleMatch) contact.title = roleMatch[1].trim();

      const emailMatch = line.match(/\*\*Email\*\*[:\s]*(\S+@\S+)/);
      if (emailMatch) contact.email = emailMatch[1].trim();

      const phoneMatch = line.match(/\*\*Phone\*\*[:\s]*(.+)/);
      if (phoneMatch) contact.phone = phoneMatch[1].trim();
    }
    contacts.push(contact);
  }

  return contacts;
}

function parseNumber(v) {
  if (v == null || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log(`Vault enrichment${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const slugs = fs.readdirSync(VAULT).filter(f => {
    if (ONLY && !ONLY.includes(f)) return false;
    return fs.statSync(path.join(VAULT, f)).isDirectory();
  });

  console.log(`  ${slugs.length} company folders\n`);

  for (const slug of slugs) {
    const dir = path.join(VAULT, slug);

    // --- Enrich company from deal.md ---
    const dealPath = path.join(dir, 'deal.md');
    if (fs.existsSync(dealPath)) {
      const fm = parseFrontmatter(fs.readFileSync(dealPath, 'utf8'));
      if (fm) {
        // Get current DB row
        const { rows: [dbRow] } = await db.query(
          'SELECT * FROM companies WHERE slug = $1 OR vault_slug = $1', [slug]
        );

        if (dbRow) {
          // Build SET clause for only NULL fields in DB that have values in vault
          const updates = {};
          const fieldMap = {
            deal_value: parseNumber(fm.deal_value),
            billing_cadence: fm.annual_or_monthly || null,
            decision_maker: fm.decision_maker || null,
            champion: fm.champion || null,
            next_action: fm.next_action || null,
            next_action_due: fm.next_action_due || null,
            last_contact: fm.last_contact || null,
            field: fm.field || null,
            licenses: parseNumber(fm.licenses),
            avg_license_cost: parseNumber(fm.avg_license_cost),
            action_status: fm.action_status || null,
            health_score: parseNumber(fm.health_score),
            health_tier: fm.health_tier || null,
            onboarding_status: fm.onboarding_status || null,
            primary_workflow: fm.primary_workflow || null,
            mrr: parseNumber(fm.mrr),
            project_type: fm.project_type || null,
            implementation_total: parseNumber(fm.implementation_total),
            implementation_invoiced: parseNumber(fm.implementation_invoiced),
            sample_files_status: fm.sample_files_status || null,
            blocked_on: fm.blocked_on || null,
          };

          for (const [col, val] of Object.entries(fieldMap)) {
            if (val != null && val !== '' && val !== 'NA' && (dbRow[col] == null || dbRow[col] === '')) {
              updates[col] = val;
            }
          }

          if (Object.keys(updates).length > 0) {
            const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
            const sql = `UPDATE companies SET ${setClauses.join(', ')}, updated_at = now() WHERE company_id = $1`;
            const vals = [dbRow.company_id, ...Object.values(updates)];

            if (DRY_RUN) {
              console.log(`  [${slug}] would update: ${JSON.stringify(updates)}`);
            } else {
              await db.query(sql, vals);
              console.log(`  [${slug}] enriched: ${Object.keys(updates).join(', ')}`);
            }
            counters.companies_enriched++;
          }
        }
      }
    }

    // --- Add missing contacts from profile.md ---
    const profilePath = path.join(dir, 'profile.md');
    if (fs.existsSync(profilePath)) {
      const profileContent = fs.readFileSync(profilePath, 'utf8');
      const vaultContacts = parseContacts(profileContent);

      if (vaultContacts.length > 0) {
        const { rows: [company] } = await db.query(
          'SELECT company_id FROM companies WHERE slug = $1 OR vault_slug = $1', [slug]
        );
        if (!company) continue;

        // Get existing contacts for this company
        const { rows: existing } = await db.query(
          'SELECT lower(name) as lname, email FROM contacts WHERE company_id = $1',
          [company.company_id]
        );
        const existingNames = new Set(existing.map(r => r.lname));
        const existingEmails = new Set(existing.filter(r => r.email).map(r => r.email.toLowerCase()));

        for (const vc of vaultContacts) {
          const nameExists = existingNames.has(vc.name.toLowerCase());
          const emailExists = vc.email && existingEmails.has(vc.email.toLowerCase());

          if (nameExists || emailExists) {
            // Contact exists — check if we can fill missing email
            if (!emailExists && vc.email && nameExists) {
              const { rows: [match] } = await db.query(
                'SELECT contact_id, email FROM contacts WHERE company_id = $1 AND lower(name) = lower($2)',
                [company.company_id, vc.name]
              );
              if (match && !match.email) {
                if (!DRY_RUN) {
                  await db.query('UPDATE contacts SET email = $1 WHERE contact_id = $2', [vc.email, match.contact_id]);
                }
                console.log(`  [${slug}] filled email for ${vc.name}: ${vc.email}`);
              }
            }
            continue;
          }

          // New contact — insert
          if (!DRY_RUN) {
            await db.query(`
              INSERT INTO contacts (company_id, name, email, title, phone, source)
              VALUES ($1, $2, $3, $4, $5, 'vault')
              ON CONFLICT DO NOTHING
            `, [company.company_id, vc.name, vc.email || null, vc.title || null, vc.phone || null]);
          }
          console.log(`  [${slug}] added contact: ${vc.name}${vc.email ? ' (' + vc.email + ')' : ''}`);
          counters.contacts_added++;
        }
      }
    }
  }

  console.log(`\nResults: companies_enriched=${counters.companies_enriched} contacts_added=${counters.contacts_added} skipped=${counters.skipped} errors=${counters.errors}`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch {}
  process.exit(1);
});
