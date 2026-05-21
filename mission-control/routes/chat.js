// Chat endpoint for the always-on agent brains.
//
// Each agent has one persistent OpenClaw session at `agent:<id>:main`.
// Matt's typed messages flow through here, the agent's reply streams back
// via SSE, and the durable transcript lives in the chat_messages table so
// nothing is lost when OpenClaw restarts and so Phase 2 cron triggers can
// write into the same brain history.
//
// Architecture: A single module-level "sink" subscribes to the OpenClaw
// client at boot. Every assistant reply is persisted to Postgres the moment
// it arrives, regardless of whether a browser SSE consumer is connected.
// The sink re-emits replies on `replyBus`, which the SSE handlers tap to
// forward live events to the browser. This means closing the tab during a
// reply doesn't lose the message — it's already in the DB by the time the
// browser reconnects.

const express = require('express');
const EventEmitter = require('node:events');
const db = require('../lib/db');
const { getClient } = require('../lib/openclaw');
const briefing = require('../lib/briefing');

const router = express.Router();

const KNOWN_AGENTS = new Set(['cro', 'cs', 'bdm', 'fin', 'analyst', 'content', 'dev']);
const BRIEFING_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STREAM_TIMEOUT_MS = 3 * 60 * 1000;    // 3 min — matches OpenClaw REQUEST_TIMEOUT_MS

function sessionKeyFor(agentId) {
  return `agent:${agentId}:main`;
}

function agentIdFromSessionKey(sessionKey) {
  // sessionKey "agent:cro:main" → "cro"
  const parts = String(sessionKey || '').split(':');
  return parts.length >= 3 && parts[0] === 'agent' ? parts[1] : null;
}

function validateAgent(req, res) {
  const id = req.params.id;
  if (!KNOWN_AGENTS.has(id)) {
    res.status(404).json({ error: `unknown agent: ${id}` });
    return null;
  }
  return id;
}

// ─── Sink: persist every assistant reply, regardless of SSE state ──────────
// Internal bus so SSE handlers can subscribe to live events. Status events
// flow through unchanged (status pills are best-effort). Replies are
// persisted here, then re-emitted as 'reply' on this bus.
const replyBus = new EventEmitter();
replyBus.setMaxListeners(50); // 7 agents × a few concurrent browser tabs

function extractReplyText(payload) {
  const msg = payload?.message || payload;
  if (!msg) return '';
  let text = '';
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part.text === 'string') text += part.text;
    }
  } else if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (typeof msg.text === 'string') {
    text = msg.text;
  }
  return text.trim();
}

function isDoneAssistantPayload(payload) {
  if (!payload) return false;
  const msg = payload.message || payload;
  const role = msg.role || payload.role;
  if (role !== 'assistant') return false;
  return (
    (payload.session && payload.session.status === 'done') ||
    payload.done === true ||
    msg.status === 'done'
  );
}

// Initialize sink once at module load. getClient() returns the singleton;
// these listeners survive reconnects (they're on the EventEmitter, not the
// underlying socket).
(function initSink() {
  const client = getClient();

  client.on('agent', (payload) => {
    if (!payload) return;
    const agentId = agentIdFromSessionKey(payload.sessionKey);
    if (!agentId || !KNOWN_AGENTS.has(agentId)) return;
    replyBus.emit('status', { agentId, runId: payload.runId, payload });
  });

  client.on('message', async (payload) => {
    if (!isDoneAssistantPayload(payload)) return;
    const agentId = agentIdFromSessionKey(payload.sessionKey);
    if (!agentId || !KNOWN_AGENTS.has(agentId)) return;
    const text = extractReplyText(payload);
    if (!text) return;
    const runId = payload.runId || payload.message?.runId || null;

    // Persist first — single source of truth. If a tab is open, the SSE
    // handler will forward this via replyBus.emit('reply', ...) below.
    try {
      await db.query(
        `INSERT INTO chat_messages (agent_id, session_key, role, text, run_id, source)
         VALUES ($1, $2, 'assistant', $3, $4, 'chat')`,
        [agentId, sessionKeyFor(agentId), text, runId]
      );
    } catch (err) {
      console.error('[chat/sink] persist assistant failed:', err.message);
    }

    replyBus.emit('reply', { agentId, runId, text });
  });
})();

/**
 * POST /api/agents/:id/chat
 * Body: { text }
 * Inserts the user message, refreshes briefing if stale, sends to OpenClaw.
 * Returns { runId, sessionKey, messageId }.
 */
