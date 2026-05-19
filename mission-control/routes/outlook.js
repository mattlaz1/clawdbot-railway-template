// /api/outlook/* routes — fetch Outlook emails for a company by contact emails/domain.
const express = require('express');
const db = require('../lib/db');
const { callGraph } = require('../lib/outlook');

const router = express.Router();

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// GET /api/outlook/emails/:companyId
// Looks up all contact emails for the company, then searches Graph for conversations.
router.get('/emails/:companyId', async (req, res) => {
  try {
    const id = req.params.companyId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    // Get company + contacts
    const { rows: co } = await db.query(
      isUuid
        ? 'SELECT company_id, name, slug FROM companies WHERE company_id = $1'
        : 'SELECT company_id, name, slug FROM companies WHERE slug = $1',
      [id]
    );
    if (!co.length) return res.status(404).json({ error: 'company not found' });

    const { rows: contacts } = await db.query(
      'SELECT email FROM contacts WHERE company_id = $1 AND email IS NOT NULL',
      [co[0].company_id]
    );

    const emails = contacts.map(c => c.email.toLowerCase()).filter(Boolean);
    if (!emails.length) {
      return res.json({ emails: [], query: null, note: 'No contact emails on file.' });
    }

    // Search by each contact email using Graph's from:/to: KQL keywords.
    // Build: (from:addr1 OR to:addr1 OR from:addr2 OR to:addr2 ...)
    const searchParts = emails.flatMap(e => [`from:${e}`, `to:${e}`]);
    const query = searchParts.join(' OR ');
    const count = parseInt(req.query.count, 10) || 25;

    const endpoint = `/me/messages?$search="${encodeURIComponent(query)}"&$top=${count}&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments`;
    const result = await callGraph(endpoint);

    const messages = (result.value || []).map(msg => ({
      id: msg.id,
      subject: msg.subject || '(no subject)',
      from: msg.from?.emailAddress ? {
        name: msg.from.emailAddress.name,
        address: msg.from.emailAddress.address,
      } : null,
      to: (msg.toRecipients || []).map(r => ({
        name: r.emailAddress.name,
        address: r.emailAddress.address,
      })),
      cc: (msg.ccRecipients || []).map(r => ({
        name: r.emailAddress.name,
        address: r.emailAddress.address,
      })),
      date: msg.receivedDateTime,
      preview: msg.bodyPreview || '',
      conversationId: msg.conversationId,
      isRead: msg.isRead,
      hasAttachments: msg.hasAttachments,
    }));

    res.json({ emails: messages, query, contactEmails: emails });
  } catch (err) {
    console.error('[outlook] email fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/outlook/read/:emailId — read full email body
router.get('/read/:emailId', async (req, res) => {
  try {
    const msg = await callGraph(`/me/messages/${req.params.emailId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead`);
    res.json({
      id: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress ? {
        name: msg.from.emailAddress.name,
        address: msg.from.emailAddress.address,
      } : null,
      to: (msg.toRecipients || []).map(r => ({
        name: r.emailAddress.name,
        address: r.emailAddress.address,
      })),
      cc: (msg.ccRecipients || []).map(r => ({
        name: r.emailAddress.name,
        address: r.emailAddress.address,
      })),
      date: msg.receivedDateTime,
      body: stripHtml(msg.body?.content),
      bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : null,
      isRead: msg.isRead,
    });
  } catch (err) {
    console.error('[outlook] read email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
