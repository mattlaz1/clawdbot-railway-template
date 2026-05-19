// HTTP Basic Auth gate. Protects every route on the server.
// Credentials come from BASIC_AUTH_USER + BASIC_AUTH_PASS env vars.
// If either is missing, auth is disabled (useful for local dev on localhost).
//
// Webhook endpoints (/api/webhooks/*) bypass this because they authenticate
// themselves via HMAC signatures from the sending service (e.g. Fathom).

const crypto = require("crypto");

const USER = process.env.BASIC_AUTH_USER || "";
const PASS = process.env.BASIC_AUTH_PASS || "";
// When MC runs inside the Railway container behind the OpenClaw wrapper, the
// wrapper's Basic Auth gate (SETUP_PASSWORD) has already authenticated every
// request before it reaches us on localhost:3700. Defer to it.
const BEHIND_WRAPPER = process.env.MC_BEHIND_WRAPPER === "1";
const ENABLED = Boolean(USER && PASS) && !BEHIND_WRAPPER;

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = function basicAuth(req, res, next) {
  if (!ENABLED) return next();
  if (req.path.startsWith("/api/webhooks/")) return next();

  const header = req.headers.authorization || "";
  const match = /^Basic (.+)$/.exec(header);
  if (match) {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx !== -1) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (safeEqual(user, USER) && safeEqual(pass, PASS)) return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Mission Control"');
  res.status(401).send("Authentication required");
};

module.exports.enabled = ENABLED;