router.post('/api/agents/:id/chat', async (req, res) => {
  const agentId = validateAgent(req, res);
  if (!agentId) return;
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const sessionKey = sessionKeyFor(agentId);
  const client = getClient();

  try {
    // 1. Insert the user message immediately (no run_id yet — we'll patch it).
    const userInsert = await db.query(
      `INSERT INTO chat_messages (agent_id, session_key, role, text, source)
       VALUES ($1, $2, 'user', $3, 'chat')
       RETURNING id`,
      [agentId, sessionKey, text]
    );
    const userMessageId = userInsert.rows[0].id;

    // 2. Refresh briefing if missing or stale.
    const lastInjectRes = await db.query(
      `SELECT MAX(created_at) AS last
         FROM chat_messages
        WHERE agent_id = $1 AND source = 'inject'`,
      [agentId]
    );
    const last = lastInjectRes.rows[0]?.last;
    const stale = !last || (Date.now() - new Date(last).getTime()) > BRIEFING_TTL_MS;
    if (stale) {
      try {
        const briefingText = await briefing.buildAndInject(agentId, sessionKey);
        await db.query(
          `INSERT INTO chat_messages (agent_id, session_key, role, text, source)
           VALUES ($1, $2, 'system', $3, 'inject')`,
          [agentId, sessionKey, briefingText]
        );
      } catch (err) {
        // Don't fail the whole send if briefing inject fails — the agent
        // can still answer from its persona + recent history.
        console.error('[chat] briefing inject failed:', err.message);
      }
    }

    // 3. Send to OpenClaw, capture runId, patch the user row.
    const sendRes = await client.send(sessionKey, text);
    const runId = sendRes?.runId;
    if (runId) {
      await db.query(
        `UPDATE chat_messages SET run_id = $1 WHERE id = $2`,
        [runId, userMessageId]
      );
    }

    res.json({ runId, sessionKey, messageId: userMessageId });
  } catch (err) {
    console.error('[chat] send failed:', err);
    res.status(500).json({ error: err.message || 'send failed' });
  }
});

/**
 * GET /api/agents/:id/chat/stream?runId=<id>
 * SSE. Forwards live events from the sink for the matching agent + runId.
 *
 * Emits:
 *   event: status   data: <label>       — tool/lifecycle updates
 *   event: reply    data: <text>        — final assistant message
 *   event: error    data: <message>     — timeout
 *
 * Stream closes after reply or timeout. If the reply already landed in the
 * DB before the browser reconnects (because the tab was closed during the
 * 5-15s reply window), the next loadChatHistory() call will surface it.
 */
router.get('/api/agents/:id/chat/stream', async (req, res) => {
  const agentId = validateAgent(req, res);
  if (!agentId) return;
  const runId = req.query.runId;
  if (!runId) return res.status(400).json({ error: 'runId required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');

  let closed = false;
  const sendEvent = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('[chat/stream] write failed:', err.message);
    }
  };

  const onStatus = (evt) => {
    if (evt.agentId !== agentId) return;
    if (evt.runId && evt.runId !== runId) return;
    const p = evt.payload || {};
    const label = p.status || p.tool || p.label || p.message || p.event || 'working';
    sendEvent('status', { label });
  };

  const onReply = (evt) => {
    if (evt.agentId !== agentId) return;
    if (evt.runId && evt.runId !== runId) return;
    sendEvent('reply', { text: evt.text, runId: evt.runId });
    cleanup();
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    replyBus.off('status', onStatus);
    replyBus.off('reply', onReply);
    clearTimeout(timeoutId);
    try { res.end(); } catch {}
  };

  const timeoutId = setTimeout(() => {
    sendEvent('error', { message: `stream timeout after ${STREAM_TIMEOUT_MS}ms` });
    cleanup();
  }, STREAM_TIMEOUT_MS);

  replyBus.on('status', onStatus);
  replyBus.on('reply', onReply);

  req.on('close', cleanup);
});

/**
 * GET /api/agents/:id/chat/history?limit=50
 * Returns chronological chat history for the agent's session, filtered to
 * chat + inject sources (cron/trigger surface in Phase 2).
 */
router.get('/api/agents/:id/chat/history', async (req, res) => {
  const agentId = validateAgent(req, res);
  if (!agentId) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const r = await db.query(
      `SELECT id, role, text, run_id, source, created_at
         FROM chat_messages
        WHERE agent_id = $1 AND source IN ('chat', 'inject')
        ORDER BY created_at DESC
        LIMIT $2`,
      [agentId, limit]
    );
    res.json({ messages: r.rows.reverse() });
  } catch (err) {
    console.error('[chat] history failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
