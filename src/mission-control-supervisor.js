// Mission Control supervisor.
//
// MC is a CommonJS Node app that lives in /mission-control/ inside this image.
// We fork it as a child process and restart on crash with exponential backoff.
// MC binds to MC_PORT (127.0.0.1) inside the container; the wrapper proxies
// /mc/* to it (see server.js where this module is consumed).
//
// MC connects to the OpenClaw gateway via ws://127.0.0.1:18789/ — loopback,
// which is the whole point of this co-location: the gateway grants full
// operator.* scopes to loopback clients, so MC can drive workspaces.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MC_DIR = path.resolve(process.cwd(), "mission-control");
const MC_DATA_DIR = process.env.MC_DATA_DIR || "/data/mc";
const MC_PORT = process.env.MC_PORT || "3700";

let proc = null;
let restartAttempts = 0;
let lastSpawnAt = 0;
let shuttingDown = false;

function backoffMs() {
  // 1s, 2s, 4s, 8s, 16s, capped at 30s
  return Math.min(30_000, 1000 * Math.pow(2, restartAttempts));
}

function ensureDirs() {
  try {
    fs.mkdirSync(MC_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(MC_DATA_DIR, "execute-logs"), { recursive: true });
  } catch (err) {
    console.warn(`[mc] failed to mkdir ${MC_DATA_DIR}: ${err.message}`);
  }
}

function buildEnv() {
  return {
    ...process.env,
    NODE_ENV: "production",
    MC_PORT,
    MC_BEHIND_WRAPPER: "1",
    MC_DATA_DIR,
    MC_EXECUTE_LOG_DIR: path.join(MC_DATA_DIR, "execute-logs"),
    // OpenClaw WS — loopback so the gateway grants operator scopes
    OPENCLAW_WS_URL: process.env.OPENCLAW_WS_URL || "ws://127.0.0.1:18789/",
    OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "",
    // Where MC's agent persona files (AGENTS.md, IDENTITY.md, etc.) live on Railway
    AGENT_BASE: process.env.AGENT_BASE || "/data/workspace/mission-agents",
    VAULT_ROOT: process.env.VAULT_ROOT || "/data/workspace",
  };
}

export function isRunning() {
  return Boolean(proc);
}

export function start() {
  if (proc || shuttingDown) return;
  ensureDirs();

  const entry = path.join(MC_DIR, "server.js");
  if (!fs.existsSync(entry)) {
    console.warn(`[mc] ${entry} missing — skipping Mission Control startup`);
    return;
  }

  lastSpawnAt = Date.now();
  console.log(`[mc] starting (attempt ${restartAttempts + 1}): node ${entry}`);

  proc = childProcess.spawn("node", [entry], {
    cwd: MC_DIR,
    env: buildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk) => {
    process.stdout.write(`[mc] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[mc] ${chunk}`);
  });

  proc.on("error", (err) => {
    console.error(`[mc] spawn error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    const ranFor = Date.now() - lastSpawnAt;
    console.warn(`[mc] exited code=${code} signal=${signal} ranFor=${ranFor}ms`);
    proc = null;
    if (shuttingDown) return;

    // If MC ran cleanly for >60s, reset the backoff counter.
    if (ranFor > 60_000) restartAttempts = 0;
    else restartAttempts += 1;

    const wait = backoffMs();
    console.log(`[mc] restarting in ${wait}ms`);
    setTimeout(start, wait).unref?.();
  });
}

export function stop() {
  shuttingDown = true;
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {}
  // Hard-kill after 5s if it didn't go down cleanly.
  setTimeout(() => {
    if (proc) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }, 5_000).unref?.();
}
