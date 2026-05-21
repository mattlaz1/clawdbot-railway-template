// OpenClaw WebSocket client for Mission Control.
//
// Maintains ONE persistent WS connection to the OpenClaw gateway. Reconnects
// with exponential backoff if the connection drops. Multiplexes all chat
// traffic across the single socket.
//
// Protocol locked from observed payloads (see notes in commit message):
//   - connect (protocol v4, scopes operator.read+write)
//   - sessions.messages.subscribe per sessionKey
//   - chat.send { sessionKey, message, idempotencyKey } -> { runId }
//   - events:  "agent"  (lifecycle/status badges)
//              "session.message" (role: user|assistant, final text)
//
// API:
//   const client = require('./openclaw').getClient();
//   client.subscribe('agent:cro:main');
//   client.on('agent', (payload) => { ... });   // status events
//   client.on('message', (payload) => { ... }); // session.message events
//   const { runId } = await client.send('agent:cro:main', 'Hello');
//   await client.inject('agent:cro:main', 'Context: ...', 'task-context');
//   const history = await client.history('agent:cro:main', { limit: 50 });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const WS_URL = process.env.OPENCLAW_WS_URL;
const TOKEN = process.env.OPENCLAW_TOKEN;
const DEVICE_TOKEN = process.env.OPENCLAW_DEVICE_TOKEN; // optional, grants paired-device scopes
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000; // 3 min; matches CRO's worst-case turnaround

if (!WS_URL || !TOKEN) {
  console.warn(
    '[openclaw] OPENCLAW_WS_URL or OPENCLAW_TOKEN missing — chat features disabled. Set in .env to enable.'
  );
}

const uid = () => crypto.randomBytes(8).toString('hex');

class OpenClawClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.subscriptions = new Set();   // sessionKeys we've subscribed to
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shutdown = false;
  }

  /** Connect (or reconnect) to the gateway. Idempotent. */
  connect() {
    if (this.shutdown) return;
    if (!WS_URL || !TOKEN) return;
    if (this.connected || this.connecting) return;
    this.connecting = true;

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      const id = uid();
      const frame = {
        type: 'req',
        id,
        method: 'connect',
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: 'gateway-client',
            version: '1.0.0',
            platform: 'node',
            mode: 'backend',
          },
          auth: {
            token: TOKEN,
            ...(DEVICE_TOKEN ? { deviceToken: DEVICE_TOKEN } : {}),
          },
          // operator.admin is required for chat.inject (briefing). Loopback
          // clients get all scopes by default on Railway (the wrapper binds
          // the gateway to 127.0.0.1, which auto-grants admin); listing
          // explicitly here is harmless if the gateway already grants more.
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
        },
      };
      this._send(frame);
      // Track the connect request so we know when handshake completes.
      this.pendingRequests.set(id, {
        resolve: (payload) => {
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log('[openclaw] connected; server:', payload?.server?.version);
          this.emit('connect', payload);
          // Re-subscribe to all sessions we were tracking before the disconnect.
          for (const key of this.subscriptions) {
            this._resubscribe(key);
          }
        },
        reject: (err) => {
          console.error('[openclaw] connect rejected:', err);
          this.ws?.close();
        },
        timer: null,
      });
    });

    ws.on('message', (raw) => this._onFrame(raw));

    ws.on('close', () => {
      this.connected = false;
      this.connecting = false;
      // Reject all in-flight requests; they will retry against the new connection
      // if the caller wants. For chat sends, the caller surfaces the error to user.
      for (const [id, { reject, timer }] of this.pendingRequests) {
        if (timer) clearTimeout(timer);
        reject(new Error('WebSocket closed before response'));
      }
      this.pendingRequests.clear();
      if (!this.shutdown) {
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      console.error('[openclaw] ws error:', err.message);
      // 'close' will fire after 'error', which handles reconnect.
    });
  }

  /** Subscribe to a session's message stream. Idempotent across reconnects. */
  async subscribe(sessionKey) {
    this.subscriptions.add(sessionKey);
    if (!this.connected) {
      this.connect();
      await this._waitForConnect();
    }
    return this._request('sessions.messages.subscribe', { key: sessionKey });
  }

  /** Internal: re-fire subscribe after a reconnect (don't add to set, already there). */
  async _resubscribe(sessionKey) {
    try {
      await this._request('sessions.messages.subscribe', { key: sessionKey });
      console.log('[openclaw] re-subscribed:', sessionKey);
    } catch (err) {
      console.error('[openclaw] re-subscribe failed:', sessionKey, err.message);
    }
  }

  /**
   * Send a user message to an agent's session.
   * Returns { runId } when the gateway accepts the send.
   * The actual assistant reply arrives later via 'message' event.
   */
  async send(sessionKey, message) {
    if (!this.connected) {
      this.connect();
      await this._waitForConnect();
    }
    if (!this.subscriptions.has(sessionKey)) {
      await this.subscribe(sessionKey);
    }
    const payload = await this._request('chat.send', {
      sessionKey,
      message,
      idempotencyKey: uid(),
    });
    return payload; // { runId, status:"started" }
  }

  /** Inject a non-user message (e.g. task context) into the session transcript. */
  async inject(sessionKey, message, label) {
    if (!this.connected) {
      this.connect();
      await this._waitForConnect();
    }
    return this._request('chat.inject', { sessionKey, message, label });
  }

  /** Pull session history. limit caps to gateway max (1000). */
  async history(sessionKey, { limit = 50, maxChars = 50_000 } = {}) {
    if (!this.connected) {
      this.connect();
      await this._waitForConnect();
    }
    return this._request('chat.history', { sessionKey, limit, maxChars });
  }

  /** Cancel an in-flight run. */
  async abort(sessionKey, runId) {
    if (!this.connected) return;
    return this._request('chat.abort', { sessionKey, runId });
  }

  /** Close the connection and stop reconnecting. For graceful shutdown. */
  close() {
    this.shutdown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  // --- internal ---

  _send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(JSON.stringify(frame));
  }

  async _request(method, params) {
    // Wait for an open socket, then send. If _send still fails (race with
    // an in-flight disconnect — the gateway sometimes closes the very first
    // post-handshake connection at boot), wait for the next 'connect' and
    // retry once. After that, propagate the error.
    const id = uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });

      const sendOnce = async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          if (!this.connecting && !this.connected) this.connect();
          await this._waitForConnect();
        }
        this._send({ type: 'req', id, method, params });
      };

      sendOnce().catch(async (err) => {
        if (String(err.message).includes('WebSocket not open')) {
          // Wait for the reconnect cycle that already kicked off, then retry.
          try {
            await this._waitForConnect();
            this._send({ type: 'req', id, method, params });
            return;
          } catch (err2) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            return reject(err2);
          }
        }
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  _onFrame(raw) {
    let f;
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (f.type === 'res' && f.id) {
      const pending = this.pendingRequests.get(f.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingRequests.delete(f.id);
      if (f.ok) pending.resolve(f.payload);
      else pending.reject(new Error(f.error?.message || 'Unknown gateway error'));
      return;
    }

    if (f.type !== 'event') return;

    // Re-emit relevant events for consumers. The router layer (routes/chat.js)
    // listens for 'agent' (status badges) and 'message' (assistant replies).
    if (f.event === 'agent') {
      this.emit('agent', f.payload);
    } else if (f.event === 'session.message') {
      this.emit('message', f.payload);
    }
    // Ignored: health, tick, connect.challenge, presence, etc.
  }

  _waitForConnect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.off('connect', onConnect);
        resolve();
      };
      this.on('connect', onConnect);
      // 15s safety timeout — if connect doesn't fire, surface to caller.
      setTimeout(() => {
        this.off('connect', onConnect);
        if (!this.connected) reject(new Error('OpenClaw connect timeout'));
      }, 15_000);
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MIN_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;
    console.log(`[openclaw] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// Singleton — Mission Control has one process, one WS connection.
let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenClawClient();
    _client.connect();
  }
  return _client;
}

module.exports = { getClient, OpenClawClient };
