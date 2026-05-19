// /api/webhooks/* routes — inbound webhooks from external services
const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { matchCompany, inferType } = require('../lib/match-company');

const router = express.Router();

const FATHOM_WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET || '';

// ── Fathom webhook signature verification ──────────────────────────────────
function verifyFathomSignature(req) {
  if (!FATHOM_WEBHOOK_SECRET) return true; // skip if not configured
  const msgId = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signature = req.headers['webhook-signature'];
  if (!msgId || !timestamp || !signature) return false;

  const toSign = `${msgId}.${timestamp}.${JSON.stringify(req.body)}`;
  const secret = Buffer.from(FATHOM_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
  const expected = crypto.createHmac('sha256', secret).update(toSign).digest('base64');

  // signature header can have multiple sigs separated by space: "v1,<sig1> v1,<sig2>"
  return signature.split(' ').some(s => {
    const parts = s.split(',');
    return parts.length === 2 && parts[1] === expected;
  });
}

// ── POST /api/webhooks/fathom ──────────────────────────────────────────────
router.post('/fathom', async (req, res) => {
  // Verify signature
  if (!verifyFathomSignature(req)) {
    console.warn('[webhook/fathom] signature verification failed');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const m = req.body;
  if (!m || !m.recording_id) {
    return res.status(400).json({ error: 'missing recording data' });
  }

  try {
    // Dedup by fathom_id (recording_id)
    const fathomId = String(m.recording_id);
    const { rows: existing } = await db.query(
      `SELECT meeting_id FROM meetings WHERE fathom_id = $1`,
      [fathomId]
    );
    if (existing.length) {
      // Update existing record with new data (transcript/summary may arrive later).
      // Note: do NOT overwrite status on update — preserve human-curated type.
      await db.query(`
        UPDATE meetings SET
          title = COALESCE($2, title),
          summary = COALESCE($3, summary),
          transcript = COALESCE($4, transcript),
          recording_url = COALESCE($5, recording_url),
          share_url = COALESCE($6, share_url),
          synced_at = now()
        WHERE fathom_id = $1
      `, [
        fathomId,
        m.title || m.meeting_title,
        m.default_summary,
        m.transcript,
        m.recording_url || null,
        m.share_url || m.url || null,
      ]);
      console.log(`[webhook/fathom] updated meeting ${fathomId}: ${m.title}`);
      return res.json({ status: 'updated', fathom_id: fathomId });
    }

    // Calculate duration from recording times
    let durationMinutes = null;
    if (m.recording_start_time && m.recording_end_time) {
      const start = new Date(m.recording_start_time);
      const end = new Date(m.recording_end_time);
      durationMinutes = Math.round((end - start) / 60000);
    }

    // Extract attendee names from calendar_invitees
    let attendees = null;
    if (m.calendar_invitees && m.calendar_invitees.length) {
      attendees = m.calendar_invitees.map(i => i.name || i.email);
    }

    // Auto-match company — title regex → attendee email → email domain → AI
    const title = m.title || m.meeting_title;
    const { company_id: companyId, method } = await matchCompany({
      title,
      attendees,
      calendar_invitees: m.calendar_invitees,
      transcript: m.transcript,
      summary: m.default_summary,
    });

    // Infer meeting type from title (Internal/Demo/Discovery/Proposal/etc.)
    const meetingType = inferType(title) || 'NA';

    const { rows } = await db.query(`
      INSERT INTO meetings (
        company_id, title, meeting_date, duration_minutes,
        recording_url, share_url, summary, transcript, attendees,
        status, source, fathom_id, synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      RETURNING meeting_id
    `, [
      companyId,
      title,
      m.recording_start_time || m.scheduled_start_time || m.created_at,
      durationMinutes,
      m.recording_url || null,
      m.share_url || m.url || null,
      m.default_summary,
      m.transcript,
      attendees,
      meetingType,
      'fathom',
      fathomId,
    ]);

    console.log(`[webhook/fathom] created meeting ${rows[0].meeting_id}: ${title} (company: ${companyId || 'unmatched'} via ${method}, type: ${meetingType})`);
    res.status(201).json({ status: 'created', meeting_id: rows[0].meeting_id, company_matched: !!companyId, match_method: method });
  } catch (err) {
    console.error('[webhook/fathom] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
