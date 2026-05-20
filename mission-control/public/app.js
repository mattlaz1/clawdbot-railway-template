// SkySuite Mission Control — frontend
const MCP_ICONS = {
  outlook:    { logo: "https://www.google.com/s2/favicons?domain=outlook.live.com&sz=64",     label: "Outlook" },
  calendar:   { logo: "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=64", label: "Calendar" },
  notion:     { logo: "https://www.google.com/s2/favicons?domain=notion.so&sz=64",            label: "Notion" },
  linkedin:   { logo: "https://www.google.com/s2/favicons?domain=linkedin.com&sz=64",         label: "LinkedIn" },
  quickbooks: { logo: "https://www.google.com/s2/favicons?domain=quickbooks.intuit.com&sz=64",label: "QuickBooks" },
  stripe:     { logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=64",           label: "Stripe" },
  zoom:       { logo: "https://www.google.com/s2/favicons?domain=zoom.us&sz=64",              label: "Zoom" },
  chrome:     { logo: "https://www.google.com/s2/favicons?domain=google.com&sz=64",           label: "Chrome" },
  firecrawl:  { logo: "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=64",        label: "Firecrawl" },
};

const ACTION_LABELS = {
  draft_email: "📧 Email",
  notion_task: "📋 Task",
  notion_update: "📋 Update",
  linkedin_reply: "💼 LinkedIn",
  linkedin_invite: "💼 Invite",
  qb_invoice: "💰 Invoice",
  calendar_event: "📅 Event",
  research: "🔍 Research",
};

Object.assign(ACTION_LABELS, {
  draft_email: "Email",
  notion_task: "Task",
  notion_update: "Update",
  linkedin_reply: "LinkedIn",
  linkedin_invite: "Invite",
  qb_invoice: "Invoice",
  qb_bill: "Bill",
  calendar_event: "Event",
  newsletter_draft: "Newsletter",
  linkedin_post_draft: "Post",
  research: "Research",
  freeform: "Freeform",
});

const PRIORITY_META = {
  urgent: { label: "Urgent", color: "#ef4444", dot: "#ef4444", order: 0 },
  high:   { label: "High",   color: "#f59e0b", dot: "#f59e0b", order: 1 },
  normal: { label: "Normal", color: "#6b7280", dot: "#6b7280", order: 2 },
  low:    { label: "Low",    color: "#94a3b8", dot: "#94a3b8", order: 3 },
};

function priorityOrder(p) {
  return PRIORITY_META[p?.priority]?.order ?? 2;
}

function renderPriorityBadge(priority) {
  if (!priority || priority === "normal") return "";
  const meta = PRIORITY_META[priority];
  if (!meta) return "";
  return `<span class="priority-badge" style="background:${meta.color}">${meta.label}</span>`;
}

// Normalize a due_date value to YYYY-MM-DD string. Handles both "2026-04-14"
// and full ISO timestamps like "2026-04-14T04:00:00.000Z" from Postgres.
function normalizeDateStr(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 10);
}

function renderDueDateChip(dueDate) {
  if (!dueDate) return "";
  const dateStr = normalizeDateStr(dueDate);
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isOverdue = d < today;
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `<span class="due-chip${isOverdue ? " overdue" : ""}">Due: ${escape(label)}</span>`;
}

const state = {
  agents: [],
  tasksByAgent: {}, // id -> { generated_at, proposals, decisions }
  runningExecutes: {}, // agent_id -> run_id
  expandedProps: new Set(), // proposal ids currently expanded (chevron)
  replyOpenProps: new Set(), // proposal ids showing the Reply compose without full expand
  collapsedSections: new Set(), // agent ids whose task list is collapsed
  collapsedReports: new Set(), // agent ids whose inline report section is collapsed (all start collapsed)
  agentBriefings: {}, // agent_id -> { body, title, generated_at } — lazy-loaded cache
  agentBriefingStatus: {}, // agent_id -> "loading" | "loaded" | "empty" | "error"
  taskDensity: ["comfortable", "compact"].includes(localStorage.getItem("mc_task_density")) ? localStorage.getItem("mc_task_density") : "compact", // "comfortable" | "compact"
  inboxMode: localStorage.getItem("mc_inbox_mode") || "list", // "list" | "kanban"
  inboxAgentFilter: (() => {
    // Multi-select: stored as CSV of agent ids. Empty / "all" = no filter.
    const raw = localStorage.getItem("mc_inbox_agent_filter") || "";
    if (!raw || raw === "all") return new Set();
    return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  })(), // Set<agent_id>; empty = All
  inboxSearch: "", // live text filter — not persisted
  completedCollapsed: localStorage.getItem("mc_inbox_completed_collapsed") !== "0", // collapsed by default
  dbCompaniesMode: localStorage.getItem("mc_db_companies_mode") || "table", // "table" | "kanban"
  dbContactsMode: localStorage.getItem("mc_db_contacts_mode") || "grouped", // "grouped" | "table"
  dbContactsSearch: "", // live filter, not persisted
  dbContactsRole: "",  // role filter, not persisted
  dbContactsCollapsed: new Set(JSON.parse(localStorage.getItem("mc_db_contacts_collapsed") || "[]")), // company_ids collapsed in grouped view
  meetingTypeFilter: localStorage.getItem("mc_meeting_type_filter") || "external", // "all" | "external" | "internal"
  covExpanded: new Set(JSON.parse(localStorage.getItem("mc_cov_expanded") || "[]")), // company slugs whose coverage card is expanded
  covDetailCache: {}, // slug -> { proposals, tasks, fetchedAt } — avoids re-fetching on collapse/expand
  completedItems: [], // recently-executed items loaded from history endpoint
  gridFilter: ["now", "scheduled", "all"].includes(localStorage.getItem("mc_grid_filter")) ? localStorage.getItem("mc_grid_filter") : "now", // "now" | "scheduled" | "all"
  // ─── Notifications ──
  notifications: [],                       // unified event list from /api/notifications
  seenEventIds: new Set(JSON.parse(localStorage.getItem("mc_seen_events") || "[]")), // event ids Matt has acknowledged
  lastSeenTs: localStorage.getItem("mc_last_seen_ts") || new Date(Date.now() - 24*3600*1000).toISOString(), // initial window: last 24h
  notifBellOpen: false,                    // bell dropdown open?
  osNotifPermission: (typeof Notification !== "undefined" ? Notification.permission : "default"),
};

// ─── Helpers ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const escape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function timeAgo(date) {
  if (!date) return "never";
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// Human label for a due date. Handles both YYYY-MM-DD and full ISO timestamps.
// "today", "tomorrow", "in 3d", "Jun 15", etc. Used on scheduled-card badges.
function formatDueDate(iso) {
  if (!iso) return "";
  const dateStr = normalizeDateStr(iso);
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff < 0) return `${Math.abs(diff)}d ago`;
  if (diff < 7) return `in ${diff}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isStale(ts) {
  // Stale if the source timestamp is older than the agent's typical cadence.
  // We use 36h as the bar — any agent (even weekly ones mid-week) should have
  // something fresh within 36h of their scheduled slot. Prevents false-positive
  // "Stale" on daily agents that ran this morning but whose latest *proposal*
  // was carried forward from a prior run (so proposals.generated_at lags).
  if (!ts) return false;
  return Date.now() - new Date(ts) > 36 * 3600 * 1000;
}

// Best "when was this agent last fresh" signal — prefer actual run completion
// over proposal generation, because a run that carried proposals forward won't
// bump generated_at but IS a legitimate freshness event.
function latestFreshness(agent, propData) {
  const runTs = agent?.last_run?.completed_at;
  const propTs = propData?.generated_at;
  if (runTs && propTs) return new Date(runTs) > new Date(propTs) ? runTs : propTs;
  return runTs || propTs || null;
}

// Agents without a cron (Analyst, Dev) have schedule: null in server.js.
// Show a sensible label instead of the literal "null" string.
function scheduleLabel(agent) {
  return agent && agent.schedule ? agent.schedule : "On demand";
}

// Skills from /api/agents are plain strings ("Draft emails") — not {slash, label}.
// Normalize into a consistent object so the popover always renders something
// useful. The agent's main cron skill (/cro-daily, /cs-daily, etc.) becomes
// the fallback slash for every skill chip since that's what actually runs.
function normalizeSkill(s, fallbackSlash) {
  if (s && typeof s === "object") {
    return { slash: s.slash || fallbackSlash || "", label: s.label || "" };
  }
  return { slash: fallbackSlash || "", label: String(s || "") };
}

// Grid filter: "now" = no due_date or due_date <= today (things to do now).
// "scheduled" = due_date in the future (parked for later).
// Future due_date wins — even if Matt has commented, a snoozed/future item stays scheduled.
// Only queued items (actively waiting on /execute) override into "now".
function isNowForGrid(proposal, decision) {
  if (decision?.status === "in_progress") return true;
  if (!proposal.due_date) return true;
  const dateStr = normalizeDateStr(proposal.due_date);
  if (!dateStr) return true;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d <= today;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

// ─── Minimal markdown renderer (briefings are controlled content, not user input) ──
// Supports: # / ## / ### headings, bold, italic, inline code, - bullets, 1. numbered,
// blockquotes, horizontal rules, paragraphs. No links/images by design — briefings
// are plain narrative. Escapes HTML first, then applies formatting.
function renderBriefingMarkdown(md) {
  if (!md) return "";
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let inList = null; // "ul" | "ol" | null
  const flushList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };
  const inline = (s) => {
    let x = escape(s);
    x = x.replace(/`([^`]+)`/g, "<code>$1</code>");
    x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    x = x.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return x;
  };
  // Split a GFM pipe-table row into cells. Strips the leading/trailing pipe
  // (if present) so `| a | b |` and `a | b` both yield ["a","b"].
  const splitRow = (s) => {
    let t = s.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  };
  const isTableSeparator = (s) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) { flushList(); continue; }
    let m;
    // GFM pipe table: header row + separator row + 0+ body rows.
    // Detected by peeking at line i+1 for a separator pattern.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList();
      const headers = splitRow(line);
      const bodyRows = [];
      i += 2; // skip header + separator
      while (i < lines.length) {
        const r = lines[i].trimEnd();
        if (!r.trim() || !r.includes("|")) break;
        bodyRows.push(splitRow(r));
        i++;
      }
      i--; // loop will increment; stay on the non-table line
      const thead = `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    if ((m = line.match(/^###\s+(.*)$/))) { flushList(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = line.match(/^##\s+(.*)$/)))  { flushList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = line.match(/^#\s+(.*)$/)))   { flushList(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if (/^---+\s*$/.test(line))           { flushList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^>\s?(.*)$/)))   { flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (inList !== "ul") { flushList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (inList !== "ol") { flushList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return out.join("\n");
}

// ─── Briefing modal ────────────────────────────────────────────
// Renders one or more daily_reports rows in an overlay modal. If `rows` is
// empty, shows a "no briefing yet" message. The modal is self-contained —
// click the backdrop, the close button, or press Escape to dismiss.
function openBriefingModal({ title, rows }) {
  closeBriefingModal(); // idempotent
  const wrap = document.createElement("div");
  wrap.className = "briefing-overlay";
  wrap.id = "briefing-overlay";
  wrap.innerHTML = `
    <div class="briefing-modal" role="dialog" aria-modal="true">
      <div class="briefing-modal-head">
        <h2>${escape(title)}</h2>
        <button class="briefing-close" aria-label="Close" data-action="close-briefing">×</button>
      </div>
      <div class="briefing-modal-body">
        ${rows && rows.length
          ? rows.map((r) => {
              const agent = state.agents.find((a) => a.id === r.agent);
              const header = agent
                ? `<div class="briefing-agent-head" style="--card-color:${escape(agent.color)};--card-pastel:${escape(agent.pastel)}">
                     <span class="briefing-agent-emoji">${agent.emoji}</span>
                     <span class="briefing-agent-name">${escape(agent.name)}</span>
                     <span class="briefing-agent-meta">${escape(r.title || "")} · ${escape(r.report_date || "")}</span>
                   </div>`
                : `<div class="briefing-agent-head"><span class="briefing-agent-name">${escape(r.agent)}</span><span class="briefing-agent-meta">${escape(r.title || "")}</span></div>`;
              return `<section class="briefing-agent-block">${header}<div class="briefing-markdown">${renderBriefingMarkdown(r.body)}</div></section>`;
            }).join("")
          : `<div class="briefing-empty">No briefing yet for this agent today. Next run: check the agent card.</div>`
        }
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  // dismiss on backdrop click or Escape
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest('[data-action="close-briefing"]')) {
      closeBriefingModal();
    }
  });
  document.addEventListener("keydown", briefingEscHandler);
}

function closeBriefingModal() {
  const existing = $("#briefing-overlay");
  if (existing) existing.remove();
  document.removeEventListener("keydown", briefingEscHandler);
}

function briefingEscHandler(e) {
  if (e.key === "Escape") closeBriefingModal();
}

async function showAgentBriefing(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent ? `${agent.emoji} ${agent.name} Briefing` : `Briefing`;
  try {
    const res = await fetch(`/api/agents/${agentId}/briefing`);
    if (res.status === 404) {
      openBriefingModal({ title, rows: [] });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const row = await res.json();
    openBriefingModal({ title, rows: [row] });
  } catch (err) {
    toast(`Couldn't load briefing — ${err.message}`);
  }
}

async function loadAgentBriefing(agentId) {
  if (!agentId) return;
  const status = state.agentBriefingStatus[agentId];
  if (status === "loading" || status === "loaded" || status === "empty") return;
  state.agentBriefingStatus[agentId] = "loading";
  try {
    const res = await fetch(`/api/agents/${agentId}/briefing`);
    if (res.status === 404) {
      state.agentBriefingStatus[agentId] = "empty";
      render();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.agentBriefings[agentId] = await res.json();
    state.agentBriefingStatus[agentId] = "loaded";
  } catch (err) {
    state.agentBriefingStatus[agentId] = "error";
    console.warn(`Could not load briefing for ${agentId}:`, err);
  }
  render();
}

function ensureVisibleBriefingsLoaded() {
  for (const agent of state.agents) {
    if (state.collapsedReports.has(agent.id)) continue;
    const propData = state.tasksByAgent[agent.id];
    if (!latestFreshness(agent, propData)) continue;
    if (state.agentBriefingStatus[agent.id]) continue;
    loadAgentBriefing(agent.id);
  }
}

async function showTodaysBriefings() {
  try {
    const res = await fetch(`/api/briefings/today?days=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    openBriefingModal({ title: `Today's Briefings · ${today}`, rows });
  } catch (err) {
    toast(`Couldn't load briefings — ${err.message}`);
  }
}

function setGreeting() {
  // Greeting/date were dropped when the topbar was removed. Keep the function
  // defensive in case DOM elements are reintroduced later.
  const greetEl = $("#greeting");
  const todayEl = $("#today");
  if (!greetEl && !todayEl) return;
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  if (greetEl) greetEl.textContent = `${greet}, Matt`;
  if (todayEl) todayEl.textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Notification engine ──────────────────────────────────────────
function persistSeenEvents() {
  try {
    const arr = Array.from(state.seenEventIds).slice(-500);
    localStorage.setItem("mc_seen_events", JSON.stringify(arr));
    localStorage.setItem("mc_last_seen_ts", state.lastSeenTs);
  } catch {}
}
function unreadEvents() {
  return (state.notifications || []).filter((e) => !state.seenEventIds.has(e.id));
}
function unreadCountForAgent(agentId) {
  return unreadEvents().filter((e) => e.agent_id === agentId).length;
}
function agentEmojiById(agentId) {
  const a = state.agents.find((x) => x.id === agentId);
  return a?.emoji || "";
}
function agentNameById(agentId) {
  const a = state.agents.find((x) => x.id === agentId);
  return a?.name || agentId;
}
function fireOsNotification(event) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;
  try {
    const n = new Notification(event.title || "Mission Control", {
      body: event.summary || `${agentNameById(event.agent_id)} · ${event.type}`,
      tag: event.id,
      icon: "/favicon.png",
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      if (event.agent_id) location.hash = `#/agent/${event.agent_id}`;
      n.close();
    };
  } catch {}
}
async function requestOsPermission() {
  if (typeof Notification === "undefined") { toast("This browser doesn't support desktop notifications."); return; }
  if (Notification.permission === "granted") { toast("Notifications already enabled."); return; }
  if (Notification.permission === "denied") { toast("Notifications blocked — change in browser settings."); return; }
  const p = await Notification.requestPermission();
  state.osNotifPermission = p;
  if (p === "granted") {
    toast("Desktop notifications on.");
    try { new Notification("Mission Control", { body: "You'll now get alerts when agents fire.", icon: "/favicon.png" }); } catch {}
  } else {
    toast("Notifications not enabled.");
  }
  renderNotifBell();
}
async function pollNotifications({ silent = false } = {}) {
  try {
    const res = await fetch(`/api/notifications?since=${encodeURIComponent(state.lastSeenTs)}`);
    if (!res.ok) return;
    const events = await res.json();
    const seen = new Set(state.notifications.map((e) => e.id));
    const toAdd = events.filter((e) => !seen.has(e.id));
    if (toAdd.length === 0) { renderNotifBell(); return; }
    const trulyNew = toAdd.filter((e) => !state.seenEventIds.has(e.id));
    state.notifications = [...toAdd, ...state.notifications].slice(0, 200);
    if (events.length) {
      const newest = events[0]?.timestamp;
      if (newest && new Date(newest) > new Date(state.lastSeenTs)) {
        state.lastSeenTs = newest;
        persistSeenEvents();
      }
    }
    if (!silent) {
      for (const e of trulyNew.slice(0, 3)) {
        const emoji = agentEmojiById(e.agent_id);
        const label = `${emoji} ${e.title}`.trim();
        toast(label);
        fireOsNotification(e);
      }
      if (trulyNew.length > 3) toast(`…and ${trulyNew.length - 3} more`);
    }
    renderNotifBell();
    render();
  } catch {}
}
function renderNotifBell() {
  const bell = $("#notif-bell");
  if (!bell) return;
  const unread = unreadEvents().length;
  bell.classList.toggle("has-unread", unread > 0);
  const countEl = bell.querySelector(".notif-count");
  if (countEl) {
    countEl.textContent = unread > 99 ? "99+" : String(unread);
    countEl.style.display = unread > 0 ? "" : "none";
  }
}
function markAllNotifsSeen() {
  for (const e of state.notifications) state.seenEventIds.add(e.id);
  persistSeenEvents();
  renderNotifBell();
  render();
}
function openNotifPanel() {
  closeNotifPanel();
  const events = [...state.notifications].slice(0, 80);
  const wrap = document.createElement("div");
  wrap.id = "notif-panel";
  wrap.className = "notif-panel";
  const permLabel = state.osNotifPermission === "granted"
    ? `<span class="notif-perm on">Desktop alerts: on</span>`
    : state.osNotifPermission === "denied"
    ? `<span class="notif-perm denied">Desktop alerts: blocked</span>`
    : `<button class="notif-perm-btn" data-action="notif-enable-os">Enable desktop alerts</button>`;
  wrap.innerHTML = `
    <div class="notif-panel-head">
      <h3>Activity</h3>
      <div class="notif-panel-head-actions">
        ${permLabel}
        <button class="notif-mark-all" data-action="notif-mark-all">Mark all seen</button>
      </div>
    </div>
    <div class="notif-panel-body">
      ${events.length === 0
        ? `<div class="notif-empty">No events yet. Agents will post here when they run.</div>`
        : events.map((e) => {
            const unread = !state.seenEventIds.has(e.id);
            const a = state.agents.find((x) => x.id === e.agent_id);
            const dotColor = e.severity === "error" ? "#ef4444" : e.severity === "warn" ? "#f59e0b" : (a?.color || "#3b82f6");
            const typeLabel = e.type === "run" ? "Run" : e.type === "proposal" ? "Proposal" : e.type === "briefing" ? "Briefing" : e.type;
            return `
              <div class="notif-row ${unread ? "unread" : ""}" data-event-id="${escape(e.id)}" data-agent-id="${escape(e.agent_id || "")}" data-event-type="${escape(e.type)}">
                <span class="notif-dot" style="background:${dotColor}"></span>
                <div class="notif-row-main">
                  <div class="notif-row-title">${a ? `<span class="notif-emoji">${a.emoji}</span>` : ""}<span>${escape(e.title)}</span></div>
                  ${e.summary ? `<div class="notif-row-summary">${escape(e.summary)}</div>` : ""}
                  <div class="notif-row-meta">
                    <span class="notif-type-tag">${escape(typeLabel)}</span>
                    <span>${timeAgo(e.timestamp)}</span>
                    ${e.priority === "urgent" ? `<span class="notif-urgent">URGENT</span>` : ""}
                  </div>
                </div>
              </div>`;
          }).join("")
      }
    </div>
  `;
  document.body.appendChild(wrap);
  state.notifBellOpen = true;
  setTimeout(() => { document.addEventListener("click", notifOutsideClickHandler); }, 0);
}
function closeNotifPanel() {
  const existing = $("#notif-panel");
  if (existing) existing.remove();
  state.notifBellOpen = false;
  document.removeEventListener("click", notifOutsideClickHandler);
}
function notifOutsideClickHandler(e) {
  if (e.target.closest("#notif-panel") || e.target.closest("#notif-bell")) return;
  closeNotifPanel();
}

// ─── Rendering ──────────────────────────────────────────────────
function renderPreview(preview, editedBody) {
  if (!preview || typeof preview !== "object") return "";
  const labelMap = {
    to: "To",
    cc: "Cc",
    from: "From",
    subject: "Subject",
    body_snippet: "Body",
    body: "Body",
    task: "Task",
    due: "Due",
    company: "Company",
    action_type: "Type",
  };
  const headerKeys = ["to", "cc", "from", "subject"];
  const headerRows = headerKeys
    .filter((k) => preview[k] != null)
    .map((k) => {
      const val = typeof preview[k] === "object" ? JSON.stringify(preview[k]) : String(preview[k]);
      return `<div class="preview-row"><span class="preview-key">${escape(labelMap[k])}</span><span class="preview-val">${escape(val)}</span></div>`;
    })
    .join("");

  const originalBody = preview.body ?? preview.body_snippet ?? null;
  // editedBody (string) takes precedence over the original. null means "no edit yet".
  const displayBody = editedBody != null ? editedBody : originalBody;
  const isEdited = editedBody != null && editedBody !== originalBody;
  const bodyBlock = displayBody != null
    ? `<div class="preview-body-wrap${isEdited ? " edited" : ""}">
         ${isEdited ? '<span class="edited-badge">edited</span>' : ""}
         <div class="preview-body" contenteditable="plaintext-only" spellcheck="true" data-action="edit-body">${escape(String(displayBody)).replace(/\n/g, "<br>")}</div>
       </div>`
    : "";

  const otherKeys = Object.keys(preview).filter(
    (k) => !headerKeys.includes(k) && k !== "body" && k !== "body_snippet"
  );
  const otherRows = otherKeys
    .map((k) => {
      const val = typeof preview[k] === "object" ? JSON.stringify(preview[k]) : String(preview[k]);
      const label = labelMap[k] || k.replace(/_/g, " ");
      return `<div class="preview-row"><span class="preview-key">${escape(label)}</span><span class="preview-val">${escape(val)}</span></div>`;
    })
    .join("");

  return `<div class="proposal-preview">${headerRows}${bodyBlock}${otherRows}</div>`;
}

// Render just the message bubbles (no header, no toggle). Returns empty
// string when there are no messages so the card stays clean until there's
// actual conversation.
function renderThreadMessages(thread) {
  if (!Array.isArray(thread) || !thread.length) return "";
  const bubbles = thread
    .map((m) => {
      const time = new Date(m.ts).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const actionLabel =
        m.action === "refined" ? "↺ refined"
        : m.action === "executed" ? "✓ executed"
        : m.action === "question" ? "? question"
        : m.action === "snoozed" ? "⏸ snoozed"
        : m.action === "rejected_logged" ? "🧠 logged to brain"
        : null;
      return `
        <div class="thread-bubble ${escape(m.role)}">
          <div class="bubble-meta">
            <span class="bubble-role">${m.role === "matt" ? "You" : "Claude"}</span>
            ${actionLabel ? `<span class="bubble-action">${escape(actionLabel)}</span>` : ""}
            <span class="bubble-time">${escape(time)}</span>
          </div>
          <div class="bubble-text">${escape(m.text).replace(/\n/g, "<br>")}</div>
        </div>
      `;
    })
    .join("");
  return `<div class="thread-messages">${bubbles}</div>`;
}

// The always-visible compose box at the bottom of the expanded card. This
// is the primary input now that Yes/No buttons are gone.
function renderCompose(propId) {
  const draftValue = escape(threadDrafts.get(propId) || "");
  return `
    <div class="thread-compose">
      <textarea
        class="thread-input"
        placeholder="Type yes to approve, or tell Claude what to change…"
        data-action="thread-draft"
        rows="1"
      >${draftValue}</textarea>
    </div>
  `;
}

function renderProposal(agentId, p, decisionRecord, generatedAt) {
  const status = decisionRecord?.status || null;
  const thread = decisionRecord?.thread || [];
  const edits = decisionRecord?.edits || {};
  const editedBody = edits.body ?? null;
  const hasThread = thread.length > 0;
  const hasEdits = Object.keys(edits).length > 0;
  const touched = isTouched(decisionRecord);
  const isInProgress = status === "in_progress";
  const isSnoozed = status === "snoozed";
  const needsMatt = status === "needs_matt";
  const needsRefinement = status === "needs_refinement";

  const stateClass = isInProgress
    ? "in-progress"
    : isSnoozed
    ? "snoozed"
    : needsMatt
    ? "needs-matt"
    : needsRefinement
    ? "needs-refinement"
    : touched
    ? "touched"
    : "";

  const actionLabel = ACTION_LABELS[p.action_type] || (p.action_type || "").replace(/_/g, " ");
  const isExpanded = state.expandedProps.has(p.id);
  // Reply mode = lightweight compose without expanding the full preview.
  // Only show when the user explicitly toggled the reply button — a stale
  // localStorage draft must not auto-reopen the inline composer after commit.
  const isReplyOpen =
    !isInProgress && state.replyOpenProps.has(p.id);
  const addedAt = p.added_at || generatedAt;

  const statusBadge = isInProgress
    ? `<span class="status-pill in-progress">▶ In Progress</span>`
    : needsMatt
    ? `<span class="status-pill needs-matt"><span class="dot-pulse"></span>Needs review</span>`
    : needsRefinement
    ? `<span class="status-pill needs-refinement">↺ Refining</span>`
    : isSnoozed
    ? `<span class="status-pill snoozed">⏸ Snoozed</span>`
    : "";

  return `
    <div class="proposal ${stateClass} ${isExpanded ? "expanded" : ""} ${isReplyOpen ? "reply-open" : ""}" data-prop-id="${escape(p.id)}" data-agent="${escape(agentId)}">
      <div class="proposal-row">
        <button class="prop-chevron" data-action="toggle-prop" aria-label="Expand">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="proposal-content">
          <div class="proposal-title">${escape(p.title)}</div>
          <div class="proposal-meta">
            ${renderPriorityBadge(p.priority)}
            ${actionLabel ? `<span class="action-chip">${escape(actionLabel)}</span>` : ""}
            ${statusBadge}
            ${renderDueDateChip(p.due_date)}
            ${hasEdits && !hasThread ? `<span class="meta-sep"></span><span class="meta-time">edited</span>` : ""}
            ${hasThread ? `<span class="meta-sep"></span><span class="meta-time">${thread.length} message${thread.length === 1 ? "" : "s"}</span>` : ""}
            ${addedAt && !isInProgress ? `<span class="meta-sep"></span><span class="meta-time">${timeAgo(addedAt)}</span>` : ""}
          </div>
        </div>
        ${isInProgress ? `
          <button class="prop-unstick" data-action="unstick-prop" data-prop-id="${escape(p.id)}" data-agent="${escape(agentId)}" title="Reset: remove from queue (back to To-Do)">↺ Reset</button>
        ` : `
          <button class="reply-btn ${isReplyOpen ? "active" : ""}" data-action="toggle-reply" title="Quick reply">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <div class="card-menu-wrap">
            <button class="card-menu-btn" data-action="card-menu" data-prop-id="${escape(p.id)}" data-agent="${escape(agentId)}" title="Actions">&#8943;</button>
            <div class="card-menu-dropdown" data-menu-for="${escape(p.id)}">
              <button class="card-menu-item" data-resolve="completed" data-prop-id="${escape(p.id)}" data-agent="${escape(agentId)}">&#10003; Mark complete</button>
              <button class="card-menu-item card-menu-item--danger" data-resolve="dismissed" data-prop-id="${escape(p.id)}" data-agent="${escape(agentId)}">&#10005; Dismiss</button>
            </div>
          </div>
        `}
      </div>
      ${isReplyOpen && !isExpanded ? `
        <div class="reply-inline">
          ${renderCompose(p.id)}
        </div>
      ` : ""}
      <div class="proposal-detail ${isExpanded ? "" : "hidden"}">
        <div class="proposal-rationale">${escape(p.rationale || "")}</div>
        ${renderPreview(p.preview, editedBody)}
        ${renderThreadMessages(thread)}
        ${!isInProgress ? renderCompose(p.id) : ""}
      </div>
    </div>
  `;
}

// A proposal is "touched" (= actionable) if Matt has left any signal:
// a thread message, a comment, or a body edit. Untouched proposals are
// left alone on Execute and stay in To Do.
function isTouched(decisionRecord) {
  if (!decisionRecord) return false;
  const thread = Array.isArray(decisionRecord.thread) ? decisionRecord.thread : [];
  if (thread.some((m) => m.role === "matt")) return true;
  if ((decisionRecord.comment || "").trim()) return true;
  if (decisionRecord.edits && Object.keys(decisionRecord.edits).length) return true;
  return false;
}

function renderActiveCard(agent) {
  const propData = state.tasksByAgent[agent.id];
  const decisions = propData?.decisions || {};
  const allProposals = (propData?.tasks || []).filter(
    (p) => decisions[p.id]?.status !== "executed"
  );
  const generatedAt = latestFreshness(agent, propData);
  const stale = isStale(generatedAt);
  const isRunning = !!state.runningExecutes[agent.id];

  // Apply grid filter — "now" shows today's tasks, "scheduled" shows future-dated, "all" shows everything
  const proposals = state.gridFilter === "all"
    ? allProposals
    : state.gridFilter === "scheduled"
    ? allProposals.filter((p) => !isNowForGrid(p, decisions[p.id]))
    : allProposals.filter((p) => isNowForGrid(p, decisions[p.id]));
  const hiddenCount = allProposals.length - proposals.length;

  // Count touched items that aren't already queued. "Touched" = any signal
  // from Matt: thread message, comment, or body edit. No buttons to click.
  const notInProg = (p) => decisions[p.id]?.status !== "in_progress";
  const touchedCount = proposals.filter(
    (p) => isTouched(decisions[p.id]) && notInProg(p)
  ).length;
  const todoCount = proposals.filter(
    (p) => !isTouched(decisions[p.id]) && notInProg(p)
  ).length;
  const inProgCount = proposals.filter((p) => decisions[p.id]?.status === "in_progress").length;
  const anyInProg = inProgCount > 0;
  const hasAdhoc = (adhocDrafts.get(agent.id) || "").trim().length > 0;
  const isCronToggled = !!cronToggles.get(agent.id);
  // Must mirror the global Execute All logic (touched + adhoc + cron) — otherwise
  // the per-card Execute button flickers disabled on initial render until
  // updateCounts() catches up in a setTimeout.
  const actionableCount = touchedCount + (hasAdhoc ? 1 : 0) + (isCronToggled ? 1 : 0);

  const lastRunDot = agent.last_run ? (agent.last_run.status === "success" ? "green" : "red") : "gray";

  const mcpRow = (agent.mcps || [])
    .map((m) => {
      const meta = MCP_ICONS[m] || { logo: "", label: m };
      return `<span class="mcp-chip" title="${escape(meta.label)}"><img src="${escape(meta.logo)}" alt="" loading="lazy" onerror="this.style.display='none'"/><span>${escape(meta.label)}</span></span>`;
    })
    .join("");

  // Sort proposals by urgency (priority, then due date ascending) — most urgent first.
  const sortedProposals = proposals.slice().sort((a, b) => {
    const pa = priorityOrder(a);
    const pb = priorityOrder(b);
    if (pa !== pb) return pa - pb;
    const da = a.due_date || "9999-99-99";
    const db = b.due_date || "9999-99-99";
    return da.localeCompare(db);
  });
  const proposalListHtml = sortedProposals.length
    ? sortedProposals.map((p) => renderProposal(agent.id, p, decisions[p.id], generatedAt)).join("")
    : `<div class="proposal-empty">No tasks yet · next run ${escape(scheduleLabel(agent))}</div>`;
  const sectionCollapsed = state.collapsedSections.has(agent.id);

  // Inline report section
  const reportCollapsed = state.collapsedReports.has(agent.id);
  const cachedBriefing = state.agentBriefings[agent.id];
  const briefingStatus = state.agentBriefingStatus[agent.id];
  const reportBodyHtml = cachedBriefing
    ? `<div class="briefing-markdown">${renderBriefingMarkdown(cachedBriefing.body)}</div>`
    : reportCollapsed
    ? ""
    : briefingStatus === "empty"
    ? `<div class="report-empty">No report found yet.</div>`
    : briefingStatus === "error"
    ? `<div class="report-empty">Couldn't load report.</div>`
    : `<div class="report-loading">Loading…</div>`;
  const reportSectionHtml = generatedAt ? `
    <div class="report-section${reportCollapsed ? " collapsed" : ""}">
      <button class="task-section-header" data-action="toggle-report" data-agent-id="${escape(agent.id)}">
        <span class="task-section-title">📝 Last Report <span class="report-time">${timeAgo(generatedAt)}</span></span>
        <svg class="section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="report-body">
        ${reportBodyHtml}
      </div>
    </div>
  ` : "";

  return `
    <div class="agent-card" data-agent="${escape(agent.id)}" style="--card-color:${escape(agent.color)};--card-pastel:${escape(agent.pastel)}">
      <div class="card-header">
        <div class="card-header-row">
          <div class="card-emoji-name" data-action="open-agent" role="link" tabindex="0">
            <div class="card-emoji">${agent.emoji}${unreadCountForAgent(agent.id) > 0 ? `<span class="card-unread-dot" title="${unreadCountForAgent(agent.id)} new event${unreadCountForAgent(agent.id) === 1 ? '' : 's'}">${unreadCountForAgent(agent.id) > 9 ? '9+' : unreadCountForAgent(agent.id)}</span>` : ''}</div>
            <div>
              <div class="card-name">${escape(agent.name)}</div>
              <div class="card-tagline">${escape(agent.tagline)}</div>
            </div>
          </div>
          <div class="header-actions">
            <div class="skills-wrap">
            ${stale ? '<span class="stale-badge" style="margin-right:8px">Stale</span>' : ""}
            ${(agent.skills || []).length ? `
              <button class="skills-btn" data-action="toggle-skills">
                <span class="skills-count">${agent.skills.length}</span>
                Skills
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="skills-popover">
                ${agent.skills.map((raw) => {
                  const s = normalizeSkill(raw, agent.skill);
                  return `
                  <button class="skill-item" data-action="copy-skill" data-slash="${escape(s.slash)}">
                    ${s.slash ? `<span class="slash">${escape(s.slash)}</span>` : ""}
                    <span class="label">${escape(s.label)}</span>
                  </button>`;
                }).join("")}
              </div>
            ` : ""}
            </div>
          </div>
        </div>
        <div class="card-meta">
          <span class="card-meta-item"><span class="dot ${lastRunDot}"></span>${agent.last_run ? "Last run " + timeAgo(agent.last_run.completed_at) : "No runs yet"}</span>
          <span class="card-meta-item">⏰ ${escape(scheduleLabel(agent))}</span>
          ${generatedAt ? `<button class="card-meta-item briefing-chip" data-action="view-briefing" data-agent-id="${escape(agent.id)}" title="Open today's briefing">📝 Brief ${timeAgo(generatedAt)}</button>` : ""}
          ${agent.skill && agent.skill.startsWith("/") ? `<button class="btn-trigger${cronToggles.get(agent.id) ? " cron-active" : ""}" data-action="toggle-cron" data-cmd="${escape(agent.skill)}" title="${cronToggles.get(agent.id) ? "Click to remove from execute" : "Click to include in execute"}: ${escape(agent.skill)}">▶</button>` : ""}
        </div>
        <div class="mcp-row">${mcpRow}</div>
      </div>

      <div class="adhoc-compose">
        <textarea
          class="adhoc-input"
          placeholder="Ask ${escape(agent.name)}… (Enter to send, Shift+Enter for newline)"
          data-action="adhoc-input"
          rows="1"
        >${escape(adhocDrafts.get(agent.id) || "")}</textarea>
        <button class="adhoc-send" data-action="adhoc-send" data-agent-id="${escape(agent.id)}" ${hasAdhoc ? "" : "disabled"} title="Chat with ${escape(agent.name)}">Send</button>
      </div>
      <div class="chat-area" data-chat-log>${chatLogHtml(agent.id)}</div>

      <div class="task-section ${sectionCollapsed ? "collapsed" : ""}">
        <button class="task-section-header" data-action="toggle-section">
          <span class="task-section-title">Recommended tasks <span class="task-count">${proposals.length}</span>${hiddenCount > 0 ? `<span class="hidden-count">${hiddenCount} scheduled later</span>` : ""}</span>
          <svg class="section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="proposal-list">${proposalListHtml}</div>
      </div>

      ${reportSectionHtml}

      <div class="card-footer ${anyInProg ? "in-progress" : ""}">
        <div class="footer-stats">
          ${inProgCount > 0 ? `<strong>${inProgCount}</strong> in progress · ` : ""}
          <strong>${todoCount}</strong> to do
        </div>
        <button class="btn-execute" data-action="execute"${actionableCount === 0 ? " disabled" : ""}>Execute${actionableCount > 0 ? ` (${actionableCount})` : ""}</button>
      </div>
    </div>
  `;
}

function renderWaitingCard(agent) {
  return `
    <div class="waiting-card" style="--card-pastel:${escape(agent.pastel)}">
      <div class="waiting-emoji">${agent.emoji}</div>
      <div class="waiting-info">
        <div class="waiting-name">${escape(agent.name)}</div>
        <div class="waiting-next">Next: ${escape(scheduleLabel(agent))}</div>
      </div>
    </div>
  `;
}

function renderDetail(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    location.hash = "";
    return;
  }
  const data = state.tasksByAgent[agentId] || { tasks: [], decisions: {} };
  const decisions = data.decisions || {};
  const proposals = (data.tasks || []).filter(
    (p) => decisions[p.id]?.status !== "executed"
  );
  const generatedAt = latestFreshness(agent, data);
  const stale = isStale(generatedAt);

  const touchedCountDetail = proposals.filter((p) => isTouched(decisions[p.id]) && decisions[p.id]?.status !== "in_progress").length;
  const isCronToggledDetail = !!cronToggles.get(agent.id);
  const actionableCountDetail = touchedCountDetail + (isCronToggledDetail ? 1 : 0);
  const todoCountDetail = proposals.filter((p) => !isTouched(decisions[p.id]) && decisions[p.id]?.status !== "in_progress").length;

  const mcpRow = (agent.mcps || [])
    .map((m) => {
      const meta = MCP_ICONS[m] || { logo: "", label: m };
      return `<span class="mcp-chip" title="${escape(meta.label)}"><img src="${escape(meta.logo)}" alt="" loading="lazy" onerror="this.style.display='none'"/><span>${escape(meta.label)}</span></span>`;
    })
    .join("");

  const skillsList = (agent.skills || [])
    .map((raw) => {
      const s = normalizeSkill(raw, agent.skill);
      return `
      <button class="skill-item" data-action="copy-skill" data-slash="${escape(s.slash)}">
        ${s.slash ? `<span class="slash">${escape(s.slash)}</span>` : ""}
        <span class="label">${escape(s.label)}</span>
      </button>`;
    })
    .join("");

  // Force-expand all proposals on detail view
  const renderOne = (p) => {
    const stableExpanded = state.expandedProps.has(p.id);
    if (!stableExpanded) state.expandedProps.add(p.id);
    return renderProposal(agentId, p, decisions[p.id], generatedAt);
  };

  // Sort proposals by urgency (priority, then due date asc) — most urgent first.
  let proposalsHtml;
  if (!proposals.length) {
    proposalsHtml = `<div class="proposal-empty">No proposals yet · next run ${escape(scheduleLabel(agent))}</div>`;
  } else {
    const sortedProposals = proposals.slice().sort((a, b) => {
      const pa = priorityOrder(a);
      const pb = priorityOrder(b);
      if (pa !== pb) return pa - pb;
      const da = a.due_date || "9999-99-99";
      const db = b.due_date || "9999-99-99";
      return da.localeCompare(db);
    });
    proposalsHtml = sortedProposals.map(renderOne).join("");
  }

  const isRunning = !!state.runningExecutes[agentId];

  $("#detail-view").innerHTML = `
    <div class="detail-back">
      <a href="#" class="back-link">← Back to all agents</a>
    </div>

    <div class="detail-card" style="--card-color:${escape(agent.color)};--card-pastel:${escape(agent.pastel)}">
      <div class="detail-header">
        <div class="detail-emoji">${agent.emoji}</div>
        <div class="detail-title-block">
          <div class="detail-tagline">${escape(agent.tagline)}</div>
          <h1 class="detail-name">${escape(agent.name)}</h1>
          <div class="detail-meta">
            <span class="detail-meta-item">⏰ ${escape(scheduleLabel(agent))}</span>
            ${agent.last_run ? `<span class="detail-meta-item">Last run ${timeAgo(agent.last_run.completed_at)}</span>` : '<span class="detail-meta-item">No runs yet</span>'}
            ${generatedAt ? `<button class="detail-meta-item briefing-chip" data-action="view-briefing" data-agent-id="${escape(agentId)}" title="Open today's briefing">📝 Brief ${timeAgo(generatedAt)}</button>` : ""}
            ${stale ? '<span class="stale-badge">Stale</span>' : ""}
          </div>
          <div class="mcp-row">${mcpRow}</div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-head">
          <h2>Recommended tasks <span class="task-count" style="background:${escape(agent.color)}">${proposals.length}</span></h2>
          <div class="footer-stats"><strong>${touchedCountDetail}</strong> ready · <strong>${todoCountDetail}</strong> to do</div>
        </div>
        <div class="proposal-list detail-proposals">${proposalsHtml}</div>
        <div class="detail-execute-row">
          <button class="btn-execute ${isRunning ? "running" : ""}" data-action="execute" data-agent-id="${escape(agentId)}" ${actionableCountDetail === 0 || isRunning ? "disabled" : ""}>${isRunning ? "Running…" : actionableCountDetail > 0 ? `Execute · ${actionableCountDetail}` : "Execute"}</button>
        </div>
      </div>

      ${(agent.skills || []).length ? `
        <div class="detail-section">
          <h2>Skills <span class="muted-count">${agent.skills.length}</span></h2>
          <div class="detail-skills-grid">${skillsList}</div>
        </div>
      ` : ""}
    </div>
  `;
}

function collectInboxItems(skipAgentFilter = false) {
  let items = [];
  for (const a of state.agents) {
    const data = state.tasksByAgent[a.id];
    if (!data?.tasks?.length) continue;
    for (const p of data.tasks) {
      items.push({
        agent: a,
        proposal: p,
        decision: data.decisions?.[p.id],
        generatedAt: data.generated_at,
      });
    }
  }
  // Merge in recently-completed items loaded from the history archive
  for (const ci of state.completedItems || []) {
    items.push(ci);
  }
  // Agent filter — multi-select. Empty Set = no filter (All).
  if (!skipAgentFilter && state.inboxAgentFilter && state.inboxAgentFilter.size > 0) {
    items = items.filter(it => state.inboxAgentFilter.has(it.agent?.id));
  }
  // Text search
  if (state.inboxSearch && state.inboxSearch.trim()) {
    const q = state.inboxSearch.trim().toLowerCase();
    items = items.filter(it =>
      (it.proposal?.title || "").toLowerCase().includes(q) ||
      (it.proposal?.company_slug || "").toLowerCase().includes(q) ||
      (it.proposal?.company_name || "").toLowerCase().includes(q)
    );
  }
  return items;
}

function groupInboxItems(items) {
  // Kanban flow: To Do → Pending → Scheduled → Queued → Completed
  //  todo: untouched (pristine from cron — Matt hasn't commented/edited)
  //  pending: touched (comment, thread, or body edit) — ready to execute
  //  scheduled: has a due_date strictly in the future (parked for later)
  //  queued: status === "in_progress" — waiting for /execute-* to run
  //  completed: status === "executed" or sourced from history feed
  //
  // Scheduled is checked BEFORE pending/todo so a future-dated card with an
  // existing thread still parks. The moment due_date <= today, it falls
  // through to the normal pending/todo logic — auto-surfacing without a cron run.
  const groups = { todo: [], pending: [], scheduled: [], in_progress: [], completed: [] };
  // Local-date YYYY-MM-DD so this matches the "today/tomorrow" badge (formatDueDate).
  // toISOString() returns UTC — in evening ET that's already tomorrow, which wrongly
  // parks today's cards in the Scheduled column.
  const today = new Date().toLocaleDateString("en-CA");
  for (const it of items) {
    const p = it.proposal;
    const dec = it.decision;
    const status = dec?.status;
    const dueStr = normalizeDateStr(p?.due_date);
    const isFutureDated = dueStr && dueStr > today;

    if (status === "executed") groups.completed.push(it);
    else if (status === "in_progress") groups.in_progress.push(it);
    else if (isFutureDated) groups.scheduled.push(it);
    else if (isTouched(dec)) groups.pending.push(it);
    else groups.todo.push(it);
  }
  // Sort all groups by priority first, then due_date ascending.
  const sortByPriorityThenDate = (a, b) => {
    const pa = priorityOrder(a.proposal);
    const pb = priorityOrder(b.proposal);
    if (pa !== pb) return pa - pb;
    const da = a.proposal.due_date || "9999-99-99";
    const db = b.proposal.due_date || "9999-99-99";
    return da.localeCompare(db);
  };
  // To Do sorts by date first (urgency-forward — overdue bubbles up), then priority.
  // Other groups keep priority-first sort.
  const sortByDateThenPriority = (a, b) => {
    const da = a.proposal.due_date || "9999-99-99";
    const db = b.proposal.due_date || "9999-99-99";
    const dc = da.localeCompare(db);
    if (dc !== 0) return dc;
    return priorityOrder(a.proposal) - priorityOrder(b.proposal);
  };
  groups.todo.sort(sortByDateThenPriority);
  groups.pending.sort(sortByPriorityThenDate);
  groups.scheduled.sort(sortByPriorityThenDate);
  groups.in_progress.sort(sortByPriorityThenDate);
  return groups;
}

function renderInboxHeader(items, groups) {
  const readyCount = groups.pending.length;
  const staleCount = groups.todo.filter(it => {
    const addedAt = it.proposal?.added_at || it.generatedAt;
    return addedAt && (Date.now() - new Date(addedAt)) / 86400000 >= 3;
  }).length;

  // Agent filter pills — built from ALL unfiltered items so the bar stays visible even when a filter is active
  const allItems = collectInboxItems(true);
  const agentIds = [...new Set(allItems.map(it => it.agent?.id).filter(Boolean))];
  const selected = state.inboxAgentFilter;
  const agentFilterHtml = agentIds.length > 1 ? `
    <div class="inbox-agent-filter">
      <button class="inbox-agent-btn${selected.size === 0 ? " active" : ""}" data-inbox-agent="all">All</button>
      ${agentIds.map(id => {
        const ag = state.agents.find(a => a.id === id);
        const active = selected.has(id);
        return `<button class="inbox-agent-btn${active ? " active" : ""}" data-inbox-agent="${escape(id)}">${ag ? ag.emoji + " " + escape(ag.name) : escape(id)}</button>`;
      }).join("")}
    </div>` : "";

  return `
    <div class="inbox-toolbar">
      <div class="inbox-toolbar-left">
        <h1 class="inbox-title">All tasks</h1>
        <div class="page-toggle">
          <button class="page-toggle-btn${state.inboxMode === "list" ? " page-toggle-btn--active" : ""}" data-inbox-mode="list">List</button>
          <button class="page-toggle-btn${state.inboxMode === "kanban" ? " page-toggle-btn--active" : ""}" data-inbox-mode="kanban">Kanban</button>
          <button class="page-toggle-btn${state.inboxMode === "database" ? " page-toggle-btn--active" : ""}" data-inbox-mode="database">Table</button>
        </div>
      </div>
      <div class="inbox-toolbar-right">
        <input class="inbox-search" type="text" placeholder="Search tasks…" value="${escape(state.inboxSearch)}" id="inbox-search-input">
        <button class="btn-ghost inbox-add-btn" id="inbox-add-task">+ Add task</button>
        <button class="btn-primary" id="inbox-execute-all" ${readyCount === 0 ? "disabled" : ""}>${readyCount > 0 ? `Execute all · ${readyCount}` : "Execute all"}</button>
      </div>
    </div>
    ${agentFilterHtml}
    <div class="inbox-summary-bar">
      <strong>${groups.todo.length}</strong> to do${staleCount ? ` <span class="stale-nudge">(${staleCount} aging)</span>` : ""} · <strong>${groups.pending.length}</strong> ready · <strong>${groups.scheduled.length}</strong> scheduled · <strong>${groups.in_progress.length}</strong> in progress · <strong>${groups.completed.length}</strong> completed
    </div>
    <div id="inbox-add-form" class="inbox-add-form" style="display:none">
      <div class="inbox-add-form-inner">
        <input class="inbox-add-input" type="text" placeholder="Task title…" id="inbox-add-title">
        <select class="inbox-add-select" id="inbox-add-agent">
          ${state.agents.map(a => `<option value="${escape(a.id)}">${a.emoji} ${escape(a.name)}</option>`).join("")}
        </select>
        <select class="inbox-add-select" id="inbox-add-action">
          ${Object.entries(ACTION_LABELS).map(([k,v]) => `<option value="${escape(k)}">${escape(v)}</option>`).join("")}
        </select>
        <input class="inbox-add-input inbox-add-date" type="date" id="inbox-add-due">
        <div class="inbox-add-btns">
          <button class="btn-primary" id="inbox-add-submit">Add</button>
          <button class="btn-ghost" id="inbox-add-cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderInbox() {
  const items = collectInboxItems();
  const groups = groupInboxItems(items);

  if (items.length === 0) {
    $("#inbox-view").innerHTML = `
      ${renderInboxHeader(items, groups)}
      <div class="inbox-empty"><div style="font-size:42px;margin-bottom:12px">☕</div><div>No proposals from any agent yet today.</div></div>
    `;
    return;
  }

  const inboxEl = $("#inbox-view");
  inboxEl.classList.remove("kanban-mode", "database-mode");
  if (state.inboxMode === "kanban") {
    inboxEl.classList.add("kanban-mode");
    renderInboxKanban(items, groups);
  } else if (state.inboxMode === "database") {
    inboxEl.classList.add("database-mode");
    renderInboxDatabase(items, groups);
  } else {
    renderInboxList(items, groups);
  }
}

// Database view — flat sortable table of every item collected from the inbox
// data source (proposals + recently-completed history). Same data as List/Kanban,
// just a denser tabular layout for scanning + bulk-eyeballing.
function renderInboxDatabase(items, groups) {
  const STATE_LABELS = {
    todo: "To do",
    pending: "Ready",
    scheduled: "Scheduled",
    in_progress: "In progress",
    completed: "Completed",
  };
  const stateOf = (it) => {
    for (const k of Object.keys(groups)) {
      if (groups[k].includes(it)) return k;
    }
    return "todo";
  };

  // Sort: by state bucket order, then by priority, then by due_date asc.
  const stateOrder = { todo: 0, pending: 1, scheduled: 2, in_progress: 3, completed: 4 };
  const sorted = items.slice().sort((a, b) => {
    const sa = stateOrder[stateOf(a)] ?? 99;
    const sb = stateOrder[stateOf(b)] ?? 99;
    if (sa !== sb) return sa - sb;
    const pa = priorityOrder(a.proposal);
    const pb = priorityOrder(b.proposal);
    if (pa !== pb) return pa - pb;
    const da = a.proposal.due_date || "9999-99-99";
    const db = b.proposal.due_date || "9999-99-99";
    return da.localeCompare(db);
  });

  const rowHtml = sorted.map((it) => {
    const { agent, proposal: p } = it;
    const st = stateOf(it);
    const actionLabel = ACTION_LABELS[p.action_type] || (p.action_type || "").replace(/_/g, " ");
    const dueStr = normalizeDateStr(p.due_date);
    const dueCell = dueStr ? escape(formatDueDate(dueStr)) : "—";
    const company = p.company_slug ? escape(p.company_slug) : "—";
    return `
      <tr class="clickable" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">
        <td><span class="agent-tag" style="background:${escape(agent.pastel)};color:${escape(agent.color)}">${agent.emoji} ${escape(agent.name)}</span></td>
        <td>${escape(p.title || "")}</td>
        <td>${actionLabel ? `<span class="action-chip">${escape(actionLabel)}</span>` : "—"}</td>
        <td>${renderPriorityBadge(p.priority) || "—"}</td>
        <td>${dueCell}</td>
        <td>${company}</td>
        <td><span class="db-state-pill db-state-${st}">${escape(STATE_LABELS[st] || st)}</span></td>
      </tr>
    `;
  }).join("");

  $("#inbox-view").innerHTML = `
    ${renderInboxHeader(items, groups)}
    <div class="db-table-wrap">
      <table class="db-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Title</th>
            <th>Action</th>
            <th>Priority</th>
            <th>Due</th>
            <th>Company</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>${rowHtml || `<tr><td colspan="7" class="db-empty">No tasks.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function renderInboxList(items, groups) {
  // Render a section header row inside the shared table
  const renderSectionRow = (label, count, tone, collapsible = false, collapsed = false) => `
    <tr class="inbox-section-row inbox-section-${tone}" ${collapsible ? "data-toggle-completed" : ""} style="${collapsible ? "cursor:pointer" : ""}">
      <td colspan="6" class="inbox-section-cell">
        <span class="inbox-section-label">${escape(label)}</span>
        <span class="inbox-group-count">${count}</span>
        ${collapsible ? `<span class="inbox-group-chevron${collapsed ? "" : " open"}">${collapsed ? "▸" : "▾"}</span>` : ""}
      </td>
    </tr>`;

  const renderGroupRows = (groupItems) =>
    groupItems.map(({ agent, proposal: p, decision, generatedAt }) => {
      const comment = decision?.comment || "";
      const edits = decision?.edits || {};
      const editedBody = edits.body ?? null;
      const touched = isTouched(decision);
      const actionLabel = ACTION_LABELS[p.action_type] || (p.action_type || "").replace(/_/g, " ");
      const isExpanded = state.expandedProps.has(p.id);
      const addedAt = p.added_at || generatedAt;
      const ageDays = addedAt ? Math.floor((Date.now() - new Date(addedAt)) / 86400000) : 0;
      const ageClass = ageDays >= 5 ? "age-critical" : ageDays >= 3 ? "age-warn" : "";
      const stateClass = touched ? "touched" : "";
      const isCarryForward = /carry.?forward/i.test(p.title);
      const showMenu = decision?.status !== "executed";
      const dueStr = normalizeDateStr(p.due_date);
      const dueDisplay = dueStr ? (() => {
        const d = new Date(dueStr + "T00:00:00");
        const today = new Date(); today.setHours(0,0,0,0);
        const diff = Math.round((d - today) / 86400000);
        const isOverdue = diff < 0;
        const lbl = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday"
          : Math.abs(diff) < 30 ? `${Math.abs(diff)}d ${isOverdue ? "ago" : ""}`
          : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `<span class="due-chip${isOverdue ? " overdue" : ""}">${escape(lbl)}</span>`;
      })() : "";
      const titleText = escape(p.title.replace(/\s*-?\s*CARRY\s*FORWARD\s*/gi, "").trim());
      const companyName = p.company_name || p.company_slug || "";
      const previewHtml = renderPreview(p.preview, editedBody);
      const rationaleHtml = p.rationale ? `<div class="proposal-rationale">${escape(p.rationale)}</div>` : "";
      return `
        <tr class="inbox-tr inbox-tr-clickable ${stateClass} ${ageClass} ${isExpanded ? "expanded" : ""}" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}" data-action="toggle-prop" style="--card-color:${escape(agent.color)}">
          <td class="inbox-td-agent">
            <span class="agent-tag" style="background:${escape(agent.pastel)};color:${escape(agent.color)}">${agent.emoji} ${escape(agent.name)}</span>
          </td>
          <td class="inbox-td-title">
            ${isCarryForward ? '<span class="carry-badge">CARRY</span>' : ""}
            <span class="inbox-tr-title">${titleText}</span>
            ${comment ? `<span class="inbox-comment-preview" title="Comment saved">${escape(comment)}</span>` : ""}
          </td>
          <td class="inbox-td-company">${companyName ? `<span class="inbox-company">${escape(companyName)}</span>` : "<span class='db-null'></span>"}</td>
          <td class="inbox-td-action">${actionLabel ? `<span class="action-chip">${escape(actionLabel)}</span>` : "<span class='db-null'>—</span>"}</td>
          <td class="inbox-td-priority">${renderPriorityBadge(p.priority) || "<span class='db-null'>—</span>"}</td>
          <td class="inbox-td-due">${dueDisplay || "<span class='db-null'>—</span>"}</td>
        </tr>
        <tr class="inbox-tr-detail ${isExpanded ? "" : "hidden"}" data-detail-for="${escape(p.id)}">
          <td colspan="6" class="inbox-td-detail">
            ${rationaleHtml}
            ${previewHtml}
            ${comment ? `<div class="inbox-detail-comment-row"><span class="inbox-detail-comment-label">Your comment:</span> <span class="inbox-detail-comment-text">${escape(comment)}</span></div>` : ""}
            ${showMenu ? `<div class="inbox-detail-actions">
              <button class="row-action-btn row-action-reply" data-action="open-reply" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">${comment ? "Edit reply" : "Reply"}</button>
              <button class="row-action-btn row-action-done" data-resolve="completed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">✓ Done</button>
              <button class="row-action-btn row-action-dismiss" data-resolve="dismissed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">✗ Dismiss</button>
            </div>` : ""}
          </td>
        </tr>`;
    }).join("");

  const todoBuckets = (() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const b = { overdue: [], today: [], week: [], later: [], undated: [] };
    for (const it of groups.todo) {
      const dateStr = normalizeDateStr(it.proposal?.due_date);
      if (!dateStr) { b.undated.push(it); continue; }
      const d = new Date(dateStr + "T00:00:00");
      if (isNaN(d.getTime())) { b.undated.push(it); continue; }
      const diff = Math.round((d - today) / 86400000);
      if (diff < 0) b.overdue.push(it);
      else if (diff === 0) b.today.push(it);
      else if (diff < 7) b.week.push(it);
      else b.later.push(it);
    }
    return b;
  })();

  const bucketDefs = [
    { key: "overdue", label: "Overdue", tone: "overdue" },
    { key: "today",   label: "Today",    tone: "today" },
    { key: "week",    label: "This week", tone: "week" },
    { key: "later",   label: "Later",    tone: "later" },
    { key: "undated", label: "No date",  tone: "undated" },
  ];

  const completedCollapsed = state.completedCollapsed;
  let tableBody = "";
  if (groups.todo.length) {
    tableBody += renderSectionRow("To do", groups.todo.length, "todo");
    for (const b of bucketDefs) {
      if (!todoBuckets[b.key].length) continue;
      tableBody += renderSectionRow(b.label, todoBuckets[b.key].length, b.key);
      tableBody += renderGroupRows(todoBuckets[b.key]);
    }
  }
  if (groups.in_progress.length) {
    tableBody += renderSectionRow("In Progress", groups.in_progress.length, "in-progress");
    tableBody += renderGroupRows(groups.in_progress);
  }
  if (groups.pending.length) {
    tableBody += renderSectionRow("Pending", groups.pending.length, "pending");
    tableBody += renderGroupRows(groups.pending);
  }
  if (groups.scheduled.length) {
    tableBody += renderSectionRow("Scheduled", groups.scheduled.length, "scheduled");
    tableBody += renderGroupRows(groups.scheduled);
  }
  if (groups.completed.length) {
    tableBody += renderSectionRow("Completed", groups.completed.length, "completed", true, completedCollapsed);
    if (!completedCollapsed) tableBody += renderGroupRows(groups.completed);
  }

  $("#inbox-view").innerHTML = `
    ${renderInboxHeader(items, groups)}
    <div class="inbox-table-wrap">
      <table class="inbox-table">
        <thead>
          <tr class="inbox-thead-row">
            <th class="inbox-th-agent">Agent</th>
            <th class="inbox-th-title">Title</th>
            <th class="inbox-th-company">Company</th>
            <th class="inbox-th-action">Action</th>
            <th class="inbox-th-priority">Priority</th>
            <th class="inbox-th-due">Due</th>
          </tr>
        </thead>
        <tbody>${tableBody}</tbody>
      </table>
    </div>
  `;
}

function renderInboxKanban(items, groups) {
  const column = (key, label, tone, items, droppable = true) => `
    <div class="kanban-col kanban-${tone}${droppable ? " droppable" : ""}" data-drop-target="${escape(key)}">
      <div class="kanban-col-head">
        <span class="kanban-col-label">${escape(label)}</span>
        <span class="kanban-col-count">${items.length}</span>
      </div>
      <div class="kanban-col-body">
        ${items.length
          ? items.map((it) => renderKanbanCard(it)).join("")
          : `<div class="kanban-empty">No tasks</div>`
        }
      </div>
    </div>
  `;

  $("#inbox-view").innerHTML = `
    ${renderInboxHeader(items, groups)}
    <div class="inbox-kanban-wrap">
      <div class="kanban-board">
        ${column("todo", "To do", "todo", groups.todo, true)}
        ${column("pending", "Pending", "pending", groups.pending, true)}
        ${column("scheduled", "Scheduled", "scheduled", groups.scheduled, true)}
        ${column("in_progress", "In Progress", "in-progress", groups.in_progress, true)}
        ${column("completed", "Completed", "completed", groups.completed, true)}
      </div>
    </div>
    <div class="inbox-kanban-scrollbar-proxy"><div></div></div>
  `;
}

// Due-date chip on a kanban card. Clickable → opens a native date picker and
// PUTs /due_date. Hidden on completed/executed cards (no point scheduling
// something that's already done). Queued cards also skip the chip since
// they're waiting on execution and editing dates mid-flight is confusing.
function renderDueDateBadge(p, decision) {
  const status = decision?.status;
  const dateStr = normalizeDateStr(p?.due_date);
  const isOverdue = dateStr && new Date(dateStr + "T00:00:00") < new Date(new Date().toDateString());
  const overdueClass = isOverdue ? " meta-due-overdue" : "";
  const dueValue = dateStr || "";
  if (status === "executed" || status === "in_progress") {
    return dateStr ? `<span class="meta-due meta-due-locked${overdueClass}">📅 ${escape(formatDueDate(dateStr))}</span>` : "";
  }
  if (dateStr) {
    return `<span class="meta-due${overdueClass}" data-due-edit="1" data-due-value="${escape(dueValue)}" title="Click to change or clear">📅 ${escape(formatDueDate(dateStr))}</span>`;
  }
  return `<span class="meta-due meta-due-empty" data-due-edit="1" data-due-value="" title="Schedule for later">+ date</span>`;
}

function renderKanbanCard({ agent, proposal: p, decision, generatedAt }) {
  const actionLabel = ACTION_LABELS[p.action_type] || (p.action_type || "").replace(/_/g, " ");
  const hasComment = (decision?.comment || "").trim().length > 0;
  const hasThread = Array.isArray(decision?.thread) && decision.thread.some((m) => m.role === "matt");
  const isEdited = !!decision?.edits?.body;
  const addedAt = p.added_at || generatedAt;
  const isInProgress = decision?.status === "in_progress";
  const touched = isTouched(decision);

  const showMenu = decision?.status !== "executed";

  return `
    <div class="kanban-card ${touched ? "touched" : ""}" draggable="true" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}" style="--card-color:${escape(agent.color)}">
      <div class="kanban-card-head">
        <span class="agent-tag" style="background:${escape(agent.pastel)};color:${escape(agent.color)}">${agent.emoji} ${escape(agent.name)}</span>
        <div class="kanban-card-head-right">
          ${renderPriorityBadge(p.priority)}
          ${actionLabel ? `<span class="action-chip">${escape(actionLabel)}</span>` : ""}
          ${showMenu ? `<div class="card-menu-wrap">
            <button class="card-menu-btn" data-action="card-menu" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}" title="Actions">&#8943;</button>
            <div class="card-menu-dropdown" data-menu-for="${escape(p.id)}">
              <button class="card-menu-item" data-resolve="completed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">&#10003; Mark complete</button>
              <button class="card-menu-item card-menu-item--danger" data-resolve="dismissed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">&#10005; Dismiss</button>
            </div>
          </div>` : ""}
        </div>
      </div>
      <div class="kanban-card-title">${escape(p.title)}</div>
      ${hasComment || hasThread || isEdited ? `
        <div class="kanban-card-flags">
          ${isEdited ? '<span class="kanban-flag edited">edited</span>' : ""}
          ${hasComment || hasThread ? '<span class="kanban-flag comment">💬 comment</span>' : ""}
        </div>
      ` : ""}
      <div class="kanban-card-meta">
        ${addedAt ? `<span class="meta-time">${timeAgo(addedAt)}</span>` : ""}
        ${renderDueDateBadge(p, decision)}
      </div>
      ${isInProgress ? `
        <div class="kanban-card-in-progress"><span class="spinner"></span>In progress — /execute-${escape(agent.id)}</div>
      ` : ""}
    </div>
  `;
}

function renderInboxRow(agent, p, decisionRecord, generatedAt) {
  const comment = decisionRecord?.comment || "";
  const edits = decisionRecord?.edits || {};
  const editedBody = edits.body ?? null;
  const touched = isTouched(decisionRecord);
  const stateClass = touched ? "touched" : "";
  const actionLabel = ACTION_LABELS[p.action_type] || (p.action_type || "").replace(/_/g, " ");
  const isExpanded = state.expandedProps.has(p.id);
  const addedAt = p.added_at || generatedAt;

  // Aging urgency: how many days since added
  const ageDays = addedAt ? Math.floor((Date.now() - new Date(addedAt)) / 86400000) : 0;
  const ageClass = ageDays >= 5 ? "age-critical" : ageDays >= 3 ? "age-warn" : "";

  // Detect CARRY FORWARD in title
  const isCarryForward = /carry.?forward/i.test(p.title);

  const showMenu = decisionRecord?.status !== "executed";

  return `
    <div class="proposal inbox-row ${stateClass} ${ageClass} ${isExpanded ? "expanded" : ""}" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}" style="--card-color:${escape(agent.color)}">
      <div class="proposal-row">
        <button class="prop-chevron" data-action="toggle-prop" aria-label="Expand">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="proposal-content">
          <span class="meta-slot meta-slot--priority">${renderPriorityBadge(p.priority)}</span>
          <span class="meta-slot meta-slot--action">${actionLabel ? `<span class="action-chip">${escape(actionLabel)}</span>` : ""}</span>
          <span class="meta-slot meta-slot--due">${renderDueDateChip(p.due_date)}</span>
          <div class="proposal-title">${isCarryForward ? '<span class="carry-badge">CARRY</span>' : ""}<span class="agent-tag inline" style="background:${escape(agent.pastel)};color:${escape(agent.color)}" title="${escape(agent.name)}">${agent.emoji}</span>${escape(p.title.replace(/\s*-?\s*CARRY\s*FORWARD\s*/gi, "").trim())}${p.company_name || p.company_slug ? `<span class="inbox-company">${escape(p.company_name || p.company_slug)}</span>` : ""}</div>
        </div>
        ${showMenu ? `<div class="card-menu-wrap">
          <button class="card-menu-btn" data-action="card-menu" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}" title="Actions">&#8943;</button>
          <div class="card-menu-dropdown" data-menu-for="${escape(p.id)}">
            <button class="card-menu-item" data-resolve="completed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">&#10003; Mark complete</button>
            <button class="card-menu-item card-menu-item--danger" data-resolve="dismissed" data-prop-id="${escape(p.id)}" data-agent="${escape(agent.id)}">&#10005; Dismiss</button>
          </div>
        </div>` : ""}
      </div>
      <textarea class="proposal-comment" placeholder="Type yes to approve, or tell the agent what to change…" data-action="comment">${escape(comment)}</textarea>
      <div class="proposal-detail ${isExpanded ? "" : "hidden"}">
        <div class="proposal-rationale">${escape(p.rationale || "")}</div>
        ${renderPreview(p.preview, editedBody)}
      </div>
    </div>
  `;
}

async function renderHistory() {
  const view = $("#history-view");
  view.innerHTML = `<div class="history-loading">Loading history…</div>`;

  let events = [];
  try {
    const r = await fetch("/api/history?limit=300");
    events = await r.json();
  } catch {
    view.innerHTML = `<div class="history-loading">Failed to load history.</div>`;
    return;
  }

  if (!events.length) {
    view.innerHTML = `
      <div class="history-header">
        <div class="inbox-eyebrow">Activity log</div>
        <h1 class="inbox-title">History</h1>
      </div>
      <div class="inbox-empty">
        <div style="font-size:42px;margin-bottom:12px">📭</div>
        <div>Nothing has happened yet. Cron runs and executions will show up here.</div>
      </div>`;
    return;
  }

  // Group by day
  const groups = new Map();
  for (const e of events) {
    const day = new Date(e.timestamp).toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  }

  const dayLabel = (d) => {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (d === today) return "Today";
    if (d === yesterday) return "Yesterday";
    return new Date(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  };

  const eventIcon = (e) => {
    if (e.type === "cron") return "⏰";
    if (e.type === "execute") return "⚡";
    if (e.type === "decision") {
      if (e.decision === "yes") return e.executed ? "✅" : "👍";
      return "❌";
    }
    return "•";
  };

  const renderEvent = (e) => {
    const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const editsBadge = e.edits ? '<span class="edited-badge" style="position:static;margin-left:6px">edited</span>' : "";
    const actionChip = e.action_type
      ? `<span class="action-chip">${escape(ACTION_LABELS[e.action_type] || e.action_type)}</span>`
      : "";
    const statusBadge = e.type === "cron" && e.status === "error"
      ? '<span class="history-status error">error</span>'
      : "";

    return `
      <div class="history-row history-${e.type} ${e.decision || ""}">
        <div class="history-icon">${eventIcon(e)}</div>
        <div class="history-content">
          <div class="history-title">
            <span>${escape(e.title)}</span>
            ${actionChip}
            ${editsBadge}
            ${statusBadge}
          </div>
          ${e.summary ? `<div class="history-summary">${escape(e.summary)}</div>` : ""}
          <div class="history-meta">
            <span class="history-agent" style="color:${escape(e.agent_color || "#666")}">${e.agent_emoji || ""} ${escape(e.agent_name)}</span>
            <span class="history-time">${time}</span>
            ${e.run_id ? `<span class="history-runid">run ${escape(e.run_id)}</span>` : ""}
          </div>
        </div>
      </div>`;
  };

  const groupsHtml = [...groups.entries()]
    .map(
      ([day, list]) => `
      <div class="history-day-group">
        <div class="history-day-label">${escape(dayLabel(day))} <span class="muted-count">${list.length}</span></div>
        <div class="history-list">${list.map(renderEvent).join("")}</div>
      </div>`
    )
    .join("");

  view.innerHTML = `
    <div class="history-header">
      <div class="inbox-eyebrow">Activity log</div>
      <h1 class="inbox-title">History</h1>
      <div class="inbox-summary">${events.length} events · ${groups.size} days</div>
    </div>
    ${groupsHtml}
  `;
}

function route() {
  // Always snapshot drafts before any view switch / re-render
  snapshotDrafts();

  // Backward-compat: old DB Companies routes redirect to the unified Companies tab.
  // The DB sub-nav no longer has a Companies entry — toggle Coverage/Table/Kanban
  // lives at the top of the new tab instead.
  if (location.hash === "#/db/companies") { location.replace("#/companies?mode=table"); return; }
  const dbCompanyOldM = location.hash.match(/^#\/db\/companies\/([\w-]+)$/);
  if (dbCompanyOldM) { location.replace("#/companies/" + dbCompanyOldM[1]); return; }

  const hash = location.hash;
  const detailM = hash.match(/^#\/agent\/([\w-]+)$/);
  const dbCompanyM = hash.match(/^#\/db\/companies\/([\w-]+)$/);
  const dbMeetingM = hash.match(/^#\/db\/meetings\/([\w-]+)$/);
  const githubRepoM = hash.match(/^#\/github\/([\w.-]+)$/);
  const companyDetailM = hash.match(/^#\/companies\/([\w-]+)$/);
  const isInbox = hash === "#/inbox" || hash === "#/tasks";
  const isAgents = hash === "#/agents" || hash === "#";
  const isHistory = hash === "#/history";
  const isReports = hash === "#/reports";
  const isDb = hash === "#/db" || hash.startsWith("#/db/");
  const isGithub = hash === "#/github" || hash.startsWith("#/github/");
  const isCompanies = hash === "#/companies" || hash.startsWith("#/companies/");
  const projectDetailM = hash.match(/^#\/projects\/([\w-]+)$/);
  const isProjects = hash === "#/projects" || hash.startsWith("#/projects/");

  $("#grid-view").hidden = true;
  $("#detail-view").hidden = true;
  $("#inbox-view").hidden = true;
  $("#history-view").hidden = true;
  $("#reports-view").hidden = true;
  $("#db-view").hidden = true;
  $("#github-view").hidden = true;
  $("#companies-view").hidden = true;
  const projectsViewEl = $("#projects-view");
  if (projectsViewEl) projectsViewEl.hidden = true;

  // Determine active view + (if DB) active sub-id, then render the global
  // sidebar BEFORE the main view so the sidebar is always in sync.
  let activeView;
  if (isInbox) activeView = "inbox";
  else if (isAgents || detailM) activeView = "grid";
  else if (isHistory) activeView = "history";
  else if (isReports) activeView = "reports";
  else if (isDb) activeView = "db";
  else if (isGithub) activeView = "github";
  else if (isCompanies) activeView = "companies";
  else if (isProjects) activeView = "projects";
  else activeView = "grid"; // default to agents

  const dbSubId = isDb ? (hash.replace("#/db/", "").replace("#/db", "").split("/")[0] || "companies") : null;
  renderAppSidebar(activeView, dbSubId);

  if (detailM) {
    $("#detail-view").hidden = false;
    renderDetail(detailM[1]);
  } else if (isInbox) {
    $("#inbox-view").hidden = false;
    renderInbox();
  } else if (isAgents) {
    $("#grid-view").hidden = false;
    render();
  } else if (isHistory) {
    $("#history-view").hidden = false;
    renderHistory();
  } else if (dbCompanyM) {
    $("#db-view").hidden = false;
    renderDbCompany(dbCompanyM[1]);
  } else if (dbMeetingM) {
    $("#db-view").hidden = false;
    renderDbMeeting(dbMeetingM[1]);
  } else if (isDb) {
    $("#db-view").hidden = false;
    renderDb(dbSubId || "companies");
  } else if (githubRepoM) {
    $("#github-view").hidden = false;
    renderGithubRepo(githubRepoM[1]);
  } else if (isGithub) {
    $("#github-view").hidden = false;
    renderGithubRepos();
  } else if (companyDetailM) {
    $("#companies-view").hidden = false;
    renderCompanyCoverageDetail(companyDetailM[1]);
  } else if (isCompanies) {
    $("#companies-view").hidden = false;
    renderCompanyCoverage();
  } else if (projectDetailM) {
    if (projectsViewEl) projectsViewEl.hidden = false;
    renderProjectDetail(projectDetailM[1]);
  } else if (isProjects) {
    if (projectsViewEl) projectsViewEl.hidden = false;
    renderProjects();
  } else if (isReports) {
    $("#reports-view").hidden = false;
    loadReportsFeed();
  } else {
    // Default home is the Agents grid
    location.replace("#/agents");
  }
}

async function loadReportsFeed() {
  const el = $("#reports-feed");
  if (!el) return;
  el.innerHTML = '<div class="reports-loading">Loading…</div>';
  try {
    const res = await fetch("/api/briefings/today?days=7");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) {
      el.innerHTML = '<div class="reports-empty">No reports in the last 7 days.</div>';
      return;
    }
    el.innerHTML = rows.map((r) => {
      const agent = state.agents.find((a) => a.id === r.agent);
      return `
        <section class="report-card" style="--card-color:${escape(agent?.color || "#64748b")}">
          <div class="report-card-head">
            <span class="report-card-emoji">${agent?.emoji || "🤖"}</span>
            <span class="report-card-name">${escape(agent?.name || r.agent)}</span>
            <span class="report-card-date">${escape(r.report_date || "")}</span>
            <span class="report-card-age">${timeAgo(r.created_at || r.report_date)}</span>
          </div>
          <div class="briefing-markdown">${renderBriefingMarkdown(r.body || "")}</div>
        </section>`;
    }).join("");
  } catch (err) {
    el.innerHTML = `<div class="reports-empty">Couldn't load reports — ${escape(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", route);

// Scrape any visible thread-draft textareas into the threadDrafts Map
// before we destroy them via re-render. Belt-and-suspenders against
// losing typed text when the user clicks Yes/No or chevron mid-typing.
function snapshotDrafts() {
  document.querySelectorAll('[data-action="thread-draft"]').forEach((ta) => {
    const card = ta.closest(".proposal");
    if (!card) return;
    const propId = card.dataset.propId;
    if (ta.value) {
      threadDrafts.set(propId, ta.value);
    }
  });
  persistDrafts();

  // Also snapshot per-card adhoc chat boxes
  document.querySelectorAll('[data-action="adhoc-input"]').forEach((ta) => {
    const card = ta.closest(".agent-card");
    if (!card) return;
    const agentId = card.dataset.agent;
    if (ta.value) {
      adhocDrafts.set(agentId, ta.value);
    }
  });
  persistAdhoc();
}

function render() {
  snapshotDrafts();

  // Compute total hidden count across all agents for the filter bar hint
  const totalScheduledLater = state.agents.reduce((sum, a) => {
    const data = state.tasksByAgent[a.id];
    if (!data?.tasks) return sum;
    return sum + data.tasks.filter((p) => !isNowForGrid(p, data.decisions?.[p.id])).length;
  }, 0);
  const totalNow = state.agents.reduce((sum, a) => {
    const data = state.tasksByAgent[a.id];
    if (!data?.tasks) return sum;
    return sum + data.tasks.filter((p) => isNowForGrid(p, data.decisions?.[p.id]) && data.decisions?.[p.id]?.status !== "executed").length;
  }, 0);

  const filterBar = $("#grid-filter-bar");
  if (filterBar) {
    const gf = state.gridFilter;
    const totalAll = totalNow + totalScheduledLater;
    const density = state.taskDensity;
    filterBar.innerHTML = `
      <div class="page-toggle-row">
        <div class="page-toggle">
          <button class="page-toggle-btn${gf === "now" ? " page-toggle-btn--active" : ""}" data-grid-filter="now">Now${totalNow > 0 ? ` (${totalNow})` : ""}</button>
          <button class="page-toggle-btn${gf === "scheduled" ? " page-toggle-btn--active" : ""}" data-grid-filter="scheduled">Scheduled${totalScheduledLater > 0 ? ` (${totalScheduledLater})` : ""}</button>
          <button class="page-toggle-btn${gf === "all" ? " page-toggle-btn--active" : ""}" data-grid-filter="all">All${totalAll > 0 ? ` (${totalAll})` : ""}</button>
        </div>
        <div class="page-toggle">
          <button class="page-toggle-btn${density === "comfortable" ? " page-toggle-btn--active" : ""}" data-density="comfortable">Comfortable</button>
          <button class="page-toggle-btn${density === "compact" ? " page-toggle-btn--active" : ""}" data-density="compact">Compact</button>
        </div>
      </div>
    `;
    document.getElementById("agent-grid").dataset.density = density;
  }

  // Snapshot per-card scroll positions so they survive innerHTML replacement
  const scrollSnapshot = new Map();
  document.querySelectorAll(".agent-card").forEach((card) => {
    const agentId = card.dataset.agent;
    const list = card.querySelector(".proposal-list");
    if (list) scrollSnapshot.set(agentId, list.scrollTop);
  });

  $("#agent-grid").innerHTML = state.agents.map(renderActiveCard).join("");
  $("#waiting-section").style.display = "none";

  // Restore scroll positions on the new DOM
  requestAnimationFrame(() => {
    document.querySelectorAll(".agent-card").forEach((card) => {
      const agentId = card.dataset.agent;
      const saved = scrollSnapshot.get(agentId);
      if (saved != null) {
        const list = card.querySelector(".proposal-list");
        if (list) list.scrollTop = saved;
      }
    });
  });

  // also keep the topbar button in sync after a full render
  setTimeout(() => {
    updateCounts();
    // Auto-size any pre-filled textareas (drafts restored from localStorage)
    document
      .querySelectorAll('[data-action="thread-draft"], [data-action="adhoc-input"]')
      .forEach((ta) => {
        if (ta.value) autogrow(ta);
      });
  }, 0);

  // global execute button — must match per-card logic (touched + adhoc + cron)
  const totalActionable = state.agents.reduce((sum, a) => {
    const propData = state.tasksByAgent[a.id];
    if (!propData) return sum;
    const touched = propData.tasks.filter(
      (p) => isTouched(propData.decisions[p.id]) && propData.decisions[p.id]?.status !== "in_progress"
    ).length;
    const hasAdhoc = (adhocDrafts.get(a.id) || "").trim().length > 0;
    const isCronToggled = !!cronToggles.get(a.id);
    return sum + touched + (hasAdhoc ? 1 : 0) + (isCronToggled ? 1 : 0);
  }, 0);
  const btn = $("#execute-all-btn");
  btn.textContent = totalActionable > 0 ? `Execute all · ${totalActionable}` : "Execute all";
  btn.disabled = totalActionable === 0;
}

// ─── Data fetching ──────────────────────────────────────────────
async function loadAll() {
  const agentsRes = await fetch("/api/agents");
  state.agents = await agentsRes.json();
  if (!state.collapsedReports.size) {
    state.collapsedReports = new Set(state.agents.map((a) => a.id));
  }

  await Promise.all(
    state.agents.map(async (a) => {
      const r = await fetch(`/api/agents/${a.id}/tasks`);
      state.tasksByAgent[a.id] = await r.json();
    })
  );

  // Load chat history per agent (non-blocking on failure — chat is additive).
  await Promise.all(
    state.agents.map((a) => loadChatHistory(a.id).catch(() => {}))
  );

  // Load recently-executed items for the Completed column in inbox/kanban.
  // Two sources, deduped by proposal id:
  //   1. /api/completed — proposals with decision.status='executed' (catches
  //      adhocs and archived items that never wrote to the executions table)
  //   2. /api/history — legacy feed keyed off the executions table; still the
  //      best source for /execute-* runs that don't flip proposal_decisions
  // Window is 14 days so Matt can review a reasonable span of recent work.
  try {
    const [completedRes, histRes] = await Promise.all([
      fetch("/api/completed?days=14"),
      fetch("/api/history?limit=200"),
    ]);
    const completedRows = await completedRes.json();
    const events = await histRes.json();

    const byId = new Map();
    for (const ci of completedRows) {
      // Hydrate agent from live state if we have it (richer color/pastel)
      const liveAgent = state.agents.find((a) => a.id === ci.agent.id);
      // Server returns task: {...}; downstream code reads .proposal — alias it.
      const item = { ...ci, agent: liveAgent || ci.agent, proposal: ci.task || ci.proposal };
      byId.set(item.proposal.id, item);
    }

    const since = Date.now() - 14 * 86400 * 1000; // last 14 days
    for (const e of events) {
      if (e.type !== "decision" || !e.executed) continue;
      if (new Date(e.timestamp).getTime() < since) continue;
      const synthId = `${e.run_id}-${e.agent_id}-completed`;
      // Skip if we already have a richer record from /api/completed
      if (byId.has(synthId)) continue;
      const agent = state.agents.find((a) => a.id === e.agent_id) || {
        id: e.agent_id,
        name: e.agent_name,
        color: e.agent_color,
        pastel: "#f5f5f4",
        emoji: e.agent_emoji || "",
      };
      byId.set(synthId, {
        agent,
        proposal: {
          id: synthId,
          title: e.title,
          rationale: e.summary || "",
          action_type: e.action_type,
          preview: {},
        },
        decision: {
          decision: "yes",
          status: "executed",
          thread: [],
          executed_at: e.timestamp,
        },
        generatedAt: e.timestamp,
      });
    }

    state.completedItems = Array.from(byId.values());
  } catch {
    state.completedItems = [];
  }

  route();
}

// ─── Interactions ───────────────────────────────────────────────
async function setDecision(agentId, propId, decision, comment, opts = {}) {
  // local optimistic update FIRST so UI is instant.
  // Critical: PRESERVE the thread + edits when toggling — only mutate decision/status.
  const data = state.tasksByAgent[agentId];
  if (data) {
    const existing = data.decisions[propId] || { thread: [] };
    const hasThread = Array.isArray(existing.thread) && existing.thread.length > 0;
    if (decision === null) {
      if (hasThread) {
        // Keep the thread, just clear the decision
        data.decisions[propId] = { ...existing, decision: null, status: null };
      } else {
        delete data.decisions[propId];
      }
    } else {
      data.decisions[propId] = {
        ...existing,
        decision,
        comment: comment !== undefined ? comment : existing.comment || "",
      };
    }
  }
  if (!opts.skipRender) preserveFocusAndRender();

  // server PUT after — fire and forget
  fetch(`/api/agents/${agentId}/tasks/${propId}/decision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, comment }),
  }).catch(() => {});
}

async function sendThreadMessage(agentId, propId, text) {
  // Optimistic local update — thread message is the decision.
  // Claude's execute router reads the thread and classifies it.
  const data = state.tasksByAgent[agentId];
  if (data) {
    const existing = data.decisions[propId] || { thread: [] };
    const thread = Array.isArray(existing.thread) ? [...existing.thread] : [];
    thread.push({ role: "matt", ts: new Date().toISOString(), text });
    data.decisions[propId] = {
      ...existing,
      thread,
      status: existing.status || "needs_refinement",
    };
  }
  // Keep this proposal expanded so the new message is visible
  state.expandedProps.add(propId);
  route();
  toast("Message added — run /execute-{agent} to process");

  // Server save
  fetch(`/api/agents/${agentId}/tasks/${propId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, role: "matt" }),
  }).catch(() => {});
}

// Debounced body-edit writer
const editDebounce = new Map();
function queueEditSave(agentId, propId, bodyText) {
  const data = state.tasksByAgent[agentId];
  if (!data) return;
  const proposal = data.tasks.find((p) => p.id === propId);
  if (!proposal) return;
  const original = proposal.preview?.body ?? proposal.preview?.body_snippet ?? "";

  const existing = data.decisions[propId] || {};
  const edits = { ...(existing.edits || {}) };
  if (bodyText === original) {
    delete edits.body;
  } else {
    edits.body = bodyText;
  }
  // Any edit = touched = actionable. No need for a yes/no decision.
  data.decisions[propId] = {
    ...existing,
    edits: Object.keys(edits).length ? edits : undefined,
  };

  // Surgical visual update — toggle the edited badge + flip to touched state
  const card = document.querySelector(`[data-prop-id="${CSS.escape(propId)}"]`);
  if (card) {
    const wrap = card.querySelector(".preview-body-wrap");
    if (wrap) {
      const isEdited = edits.body !== undefined;
      wrap.classList.toggle("edited", isEdited);
      let badge = wrap.querySelector(".edited-badge");
      if (isEdited && !badge) {
        badge = document.createElement("span");
        badge.className = "edited-badge";
        badge.textContent = "edited";
        wrap.prepend(badge);
      } else if (!isEdited && badge) {
        badge.remove();
      }
    }
    // Flip the card to "touched" state
    card.classList.remove("yes", "no");
    card.classList.toggle("touched", isTouched(data.decisions[propId]));
  }
  updateCounts();

  clearTimeout(editDebounce.get(propId));
  editDebounce.set(
    propId,
    setTimeout(() => {
      fetch(`/api/agents/${agentId}/tasks/${propId}/decision`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edits: Object.keys(edits).length ? edits : null,
        }),
      }).catch(() => {});
    }, 400)
  );
}

// Debounced comment writer — saves on every keystroke without nuking the DOM
const commentDebounce = new Map(); // propId -> timeout id
function queueCommentSave(agentId, propId, comment) {
  const data = state.tasksByAgent[agentId];
  if (!data) return;
  // Optimistic local update — no render. Any comment = touched = actionable.
  const existing = data.decisions[propId] || {};
  data.decisions[propId] = { ...existing, comment };

  // Update the comment-toggle button styling + touched state without re-render
  const card = document.querySelector(`[data-prop-id="${CSS.escape(propId)}"]`);
  if (card) {
    const btn = card.querySelector(".comment-toggle");
    if (btn) btn.classList.toggle("has-comment", comment.trim().length > 0);
    card.classList.remove("yes", "no");
    card.classList.toggle("touched", isTouched(data.decisions[propId]));
  }

  // Update footer/global counts without touching textareas
  updateCounts();

  // Debounce server save
  clearTimeout(commentDebounce.get(propId));
  commentDebounce.set(
    propId,
    setTimeout(() => {
      fetch(`/api/agents/${agentId}/tasks/${propId}/decision`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
      }).catch(() => {});
    }, 300)
  );
}

// Track the most recently focused comment textarea so we can restore it
// after a re-render even if focus has already moved (e.g. user clicked an
// Approve button mid-typing).
let lastCommentSnapshot = null;
// Find the proposal id + agent id from any element inside a task row (works for
// both the old .proposal card and the new .inbox-tr / .inbox-tr-detail table rows).
function propContext(el) {
  const card = el.closest(".proposal") || el.closest(".inbox-tr");
  if (card) return { propId: card.dataset.propId, agentId: card.dataset.agent };
  const detailRow = el.closest(".inbox-tr-detail");
  if (detailRow) {
    const propId = detailRow.dataset.detailFor;
    const taskRow = document.querySelector(`.inbox-tr[data-prop-id="${CSS.escape(propId)}"]`);
    return { propId, agentId: taskRow?.dataset.agent };
  }
  return { propId: null, agentId: null };
}

// ─── Reply modal ────────────────────────────────────────────────
function openReplyModal(propId, agentId) {
  const existing = document.getElementById("reply-modal");
  if (existing) existing.remove();

  // Find current comment
  const agentData = state.tasksByAgent[agentId];
  const task = agentData?.tasks?.find(t => t.id === propId);
  const currentComment = agentData?.decisions?.[propId]?.comment || "";
  const title = task?.title || "";

  const modal = document.createElement("div");
  modal.id = "reply-modal";
  modal.className = "reply-modal-overlay";
  modal.innerHTML = `
    <div class="reply-modal">
      <div class="reply-modal-header">
        <span class="reply-modal-title">${escape(title)}</span>
        <button class="reply-modal-close" id="reply-modal-close">&times;</button>
      </div>
      <textarea class="reply-modal-textarea" id="reply-modal-ta" placeholder="Type yes to approve, or tell the agent what to change…">${escape(currentComment)}</textarea>
      <div class="reply-modal-footer">
        <button class="reply-modal-btn reply-modal-cancel" id="reply-modal-cancel">Cancel</button>
        <button class="reply-modal-btn reply-modal-save" id="reply-modal-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const ta = document.getElementById("reply-modal-ta");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => modal.remove();
  const save = () => {
    const val = ta.value;
    queueCommentSave(agentId, propId, val);
    close();
    preserveFocusAndRender();
  };

  document.getElementById("reply-modal-close").addEventListener("click", close);
  document.getElementById("reply-modal-cancel").addEventListener("click", close);
  document.getElementById("reply-modal-save").addEventListener("click", save);
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
  ta.addEventListener("keydown", e => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  });
}

document.addEventListener("focusin", (e) => {
  if (e.target.matches('[data-action="comment"]')) {
    const card = e.target.closest(".proposal") || e.target.closest(".inbox-tr-detail") || e.target.closest(".inbox-tr");
    lastCommentSnapshot = {
      propId: card?.dataset.propId || card?.dataset.detailFor,
      selectionStart: e.target.selectionStart,
      selectionEnd: e.target.selectionEnd,
      value: e.target.value,
    };
  }
});
document.addEventListener("focusout", (e) => {
  if (e.target.matches('[data-action="comment"]')) {
    // Keep the snapshot for ~250ms in case a click handler is about to re-render
    setTimeout(() => { lastCommentSnapshot = null; }, 250);
  }
});

function preserveFocusAndRender() {
  const snapshot = lastCommentSnapshot;
  route();
  if (snapshot) {
    const card = document.querySelector(`[data-prop-id="${CSS.escape(snapshot.propId)}"]`);
    const ta = card?.querySelector('[data-action="comment"]');
    if (ta) {
      ta.classList.remove("hidden");
      ta.value = snapshot.value;
      ta.focus();
      try { ta.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd); } catch {}
    }
  }
}

// Surgical recount of ready/to-do counts without re-rendering
function updateCounts() {
  // Per-card footers
  document.querySelectorAll(".agent-card").forEach((card) => {
    const agentId = card.dataset.agent;
    const data = state.tasksByAgent[agentId];
    if (!data) return;
    // Only count items that aren't already queued
    const notInProg = (p) => data.decisions[p.id]?.status !== "in_progress";
    const touched = data.tasks.filter(
      (p) => isTouched(data.decisions[p.id]) && notInProg(p)
    ).length;
    const todo = data.tasks.filter(
      (p) => !isTouched(data.decisions[p.id]) && notInProg(p)
    ).length;
    const stats = card.querySelector(".footer-stats");
    if (stats) {
      stats.innerHTML = `<strong>${touched}</strong> ready · <strong>${todo}</strong> to do`;
    }
    const isCronToggled = !!cronToggles.get(agentId);
    const exec = card.querySelector('[data-action="execute"]');
    if (exec) {
      const hasAdhoc = (adhocDrafts.get(agentId) || "").trim().length > 0;
      const actionable = touched + (hasAdhoc ? 1 : 0) + (isCronToggled ? 1 : 0);
      exec.textContent = actionable > 0 ? `Execute · ${actionable}` : "Execute";
      exec.disabled = actionable === 0;
    }
    // Sync ▶ cron button visual state
    const cronBtn = card.querySelector('[data-action="toggle-cron"]');
    if (cronBtn) cronBtn.classList.toggle("cron-active", isCronToggled);
  });
  // Global topbar button — must match per-card logic (touched + adhoc + cron toggle)
  const totalActionable = state.agents.reduce((s, a) => {
    const d = state.tasksByAgent[a.id];
    if (!d) return s;
    const touched = d.tasks.filter((p) => {
      const status = d.decisions[p.id]?.status;
      return isTouched(d.decisions[p.id]) && status !== "in_progress";
    }).length;
    const hasAdhoc = (adhocDrafts.get(a.id) || "").trim().length > 0;
    const isCronToggled = !!cronToggles.get(a.id);
    return s + touched + (hasAdhoc ? 1 : 0) + (isCronToggled ? 1 : 0);
  }, 0);
  const btn = document.getElementById("execute-all-btn");
  if (btn) {
    btn.textContent = totalActionable > 0 ? `Execute all · ${totalActionable}` : "Execute all";
    btn.disabled = totalActionable === 0;
  }
}

document.addEventListener("click", async (e) => {
  // Briefing chip (per-agent) — open today's briefing for that agent
  const briefBtn = e.target.closest('[data-action="view-briefing"]');
  if (briefBtn) {
    e.preventDefault();
    e.stopPropagation();
    const agentId = briefBtn.dataset.agentId;
    if (agentId) await showAgentBriefing(agentId);
    return;
  }

  // Today's Briefings topbar button — show all agents' briefings in one modal
  const allBriefBtn = e.target.closest('[data-action="view-all-briefings"]');
  if (allBriefBtn) {
    e.preventDefault();
    await showTodaysBriefings();
    return;
  }

  // Notification bell — toggle the activity panel
  const bellBtn = e.target.closest('[data-action="toggle-notif-bell"]');
  if (bellBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (state.notifBellOpen) closeNotifPanel();
    else openNotifPanel();
    return;
  }

  // Mark all notifications as seen
  const markAllBtn = e.target.closest('[data-action="notif-mark-all"]');
  if (markAllBtn) {
    e.preventDefault();
    e.stopPropagation();
    markAllNotifsSeen();
    // Re-open the panel so the visual state updates
    closeNotifPanel();
    openNotifPanel();
    return;
  }

  // Enable OS-level notifications
  const enableOsBtn = e.target.closest('[data-action="notif-enable-os"]');
  if (enableOsBtn) {
    e.preventDefault();
    e.stopPropagation();
    await requestOsPermission();
    closeNotifPanel();
    openNotifPanel();
    return;
  }

  // Click on a notification row — mark it seen, jump to the agent/proposal
  const notifRow = e.target.closest(".notif-row");
  if (notifRow && notifRow.closest("#notif-panel")) {
    const eventId = notifRow.dataset.eventId;
    const agentId = notifRow.dataset.agentId;
    if (eventId) {
      state.seenEventIds.add(eventId);
      persistSeenEvents();
    }
    if (agentId) {
      closeNotifPanel();
      location.hash = `#/agent/${agentId}`;
    } else {
      notifRow.classList.remove("unread");
      renderNotifBell();
    }
    return;
  }

  // Grid filter toggle (Now / Scheduled / All)
  const filterTab = e.target.closest("[data-grid-filter]");
  if (filterTab) {
    const val = filterTab.dataset.gridFilter;
    if (val !== state.gridFilter) {
      state.gridFilter = val;
      localStorage.setItem("mc_grid_filter", val);
      render();
    }
    return;
  }

  // Density toggle (Comfortable / Compact)
  const densityBtn = e.target.closest("button[data-density]");
  if (densityBtn) {
    const val = densityBtn.dataset.density;
    if (val !== state.taskDensity) {
      state.taskDensity = val;
      localStorage.setItem("mc_task_density", val);
      const grid = document.getElementById("agent-grid");
      if (grid) grid.dataset.density = val;
      render();
    }
    return;
  }

  // Toggle inline report section
  const reportToggle = e.target.closest('[data-action="toggle-report"]');
  if (reportToggle) {
    e.preventDefault();
    e.stopPropagation();
    const agentId = reportToggle.dataset.agentId;
    const section = reportToggle.closest(".report-section");
    const body = section?.querySelector(".report-body");
    if (state.collapsedReports.has(agentId)) {
      state.collapsedReports.delete(agentId);
      if (section) section.classList.remove("collapsed");
      if (body && state.agentBriefings[agentId]) {
        body.innerHTML = `<div class="briefing-markdown">${renderBriefingMarkdown(state.agentBriefings[agentId].body)}</div>`;
      } else if (body) {
        body.innerHTML = `<div class="report-loading">Loading…</div>`;
        state.agentBriefingStatus[agentId] = "loading";
        fetch(`/api/agents/${agentId}/briefing`)
          .then((res) => {
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((data) => {
            if (data) {
              state.agentBriefings[agentId] = data;
              state.agentBriefingStatus[agentId] = "loaded";
              body.innerHTML = `<div class="briefing-markdown">${renderBriefingMarkdown(data.body)}</div>`;
            } else {
              state.agentBriefingStatus[agentId] = "empty";
              body.innerHTML = `<div class="report-empty">No report found yet.</div>`;
            }
          })
          .catch((err) => {
            state.agentBriefingStatus[agentId] = "error";
            console.warn(`Could not load briefing for ${agentId}:`, err);
            body.innerHTML = `<div class="report-empty">Couldn't load report.</div>`;
          });
      }
    } else {
      state.collapsedReports.add(agentId);
      if (section) section.classList.add("collapsed");
    }
    return;
  }

  // Open agent detail view
  const openBtn = e.target.closest('[data-action="open-agent"]');
  if (openBtn) {
    const card = openBtn.closest(".agent-card");
    location.hash = `#/agent/${card.dataset.agent}`;
    return;
  }

  // Back link
  const back = e.target.closest(".back-link");
  if (back) {
    e.preventDefault();
    location.hash = "";
    return;
  }

  // Skills dropdown toggle
  const skillsBtn = e.target.closest('[data-action="toggle-skills"]');
  if (skillsBtn) {
    const wrap = skillsBtn.closest(".skills-wrap");
    const popover = wrap.querySelector(".skills-popover");
    const isOpen = popover.classList.contains("show");
    // close all other popovers
    document.querySelectorAll(".skills-popover.show").forEach((p) => p.classList.remove("show"));
    document.querySelectorAll(".skills-btn.open").forEach((b) => b.classList.remove("open"));
    if (!isOpen) {
      popover.classList.add("show");
      skillsBtn.classList.add("open");
    }
    return;
  }

  // Copy skill slash command
  const skillItem = e.target.closest('[data-action="copy-skill"]');
  if (skillItem) {
    const slash = skillItem.dataset.slash;
    try {
      await navigator.clipboard.writeText(slash);
      toast(`Copied ${slash}`);
    } catch {
      toast(`Couldn't copy — ${slash}`);
    }
    // close popover
    document.querySelectorAll(".skills-popover.show").forEach((p) => p.classList.remove("show"));
    document.querySelectorAll(".skills-btn.open").forEach((b) => b.classList.remove("open"));
    return;
  }

  // Click outside any popover closes it
  if (!e.target.closest(".skills-wrap")) {
    document.querySelectorAll(".skills-popover.show").forEach((p) => p.classList.remove("show"));
    document.querySelectorAll(".skills-btn.open").forEach((b) => b.classList.remove("open"));
  }

  const toggleReply = e.target.closest('[data-action="toggle-reply"]');
  if (toggleReply) {
    const card = toggleReply.closest(".proposal");
    const id = card.dataset.propId;
    const nowOpen = !state.replyOpenProps.has(id);
    if (nowOpen) state.replyOpenProps.add(id);
    else state.replyOpenProps.delete(id);
    // Surgical toggle — only re-render this one card so we don't lose focus elsewhere
    card.classList.toggle("reply-open", nowOpen);
    toggleReply.classList.toggle("active", nowOpen);

    // If the card is already expanded, don't duplicate the compose inline —
    // let the user scroll down to the sticky compose (or just use it).
    const isExpanded = card.classList.contains("expanded");
    let inline = card.querySelector(".reply-inline");
    if (nowOpen && !isExpanded) {
      if (!inline) {
        inline = document.createElement("div");
        inline.className = "reply-inline";
        inline.innerHTML = `
          ${renderThreadMessages(state.tasksByAgent[card.dataset.agent]?.decisions?.[id]?.thread || [])}
          ${renderCompose(id)}
        `;
        card.querySelector(".proposal-row").insertAdjacentElement("afterend", inline);
      }
      // Focus the textarea so Matt can just start typing
      const ta = inline.querySelector('[data-action="thread-draft"]');
      if (ta) {
        ta.focus();
        autogrow(ta);
      }
    } else if (!nowOpen && inline) {
      // Snapshot the draft before tearing down the textarea
      const ta = inline.querySelector('[data-action="thread-draft"]');
      if (ta && ta.value.trim()) {
        threadDrafts.set(id, ta.value);
        persistDrafts();
        // Keep it open if there's a draft — don't lose Matt's text
        state.replyOpenProps.add(id);
        card.classList.add("reply-open");
        toggleReply.classList.add("active");
        return;
      }
      inline.remove();
    }
    return;
  }

  const toggleProp = e.target.closest('[data-action="toggle-prop"]');
  if (toggleProp) {
    // Support both the old .proposal card layout and new .inbox-tr table row layout
    const card = toggleProp.closest(".proposal") || toggleProp.closest(".inbox-tr");
    if (!card) return;
    const id = card.dataset.propId;
    const nowExpanded = !state.expandedProps.has(id);
    if (nowExpanded) state.expandedProps.add(id);
    else state.expandedProps.delete(id);
    card.classList.toggle("expanded", nowExpanded);
    // Old card layout: .proposal-detail
    const detail = card.querySelector(".proposal-detail");
    if (detail) detail.classList.toggle("hidden", !nowExpanded);
    // New table layout: sibling .inbox-tr-detail row
    const detailRow = document.querySelector(`.inbox-tr-detail[data-detail-for="${CSS.escape(id)}"]`);
    if (detailRow) detailRow.classList.toggle("hidden", !nowExpanded);
    if (nowExpanded) {
      const container = detail || detailRow;
      if (container) {
        container.querySelectorAll('[data-action="thread-draft"]').forEach((ta) => {
          if (ta.value) autogrow(ta);
        });
      }
    }
    return;
  }

  // Unstick — reset an in_progress proposal back to To-Do by deleting its
  // decision row (server's /move endpoint with target=todo does exactly that).
  // This is the escape hatch when Matt queues something via Execute All but
  // never runs the paired /execute-* slash command, leaving the card stranded.
  const unstickBtn = e.target.closest('[data-action="unstick-prop"]');
  if (unstickBtn) {
    e.preventDefault();
    e.stopPropagation();
    const propId = unstickBtn.dataset.propId;
    const agentId = unstickBtn.dataset.agent;
    unstickBtn.disabled = true;
    try {
      const res = await fetch(`/api/agents/${agentId}/tasks/${propId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "todo" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Optimistic local state update so the next render reflects the reset
      const data = state.tasksByAgent[agentId];
      if (data && data.decisions) delete data.decisions[propId];
      toast("Reset to To-Do");
      render();
    } catch (err) {
      toast(`Couldn't reset — ${err.message}`);
      unstickBtn.disabled = false;
    }
    return;
  }

  // Send — wire the textarea + button to the agent's persistent OpenClaw chat
  // session. The reply streams back via SSE and renders inline below the input.
  // The /adhoc endpoint (synthetic task) is still used by Execute All for any
  // un-Sent text, so the historical batch flow keeps working.
  const adhocSendBtn = e.target.closest('[data-action="adhoc-send"]');
  if (adhocSendBtn) {
    e.preventDefault();
    e.stopPropagation();
    const agentId = adhocSendBtn.dataset.agentId;
    const text = (adhocDrafts.get(agentId) || "").trim();
    if (!text) return;
    adhocSendBtn.disabled = true;
    adhocSendBtn.textContent = "Sending…";
    // Clear the textarea immediately so Matt can type the next message.
    const ta = document.querySelector(
      `.agent-card[data-agent="${CSS.escape(agentId)}"] [data-action="adhoc-input"]`
    );
    if (ta) { ta.value = ""; autogrow(ta); }
    updateCounts();
    try {
      await commitChat(agentId);
    } catch (err) {
      toast(`Chat failed — ${err.message}`);
    } finally {
      adhocSendBtn.disabled = true; // re-disabled because draft is empty now
      adhocSendBtn.textContent = "Send";
    }
    return;
  }

  const toggleSection = e.target.closest('[data-action="toggle-section"]');
  if (toggleSection) {
    const card = toggleSection.closest(".agent-card");
    // Custom section id (e.g. "cro-completed") or default to agent id
    const sectionId = toggleSection.dataset.section || card.dataset.agent;
    const nowCollapsed = !state.collapsedSections.has(sectionId);
    if (nowCollapsed) state.collapsedSections.add(sectionId);
    else state.collapsedSections.delete(sectionId);
    // Surgical: toggle the collapsed class on the parent wrapper
    const wrapper = toggleSection.closest(".task-section, .completed-section");
    if (wrapper) wrapper.classList.toggle("collapsed", nowCollapsed);
    return;
  }


  const cronBtn = e.target.closest('[data-action="toggle-cron"]');
  if (cronBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = cronBtn.closest(".agent-card");
    const agentId = card?.dataset.agent;
    if (!agentId) return;
    const isOn = !!cronToggles.get(agentId);
    if (isOn) {
      cronToggles.delete(agentId);
      cronBtn.classList.remove("cron-active");
      cronBtn.title = `Click to include in execute: ${cronBtn.dataset.cmd}`;
    } else {
      cronToggles.set(agentId, true);
      cronBtn.classList.add("cron-active");
      cronBtn.title = `Click to remove from execute: ${cronBtn.dataset.cmd}`;
    }
    persistCronToggles();
    updateCounts();
    return;
  }

  const execBtn = e.target.closest('[data-action="execute"]');
  if (execBtn) {
    const agentId = execBtn.dataset.agentId || execBtn.closest(".agent-card")?.dataset.agent;
    if (agentId) await executeAgent(agentId);
    return;
  }

  if (e.target.id === "refresh-btn") {
    await loadAll();
    toast("Refreshed");
    return;
  }

  if (e.target.id === "inbox-execute-all" || e.target.id === "execute-all-btn") {
    const btn = e.target;
    btn.classList.add("btn-firing");

    // Snapshot which agents actually have actionable items so we can ripple them
    const agentsToQueue = state.agents.filter((a) => {
      const data = state.tasksByAgent[a.id];
      if (!data) return false;
      const hasDraft = (adhocDrafts.get(a.id) || "").trim().length > 0;
      const hasTouched = data.tasks.some((p) => isTouched(data.decisions[p.id]) && data.decisions[p.id]?.status !== "in_progress");
      const isCronToggled = !!cronToggles.get(a.id);
      return hasDraft || hasTouched || isCronToggled;
    });
    // Clear all cron toggles included in this execute-all
    for (const a of agentsToQueue) {
      if (cronToggles.has(a.id)) cronToggles.delete(a.id);
    }
    persistCronToggles();

    // Fire each agent's queue + adhoc commit in parallel, then animate
    await Promise.all(
      agentsToQueue.map(async (a) => {
        // Commit any adhoc chat box
        if (adhocDrafts.has(a.id)) {
          await commitAdhoc(a.id);
          const taAdhoc = document.querySelector(
            `.agent-card[data-agent="${CSS.escape(a.id)}"] [data-action="adhoc-input"]`
          );
          if (taAdhoc) taAdhoc.value = "";
          try {
            const r = await fetch(`/api/agents/${a.id}/tasks`);
            state.tasksByAgent[a.id] = await r.json();
          } catch {}
        }
        // Commit any pending thread drafts
        const data = state.tasksByAgent[a.id];
        if (data) {
          for (const p of data.tasks) {
            if (threadDrafts.has(p.id)) {
              await commitDraft(a.id, p.id);
              const ta = document.querySelector(
                `[data-prop-id="${CSS.escape(p.id)}"] [data-action="thread-draft"]`
              );
              if (ta) ta.value = "";
            }
          }
          // Optimistic local queue — any touched item
          for (const p of data.tasks) {
            const d = data.decisions[p.id];
            if (isTouched(d) && d.status !== "in_progress") {
              data.decisions[p.id] = { ...d, status: "in_progress" };
            }
          }
        }
        // Server-side queue
        try {
          await fetch(`/api/agents/${a.id}/queue`, { method: "POST" });
        } catch {}

        // Ripple the card
        const card = document.querySelector(
          `.agent-card[data-agent="${CSS.escape(a.id)}"]`
        );
        if (card) {
          card.classList.add("card-ripple");
          setTimeout(() => card.classList.remove("card-ripple"), 900);
        }
      })
    );

    try {
      await navigator.clipboard.writeText("/execute-all");
      toast(`Started ${agentsToQueue.length} agent${agentsToQueue.length === 1 ? "" : "s"} · /execute-all copied`);
    } catch {
      toast(`Started ${agentsToQueue.length} agents · run /execute-all in Claude Code`);
    }

    setTimeout(() => btn.classList.remove("btn-firing"), 900);
    route();
    return;
  }

  // Reply button — open modal
  const replyBtn = e.target.closest("[data-action='open-reply']");
  if (replyBtn) {
    openReplyModal(replyBtn.dataset.propId, replyBtn.dataset.agent);
    return;
  }

  // Inbox mode toggle (list vs kanban vs table)
  const modeBtn = e.target.closest("[data-inbox-mode]");
  if (modeBtn) {
    state.inboxMode = modeBtn.dataset.inboxMode;
    localStorage.setItem("mc_inbox_mode", state.inboxMode);
    renderInbox();
    return;
  }

  // Inbox agent filter — multi-select. "All" clears the set; clicking an
  // agent toggles its membership. Shift/Ctrl/Cmd is optional — every click
  // is additive, since that's the common case for "show me CS + CRO".
  const agentFilterBtn = e.target.closest("[data-inbox-agent]");
  if (agentFilterBtn) {
    const id = agentFilterBtn.dataset.inboxAgent;
    if (id === "all") {
      state.inboxAgentFilter = new Set();
    } else {
      if (state.inboxAgentFilter.has(id)) state.inboxAgentFilter.delete(id);
      else state.inboxAgentFilter.add(id);
    }
    localStorage.setItem("mc_inbox_agent_filter", [...state.inboxAgentFilter].join(","));
    renderInbox();
    return;
  }

  // Inbox add-task button — toggle form visibility
  if (e.target.id === "inbox-add-task") {
    const form = document.getElementById("inbox-add-form");
    if (form) {
      const showing = form.style.display !== "none";
      form.style.display = showing ? "none" : "block";
      if (!showing) document.getElementById("inbox-add-title")?.focus();
    }
    return;
  }

  // Inbox add-task cancel
  if (e.target.id === "inbox-add-cancel") {
    const form = document.getElementById("inbox-add-form");
    if (form) form.style.display = "none";
    return;
  }

  // Inbox add-task submit
  if (e.target.id === "inbox-add-submit") {
    const title = document.getElementById("inbox-add-title")?.value?.trim();
    const agentId = document.getElementById("inbox-add-agent")?.value;
    const actionType = document.getElementById("inbox-add-action")?.value;
    const due = document.getElementById("inbox-add-due")?.value || null;
    if (!title) { toast("Title is required"); return; }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const taskId = `${agentId}-manual-${today}-${Date.now().toString(36)}`;
      await fetch("/api/db/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, agent_id: agentId, title, action_type: actionType, due_date: due, origin: "manual", active: true }),
      });
      await loadAll();
      toast("Task added");
    } catch (err) {
      toast("Failed to add task");
    }
    return;
  }

  // Collapse/expand completed section
  if (e.target.closest("[data-toggle-completed]")) {
    state.completedCollapsed = !state.completedCollapsed;
    localStorage.setItem("mc_inbox_completed_collapsed", state.completedCollapsed ? "1" : "0");
    renderInbox();
    return;
  }

  // View tabs / sidebar nav items / brand link
  const tab = e.target.closest(".view-tab, .app-nav-item, .app-sidebar-brand");
  if (tab && tab.dataset.view) {
    e.preventDefault();
    const v = tab.dataset.view;
    location.hash = v === "inbox" ? "#/tasks"
      : v === "grid" ? "#/agents"
      : v === "history" ? "#/history"
      : v === "db" ? "#/db"
      : v === "github" ? "#/github"
      : v === "companies" ? "#/companies"
      : v === "projects" ? "#/projects"
      : v === "reports" ? "#/reports"
      : "#/tasks";
    return;
  }

  // Companies-tab filter (All / Pipeline / Customers)
  const covFilterBtn = e.target.closest("[data-cov-filter]");
  if (covFilterBtn) {
    e.preventDefault();
    localStorage.setItem("mc_cov_filter", covFilterBtn.dataset.covFilter);
    renderCompanyCoverage();
    return;
  }

  // Companies-tab top mode toggle (Coverage / Table / Kanban)
  const covPageModeBtn = e.target.closest("[data-cov-page-mode]");
  if (covPageModeBtn) {
    e.preventDefault();
    const mode = covPageModeBtn.dataset.covPageMode;
    if (mode === (localStorage.getItem("mc_companies_view") || "kanban")) return;
    localStorage.setItem("mc_companies_view", mode);
    renderCompanyCoverage();
    return;
  }

  // Kanban toolbar: density toggle (Comfy / Compact)
  const kanbanDensityBtn = e.target.closest("[data-kanban-density]");
  if (kanbanDensityBtn) {
    e.preventDefault();
    localStorage.setItem("mc_kanban_density", kanbanDensityBtn.dataset.kanbanDensity);
    renderCompanyCoverage();
    return;
  }

  // (show-closed checkbox handled by the document `change` listener)

  // Coverage card expand/collapse — lazy-fetches proposals + tasks for one company
  const covExpandBtn = e.target.closest("[data-cov-expand]");
  if (covExpandBtn) {
    e.preventDefault();
    const slug = covExpandBtn.dataset.covExpand;
    if (state.covExpanded.has(slug)) {
      state.covExpanded.delete(slug);
    } else {
      state.covExpanded.add(slug);
    }
    localStorage.setItem("mc_cov_expanded", JSON.stringify([...state.covExpanded]));
    toggleCovCard(slug);
    return;
  }
});

// ─── Kanban due-date picker ─────────────────────────────────────
// Click the "+ date" chip (or an existing date chip) on a kanban card to
// schedule / reschedule / clear it. Uses a hidden <input type="date"> that
// floats over the card momentarily, calls showPicker() where supported, and
// PUTs the result to /api/agents/:id/proposals/:propId/due_date.
document.addEventListener("click", async (e) => {
  const chip = e.target.closest?.("[data-due-edit]");
  if (!chip) return;
  // Don't trigger when clicking through a draggable parent etc.
  e.preventDefault();
  e.stopPropagation();

  const card = chip.closest(".kanban-card");
  if (!card) return;
  const propId = card.dataset.propId;
  const agentId = card.dataset.agent;
  const existing = chip.dataset.dueValue || "";

  // Build a transient date input. Can't use a persistent one because the
  // card is re-rendered on every state change.
  const input = document.createElement("input");
  input.type = "date";
  input.value = existing;
  input.className = "due-date-hidden-input";
  // Position over the chip so the picker anchors there.
  const rect = chip.getBoundingClientRect();
  input.style.position = "fixed";
  input.style.left = `${rect.left}px`;
  input.style.top = `${rect.top}px`;
  input.style.width = `${Math.max(rect.width, 120)}px`;
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);

  const cleanup = () => {
    try { input.remove(); } catch {}
  };

  // Commit on change; escape key cancels.
  input.addEventListener("change", async () => {
    const next = input.value || null; // "" → null = clear
    cleanup();
    if (next === existing || (next === null && !existing)) return;
    await setDueDate(agentId, propId, next);
  });
  input.addEventListener("blur", cleanup);

  // If there's already a date, also allow clearing via Shift-click (quick path).
  if (e.shiftKey && existing) {
    cleanup();
    await setDueDate(agentId, propId, null);
    return;
  }

  // Focus + open the native picker.
  input.focus();
  if (typeof input.showPicker === "function") {
    try { input.showPicker(); } catch { input.click(); }
  } else {
    input.click();
  }
});

async function setDueDate(agentId, propId, dueDate) {
  // Optimistic local update so the card jumps columns immediately.
  const data = state.tasksByAgent[agentId];
  if (data?.tasks) {
    const p = data.tasks.find((x) => x.id === propId);
    if (p) {
      if (dueDate) p.due_date = dueDate;
      else delete p.due_date;
    }
  }
  renderInbox();

  // Server save.
  try {
    await fetch(`/api/agents/${agentId}/tasks/${propId}/due_date`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due_date: dueDate }),
    });
    toast(dueDate ? `Scheduled for ${formatDueDate(dueDate)}` : "Due date cleared");
  } catch {
    toast("Failed to save due date");
  }
}

// ─── Kanban drag & drop ────────────────────────────────────────
let dragState = null;

document.addEventListener("dragstart", (e) => {
  const card = e.target.closest?.(".kanban-card");
  if (!card) return;
  dragState = {
    propId: card.dataset.propId,
    agentId: card.dataset.agent,
  };
  card.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires some data to be set
    try { e.dataTransfer.setData("text/plain", card.dataset.propId); } catch {}
  }
});

document.addEventListener("dragend", (e) => {
  const card = e.target.closest?.(".kanban-card");
  if (card) card.classList.remove("dragging");
  document.querySelectorAll(".kanban-col.drop-hover").forEach((c) => c.classList.remove("drop-hover"));
  dragState = null;
});

document.addEventListener("dragover", (e) => {
  const col = e.target.closest?.(".kanban-col.droppable");
  if (!col || !dragState) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  // Clear hover on siblings and set on current
  document.querySelectorAll(".kanban-col.drop-hover").forEach((c) => {
    if (c !== col) c.classList.remove("drop-hover");
  });
  col.classList.add("drop-hover");
});

document.addEventListener("dragleave", (e) => {
  const col = e.target.closest?.(".kanban-col");
  if (!col) return;
  // Only remove if we truly left the column (not child element)
  if (!col.contains(e.relatedTarget)) col.classList.remove("drop-hover");
});

document.addEventListener("drop", async (e) => {
  const col = e.target.closest?.(".kanban-col.droppable");
  if (!col || !dragState) return;
  e.preventDefault();
  col.classList.remove("drop-hover");

  const target = col.dataset.dropTarget;
  const { propId, agentId } = dragState;
  dragState = null;

  // Confirm destructive reset
  if (target === "todo") {
    const existing = state.tasksByAgent[agentId]?.decisions?.[propId];
    const hasThread = Array.isArray(existing?.thread) && existing.thread.length > 0;
    if (hasThread) {
      const ok = confirm("Drop to To do will clear this card's decision AND its conversation history. Continue?");
      if (!ok) return;
    }
  }

  // Optimistic local update
  const data = state.tasksByAgent[agentId];
  if (data) {
    // Any drop into another column clears due_date — server.js does the same
    // on the file, but we clear locally so the re-render doesn't snap the
    // card back to Scheduled before the roundtrip completes.
    const p = data.tasks?.find((x) => x.id === propId);
    if (p && p.due_date) delete p.due_date;

    if (target === "todo") {
      delete data.decisions[propId];
    } else if (target === "in_progress") {
      const existing = data.decisions[propId] || { thread: [] };
      // Ensure it's touched — if not, stamp a minimal "approved as-is" comment.
      const touched = isTouched(existing);
      data.decisions[propId] = {
        ...existing,
        ...(touched ? {} : { comment: "approved as-is" }),
        status: "in_progress",
      };
    } else if (target === "pending") {
      // Drag to pending = mark touched without a comment
      const existing = data.decisions[propId] || { thread: [] };
      if (!isTouched(existing)) {
        data.decisions[propId] = { ...existing, comment: "approved as-is", status: null };
      } else {
        data.decisions[propId] = { ...existing, status: null };
      }
    } else if (target === "completed") {
      const existing = data.decisions[propId] || { thread: [] };
      data.decisions[propId] = { ...existing, status: "executed" };
    }
  }
  renderInbox();

  // Server save
  try {
    await fetch(`/api/agents/${agentId}/tasks/${propId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
  } catch {}
});

// ─── Card action dropdown (Complete / Dismiss) ───────────────────
// ─── 3-dot menu: toggle dropdown ─────────────────────────────────
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-action='card-menu']");
  if (btn) {
    e.stopPropagation();
    const propId = btn.dataset.propId;
    // Close any other open menus first
    document.querySelectorAll(".card-menu-dropdown.open").forEach((m) => {
      if (m.dataset.menuFor !== propId) m.classList.remove("open");
    });
    const menu = btn.parentElement.querySelector(".card-menu-dropdown");
    if (menu) {
      const willOpen = !menu.classList.contains("open");
      menu.classList.toggle("open");
      if (willOpen) {
        // Position fixed: anchor to button's bottom-right so we escape any
        // overflow:hidden ancestors (.proposal, .agent-card).
        const r = btn.getBoundingClientRect();
        const menuW = menu.offsetWidth || 150;
        menu.style.top = `${r.bottom + 2}px`;
        menu.style.left = `${Math.max(8, r.right - menuW)}px`;
      }
    }
    return;
  }

  // Handle menu item click
  const item = e.target.closest?.("[data-resolve]");
  if (item) {
    e.stopPropagation();
    const action = item.dataset.resolve;
    const propId = item.dataset.propId;
    const agentId = item.dataset.agent;

    // Optimistic local update
    const data = state.tasksByAgent[agentId];
    if (data) {
      if (action === "completed") {
        data.decisions[propId] = { ...(data.decisions[propId] || {}), status: "executed" };
      } else if (action === "dismissed") {
        data.tasks = data.tasks?.filter((p) => p.id !== propId);
        delete data.decisions[propId];
      }
    }
    renderInbox();

    // Server save
    fetch(`/api/agents/${agentId}/tasks/${propId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).then(() => {
      toast(action === "completed" ? "Marked complete" : "Dismissed");
    }).catch(() => {
      toast("Failed to update card");
    });
    return;
  }

  // Close open menus when clicking elsewhere
  document.querySelectorAll(".card-menu-dropdown.open").forEach((m) => m.classList.remove("open"));
});

// Cron skill toggles per agent (▶ button). Persists to localStorage.
// When toggled on, the cron skill counts toward Execute and gets included.
const cronToggles = new Map();
try {
  const saved = JSON.parse(localStorage.getItem("mc_cron_toggles") || "{}");
  for (const [k, v] of Object.entries(saved)) cronToggles.set(k, v);
} catch {}
function persistCronToggles() {
  try {
    localStorage.setItem("mc_cron_toggles", JSON.stringify(Object.fromEntries(cronToggles)));
  } catch {}
}

// Ad-hoc chat drafts per agent (card-level chat box). Persists to localStorage.
// Commits to a synthetic proposal on Execute.
const adhocDrafts = new Map();
try {
  const saved = JSON.parse(localStorage.getItem("mc_adhoc_drafts") || "{}");
  for (const [k, v] of Object.entries(saved)) adhocDrafts.set(k, v);
} catch {}
function persistAdhoc() {
  try {
    localStorage.setItem("mc_adhoc_drafts", JSON.stringify(Object.fromEntries(adhocDrafts)));
  } catch {}
}
async function commitAdhoc(agentId) {
  const text = adhocDrafts.get(agentId);
  if (!text || !text.trim()) return false;
  adhocDrafts.delete(agentId);
  persistAdhoc();
  try {
    await fetch(`/api/agents/${agentId}/adhoc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    });
  } catch {}
  return true;
}

// ─── Chat state ────────────────────────────────────────────────────────────
// Persistent chat with each agent's always-on OpenClaw session. History is
// the source of truth from the server; this Map caches the rendered set per
// agent so we don't refetch on every render. Live runs (after Send is hit)
// are tracked in chatRunsByAgent so the SSE stream and the card render share
// status + reply state.
const chatByAgent = new Map(); // agentId -> [{ id, role, text, source, created_at }]
const chatRunsByAgent = new Map(); // agentId -> { runId, status, reply, error, source }

async function loadChatHistory(agentId, { force = false } = {}) {
  if (chatByAgent.has(agentId) && !force) return chatByAgent.get(agentId);
  try {
    const r = await fetch(`/api/agents/${agentId}/chat/history?limit=50`);
    if (!r.ok) throw new Error(`history ${r.status}`);
    const { messages } = await r.json();
    chatByAgent.set(agentId, messages || []);
    return messages;
  } catch (err) {
    console.warn("[chat] history load failed:", err.message);
    chatByAgent.set(agentId, []);
    return [];
  }
}

// Send Matt's typed text to the agent's persistent OpenClaw session, open SSE
// for the reply, and refresh the in-card chat log as events arrive. Returns
// when the SSE stream closes (reply received or timeout) so callers can await.
async function commitChat(agentId) {
  const text = (adhocDrafts.get(agentId) || "").trim();
  if (!text) return false;
  // Clear the input draft immediately — Matt's already committed by hitting Send.
  adhocDrafts.delete(agentId);
  persistAdhoc();

  // Optimistic local user bubble so the UI updates before the server round-trip.
  const history = chatByAgent.get(agentId) || [];
  const optimisticId = `local-${Date.now()}`;
  history.push({
    id: optimisticId,
    role: "user",
    text,
    source: "chat",
    created_at: new Date().toISOString(),
  });
  chatByAgent.set(agentId, history);
  chatRunsByAgent.set(agentId, { runId: null, status: "Sending…", reply: null });
  renderChatLog(agentId);

  let runId;
  try {
    const sendRes = await fetch(`/api/agents/${agentId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.json().catch(() => ({}));
      throw new Error(errBody.error || `chat ${sendRes.status}`);
    }
    const json = await sendRes.json();
    runId = json.runId;
    chatRunsByAgent.set(agentId, { runId, status: "Thinking…", reply: null });
    renderChatLog(agentId);
  } catch (err) {
    chatRunsByAgent.set(agentId, { runId: null, status: null, reply: null, error: err.message });
    renderChatLog(agentId);
    return false;
  }

  // Open SSE and resolve when the reply (or error) arrives.
  return new Promise((resolve) => {
    const es = new EventSource(`/api/agents/${agentId}/chat/stream?runId=${encodeURIComponent(runId)}`);

    const finish = (ok) => {
      try { es.close(); } catch {}
      resolve(ok);
    };

    es.addEventListener("status", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const run = chatRunsByAgent.get(agentId) || {};
        run.status = data.label || "Working…";
        chatRunsByAgent.set(agentId, run);
        renderChatLog(agentId);
      } catch {}
    });

    es.addEventListener("reply", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const hist = chatByAgent.get(agentId) || [];
        hist.push({
          id: `srv-${data.runId}`,
          role: "assistant",
          text: data.text,
          source: "chat",
          run_id: data.runId,
          created_at: new Date().toISOString(),
        });
        chatByAgent.set(agentId, hist);
        chatRunsByAgent.delete(agentId);
        renderChatLog(agentId);
      } catch {}
      finish(true);
    });

    es.addEventListener("error", (ev) => {
      let msg = "stream error";
      try { msg = JSON.parse(ev.data).message || msg; } catch {}
      const run = chatRunsByAgent.get(agentId) || {};
      run.status = null;
      run.error = msg;
      chatRunsByAgent.set(agentId, run);
      renderChatLog(agentId);
      finish(false);
    });

    // Browser-side safety net in case the server SSE close is missed.
    setTimeout(() => finish(false), 3 * 60 * 1000 + 5000);
  });
}

function renderChatLog(agentId) {
  const logEl = document.querySelector(
    `.agent-card[data-agent="${CSS.escape(agentId)}"] [data-chat-log]`
  );
  if (!logEl) return;
  logEl.innerHTML = chatLogHtml(agentId);
}

function chatLogHtml(agentId) {
  const messages = (chatByAgent.get(agentId) || []).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  const run = chatRunsByAgent.get(agentId);
  if (!messages.length && !run) return "";

  const bubbles = messages
    .slice(-6) // show last 6 turns inline; full history in expand later
    .map((m) => {
      const time = new Date(m.created_at).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      return `
        <div class="thread-bubble ${m.role === "user" ? "matt" : "agent"}">
          <div class="bubble-meta">
            <span class="bubble-role">${m.role === "user" ? "You" : "Agent"}</span>
            <span class="bubble-time">${escape(time)}</span>
          </div>
          <div class="bubble-text">${escape(m.text).replace(/\n/g, "<br>")}</div>
        </div>
      `;
    })
    .join("");

  let statusBar = "";
  if (run?.status) {
    statusBar = `<div class="chat-status">${escape(run.status)}</div>`;
  } else if (run?.error) {
    statusBar = `<div class="chat-status chat-status-error">⚠ ${escape(run.error)}</div>`;
  }

  return `<div class="thread-messages chat-log">${bubbles}${statusBar}</div>`;
}

// In-memory drafts keyed by propId. Persist to localStorage so a refresh
// doesn't lose typed text. Committed to the server only when Matt clicks
// Yes/No/Execute on this proposal — that's the natural "I'm done typing" signal.
const threadDrafts = new Map();
try {
  const saved = JSON.parse(localStorage.getItem("mc_thread_drafts") || "{}");
  for (const [k, v] of Object.entries(saved)) threadDrafts.set(k, v);
} catch {}
function persistDrafts() {
  try {
    localStorage.setItem("mc_thread_drafts", JSON.stringify(Object.fromEntries(threadDrafts)));
  } catch {}
}
async function commitDraft(agentId, propId) {
  const text = threadDrafts.get(propId);
  if (!text || !text.trim()) return false;
  threadDrafts.delete(propId);
  persistDrafts();
  // Wipe any live DOM textareas for this propId so snapshotDrafts() can't
  // re-capture stale text on the next render (defensive — handles the case
  // where the user typed more characters during the await below).
  document
    .querySelectorAll(`.proposal[data-prop-id="${CSS.escape(propId)}"] [data-action="thread-draft"]`)
    .forEach((ta) => { ta.value = ""; });
  // Auto-collapse the inline reply so the textbox disappears after sending.
  state.replyOpenProps.delete(propId);
  // Optimistic local thread update
  const data = state.tasksByAgent[agentId];
  if (data) {
    const existing = data.decisions[propId] || { thread: [] };
    const thread = Array.isArray(existing.thread) ? [...existing.thread] : [];
    thread.push({ role: "matt", ts: new Date().toISOString(), text: text.trim() });
    data.decisions[propId] = { ...existing, thread };
  }
  // Server save
  try {
    await fetch(`/api/agents/${agentId}/tasks/${propId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim(), role: "matt" }),
    });
  } catch {}
  return true;
}

document.addEventListener("keydown", async (e) => {
  // Enter (no Shift) in a thread draft = commit + collapse
  if (e.target.matches('[data-action="thread-draft"]') && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const card = e.target.closest(".proposal");
    const agentId = card.dataset.agent;
    const propId = card.dataset.propId;
    // Make sure latest text is in the drafts map before commit
    threadDrafts.set(propId, e.target.value);
    persistDrafts();
    const committed = await commitDraft(agentId, propId);
    if (committed) {
      // Clear the live textarea so snapshotDrafts() doesn't re-capture
      e.target.value = "";
      // Collapse the proposal (both expanded preview and reply compose)
      state.expandedProps.delete(propId);
      state.replyOpenProps.delete(propId);
      route();
    }
    return;
  }

  // Enter (no Shift) in an adhoc "Ask {agent}" textarea = click the Send button
  if (e.target.matches('[data-action="adhoc-input"]') && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const card = e.target.closest(".agent-card");
    const sendBtn = card?.querySelector('[data-action="adhoc-send"]');
    if (sendBtn && !sendBtn.disabled) sendBtn.click();
  }
});

// Auto-grow a textarea to fit its content
function autogrow(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

document.addEventListener("input", (e) => {
  // Inbox live search
  if (e.target.id === "inbox-search-input") {
    state.inboxSearch = e.target.value;
    renderInbox();
    return;
  }

  if (e.target.matches('[data-action="adhoc-input"]')) {
    const card = e.target.closest(".agent-card");
    const agentId = card?.dataset.agent;
    if (agentId) {
      adhocDrafts.set(agentId, e.target.value);
      persistAdhoc();
      updateCounts();
      // Live-enable the Send button alongside the typed text
      const sendBtn = card.querySelector('[data-action="adhoc-send"]');
      if (sendBtn) sendBtn.disabled = !e.target.value.trim();
    }
    autogrow(e.target);
    return;
  }

  if (e.target.matches('[data-action="thread-draft"]')) {
    const { propId } = propContext(e.target);
    if (propId) { threadDrafts.set(propId, e.target.value); persistDrafts(); }
    autogrow(e.target);
    return;
  }

  if (e.target.matches('[data-action="comment"]')) {
    const { propId, agentId } = propContext(e.target);
    if (lastCommentSnapshot && lastCommentSnapshot.propId === propId) {
      lastCommentSnapshot.value = e.target.value;
      lastCommentSnapshot.selectionStart = e.target.selectionStart;
      lastCommentSnapshot.selectionEnd = e.target.selectionEnd;
    }
    if (propId && agentId) queueCommentSave(agentId, propId, e.target.value);
    return;
  }

  if (e.target.matches('[data-action="edit-body"]')) {
    const { propId, agentId } = propContext(e.target);
    // Convert HTML <br> back to plain newlines
    const text = e.target.innerText;
    queueEditSave(agentId, propId, text);
  }
});

async function executeAgent(agentId) {
  // Snapshot any in-progress textareas first so we don't miss the latest keystroke
  snapshotDrafts();

  // Commit any ad-hoc chat box content as a synthetic freeform proposal
  if (adhocDrafts.has(agentId)) {
    await commitAdhoc(agentId);
    const taAdhoc = document.querySelector(
      `.agent-card[data-agent="${CSS.escape(agentId)}"] [data-action="adhoc-input"]`
    );
    if (taAdhoc) taAdhoc.value = "";
    // Reload proposals so the new adhoc task is in local state before queueing
    try {
      const r = await fetch(`/api/agents/${agentId}/tasks`);
      state.tasksByAgent[agentId] = await r.json();
    } catch {}
  }

  // Commit any pending draft messages on this agent's proposals
  const data = state.tasksByAgent[agentId];
  if (data) {
    for (const p of data.tasks) {
      if (threadDrafts.has(p.id)) {
        await commitDraft(agentId, p.id);
        const ta = document.querySelector(
          `[data-prop-id="${CSS.escape(p.id)}"] [data-action="thread-draft"]`
        );
        if (ta) ta.value = "";
      }
    }
  }

  // Mark all approved proposals as "queued" on the server, then copy
  // the slash command. The card visually flips to "queued" state until
  // the slash command archives + clears them.
  const agent = state.agents.find((a) => a.id === agentId);
  const execCmd = `/execute-${agentId}`;
  const cronCmd = cronToggles.get(agentId) ? (agent?.skill || "") : "";
  const cmds = [execCmd, cronCmd].filter(Boolean).join("\n");
  // Clear cron toggle after including in execute
  if (cronToggles.get(agentId)) {
    cronToggles.delete(agentId);
    persistCronToggles();
  }
  try {
    await fetch(`/api/agents/${agentId}/queue`, { method: "POST" });
  } catch {}
  // Local optimistic update — queue any touched item
  if (data) {
    for (const p of data.tasks) {
      const d = data.decisions[p.id];
      if (isTouched(d) && d.status !== "in_progress") {
        data.decisions[p.id] = { ...d, status: "in_progress" };
      }
    }
  }
  try {
    await navigator.clipboard.writeText(cmds);
    const label = cronCmd ? `${execCmd} + ${cronCmd}` : execCmd;
    toast(`Copied ${label} — paste into Claude Code`);
  } catch {
    toast(`Run in Claude Code:\n${cmds}`);
  }
  route();
}

async function pollExecute(agentId, runId) {
  const interval = setInterval(async () => {
    try {
      const r = await fetch(`/api/execute/${runId}/status`);
      if (!r.ok) return;
      const info = await r.json();
      const terminal = ["completed", "error", "no-op"];
      if (terminal.includes(info.status)) {
        clearInterval(interval);
        delete state.runningExecutes[agentId];
        if (info.status === "completed") toast("✓ Execution complete");
        else if (info.status === "no-op") toast("⚠ Claude exited without doing the work — see History for details");
        else toast("✗ Execution failed");
        await loadAll();
      }
    } catch {}
  }, 3000);
}

// ─── Database tab (Postgres browser with inline editing) ────────
const DB_ENUMS = {
  stage: ['target','prospect','discovery','demo','proposal','negotiation','on-hold-warm','closed-won','closed-lost'],
  action_status: ['Action Needed','No Action'],
  field: ['Asset Management','Valuation & Advisory','Capital Markets','Developer','Other'],
  role: ['Decision Maker','Champion','User','Influencer','Gatekeeper'],
  source: ['Referral','Intro Call','Conference','Inbound','LinkedIn','Cold Outreach'],
  status: ['Not started','In progress','Done'],
  action_type: ['Meeting','Email','Call','Text','Research'],
  agent: ['cro','cs','bdm','fin','content','analyst'],
  health_tier: ['green','yellow','red'],
  lane: ['SkySuite Product','AI in CRE Thought Leadership'],
  post_type: ['Insight','Case Study','Hot Take','How-To','Behind the Scenes'],
  relevance: ['High','Medium','Low'],
  series: ['SkySuite Updates','AI in CRE'],
  report_type: ['daily','weekly','debrief'],
  source_type: ['LinkedIn Post','Article','Report','Tweet','Industry News','Webinar'],
  entry_type: ['meeting','email','call','note','other'],
  timeline_source: ['vault','agent','manual'],
  meeting_type: ['Intro','Discovery','Demo','Proposal','Project','Internal','NA'],
};

// Map table+column to which enum applies (when column name alone is ambiguous)
const COL_ENUM_MAP = {
  'companies:stage': 'stage',
  'companies:action_status': 'action_status',
  'companies:field': 'field',
  'companies:health_tier': 'health_tier',
  'contacts:role': 'role',
  'contacts:source': 'source',
  'tasks:status': 'status',
  'tasks:action_type': 'action_type',
  'tasks:agent': 'agent',
  'meetings:status': 'meeting_type',
  'linkedin:lane': 'lane',
  'linkedin:status': 'status',
  'linkedin:post_type': 'post_type',
  'newsletters:series': 'series',
  'newsletters:status': 'status',
  'intel:source_type': 'source_type',
  'intel:relevance': 'relevance',
  'intel:lane': 'lane',
  'reports:agent': 'agent',
  'reports:report_type': 'report_type',
  'timeline:entry_type': 'entry_type',
  'timeline:source': 'timeline_source',
};

// PK column per table (for PATCH calls)
const DB_PK = {
  companies: 'company_id', contacts: 'contact_id', tasks: 'task_id',
  meetings: 'meeting_id', linkedin: 'post_id', newsletters: 'edition_id',
  intel: 'entry_id', reports: 'report_id',
  timeline: 'entry_id',
};
// API table name (for PATCH URL — some tables use different names in the route vs API)
const DB_API_TABLE = {
  linkedin: 'linkedin_posts', intel: 'influencer_intel', reports: 'daily_reports',
};

// Columns that are read-only (computed or FK display names)
const READ_ONLY_COLS = new Set(['risk','days_since_contact','company_name','company_slug']);

// Columns that are dates
const DATE_COLS = new Set(['last_contact','next_action_due','due_date','meeting_date','last_contacted','target_date','posted_at','published_at','discovered_at','report_date','entry_date']);

async function dbPatch(tableId, rowId, col, value) {
  const apiTable = DB_API_TABLE[tableId] || tableId;
  const resp = await fetch(`/api/db/${apiTable}/${rowId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [col]: value }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function dbCreate(tableId, fields) {
  const apiTable = DB_API_TABLE[tableId] || tableId;
  const resp = await fetch(`/api/db/${apiTable}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function dbDelete(tableId, rowId) {
  const apiTable = DB_API_TABLE[tableId] || tableId;
  const resp = await fetch(`/api/db/${apiTable}/${rowId}`, { method: 'DELETE' });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${resp.status}`);
  }
}

const DB_TABLES = [
  { id: "companies",        label: "Companies" },
  { id: "contacts",         label: "Contacts" },
  { id: "tasks",            label: "Tasks" },
  { id: "meetings",         label: "Meetings" },
  { id: "linkedin",         label: "LinkedIn Posts", endpoint: "content/linkedin" },
  { id: "newsletters",      label: "Newsletters",    endpoint: "content/newsletters" },
  { id: "intel",            label: "Influencer Intel", endpoint: "content/intel" },
  { id: "reports",          label: "Daily Reports" },
  { id: "timeline",         label: "Timeline" },
];

const DB_SIDEBAR_GROUPS = [
  {
    label: "Sales", icon: "\u{1F4BC}",
    items: [
      // Companies moved to top-level "Companies" tab (with Coverage/Table/Kanban toggle).
      // Tasks moved to top-level "Tasks" tab (with List/Kanban/Database mode toggle).
      { id: "contacts",  label: "Contacts",  icon: "\u{1F464}" },
      { id: "meetings",  label: "Meetings",   icon: "\u{1F4C5}" },
    ],
  },
  {
    label: "Content", icon: "\u270F\uFE0F",
    items: [
      { id: "linkedin",    label: "LinkedIn",        icon: "\u{1F4AC}" },
      { id: "newsletters", label: "Newsletters",     icon: "\u{1F4E8}" },
      { id: "intel",       label: "Influencer Intel", icon: "\u{1F50D}" },
    ],
  },
  {
    label: "Operations", icon: "\u{1F4CA}",
    items: [
      { id: "timeline", label: "Timeline", icon: "\u{1F552}" },
    ],
  },
];

let dbStats = null;

async function loadDbStats() {
  if (dbStats) return dbStats;
  try {
    const r = await fetch("/api/db/stats");
    const j = await r.json();
    dbStats = Object.fromEntries((j.tables || []).map((t) => [t.table_name, t.n]));
  } catch (e) {
    dbStats = {};
  }
  return dbStats;
}

function dbStatLabel(id) {
  const map = {
    companies: dbStats?.companies,
    contacts: dbStats?.contacts,
    tasks: dbStats?.tasks,
    meetings: dbStats?.meetings,
    linkedin: dbStats?.linkedin_posts,
    newsletters: dbStats?.newsletters,
    intel: dbStats?.influencer_intel,
    reports: dbStats?.daily_reports,
    timeline: dbStats?.timeline,
  };
  const n = map[id];
  return n != null ? `<span class="db-count">${n}</span>` : "";
}

async function renderDb(activeId) {
  await loadDbStats();
  // Re-render sidebar so DB sub-item count badges and active state stay accurate
  await renderAppSidebar("db", activeId);
  const view = $("#db-view");
  const isKanban = activeId === "companies" && state.dbCompaniesMode === "kanban";
  view.innerHTML = `
    <div class="db-shell${isKanban ? " db-shell--kanban" : ""}">
      <section class="db-main${isKanban ? " db-main--kanban" : ""}" id="db-main">
        <div class="db-loading">Loading…</div>
      </section>
    </div>
  `;
  await renderDbTable(activeId);
}

// ─── Global app sidebar ───────────────────────────────────────────
// Renders the unified left sidebar nav: primary views (Agents/Inbox/History/
// GitHub) + Database section with Sales/Content/Operations sub-groups. Called
// from route() on every navigation so active states stay synced.
const APP_PRIMARY_NAV = [
  { id: "grid",      label: "Agents",    href: "#/agents",     icon: "\u{1F9E0}" },
  { id: "inbox",     label: "Tasks",     href: "#/tasks",      icon: "✓" },
  { id: "companies", label: "Companies", href: "#/companies",  icon: "\u{1F3E2}" },
  { id: "projects",  label: "Projects",  href: "#/projects",   icon: "\u{1F4CA}" },
  { id: "reports",   label: "Reports",   href: "#/reports",    icon: "\u{1F4CB}" },
  { id: "history",   label: "History",   href: "#/history",    icon: "\u{1F552}" },
  { id: "github",    label: "GitHub",    href: "#/github",     icon: "\u{1F4BB}" },
];

async function renderAppSidebar(activeView, activeDbId) {
  const slot = document.getElementById("app-sidebar-nav");
  if (!slot) return;

  // Pull DB stats lazily — don't block sidebar render on the network call
  if (!dbStats) {
    loadDbStats().then(() => {
      // Re-render once stats arrive so badges populate
      if (document.getElementById("app-sidebar-nav")) {
        renderAppSidebar(activeView, activeDbId);
      }
    });
  }

  const isDb = activeView === "db";

  const primaryHtml = APP_PRIMARY_NAV.map(item => {
    const active = item.id === activeView;
    return `
      <a href="${item.href}" class="app-nav-item ${active ? "active" : ""}" data-view="${item.id}">
        <span class="app-nav-icon">${item.icon}</span>
        <span class="app-nav-label">${item.label}</span>
      </a>`;
  }).join("");

  const dbGroupsHtml = DB_SIDEBAR_GROUPS.map(group => `
    <div class="app-nav-group">
      <div class="app-nav-group-label">
        <span class="app-nav-group-icon">${group.icon}</span>
        ${group.label}
      </div>
      ${group.items.map(t => {
        const isActive = isDb && t.id === activeDbId;
        const viewToggle = (t.id === "companies" && isActive) ? `
          <div class="db-sidebar-view-toggle">
            <select class="db-view-select" data-db-companies-mode-select>
              <option value="table"${state.dbCompaniesMode === "table" ? " selected" : ""}>Table</option>
              <option value="kanban"${state.dbCompaniesMode === "kanban" ? " selected" : ""}>Kanban</option>
            </select>
          </div>` : "";
        return `
        <a href="#/db/${t.id}" class="db-tab ${isActive ? "active" : ""}">
          <span class="db-tab-label">
            <span class="db-tab-icon">${t.icon}</span>
            ${t.label}
          </span>
          ${dbStatLabel(t.id)}
        </a>${viewToggle}`;
      }).join("")}
    </div>`).join("");

  slot.innerHTML = `
    <div class="app-nav-primary">${primaryHtml}</div>
    <div class="app-nav-db">
      <div class="app-nav-db-groups">${dbGroupsHtml}</div>
    </div>
  `;
}

// Sidebar collapse toggle
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".app-sidebar-toggle");
  if (!btn) return;
  const isCollapsed = document.body.classList.toggle("app-sidebar-collapsed");
  localStorage.setItem("mc_app_sidebar_collapsed", isCollapsed ? "1" : "0");
  btn.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
  const icon = btn.querySelector(".app-sidebar-toggle-icon");
  if (icon) icon.textContent = isCollapsed ? "☰" : "◀";
});

// Apply persisted collapse state on load (before first paint of sidebar contents)
if (localStorage.getItem("mc_app_sidebar_collapsed") === "1") {
  document.body.classList.add("app-sidebar-collapsed");
  const btn = document.querySelector(".app-sidebar-toggle");
  if (btn) {
    btn.title = "Expand sidebar";
    const icon = btn.querySelector(".app-sidebar-toggle-icon");
    if (icon) icon.textContent = "☰";
  }
}

async function renderDbTable(id) {
  const main = $("#db-main");
  if (!main) return;
  const meta = DB_TABLES.find((t) => t.id === id);
  if (!meta) {
    main.innerHTML = `<div class="db-empty">Unknown table: ${id}</div>`;
    return;
  }

  // Contacts: dedicated grouped-by-company view (default) with a flat-table fallback.
  if (id === "contacts" && state.dbContactsMode === "grouped") {
    await renderDbContactsGrouped(main);
    return;
  }

  const endpoint = meta.endpoint || id;
  try {
    const r = await fetch(`/api/db/${endpoint}?limit=200`);
    const j = await r.json();
    const rows = j.rows || [];
    if (!rows.length) {
      main.innerHTML = `<div class="db-empty">No rows.</div>`;
      return;
    }
    if (id === "companies" && state.dbCompaniesMode === "kanban") {
      main.innerHTML = renderDbCompaniesKanban(rows, { pageMode: "kanban" });
    } else if (id === "meetings") {
      main.innerHTML = renderDbMeetingsHtml(rows);
    } else {
      main.innerHTML = renderDbTableHtml(id, rows);
    }
    // Contacts table view: bolt on the same toolbar so users can switch back to grouped.
    if (id === "contacts") {
      const toolbar = main.querySelector(".db-table-toolbar");
      if (toolbar) {
        const switcher = document.createElement("button");
        switcher.className = "btn-ghost";
        switcher.dataset.dbContactsMode = "grouped";
        switcher.textContent = "Grouped view";
        toolbar.appendChild(switcher);
      }
    }
  } catch (e) {
    main.innerHTML = `<div class="db-empty">Error loading: ${e.message}</div>`;
  }
}

// ─── Contacts: grouped-by-company view ─────────────────────────
async function renderDbContactsGrouped(mount) {
  const q = state.dbContactsSearch || "";
  const role = state.dbContactsRole || "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (role) params.set("role", role);
  const url = `/api/db/contacts/grouped${params.toString() ? "?" + params : ""}`;
  let j;
  try {
    const r = await fetch(url);
    j = await r.json();
  } catch (e) {
    mount.innerHTML = `<div class="db-empty">Error loading: ${e.message}</div>`;
    return;
  }
  const groups = j.groups || [];
  const roles = j.roles || [];
  const totalContacts = groups.reduce((n, g) => n + g.contacts.length, 0);

  const fmtTouch = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    const now = new Date();
    const days = Math.floor((now - dt) / 86400000);
    if (days < 1) return "Today";
    if (days < 2) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  const touchTone = (d) => {
    if (!d) return "stale";
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    if (days <= 14) return "fresh";
    if (days <= 45) return "warm";
    return "stale";
  };
  const stagePill = (s) => s ? `<span class="pill stage-${escapeHtml(s)}">${escapeHtml(s)}</span>` : "";

  const roleOptionsHtml = ['<option value="">All roles</option>']
    .concat(roles.map(r => `<option value="${escapeHtml(r)}"${r.toLowerCase() === role.toLowerCase() ? " selected" : ""}>${escapeHtml(r)}</option>`))
    .join("");

  const renderContactRow = (x) => {
    const touch = x.last_touch;
    const touchLabel = fmtTouch(touch);
    return `
      <li class="db-contact-row" data-contact-id="${escapeHtml(x.contact_id)}">
        <span class="db-contact-row-name">${escapeHtml(x.name || "Unknown")}</span>
        <span class="db-contact-row-title">${x.title ? escapeHtml(x.title) : '<span class="db-null">—</span>'}</span>
        <span class="db-contact-row-role">${x.role ? `<span class="db-contact-role ${roleClass(x.role)}">${escapeHtml(x.role)}</span>` : '<span class="db-null">—</span>'}</span>
        <span class="db-contact-row-email">${x.email ? `<a href="mailto:${escapeHtml(x.email)}">${escapeHtml(x.email)}</a>` : '<span class="db-null">—</span>'}</span>
        <span class="db-contact-row-phone">${x.phone ? escapeHtml(x.phone) : (x.phone_office ? escapeHtml(x.phone_office) : '<span class="db-null">—</span>')}</span>
        <span class="db-contact-row-touch">${touchLabel ? `<span class="db-contact-touch touch-${touchTone(touch)}" title="Last touch">${touchLabel}</span>` : '<span class="db-null">—</span>'}</span>
      </li>`;
  };

  const sectionsHtml = groups.map(g => {
    const collapsed = state.dbContactsCollapsed.has(g.company_id);
    return `
      <section class="db-contacts-group ${collapsed ? "collapsed" : ""}" data-company-id="${escapeHtml(g.company_id)}">
        <header class="db-contacts-group-head" data-toggle-company="${escapeHtml(g.company_id)}">
          <span class="db-contacts-group-caret">${collapsed ? "▸" : "▾"}</span>
          <a href="#/db/companies/${escapeHtml(g.company_slug || g.company_id)}" class="db-contacts-group-name" onclick="event.stopPropagation()">${escapeHtml(g.company_name)}</a>
          ${stagePill(g.stage)}
          <span class="db-contacts-group-count">${g.contacts.length}</span>
        </header>
        ${collapsed ? "" : `
          <ul class="db-contact-list">
            <li class="db-contact-row db-contact-row-head">
              <span class="db-contact-row-name">Name</span>
              <span class="db-contact-row-title">Title</span>
              <span class="db-contact-row-role">Role</span>
              <span class="db-contact-row-email">Email</span>
              <span class="db-contact-row-phone">Phone</span>
              <span class="db-contact-row-touch">Last touch</span>
            </li>
            ${g.contacts.map(renderContactRow).join("")}
          </ul>`}
      </section>`;
  }).join("");

  mount.innerHTML = `
    <div class="db-contacts-toolbar">
      <div class="db-contacts-toolbar-left">
        <input type="search" class="db-contacts-search" placeholder="Search name, email, title, company…" value="${escapeHtml(q)}" />
        <select class="db-contacts-role-filter">${roleOptionsHtml}</select>
      </div>
      <div class="db-contacts-toolbar-right">
        <span class="db-table-meta">${groups.length} compan${groups.length === 1 ? "y" : "ies"} · ${totalContacts} contact${totalContacts === 1 ? "" : "s"}</span>
        <button class="btn-ghost" data-db-contacts-mode="table">Table view</button>
      </div>
    </div>
    ${groups.length ? `<div class="db-contacts-groups">${sectionsHtml}</div>` : `<div class="db-empty">No matches.</div>`}
  `;
}

function renderDbTableHtml(id, rows) {
  const fmtDisplay = (v) => {
    if (v == null) return '<span class="db-null">—</span>';
    if (Array.isArray(v)) return v.length ? escapeHtml(v.join(", ")) : '<span class="db-null">—</span>';
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
    if (typeof v === "string" && v.length > 80) return escapeHtml(v.slice(0, 80)) + "…";
    return escapeHtml(String(v));
  };

  const COLS = {
    companies: ["name", "stage", "risk", "last_contact", "next_action", "field", "action_status"],
    contacts: ["name", "email", "phone", "phone_office", "title", "role", "company_name"],
    tasks: ["name", "status", "action_type", "due_date", "company_name", "agent"],
    meetings: ["title", "meeting_date", "duration_minutes", "company_name", "status"],
    linkedin: ["title", "lane", "status", "post_type", "topic_tags"],
    newsletters: ["title", "series", "status", "target_date"],
    intel: ["influencer", "source_type", "relevance", "lane", "discovered_at"],
    reports: ["report_date", "agent", "report_type", "title"],
    timeline: ["entry_date", "entry_type", "title", "company_name", "source"],
  };
  const cols = COLS[id] || Object.keys(rows[0]);
  const pk = DB_PK[id];

  // Sort companies A-Z by name in table view
  if (id === "companies") rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const head = cols.map((c) => `<th>${c.replace(/_/g, " ")}</th>`).join("") + `<th class="db-th-actions"></th>`;
  const body = rows
    .map((row) => {
      const rowId = row[pk];
      const tds = cols.map((c) => {
        const ro = READ_ONLY_COLS.has(c);
        const enumKey = COL_ENUM_MAP[`${id}:${c}`];
        const isDate = DATE_COLS.has(c);
        const rawVal = row[c];
        const displayVal = fmtDisplay(rawVal);
        // Make company name a clickable link to detail view
        if (c === "name" && id === "companies" && row.slug) {
          return `<td class="db-cell-name"><a href="#/db/companies/${escapeHtml(row.slug)}" class="db-name-link">${displayVal}</a></td>`;
        }
        if (ro) return `<td class="db-cell-ro">${displayVal}</td>`;
        const safeRaw = rawVal == null ? "" : (typeof rawVal === "string" && /T\d\d:\d\d/.test(rawVal) ? rawVal.slice(0, 10) : rawVal);
        return `<td class="db-cell-edit" data-table="${id}" data-pk="${rowId}" data-col="${c}" data-enum="${enumKey || ""}" data-date="${isDate ? 1 : ""}" data-val="${escapeHtml(String(safeRaw))}">${displayVal}</td>`;
      }).join("");
      const detailLink = id === "companies" && row.slug
        ? `<a href="#/db/companies/${row.slug}" class="db-detail-link" title="Detail">→</a>`
        : "";
      const delBtn = `<button class="db-del-btn" data-table="${id}" data-pk="${rowId}" title="Delete">×</button>`;
      return `<tr class="db-row">${tds}<td class="db-cell-actions">${detailLink}${delBtn}</td></tr>`;
    })
    .join("");

  return `
    <div class="db-table-toolbar">
      <span class="db-table-meta">${rows.length} row${rows.length === 1 ? "" : "s"}</span>
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="btn-ghost db-add-btn" data-table="${id}">+ Add row</button>
      </div>
    </div>
    <div class="db-table-wrap">
      <table class="db-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

// ─── Companies Kanban view (by pipeline stage) ─────────────────
const STAGE_COLS = [
  { key: "target",       label: "Target",       tone: "target" },
  { key: "prospect",     label: "Prospect",     tone: "prospect" },
  { key: "discovery",    label: "Discovery",    tone: "discovery" },
  { key: "demo",         label: "Demo",         tone: "demo" },
  { key: "proposal",     label: "Proposal",     tone: "proposal" },
  { key: "negotiation",  label: "Negotiation",  tone: "negotiation" },
  { key: "on-hold-warm", label: "On Hold",      tone: "on-hold-warm" },
  { key: "closed-won",   label: "Closed Won",   tone: "closed-won" },
  { key: "closed-lost",  label: "Closed Lost",  tone: "closed-lost" },
];

// Stale-based tone keys the card border + days-pill color
function staleTone(days) {
  if (days == null) return "none";   // never contacted (e.g. target lists)
  if (days <= 7)  return "fresh";    // green
  if (days <= 30) return "warm";     // amber
  return "stale";                    // red
}

function renderDbCompaniesKanban(rows, opts = {}) {
  // Read persisted UI state
  const density     = localStorage.getItem("mc_kanban_density") || "comfortable"; // comfortable | compact
  const showClosed  = localStorage.getItem("mc_kanban_show_closed") === "1";
  const pageMode    = opts.pageMode || "kanban"; // for the embedded Coverage/Table/Kanban toggle

  // Kanban is pipeline-only by stage: the columns themselves restrict what shows up.
  // Exclude only the explicit CS-owned closed-won clients (they shouldn't appear on a deal pipeline).
  const filtered = rows.filter((r) => r.owning_agent !== "cs");

  // Visible stages — hide closed columns unless toggled on
  const visibleStages = STAGE_COLS.filter(s => showClosed || !s.key.startsWith("closed-"));

  // Bucket by stage
  const byStage = {};
  visibleStages.forEach((s) => (byStage[s.key] = []));
  filtered.forEach((r) => {
    const stage = r.stage || "target";
    if (byStage[stage]) byStage[stage].push(r);
    // companies in hidden closed stages just drop out of view
  });

  // Sort each column: uncovered first, then most-stale (largest days_since_contact) first
  for (const k of Object.keys(byStage)) {
    byStage[k].sort((a, b) => {
      if ((b.is_uncovered ? 1 : 0) !== (a.is_uncovered ? 1 : 0)) {
        return (b.is_uncovered ? 1 : 0) - (a.is_uncovered ? 1 : 0);
      }
      const da = a.days_since_contact == null ? -1 : a.days_since_contact;
      const db_ = b.days_since_contact == null ? -1 : b.days_since_contact;
      return db_ - da;
    });
  }

  const totals = {
    pipeline: filtered.length,
    uncovered: filtered.filter(r => r.is_uncovered).length,
  };

  // Concise days label for the right-side pill
  const daysLabel = (d) => {
    if (d == null) return "—";
    if (d === 0) return "today";
    if (d === 1) return "1d";
    if (d < 30) return `${d}d`;
    if (d < 365) return `${Math.round(d / 30)}mo`;
    return `${Math.round(d / 365)}y`;
  };

  // Card markup — clean two-row layout: name + days pill on top, optional next-action below.
  const renderCard = (r) => {
    const tone = staleTone(r.days_since_contact);
    const taskCount = Number(r.open_task_count || 0);
    const uncovered = r.is_uncovered;
    const action = r.next_action ? truncate(r.next_action, 110) : null;
    const compact = density === "compact";
    return `
      <a href="#/companies/${escapeHtml(r.slug || r.company_id)}"
         class="db-kanban-card db-kanban-card--link kc kc--${tone}${uncovered ? " kc--uncovered" : ""}${compact ? " kc--compact" : ""}"
         draggable="false"
         data-company-id="${escapeHtml(r.company_id)}"
         data-slug="${escapeHtml(r.slug || "")}">
        <div class="kc-row1">
          <span class="kc-name">${escapeHtml(r.name)}</span>
          <span class="kc-days kc-days--${tone}" title="${r.days_since_contact == null ? "Never contacted" : r.days_since_contact + " days since last touch"}">${daysLabel(r.days_since_contact)}</span>
        </div>
        ${action && !compact ? `<div class="kc-action">${escapeHtml(action)}</div>` : ""}
        <div class="kc-meta">
          ${taskCount > 0 ? `<span class="kc-pill kc-pill--tasks">${taskCount} task${taskCount === 1 ? "" : "s"}</span>` : ""}
          ${uncovered ? `<span class="kc-pill kc-pill--alert">no plan</span>` : ""}
        </div>
      </a>`;
  };

  const headerCols = visibleStages.map((s) => {
    const items = byStage[s.key];
    return `
      <div class="kanban-col-head db-kanban-stage-${s.tone}">
        <span class="kanban-col-label">${escapeHtml(s.label)}</span>
        <span class="kanban-col-count">${items.length}</span>
      </div>`;
  }).join("");

  const bodyCols = visibleStages.map((s) => {
    const items = byStage[s.key];
    const emptyCls = items.length === 0 ? " kanban-col--empty" : "";
    return `
      <div class="kanban-col${emptyCls} db-kanban-stage-${s.tone}" data-stage="${escapeHtml(s.key)}">
        <div class="kanban-col-body">
          ${items.length ? items.map(renderCard).join("") : '<div class="kanban-empty">None</div>'}
        </div>
      </div>
    `;
  }).join("");

  const pageBtn = (id, label) => `
    <button class="kc-toolbar-tog${pageMode === id ? " kc-toolbar-tog--active" : ""}" data-cov-page-mode="${id}">${label}</button>`;
  const densBtn = (id, label) => `
    <button class="kc-toolbar-tog${density === id ? " kc-toolbar-tog--active" : ""}" data-kanban-density="${id}">${label}</button>`;

  return `
    <div class="kc-sticky-head">
      <div class="kc-toolbar">
        <div class="kc-toolbar-group kc-toolbar-group--toggle">
          ${pageBtn("coverage", "Coverage")}
          ${pageBtn("table", "Table")}
          ${pageBtn("kanban", "Kanban")}
        </div>
        <div class="kc-toolbar-stat-inline">
          <span class="kc-toolbar-stat-num">${totals.pipeline}</span> pipeline deals
          ${totals.uncovered ? `<span class="kc-toolbar-stat-divider">·</span><span class="kc-toolbar-stat--alert-inline">${totals.uncovered} uncovered</span>` : ""}
        </div>
        <div class="kc-toolbar-spacer"></div>
        <div class="kc-toolbar-group kc-toolbar-group--toggle">
          ${densBtn("comfortable", "Comfy")}
          ${densBtn("compact", "Compact")}
        </div>
        <label class="kc-toolbar-checkbox">
          <input type="checkbox" data-kanban-show-closed ${showClosed ? "checked" : ""}>
          <span>Show closed</span>
        </label>
      </div>
      <div class="db-kanban-header-row">${headerCols}</div>
    </div>
    <div class="db-kanban-wrap">
      <div class="db-kanban-board">${bodyCols}</div>
    </div>
    <div class="db-kanban-scrollbar-proxy"><div></div></div>
  `;
}

// "May 14th, 26" from an ISO string. Ordinal suffix on the day, 2-digit year, no apostrophe.
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
function formatDateDMY(iso) {
  if (!iso) return "";
  const ymd = iso.slice(0, 10);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return iso.slice(0, 10);
  return `${MONTHS_SHORT[m - 1]} ${d}${ordinalSuffix(d)}, ${String(y).slice(2)}`;
}

function renderDbMeetingsHtml(rows) {
  const filter = state.meetingTypeFilter || "all";
  const filteredRows = rows.filter((x) => {
    const t = (x.status || "").trim().toLowerCase();
    if (filter === "internal") return t === "internal";
    if (filter === "external") return t !== "internal";
    return true;
  });
  const body = filteredRows.map((x, i) => {
    const hasNote = !!x.note_id;
    const hasTranscript = !!(x.has_transcript);
    const hasSummary = !!(x.has_summary);
    const hasContent = hasNote || hasTranscript || hasSummary;
    const contentId = hasNote ? x.note_id : x.meeting_id;
    const date = formatDateDMY(x.meeting_date);
    // Company cell is editable in-place for meetings: click to pick from companies,
    // or trigger AI re-match via the magic-wand button.
    const companyDisplay = x.company_slug
      ? `<a href="#/db/companies/${x.company_slug}" class="db-detail-link" data-stop>${escapeHtml(x.company_name || "")}</a>`
      : '<span class="db-null">Set company</span>';
    const matchBtn = x.meeting_id
      ? `<button class="db-match-btn" data-meeting-id="${x.meeting_id}" title="Re-match company with AI">✨</button>`
      : "";
    const companyCell = x.meeting_id
      ? `<td class="db-cell-edit-company" data-table="meetings" data-pk="${x.meeting_id}" data-col="company_id" data-val="${escapeHtml(x.company_slug || "")}">${companyDisplay} ${matchBtn}</td>`
      : `<td>${companyDisplay}</td>`;

    // Title is clickable to the recording (Fathom share URL preferred, then recording URL).
    const recordingUrl = x.share_url || x.recording_url || "";
    const titleText = escapeHtml(x.title || "");
    const titleCell = recordingUrl
      ? `<a href="${escapeHtml(recordingUrl)}" target="_blank" rel="noopener" class="db-name-link" title="Open recording">${titleText}</a>`
      : (x.meeting_id ? `<a href="#/db/meetings/${x.meeting_id}" class="db-name-link">${titleText}</a>` : titleText);

    // Fathom recording link — Share URL preferred, fall back to raw recording URL.
    const fathomUrl = x.share_url || x.recording_url || "";
    const fathomCell = fathomUrl
      ? `<a href="${escapeHtml(fathomUrl)}" target="_blank" rel="noopener" data-stop class="db-fathom-link-btn" title="Open Fathom recording">Fathom ↗</a>`
      : '<span class="db-null">-</span>';

    // Status column shows meeting type \u2014 null/"completed" both render as dash.
    const rawStatus = (x.status || "").trim();
    const typeInner = (rawStatus && rawStatus.toLowerCase() !== "completed")
      ? `<span class="db-pill ${meetingTypeClass(rawStatus)}">${escapeHtml(rawStatus)}</span>`
      : '<span class="db-null">-</span>';
    const typeCell = x.meeting_id
      ? `<td class="db-cell-edit" data-table="meetings" data-pk="${x.meeting_id}" data-col="status" data-val="${escapeHtml(rawStatus)}" data-enum="meeting_type">${typeInner}</td>`
      : `<td>${typeInner}</td>`;

    const pk = x.meeting_id || x.note_id;
    const delTable = x.meeting_id ? "meetings" : "meeting_notes";
    const detailLink = x.meeting_id
      ? `<a href="#/db/meetings/${x.meeting_id}" class="db-detail-link" title="Detail">\u2192</a>`
      : "";
    return `
      <tr class="db-meeting-row ${hasContent ? "db-row-clickable" : ""}" data-meeting-idx="${i}" data-content-id="${contentId || ""}">
        <td>${titleCell}</td>
        <td>${date}</td>
        <td>${x.duration_minutes || '<span class="db-null">-</span>'}</td>
        ${companyCell}
        ${typeCell}
        <td>${fathomCell}</td>
        <td class="db-cell-actions">${detailLink}<button class="db-del-btn" data-table="${delTable}" data-pk="${pk}" title="Delete">\u00d7</button></td>
      </tr>
      ${hasContent ? `<tr class="db-meeting-detail" id="db-meeting-${i}" style="display:none"><td colspan="7"><div class="db-meeting-body db-meeting-loading">Loading...</div></td></tr>` : ""}`;
  }).join("");

  const filterBtn = (val, label) =>
    `<button class="btn-ghost db-meeting-filter ${filter === val ? "active" : ""}" data-meeting-filter="${val}">${label}</button>`;
  return `
    <div class="db-table-toolbar">
      <span class="db-table-meta">${filteredRows.length} of ${rows.length} row${rows.length === 1 ? "" : "s"}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="db-meeting-filter-group">
          ${filterBtn("external", "External")}
          ${filterBtn("internal", "Internal")}
          ${filterBtn("all", "All")}
        </div>
        <button class="btn-ghost db-add-btn" data-table="meetings">+ Add row</button>
      </div>
    </div>
    <div class="db-table-wrap">
      <table class="db-table db-meetings-table">
        <thead><tr><th>Title</th><th>Date</th><th>Min</th><th>Company</th><th>Type</th><th>Recording</th><th class="db-th-actions"></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

// Parse Fathom transcript (text[] of stringified JSON objects, or a plain string)
// into readable "Speaker [timestamp]: text" lines.
function meetingTypeClass(t) {
  if (!t) return "";
  return "pill-type-" + String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function formatTranscript(raw) {
  if (!raw) return "";
  let arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try { arr = JSON.parse(trimmed); } catch { /* fall through */ }
    }
    // Postgres text[] literal: {"json-string-1","json-string-2",...}
    if (!arr && trimmed.startsWith("{") && trimmed.endsWith("}")) {
      arr = parsePgTextArray(trimmed);
    }
    if (!arr) return escapeHtml(raw).replace(/\n/g, "<br>");
  }
  if (!Array.isArray(arr)) return "";
  let lastSpeaker = null;
  const lines = [];
  for (const entry of arr) {
    let obj = entry;
    if (typeof entry === "string") {
      try { obj = JSON.parse(entry); } catch { continue; }
    }
    if (!obj || typeof obj !== "object") continue;
    const speaker = obj.speaker?.display_name || obj.speaker?.name || "Unknown";
    const text = (obj.text || "").trim();
    const ts = obj.timestamp || "";
    if (!text) continue;
    if (speaker !== lastSpeaker) {
      lines.push(`<div class="transcript-speaker"><b>${escapeHtml(speaker)}</b>${ts ? ` <span class="transcript-ts">${escapeHtml(ts)}</span>` : ""}</div>`);
      lastSpeaker = speaker;
    }
    lines.push(`<div class="transcript-line">${escapeHtml(text)}</div>`);
  }
  return lines.join("");
}

// Parse a Postgres text[] literal like {"a","b\"c"} into an array of JS strings.
function parsePgTextArray(s) {
  if (s.length < 2 || s[0] !== "{" || s[s.length - 1] !== "}") return null;
  const body = s.slice(1, -1);
  if (!body) return [];
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === ",") { i++; continue; }
    if (body[i] === '"') {
      let buf = "";
      i++;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "\\" && i + 1 < body.length) {
          buf += body[i + 1];
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          buf += ch;
          i++;
        }
      }
      out.push(buf);
    } else {
      let buf = "";
      while (i < body.length && body[i] !== ",") { buf += body[i++]; }
      out.push(buf === "NULL" ? null : buf);
    }
  }
  return out;
}

async function renderDbMeeting(meetingId) {
  await loadDbStats();
  const view = $("#db-view");
  view.innerHTML = `<div class="db-detail"><div class="db-loading">Loading meeting&hellip;</div></div>`;
  view.hidden = false;

  try {
    const resp = await fetch(`/api/db/meetings/${meetingId}/full`);
    if (!resp.ok) throw new Error("Meeting not found");
    const { row: m } = await resp.json();

    const date = m.meeting_date ? m.meeting_date.slice(0, 10) : "";
    const dateDisplay = formatDateDMY(m.meeting_date);
    const time = m.meeting_date && m.meeting_date.includes("T") ? m.meeting_date.slice(11, 16) : "";
    const companyLink = m.company_slug
      ? `<a href="#/db/companies/${escapeHtml(m.company_slug)}" class="db-detail-link">${escapeHtml(m.company_name || "Unknown")}</a>`
      : escapeHtml(m.company_name || "No company");
    const fathomLink = m.share_url
      ? `<a href="${escapeHtml(m.share_url)}" target="_blank">${escapeHtml(m.share_url)}</a>`
      : '<span class="db-null">No share link</span>';
    const recordingLink = m.recording_url
      ? `<a href="${escapeHtml(m.recording_url)}" target="_blank">${escapeHtml(m.recording_url)}</a>`
      : '<span class="db-null">No recording</span>';
    const attendeesStr = Array.isArray(m.attendees) ? m.attendees.join(", ") : (m.attendees || "");

    view.innerHTML = `
      <div class="db-detail">
        <a href="#/db/meetings" class="db-back-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Meetings</a>

        <div class="db-detail-header">
          <h2 class="db-detail-title">${escapeHtml(m.title || "Untitled Meeting")}</h2>
          <div class="db-detail-pills">
            ${m.status ? `<span class="db-pill ${meetingTypeClass(m.status)}">${escapeHtml(m.status)}</span>` : ""}
            ${m.source ? `<span class="db-pill">${escapeHtml(m.source)}</span>` : ""}
          </div>
        </div>

        <div class="db-detail-grid">
          <div class="db-detail-card">
            <h3>Details</h3>
            <table class="db-props-table">
              <tr><td class="db-prop-label">Title</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="title" data-val="${escapeHtml(m.title || "")}">${escapeHtml(m.title || "")}</td></tr>
              <tr><td class="db-prop-label">Date</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="meeting_date" data-val="${date}" data-date="1">${dateDisplay}${time ? " " + time : ""}</td></tr>
              <tr><td class="db-prop-label">Duration (min)</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="duration_minutes" data-val="${m.duration_minutes || ""}">${m.duration_minutes || '<span class="db-null">-</span>'}</td></tr>
              <tr><td class="db-prop-label">Company</td><td>${companyLink}</td></tr>
              <tr><td class="db-prop-label">Type</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="status" data-val="${escapeHtml(m.status || "")}" data-enum="meeting_type">${m.status ? `<span class="db-pill ${meetingTypeClass(m.status)}">${escapeHtml(m.status)}</span>` : '<span class="db-null">-</span>'}</td></tr>
              <tr><td class="db-prop-label">Source</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="source" data-val="${escapeHtml(m.source || "")}">${escapeHtml(m.source || "") || '<span class="db-null">-</span>'}</td></tr>
              <tr><td class="db-prop-label">Attendees</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="attendees" data-val="${escapeHtml(attendeesStr)}">${escapeHtml(attendeesStr) || '<span class="db-null">-</span>'}</td></tr>
            </table>
          </div>

          <div class="db-detail-card">
            <h3>Links</h3>
            <table class="db-props-table">
              <tr><td class="db-prop-label">Fathom Share</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="share_url" data-val="${escapeHtml(m.share_url || "")}">${fathomLink}</td></tr>
              <tr><td class="db-prop-label">Recording</td><td class="db-cell-edit" data-table="meetings" data-pk="${m.meeting_id}" data-col="recording_url" data-val="${escapeHtml(m.recording_url || "")}">${recordingLink}</td></tr>
              <tr><td class="db-prop-label">Notion ID</td><td>${escapeHtml(m.notion_id || "") || '<span class="db-null">-</span>'}</td></tr>
              <tr><td class="db-prop-label">Fathom ID</td><td>${escapeHtml(m.fathom_id || "") || '<span class="db-null">-</span>'}</td></tr>
            </table>
          </div>
        </div>

        ${m.summary ? `
        <div class="db-detail-card" style="margin-top:1rem">
          <h3>Summary</h3>
          <div class="db-meeting-body">${escapeHtml(m.summary).replace(/\\n/g, "<br>")}</div>
        </div>` : ""}

        ${m.transcript ? `
        <div class="db-detail-card" style="margin-top:1rem">
          <h3>Transcript</h3>
          <div class="db-meeting-body transcript-body" style="max-height:500px;overflow-y:auto;font-size:0.875rem;">${formatTranscript(m.transcript)}</div>
        </div>` : ""}

        <div style="margin-top:1.5rem">
          <button class="btn-ghost" style="color:var(--red)" onclick="if(confirm('Delete this meeting?')){dbDelete('meetings','${m.meeting_id}').then(()=>{toast('Deleted');location.hash='#/db/meetings'}).catch(err=>toast('Error: '+err.message))}">Delete Meeting</button>
        </div>
      </div>
    `;
  } catch (err) {
    view.innerHTML = `<div class="db-detail"><a href="#/db/meetings" class="db-back-link">Back</a><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

async function renderDbCompany(slug, opts = {}) {
  const containerSel = opts.container || "#db-view";
  const backHref = opts.backHref || "#/db/companies";
  const backLabel = opts.backLabel || "Companies";
  if (containerSel === "#db-view") await loadDbStats();
  const view = $(containerSel);
  view.innerHTML = `
    <div class="db-shell db-shell--detail">
      <section class="db-main db-main--detail"><div class="db-loading">Loading ${escapeHtml(slug)}&hellip;</div></section>
    </div>
  `;
  try {
    const r = await fetch(`/api/db/companies/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const c = j.company;
    const main = view.querySelector(".db-main");

    // Helper: initials from name
    const initials = (name) => (name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2);
    // Helper: days-since color
    const daysColor = (d) => d == null ? "" : d <= 7 ? "stat-green" : d <= 30 ? "stat-amber" : "stat-red";
    // Helper: role CSS class
    const roleClass = (role) => "role-" + (role || "user").toLowerCase().replace(/\s+/g, "-");
    // Helper: task status class
    const taskStatusClass = (s) => {
      if (!s) return "status-not-started";
      const sl = s.toLowerCase();
      if (sl === "done" || sl === "completed") return "status-done";
      if (sl.includes("progress")) return "status-in-progress";
      return "status-not-started";
    };
    // Helper: is task overdue
    const isOverdue = (d) => d && new Date(d) < new Date() && new Date(d).toDateString() !== new Date().toDateString();

    main.innerHTML = `
      <div class="db-detail">
        <a href="${escapeHtml(backHref)}" class="db-back-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> ${escapeHtml(backLabel)}</a>

        <!-- Hero Header -->
        <div class="db-detail-header">
          <div class="db-detail-header-left">
            <h2>${escapeHtml(c.name)}</h2>
            <div class="db-detail-meta">
              <span class="pill stage-${c.stage}">${c.stage}</span>
              <span class="pill risk-${c.risk}">${c.risk || "unknown"}</span>
              ${c.field ? `<span class="db-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v1a3 3 0 006 0V7m0 1a3 3 0 006 0V7m0 1a3 3 0 006 0V7H3l2-4h14l2 4M5 21V10.87M19 21V10.87"/></svg> ${escapeHtml(c.field)}</span>` : ""}
            </div>
          </div>
        </div>

        <!-- Stat Cards -->
        <div class="db-stat-row">
          <div class="db-stat-card">
            <span class="db-stat-label">Last Contact</span>
            <span class="db-stat-value">${c.last_contact ? c.last_contact.slice(0, 10) : "-"}</span>
          </div>
          <div class="db-stat-card">
            <span class="db-stat-label">Days Since</span>
            <span class="db-stat-value ${daysColor(c.days_since_contact)}">${c.days_since_contact != null ? c.days_since_contact + "d" : "-"}</span>
          </div>
          <div class="db-stat-card">
            <span class="db-stat-label">Contacts</span>
            <span class="db-stat-value">${j.contacts.length}</span>
          </div>
          <div class="db-stat-card">
            <span class="db-stat-label">Meetings</span>
            <span class="db-stat-value">${j.meetings.length}</span>
          </div>
          <div class="db-stat-card">
            <span class="db-stat-label">Open Tasks</span>
            <span class="db-stat-value">${j.tasks.filter(t => t.status !== "Done").length}</span>
          </div>
        </div>

        ${c.next_action ? `<div class="db-next-action">${escapeHtml(c.next_action)}</div>` : ""}

        <!-- Contacts Section -->
        <h3>Contacts <span class="db-count">${j.contacts.length}</span></h3>
        ${j.contacts.length ? `
          <div class="db-contacts-grid">
            ${j.contacts.map((x) => `
              <div class="db-contact-card">
                <div class="db-contact-avatar">${initials(x.name)}</div>
                <div class="db-contact-info">
                  <div class="db-contact-name">${escapeHtml(x.name || "Unknown")}</div>
                  ${x.title ? `<div class="db-contact-title">${escapeHtml(x.title)}</div>` : ""}
                  ${x.role ? `<span class="db-contact-role ${roleClass(x.role)}">${escapeHtml(x.role)}</span>` : ""}
                  ${x.email ? `<div class="db-contact-detail-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 01-2.06 0L2 7"/></svg> ${escapeHtml(x.email)}</div>` : ""}
                  ${x.phone ? `<div class="db-contact-detail-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg> ${escapeHtml(x.phone)}</div>` : ""}
                  ${x.phone_office ? `<div class="db-contact-detail-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg> ${escapeHtml(x.phone_office)}</div>` : ""}
                </div>
              </div>`).join("")}
          </div>` : `<div class="db-empty">No contacts.</div>`}

        <!-- Tabbed Sections: Emails / Meetings / Tasks / Timeline -->
        <div class="db-section-tabs" style="margin-top: 28px;">
          <button class="db-section-tab active" data-tab="emails"><svg class="outlook-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6zm-2 0l-8 5-8-5h16zm0 12H4V8l8 5 8-5v10z" fill="currentColor"/></svg> Emails <span class="db-count" id="db-emails-count">&hellip;</span></button>
          <button class="db-section-tab" data-tab="meetings">Meetings <span class="db-count">${j.meetings.length}</span></button>
          <button class="db-section-tab" data-tab="tasks">Tasks <span class="db-count">${j.tasks.length}</span></button>
          <button class="db-section-tab" data-tab="timeline">Timeline <span class="db-count">${(j.timeline || []).length}</span></button>
        </div>

        <!-- Emails Panel -->
        <div class="db-section-panel active" id="db-panel-emails">
          <div class="db-emails-toolbar">
            <div class="db-emails-brand"><svg viewBox="0 0 278 278" width="20" height="20"><defs><linearGradient id="og" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0078d4"/><stop offset="100%" stop-color="#0053a6"/></linearGradient></defs><rect width="278" height="278" rx="40" fill="url(#og)"/><path d="M139 65c-40.8 0-74 33.2-74 74v0l74 46.3L213 139v0c0-40.8-33.2-74-74-74z" fill="#fff" opacity=".15"/><path d="M65 113v66c0 15.5 12.5 28 28 28h92c15.5 0 28-12.5 28-28v-66L139 159 65 113z" fill="#fff"/><path d="M213 113l-74 46-74-46v-6c0-15.5 12.5-28 28-28h92c15.5 0 28 12.5 28 28v6z" fill="#fff" opacity=".8"/></svg> Outlook</div>
            <div class="db-emails-view-toggle">
              <button class="db-email-view-btn active" data-email-view="cards" title="Card view"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
              <button class="db-email-view-btn" data-email-view="table" title="Table view"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
            </div>
          </div>
          <div id="db-emails-body" class="db-emails-loading">Loading emails from Outlook...</div>
        </div>

        <!-- Meetings Panel -->
        <div class="db-section-panel" id="db-panel-meetings">
          ${j.meetings.length ? `
            <table class="db-table inset db-meetings-table">
              <thead><tr><th>Title</th><th>Date</th><th>Min</th><th>Fathom</th><th>Status</th><th>Content</th></tr></thead>
              <tbody>${j.meetings.map((x, i) => {
                const hasNote = !!x.note_id;
                const hasTranscript = !!(x.has_transcript);
                const hasSummary = !!(x.has_summary);
                const hasContent = hasNote || hasTranscript || hasSummary;
                const contentLabel = hasNote ? `${x.note_words || 0}w` : (hasTranscript ? "transcript" : (hasSummary ? "summary" : ""));
                const contentId = hasNote ? x.note_id : x.meeting_id;
                const shareLink = x.share_url
                  ? `<a href="${escapeHtml(x.share_url)}" target="_blank" class="db-fathom-link" title="Fathom share link">&#128279;</a>`
                  : '<span class="db-null">-</span>';
                return `
                <tr class="db-meeting-row ${hasContent ? "db-row-clickable" : ""}" data-meeting-idx="${i}" data-content-id="${contentId || ""}">
                  <td>${escapeHtml(x.title || "")}</td>
                  <td>${formatDateDMY(x.meeting_date)}</td>
                  <td>${x.duration_minutes || ""}</td>
                  <td>${shareLink}</td>
                  <td>${escapeHtml(x.status || "")}</td>
                  <td>${hasContent
                    ? `<span class="db-content-badge">${contentLabel}</span>`
                    : '<span class="db-null">-</span>'}</td>
                </tr>
                ${hasContent ? `<tr class="db-meeting-detail" id="db-meeting-${i}" style="display:none"><td colspan="6"><div class="db-meeting-body db-meeting-loading">Loading...</div></td></tr>` : ""}`;
              }).join("")}
              </tbody>
            </table>` : `<div class="db-empty">No meetings.</div>`}
        </div>

        <!-- Tasks Panel -->
        <div class="db-section-panel" id="db-panel-tasks">
          ${j.tasks.length ? `
            <div class="db-tasks-list">
              ${j.tasks.map((x, ti) => {
                const hasNotes = !!(x.notes && x.notes.trim());
                const created = x.created_at ? new Date(x.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
                const completed = x.completed_at ? new Date(x.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
                const dueStr = x.due_date ? x.due_date.slice(0, 10) : "";
                const overdue = isOverdue(x.due_date) && taskStatusClass(x.status) !== "status-done";
                return `
                <div class="db-task-card ${hasNotes ? "db-task-expandable" : ""}" ${hasNotes ? `data-task-idx="${ti}"` : ""}>
                  <div class="db-task-card-top">
                    <div class="db-task-status-dot ${taskStatusClass(x.status)}"></div>
                    <div class="db-task-content">
                      <div class="db-task-name">${escapeHtml(x.name || "")}</div>
                      <div class="db-task-meta">
                        ${x.action_type ? `<span class="db-task-type-pill">${escapeHtml(x.action_type)}</span>` : ""}
                        ${x.status ? `<span class="db-task-status-label">${escapeHtml(x.status)}</span>` : ""}
                        ${x.agent ? `<span class="db-task-agent">${escapeHtml(x.agent)}</span>` : ""}
                        ${created ? `<span>Created ${created}</span>` : ""}
                        ${completed ? `<span>Done ${completed}</span>` : ""}
                      </div>
                    </div>
                    <div class="db-task-right">
                      ${dueStr ? `<span class="db-task-due ${overdue ? "overdue" : ""}">${overdue ? "OVERDUE " : ""}${dueStr}</span>` : ""}
                      ${hasNotes ? `<svg class="db-task-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>` : ""}
                    </div>
                  </div>
                  ${hasNotes ? `<div class="db-task-notes" id="db-task-notes-${ti}" style="display:none"><div class="db-task-notes-inner">${escapeHtml(x.notes)}</div></div>` : ""}
                </div>`;
              }).join("")}
            </div>` : `<div class="db-empty">No tasks.</div>`}
        </div>

        <!-- Timeline Panel -->
        <div class="db-section-panel" id="db-panel-timeline">
          ${(j.timeline || []).length ? `
            <div class="db-timeline-list">
              ${j.timeline.map((x) => `
                <div class="db-timeline-item">
                  <div class="db-timeline-dot tl-${x.entry_type || "other"}"></div>
                  <div class="db-timeline-content">
                    <div class="db-timeline-title">${escapeHtml(x.title || "")}</div>
                    <div class="db-timeline-sub">
                      <span class="pill entry-type-${x.entry_type || "other"}">${escapeHtml(x.entry_type || "")}</span>
                      ${x.entry_date ? `<span>${x.entry_date.slice(0, 10)}</span>` : ""}
                      ${x.source ? `<span>${escapeHtml(x.source)}</span>` : ""}
                    </div>
                  </div>
                </div>`).join("")}
            </div>` : `<div class="db-empty">No timeline entries.</div>`}
        </div>
      </div>
    `;

    // Tab switching
    main.querySelectorAll(".db-section-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        main.querySelectorAll(".db-section-tab").forEach(t => t.classList.remove("active"));
        main.querySelectorAll(".db-section-panel").forEach(p => p.classList.remove("active"));
        tab.classList.add("active");
        const panel = document.getElementById(`db-panel-${tab.dataset.tab}`);
        if (panel) panel.classList.add("active");
      });
    });

    // Async-load emails from Outlook (non-blocking)
    loadCompanyEmails(slug);
  } catch (e) {
    view.querySelector(".db-main").innerHTML = `<div class="db-empty">Error: ${e.message}</div>`;
  }
}

// Store email thread data for re-rendering between views
let _emailThreadCache = null;

async function loadCompanyEmails(slug) {
  const countEl = document.getElementById("db-emails-count");
  const bodyEl = document.getElementById("db-emails-body");
  if (!bodyEl) return;
  try {
    const r = await fetch(`/api/outlook/emails/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const msgs = j.emails || [];
    if (countEl) countEl.textContent = msgs.length;
    if (!msgs.length) {
      bodyEl.className = "";
      bodyEl.innerHTML = `<div class="db-empty">${j.note || "No emails found."}</div>`;
      return;
    }
    // Group by conversationId for thread view
    const threads = new Map();
    for (const m of msgs) {
      const key = m.conversationId || m.id;
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key).push(m);
    }
    const threadList = [...threads.entries()].map(([convId, items]) => {
      items.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { convId, latest: items[0], count: items.length };
    });
    threadList.sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
    _emailThreadCache = threadList;

    bodyEl.className = "";
    renderEmailView("cards", bodyEl, threadList);
  } catch (err) {
    if (countEl) countEl.textContent = "!";
    bodyEl.className = "";
    bodyEl.innerHTML = `<div class="db-empty">Could not load emails: ${escapeHtml(err.message)}</div>`;
  }
}

function renderEmailView(mode, container, threadList) {
  if (mode === "cards") {
    container.innerHTML = `<div class="db-email-cards">${threadList.map((t, i) => {
      const m = t.latest;
      const fromName = m.from ? escapeHtml(m.from.name || m.from.address || "") : "Unknown";
      const fromInitials = (m.from?.name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
      const date = m.date ? new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      const time = m.date ? new Date(m.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
      const isSent = (m.from?.address || "").toLowerCase().includes("matthew") || (m.from?.address || "").toLowerCase().includes("skysuite");
      return `
      <div class="db-email-card ${!m.isRead ? "unread" : ""} db-row-clickable" data-email-idx="${i}" data-email-id="${escapeHtml(m.id)}">
        <div class="db-email-card-header">
          <div class="db-email-card-avatar ${isSent ? "sent" : ""}">${isSent ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' : fromInitials}</div>
          <div class="db-email-card-from">
            <span class="db-email-card-name">${fromName}</span>
            ${isSent ? '<span class="db-email-card-sent-badge">Sent</span>' : ""}
          </div>
          <div class="db-email-card-date">${date}<br><span>${time}</span></div>
        </div>
        <div class="db-email-card-subject">${escapeHtml(m.subject)}${m.hasAttachments ? ' <span class="db-email-attach" title="Has attachments">&#128206;</span>' : ""}${t.count > 1 ? ` <span class="db-email-thread-count">${t.count}</span>` : ""}</div>
        <div class="db-email-card-preview">${escapeHtml(m.preview || "")}</div>
        <div class="db-email-card-expand" id="db-email-${i}" style="display:none">
          <div class="db-email-thread-body" id="db-email-thread-${i}"></div>
        </div>
      </div>`;
    }).join("")}</div>`;
  } else {
    container.innerHTML = `
      <table class="db-table inset db-emails-table">
        <thead><tr><th>Subject</th><th>From</th><th>Date</th><th>Msgs</th></tr></thead>
        <tbody>${threadList.map((t, i) => {
          const m = t.latest;
          const fromLabel = m.from ? escapeHtml(m.from.name || m.from.address) : "";
          const date = m.date ? new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
          return `
          <tr class="db-email-row db-row-clickable" data-email-idx="${i}" data-email-id="${escapeHtml(m.id)}"${!m.isRead ? ' class="db-email-unread"' : ""}>
            <td>${escapeHtml(m.subject)}${m.hasAttachments ? ' <span class="db-email-attach" title="Has attachments">&#128206;</span>' : ""}</td>
            <td>${fromLabel}</td>
            <td>${date}</td>
            <td>${t.count > 1 ? `<span class="db-content-badge">${t.count}</span>` : ""}</td>
          </tr>
          <tr class="db-email-detail" id="db-email-${i}" style="display:none">
            <td colspan="4"><div class="db-email-preview">${escapeHtml(m.preview)}</div><div class="db-email-thread-body" id="db-email-thread-${i}"></div></td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>`;
  }
}

async function loadEmailBody(emailId, containerEl) {
  containerEl.innerHTML = '<div class="db-emails-loading">Loading...</div>';
  try {
    const r = await fetch(`/api/outlook/read/${encodeURIComponent(emailId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    const from = m.from ? `<b>${escapeHtml(m.from.name || m.from.address)}</b>` : "Unknown";
    const to = (m.to || []).map(r => escapeHtml(r.name || r.address)).join(", ");
    const date = m.date ? new Date(m.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const hasHtml = !!m.bodyHtml;
    const bodyContent = hasHtml ? m.bodyHtml : escapeHtml(m.body || "");
    const bodyClass = hasHtml ? "db-email-msg-body db-email-html" : "db-email-msg-body";
    containerEl.innerHTML = `<div class="db-email-msg">
      <div class="db-email-msg-header">${from} &rarr; ${to} <span class="db-email-msg-date">${date}</span></div>
      <div class="${bodyClass}">${bodyContent}</div>
    </div>`;
  } catch (err) {
    containerEl.innerHTML = `<div class="db-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── DB click delegation: inline edit, delete, add, detail nav ──
document.addEventListener("click", (e) => {
  // Detail link
  const detLink = e.target.closest(".db-detail-link");
  if (detLink) { e.preventDefault(); location.hash = detLink.getAttribute("href"); return; }

  // Email view toggle (cards vs table)
  const viewBtn = e.target.closest(".db-email-view-btn");
  if (viewBtn) {
    const mode = viewBtn.dataset.emailView;
    const bodyEl = document.getElementById("db-emails-body");
    if (bodyEl && _emailThreadCache) {
      document.querySelectorAll(".db-email-view-btn").forEach(b => b.classList.remove("active"));
      viewBtn.classList.add("active");
      renderEmailView(mode, bodyEl, _emailThreadCache);
    }
    return;
  }

  // Email card click - expand/collapse
  const emailCard = e.target.closest(".db-email-card.db-row-clickable");
  if (emailCard && !e.target.closest("a")) {
    e.stopPropagation();
    const idx = emailCard.dataset.emailIdx;
    const detail = document.getElementById(`db-email-${idx}`);
    if (detail) {
      const showing = detail.style.display !== "none";
      detail.style.display = showing ? "none" : "";
      emailCard.classList.toggle("db-email-card-expanded", !showing);
      if (!showing) {
        const threadBody = document.getElementById(`db-email-thread-${idx}`);
        if (threadBody && !threadBody.dataset.loaded) {
          threadBody.dataset.loaded = "1";
          loadEmailBody(emailCard.dataset.emailId, threadBody);
        }
      }
    }
    return;
  }

  // Email row click (table view) - expand/collapse preview + load thread
  const emailRow = e.target.closest(".db-email-row.db-row-clickable");
  if (emailRow && !e.target.closest("a")) {
    e.stopPropagation();
    const idx = emailRow.dataset.emailIdx;
    const detail = document.getElementById(`db-email-${idx}`);
    if (detail) {
      const showing = detail.style.display !== "none";
      detail.style.display = showing ? "none" : "";
      emailRow.classList.toggle("db-row-expanded", !showing);
      if (!showing) {
        const threadBody = document.getElementById(`db-email-thread-${idx}`);
        if (threadBody && !threadBody.dataset.loaded) {
          threadBody.dataset.loaded = "1";
          loadEmailBody(emailRow.dataset.emailId, threadBody);
        }
      }
    }
    return;
  }

  // Task card click - expand/collapse notes
  const taskCard = e.target.closest(".db-task-expandable");
  if (taskCard) {
    e.stopPropagation();
    const idx = taskCard.dataset.taskIdx;
    const notes = document.getElementById(`db-task-notes-${idx}`);
    if (notes) {
      const showing = notes.style.display !== "none";
      notes.style.display = showing ? "none" : "";
      taskCard.classList.toggle("db-task-expanded", !showing);
    }
    return;
  }

  // Meeting row click - expand/collapse content (lazy-fetch)
  const meetingRow = e.target.closest(".db-meeting-row.db-row-clickable");
  if (meetingRow && !e.target.closest("a") && !e.target.closest(".db-del-btn")
      && !e.target.closest(".db-cell-edit-company") && !e.target.closest(".db-match-btn")
      && !e.target.closest(".db-cell-edit")) {
    e.stopPropagation();
    const idx = meetingRow.dataset.meetingIdx;
    const detail = document.getElementById(`db-meeting-${idx}`);
    if (detail) {
      const showing = detail.style.display !== "none";
      if (showing) {
        detail.style.display = "none";
        meetingRow.classList.remove("db-row-expanded");
      } else {
        detail.style.display = "";
        meetingRow.classList.add("db-row-expanded");
        const bodyEl = detail.querySelector(".db-meeting-body");
        if (bodyEl && bodyEl.classList.contains("db-meeting-loading")) {
          const contentId = meetingRow.dataset.contentId;
          if (contentId) {
            fetch(`/api/db/meetings/${contentId}/content`)
              .then(r => r.json())
              .then(j => {
                const raw = j.body || "";
                const formatted = formatTranscript(raw);
                if (formatted) {
                  bodyEl.classList.add("transcript-body");
                  bodyEl.innerHTML = formatted;
                } else {
                  bodyEl.textContent = raw || "No content available.";
                }
                bodyEl.classList.remove("db-meeting-loading");
              })
              .catch(() => {
                bodyEl.textContent = "Failed to load content.";
                bodyEl.classList.remove("db-meeting-loading");
              });
          }
        }
      }
    }
    return;
  }

  // Delete button
  const delBtn = e.target.closest(".db-del-btn");
  if (delBtn) {
    e.stopPropagation();
    const { table, pk } = delBtn.dataset;
    if (!confirm("Delete this row?")) return;
    dbDelete(table, pk)
      .then(() => { toast("Deleted"); dbStats = null; route(); })
      .catch((err) => toast("Error: " + err.message));
    return;
  }

  // Add row button
  const addBtn = e.target.closest(".db-add-btn");
  if (addBtn) {
    e.stopPropagation();
    const tableId = addBtn.dataset.table;
    showDbAddModal(tableId);
    return;
  }

  // AI re-match button on a meeting row
  const matchBtnEl = e.target.closest(".db-match-btn");
  if (matchBtnEl) {
    e.stopPropagation();
    e.preventDefault();
    const meetingId = matchBtnEl.dataset.meetingId;
    matchBtnEl.disabled = true;
    matchBtnEl.textContent = "…";
    fetch(`/api/db/meetings/${meetingId}/match`, { method: "POST" })
      .then(r => r.json())
      .then(j => {
        if (j.matched) {
          toast(`Matched → ${j.company.name}`);
          dbStats = null; route();
        } else {
          toast(`No match (${j.method})`);
          matchBtnEl.disabled = false;
          matchBtnEl.textContent = "✨";
        }
      })
      .catch(err => {
        toast("Error: " + err.message);
        matchBtnEl.disabled = false;
        matchBtnEl.textContent = "✨";
      });
    return;
  }

  // Inline company picker for meeting rows. We let the link inside still navigate
  // (data-stop on the <a>) — clicking elsewhere in the cell opens the picker.
  const companyCell = e.target.closest("td.db-cell-edit-company");
  if (companyCell && !e.target.closest("[data-stop]") && !companyCell.querySelector("input, select")) {
    e.stopPropagation();
    const { pk, val } = companyCell.dataset;
    // Lazy-load and cache the company list.
    const openPicker = (companies) => {
      const sel = document.createElement("select");
      sel.className = "db-inline-select";
      sel.innerHTML = `<option value="">— none —</option>` +
        companies.map(c => `<option value="${escapeHtml(c.slug)}" ${c.slug === val ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
      companyCell.textContent = "";
      companyCell.appendChild(sel);
      sel.focus();
      const save = () => {
        const newSlug = sel.value;
        if (newSlug === val) { route(); return; }
        // Convert slug to company_id, then PATCH.
        const company = companies.find(c => c.slug === newSlug);
        const newCompanyId = company ? company.company_id : null;
        dbPatch("meetings", pk, "company_id", newCompanyId)
          .then(() => { toast("Saved"); dbStats = null; route(); })
          .catch(err => { toast("Error: " + err.message); route(); });
      };
      sel.addEventListener("change", save);
      sel.addEventListener("blur", save);
    };
    if (window.__companyCache) {
      openPicker(window.__companyCache);
    } else {
      fetch("/api/db/companies?limit=500")
        .then(r => r.json())
        .then(j => {
          window.__companyCache = (j.rows || [])
            .filter(r => r.slug !== "skysuite")
            .map(r => ({
              slug: r.slug, name: r.name, company_id: r.company_id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          openPicker(window.__companyCache);
        });
    }
    return;
  }

  // Inline edit cell
  const cell = e.target.closest("td.db-cell-edit");
  if (cell && !cell.querySelector("input, select")) {
    const { table, pk, col, val } = cell.dataset;
    const enumKey = cell.dataset.enum;
    const isDate = cell.dataset.date === "1";

    if (enumKey && DB_ENUMS[enumKey]) {
      // Dropdown
      const sel = document.createElement("select");
      sel.className = "db-inline-select";
      sel.innerHTML = `<option value="">—</option>` +
        DB_ENUMS[enumKey].map((o) => `<option value="${escapeHtml(o)}" ${o === val ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
      cell.textContent = "";
      cell.appendChild(sel);
      sel.focus();
      const save = () => {
        const newVal = sel.value;
        if (newVal !== val) {
          dbPatch(table, pk, col, newVal || null)
            .then(() => { toast("Saved"); dbStats = null; route(); })
            .catch((err) => { toast("Error: " + err.message); route(); });
        } else {
          route();
        }
      };
      sel.addEventListener("change", save);
      sel.addEventListener("blur", save);
    } else if (isDate) {
      // Date picker
      const inp = document.createElement("input");
      inp.type = "date";
      inp.className = "db-inline-input";
      inp.value = val || "";
      cell.textContent = "";
      cell.appendChild(inp);
      inp.focus();
      const save = () => {
        const newVal = inp.value;
        if (newVal !== (val || "")) {
          dbPatch(table, pk, col, newVal || null)
            .then(() => { toast("Saved"); dbStats = null; route(); })
            .catch((err) => { toast("Error: " + err.message); route(); });
        } else {
          route();
        }
      };
      inp.addEventListener("change", save);
      inp.addEventListener("blur", save);
    } else {
      // Text input
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "db-inline-input";
      inp.value = val || "";
      cell.textContent = "";
      cell.appendChild(inp);
      inp.focus();
      inp.select();
      const save = () => {
        const newVal = inp.value;
        if (newVal !== (val || "")) {
          dbPatch(table, pk, col, newVal || null)
            .then(() => { toast("Saved"); dbStats = null; route(); })
            .catch((err) => { toast("Error: " + err.message); route(); });
        } else {
          route();
        }
      };
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } if (ev.key === "Escape") route(); });
    }
    return;
  }
});

// ─── DB companies mode toggle (table vs kanban) ────────────────
// Supports both the old button toggle and the new sidebar select
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-db-companies-mode]");
  if (!btn) return;
  const mode = btn.dataset.dbCompaniesMode;
  if (mode === state.dbCompaniesMode) return;
  state.dbCompaniesMode = mode;
  localStorage.setItem("mc_db_companies_mode", mode);
  route();
});
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-meeting-filter]");
  if (!btn) return;
  const filter = btn.dataset.meetingFilter;
  if (filter === state.meetingTypeFilter) return;
  state.meetingTypeFilter = filter;
  localStorage.setItem("mc_meeting_type_filter", filter);
  route();
});
document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-db-companies-mode-select]");
  if (sel) {
    const mode = sel.value;
    if (mode === state.dbCompaniesMode) return;
    state.dbCompaniesMode = mode;
    localStorage.setItem("mc_db_companies_mode", mode);
    route();
    return;
  }
  const showClosed = e.target.closest("[data-kanban-show-closed]");
  if (showClosed) {
    localStorage.setItem("mc_kanban_show_closed", showClosed.checked ? "1" : "0");
    renderCompanyCoverage();
  }
});

// ─── DB contacts: grouped/table toggle, search, role filter, collapse ───
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-db-contacts-mode]");
  if (btn) {
    const mode = btn.dataset.dbContactsMode;
    if (mode !== state.dbContactsMode) {
      state.dbContactsMode = mode;
      localStorage.setItem("mc_db_contacts_mode", mode);
      route();
    }
    return;
  }
  const head = e.target.closest("[data-toggle-company]");
  if (head) {
    const id = head.dataset.toggleCompany;
    if (state.dbContactsCollapsed.has(id)) state.dbContactsCollapsed.delete(id);
    else state.dbContactsCollapsed.add(id);
    localStorage.setItem("mc_db_contacts_collapsed", JSON.stringify([...state.dbContactsCollapsed]));
    // Cheaper than a full re-route: rebuild just the contacts main area.
    const main = document.getElementById("db-main");
    if (main && state.dbContactsMode === "grouped") renderDbContactsGrouped(main);
  }
});

// Debounced live search — re-render the grouped view without re-routing.
(function () {
  let t = null;
  document.addEventListener("input", (e) => {
    const inp = e.target.closest(".db-contacts-search");
    if (!inp) return;
    clearTimeout(t);
    const val = inp.value;
    t = setTimeout(() => {
      state.dbContactsSearch = val;
      const main = document.getElementById("db-main");
      if (main) renderDbContactsGrouped(main).then(() => {
        // Restore focus + cursor after re-render
        const next = main.querySelector(".db-contacts-search");
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      });
    }, 200);
  });
})();

document.addEventListener("change", (e) => {
  const sel = e.target.closest(".db-contacts-role-filter");
  if (!sel) return;
  state.dbContactsRole = sel.value || "";
  const main = document.getElementById("db-main");
  if (main) renderDbContactsGrouped(main);
});

// ─── DB kanban scrollbar proxy + header sync ───────────────────
(function () {
  let syncing = false;
  function setupProxy() {
    const wrap = document.querySelector(".db-kanban-wrap");
    const proxy = document.querySelector(".db-kanban-scrollbar-proxy");
    const hdr = document.querySelector(".db-kanban-header-row");
    if (!wrap || !proxy) return;
    proxy.style.display = "";
    // Size the proxy's inner div to match the wrapper's scroll width
    const inner = proxy.querySelector("div");
    if (inner) inner.style.width = wrap.scrollWidth + "px";
    // Sync: proxy → wrapper + header
    proxy.onscroll = () => {
      if (syncing) return;
      syncing = true;
      wrap.scrollLeft = proxy.scrollLeft;
      if (hdr) hdr.scrollLeft = proxy.scrollLeft;
      syncing = false;
    };
    // Sync: wrapper → proxy + header (e.g. trackpad horizontal scroll)
    wrap.onscroll = () => {
      if (syncing) return;
      syncing = true;
      proxy.scrollLeft = wrap.scrollLeft;
      if (hdr) hdr.scrollLeft = wrap.scrollLeft;
      syncing = false;
    };
  }
  // Re-run setup after each render
  if (!window._kanbanProxyObserver) {
    const obs = new MutationObserver(() => {
      if (document.querySelector(".db-kanban-wrap")) setupProxy();
      else {
        const p = document.querySelector(".db-kanban-scrollbar-proxy");
        if (p) p.style.display = "none";
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window._kanbanProxyObserver = obs;
  }
  window.addEventListener("resize", setupProxy);
})();

// ─── Inbox kanban scrollbar proxy ──────────────────────────────
// Mirror of the db-kanban proxy, scoped to the inbox/tasks kanban.
// Fixed scrollbar at the bottom of the viewport that scrolls the
// kanban board horizontally. Hidden when the inbox isn't in kanban mode.
(function () {
  let syncing = false;
  function setupProxy() {
    const wrap = document.querySelector(".inbox-kanban-wrap");
    const proxy = document.querySelector(".inbox-kanban-scrollbar-proxy");
    if (!wrap || !proxy) return;
    proxy.style.display = "";
    const inner = proxy.querySelector("div");
    if (inner) inner.style.width = wrap.scrollWidth + "px";
    proxy.onscroll = () => {
      if (syncing) return;
      syncing = true;
      wrap.scrollLeft = proxy.scrollLeft;
      syncing = false;
    };
    wrap.onscroll = () => {
      if (syncing) return;
      syncing = true;
      proxy.scrollLeft = wrap.scrollLeft;
      syncing = false;
    };
  }
  if (!window._inboxKanbanProxyObserver) {
    const obs = new MutationObserver(() => {
      if (document.querySelector(".inbox-kanban-wrap")) setupProxy();
      else {
        const p = document.querySelector(".inbox-kanban-scrollbar-proxy");
        if (p) p.style.display = "none";
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window._inboxKanbanProxyObserver = obs;
  }
  window.addEventListener("resize", setupProxy);
})();

// ─── DB kanban pointer-based drag (Notion-style) ───────────────
(function () {
  let dragState = null; // { card, clone, companyId, offsetX, offsetY, startCol }

  function clearIndicators() {
    document.querySelectorAll(".db-kanban-board .kanban-col.drop-hover").forEach((c) => c.classList.remove("drop-hover"));
    document.querySelectorAll(".db-kanban-card.drop-above, .db-kanban-card.drop-below").forEach((c) => {
      c.classList.remove("drop-above", "drop-below");
    });
  }

  function colUnder(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const col = el.closest(".db-kanban-board .kanban-col");
      if (col) return col;
    }
    return null;
  }

  function cardUnder(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const c = el.closest(".db-kanban-card");
      if (c && dragState && c !== dragState.card) return c;
    }
    return null;
  }

  // --- mousedown: start drag after a small move threshold ---
  document.addEventListener("mousedown", (e) => {
    // Only left-click
    if (e.button !== 0) return;
    // Skip inner anchors (e.g. detail-link arrow) but allow the card-link itself
    const innerAnchor = e.target.closest("a");
    if (innerAnchor && !innerAnchor.classList.contains("db-kanban-card--link")) return;
    const card = e.target.closest(".db-kanban-card");
    if (!card) return;

    const rect = card.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const companyId = card.dataset.companyId;
    const startCol = card.closest(".kanban-col");
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Wait for 5px move before starting drag (prevents click interference)
      if (!started && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

      if (!started) {
        started = true;
        // Suppress the click that would otherwise navigate when the card itself
        // is an anchor. One-shot capture-phase listener.
        const swallowClick = (cev) => { cev.preventDefault(); cev.stopPropagation(); };
        document.addEventListener("click", swallowClick, { capture: true, once: true });
        // Create floating clone
        const clone = card.cloneNode(true);
        clone.classList.add("db-kanban-drag-clone");
        clone.style.width = rect.width + "px";
        clone.style.position = "fixed";
        clone.style.zIndex = "9999";
        clone.style.pointerEvents = "none";
        clone.style.left = (ev.clientX - offsetX) + "px";
        clone.style.top = (ev.clientY - offsetY) + "px";
        document.body.appendChild(clone);

        card.classList.add("dragging");
        dragState = { card, clone, companyId, offsetX, offsetY, startCol };
      }

      if (!dragState) return;
      // Move clone with cursor
      dragState.clone.style.left = (ev.clientX - offsetX) + "px";
      dragState.clone.style.top = (ev.clientY - offsetY) + "px";

      // Highlight target column
      clearIndicators();
      const col = colUnder(ev.clientX, ev.clientY);
      if (col) {
        col.classList.add("drop-hover");
        // Insertion indicator
        const target = cardUnder(ev.clientX, ev.clientY);
        if (target) {
          const tRect = target.getBoundingClientRect();
          target.classList.add(ev.clientY < tRect.top + tRect.height / 2 ? "drop-above" : "drop-below");
        }
      }

      // Auto-scroll the board horizontally when near edges
      const board = document.querySelector(".db-kanban-board");
      if (board) {
        const bRect = board.getBoundingClientRect();
        const edge = 60;
        if (ev.clientX < bRect.left + edge) board.scrollLeft -= 8;
        else if (ev.clientX > bRect.right - edge) board.scrollLeft += 8;
      }
    }

    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (!dragState) return;
      const { card: srcCard, clone, companyId: cid, startCol: srcCol } = dragState;
      clone.remove();
      srcCard.classList.remove("dragging");
      clearIndicators();

      const col = colUnder(ev.clientX, ev.clientY);
      dragState = null;

      if (!col) return;
      const newStage = col.dataset.stage;
      const oldStage = srcCol?.dataset.stage;
      if (!newStage || newStage === oldStage) return;

      // Optimistic DOM move — no full re-render, no flicker
      const targetBody = col.querySelector(".kanban-col-body");
      const sourceBody = srcCol?.querySelector(".kanban-col-body");
      if (targetBody) {
        // Remove "None" placeholder if present
        const emptyEl = targetBody.querySelector(".kanban-empty");
        if (emptyEl) emptyEl.remove();
        targetBody.appendChild(srcCard);
        // Update column counts in the sticky header row + empty class
        const hdrRow = document.querySelector(".db-kanban-header-row");
        const hdrCols = hdrRow ? hdrRow.querySelectorAll(".kanban-col-head") : [];
        const stageKeys = document.querySelectorAll(".db-kanban-board .kanban-col");
        // Build stage→header index
        const hdrByStage = {};
        stageKeys.forEach((c, i) => { if (hdrCols[i]) hdrByStage[c.dataset.stage] = hdrCols[i]; });
        const tHdr = hdrByStage[newStage];
        if (tHdr) tHdr.querySelector(".kanban-col-count").textContent = targetBody.querySelectorAll(".db-kanban-card").length;
        col.classList.remove("kanban-col--empty");
        const sHdr = hdrByStage[oldStage];
        if (sHdr && sourceBody) {
          const remaining = sourceBody.querySelectorAll(".db-kanban-card").length;
          sHdr.querySelector(".kanban-col-count").textContent = remaining;
          if (remaining === 0) {
            sourceBody.innerHTML = '<div class="kanban-empty">None</div>';
            srcCol.classList.add("kanban-col--empty");
          }
        }
      }

      dbPatch("companies", cid, "stage", newStage)
        .then(() => { toast(`Moved to ${newStage}`); dbStats = null; })
        .catch((err) => { toast("Error: " + err.message); route(); }); // full re-render only on failure
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();

// ─── Add-row modal ──────────────────────────────────────────────
function showDbAddModal(tableId) {
  const ADD_FIELDS = {
    companies: ['name','stage','field','next_action','last_contact','action_status'],
    contacts: ['name','email','phone','phone_office','title','role','source','notes'],
    tasks: ['name','status','action_type','due_date','agent','notes'],
    meetings: ['title','meeting_date','duration_minutes','status','summary'],
    linkedin: ['title','lane','status','post_type','thesis'],
    newsletters: ['title','series','status','target_date'],
    intel: ['influencer','source_type','relevance','lane','key_insight','source_url'],
    reports: ['agent','report_date','report_type','title','body'],
    timeline: ['entry_date','entry_type','title','details','source'],
  };
  const fields = ADD_FIELDS[tableId] || ['name'];

  const overlay = document.createElement("div");
  overlay.className = "db-modal-overlay";
  overlay.innerHTML = `
    <div class="db-modal">
      <h3>Add ${tableId.replace(/_/g, " ")} row</h3>
      <form class="db-add-form">
        ${fields.map((f) => {
          const enumKey = COL_ENUM_MAP[`${tableId}:${f}`];
          const isDate = DATE_COLS.has(f);
          const label = f.replace(/_/g, " ");
          if (enumKey && DB_ENUMS[enumKey]) {
            return `<label>${label}<select name="${f}" class="db-inline-select">
              <option value="">—</option>
              ${DB_ENUMS[enumKey].map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
            </select></label>`;
          }
          if (isDate) return `<label>${label}<input type="date" name="${f}" class="db-inline-input"></label>`;
          return `<label>${label}<input type="text" name="${f}" class="db-inline-input"></label>`;
        }).join("")}
        <div class="db-modal-actions">
          <button type="button" class="btn-ghost db-modal-cancel">Cancel</button>
          <button type="submit" class="btn-primary">Create</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector(".db-modal-cancel").onclick = () => overlay.remove();
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });

  overlay.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const data = {};
    for (const [k, v] of fd.entries()) { if (v) data[k] = v; }
    if (!Object.keys(data).length) { toast("Fill in at least one field"); return; }
    // If adding a contact/task and we're inside a company detail view, attach company_id
    const companyMatch = location.hash.match(/^#\/db\/companies\/([\w-]+)$/);
    if (companyMatch && (tableId === "contacts" || tableId === "tasks")) {
      try {
        const cr = await fetch(`/api/db/companies/${companyMatch[1]}`);
        const cj = await cr.json();
        if (cj.company) data.company_id = cj.company.company_id;
      } catch {}
    }
    try {
      await dbCreate(tableId, data);
      toast("Created");
      overlay.remove();
      dbStats = null;
      route();
    } catch (err) {
      toast("Error: " + err.message);
    }
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function initials(name) {
  return (name || "?").split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}
function roleClass(role) {
  return "role-" + (role || "user").toLowerCase().replace(/\s+/g, "-");
}

// ─── GitHub dashboard ───────────────────────────────────────────
function ghTimeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso);
  const diffS = Math.floor((Date.now() - then.getTime()) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function ghBranchPill(devVsProd) {
  if (!devVsProd) return `<span class="gh-pill gh-pill--muted">no dev branch</span>`;
  const { devBranch, defaultBranch, ahead, behind } = devVsProd;
  if (ahead === 0 && behind === 0) {
    return `<span class="gh-pill gh-pill--ok">${escapeHtml(devBranch)} ≡ ${escapeHtml(defaultBranch)}</span>`;
  }
  const parts = [];
  if (ahead > 0) parts.push(`<span class="gh-ahead">↑${ahead}</span>`);
  if (behind > 0) parts.push(`<span class="gh-behind">↓${behind}</span>`);
  return `<span class="gh-pill">${escapeHtml(devBranch)} → ${escapeHtml(defaultBranch)} · ${parts.join(" ")}</span>`;
}

const GH_ENABLED_KEY = "gh.enabledRepos";
const GH_DEFAULT_ENABLED = ["SkySuite-Web-App", "SkySuite-API", "SkySuite", "skysuite-marketing"];

function ghGetEnabled() {
  try {
    const raw = localStorage.getItem(GH_ENABLED_KEY);
    if (!raw) return null; // null = not yet configured, use defaults
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function ghSetEnabled(list) {
  localStorage.setItem(GH_ENABLED_KEY, JSON.stringify(list));
}

async function renderGithubRepos() {
  const view = $("#github-view");
  view.innerHTML = `
    <div class="gh-shell">
      <div class="gh-header">
        <div>
          <div class="inbox-eyebrow">Source control</div>
          <h1 class="inbox-title">GitHub</h1>
          <div class="inbox-summary" id="gh-summary">Loading…</div>
        </div>
        <div class="gh-header-actions">
          <button class="btn-ghost" id="gh-settings">⚙ Repos</button>
          <button class="btn-ghost" id="gh-refresh">↻ Refresh</button>
        </div>
      </div>
      <div class="gh-grid" id="gh-grid"><div class="gh-empty">Fetching repos…</div></div>
    </div>
  `;

  $("#gh-refresh").addEventListener("click", async () => {
    try { await fetch("/api/github/refresh", { method: "POST" }); } catch {}
    renderGithubRepos();
  });
  $("#gh-settings").addEventListener("click", () => ghOpenSettings());

  const enabled = ghGetEnabled() || GH_DEFAULT_ENABLED;
  const qs = enabled.length ? `?enabled=${encodeURIComponent(enabled.join(","))}` : "";

  let data;
  try {
    const r = await fetch(`/api/github/repos${qs}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (err) {
    $("#gh-grid").innerHTML = `<div class="gh-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Only show enabled repos in the grid. Filter client-side against the enabled
  // set as well (belt-and-suspenders — server also filters when it's been
  // restarted with the enabled-param code, but if it hasn't, this still works).
  const allRepos = data.repos || [];
  const enabledSet = new Set(enabled);
  const repos = allRepos.filter((r) => !r.disabled && enabledSet.has(r.name));
  const hiddenCount = allRepos.length - repos.length;
  const hiddenNote = hiddenCount > 0 ? ` · ${hiddenCount} hidden` : "";
  $("#gh-summary").textContent = `${repos.length} repos${hiddenNote} · ${data.owner} · fetched ${ghTimeAgo(data.fetched_at)}`;

  if (!repos.length) {
    $("#gh-grid").innerHTML = `<div class="gh-empty">No repos enabled. Click ⚙ Repos to pick some.</div>`;
    return;
  }

  $("#gh-grid").innerHTML = repos.map((r) => {
    const prBadge = r.openPRs > 0
      ? `<span class="gh-pr-badge">${r.openPRs} PR${r.openPRs === 1 ? "" : "s"}</span>`
      : "";

    // Hero sync status — the big visual answer to "are dev and prod synced?"
    let syncHero;
    if (!r.devVsProd) {
      syncHero = `
        <div class="gh-sync gh-sync--none">
          <div class="gh-sync-label">No dev branch</div>
          <div class="gh-sync-sub">Only <code>${escapeHtml(r.defaultBranch)}</code></div>
        </div>`;
    } else {
      const { devBranch, defaultBranch, ahead, behind } = r.devVsProd;
      let tone, headline, sub;
      if (ahead === 0 && behind === 0) {
        tone = "ok";
        headline = "In sync";
        sub = `<code>${escapeHtml(devBranch)}</code> ≡ <code>${escapeHtml(defaultBranch)}</code>`;
      } else if (ahead > 0 && behind === 0) {
        tone = "ready";
        headline = `${ahead} ahead · ready to merge`;
        sub = `<code>${escapeHtml(devBranch)}</code> has ${ahead} unmerged commit${ahead === 1 ? "" : "s"} → <code>${escapeHtml(defaultBranch)}</code>`;
      } else if (behind > 0 && ahead === 0) {
        tone = "stale";
        headline = `${behind} behind`;
        sub = `<code>${escapeHtml(defaultBranch)}</code> is ${behind} commit${behind === 1 ? "" : "s"} ahead of <code>${escapeHtml(devBranch)}</code>`;
      } else {
        tone = "diverged";
        headline = `Diverged · ↑${ahead} ↓${behind}`;
        sub = `<code>${escapeHtml(devBranch)}</code> and <code>${escapeHtml(defaultBranch)}</code> have forked`;
      }
      syncHero = `
        <div class="gh-sync gh-sync--${tone}">
          <div class="gh-sync-label">${escapeHtml(headline)}</div>
          <div class="gh-sync-sub">${sub}</div>
        </div>`;
    }

    const commitLine = (branch, commit) => {
      if (!branch || !commit) return "";
      return `
        <div class="gh-commit-row">
          <span class="gh-branch-chip">${escapeHtml(branch)}</span>
          <code class="gh-sha">${escapeHtml((commit.sha || "").slice(0, 7))}</code>
          <span class="gh-commit-msg" title="${escapeHtml(commit.msg || "")}">${escapeHtml((commit.msg || "").slice(0, 60))}</span>
          <span class="gh-commit-meta">${ghTimeAgo(commit.date)}</span>
        </div>`;
    };

    return `
      <a class="gh-card" href="#/github/${encodeURIComponent(r.name)}">
        <div class="gh-card-head">
          <div class="gh-card-title">
            <span class="gh-repo-name">${escapeHtml(r.name)}</span>
            ${r.isPrivate ? `<span class="gh-pill gh-pill--muted">private</span>` : ""}
            ${prBadge}
          </div>
          <div class="gh-card-meta">pushed ${ghTimeAgo(r.pushedAt)}</div>
        </div>
        ${syncHero}
        <div class="gh-commits-block">
          ${commitLine(r.defaultBranch, r.latest) || `<div class="gh-commit gh-commit--empty">No commits</div>`}
          ${commitLine(r.devBranch, r.latestDev)}
        </div>
      </a>
    `;
  }).join("");
}

async function ghOpenSettings() {
  // Fetch ALL repos (no enabled filter) to show the full picker list
  let allRepos = [];
  try {
    const r = await fetch("/api/github/repos?enabled=__none__");
    if (r.ok) {
      const d = await r.json();
      allRepos = (d.repos || []).slice().sort((a, b) =>
        new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0)
      );
    }
  } catch {}

  const enabled = new Set(ghGetEnabled() || GH_DEFAULT_ENABLED);

  const overlay = document.createElement("div");
  overlay.className = "db-modal-overlay";
  overlay.innerHTML = `
    <div class="db-modal gh-settings-modal">
      <h3>Enabled repositories</h3>
      <p class="gh-settings-hint">Only checked repos appear on the GitHub tab. Disabling repos also skips their GitHub API calls.</p>
      <div class="gh-settings-list">
        ${allRepos.map((r) => `
          <label class="gh-settings-row">
            <input type="checkbox" value="${escapeHtml(r.name)}" ${enabled.has(r.name) ? "checked" : ""}>
            <div class="gh-settings-info">
              <div class="gh-settings-name">${escapeHtml(r.name)}${r.isPrivate ? ` <span class="gh-pill gh-pill--muted">private</span>` : ""}</div>
              <div class="gh-settings-meta">pushed ${ghTimeAgo(r.pushedAt)}${r.description ? ` · ${escapeHtml(r.description.slice(0, 70))}` : ""}</div>
            </div>
          </label>
        `).join("") || '<div class="gh-empty">No repos found</div>'}
      </div>
      <div class="db-modal-actions">
        <button type="button" class="btn-ghost" data-gh-settings-action="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-gh-settings-action="save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
    const action = e.target.closest("[data-gh-settings-action]")?.dataset.ghSettingsAction;
    if (action === "cancel") overlay.remove();
    if (action === "save") {
      const checked = [...overlay.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
      ghSetEnabled(checked);
      overlay.remove();
      renderGithubRepos();
    }
  });
}

async function renderGithubRepo(repo) {
  const view = $("#github-view");
  view.innerHTML = `
    <div class="gh-shell">
      <a class="db-back-link" href="#/github">← All repos</a>
      <div class="gh-header">
        <div>
          <div class="inbox-eyebrow">Repository</div>
          <h1 class="inbox-title">${escapeHtml(repo)}</h1>
          <div class="inbox-summary" id="gh-detail-summary">Loading…</div>
        </div>
        <div class="gh-header-actions">
          <a class="btn-ghost" id="gh-open-link" target="_blank" rel="noopener">Open on GitHub ↗</a>
          <button class="btn-ghost" id="gh-refresh">↻ Refresh</button>
        </div>
      </div>
      <div id="gh-detail-body"><div class="gh-empty">Loading…</div></div>
    </div>
  `;

  $("#gh-refresh").addEventListener("click", async () => {
    try { await fetch("/api/github/refresh", { method: "POST" }); } catch {}
    renderGithubRepo(repo);
  });

  let data;
  try {
    const r = await fetch(`/api/github/repos/${encodeURIComponent(repo)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (err) {
    $("#gh-detail-body").innerHTML = `<div class="gh-empty">Failed: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const info = data.info || {};
  const branches = data.branches || [];
  const prs = data.prs || [];
  const timeline = data.timeline || [];
  const defaultBranch = info.default_branch;

  $("#gh-detail-summary").textContent =
    `${branches.length} branches · ${prs.length} open PRs · pushed ${ghTimeAgo(info.pushed_at)}`;
  const link = $("#gh-open-link");
  if (info.html_url) link.href = info.html_url;
  else link.style.display = "none";

  branches.sort((a, b) => {
    if (a.name === defaultBranch) return -1;
    if (b.name === defaultBranch) return 1;
    const da = a.commit?.date ? new Date(a.commit.date).getTime() : 0;
    const db = b.commit?.date ? new Date(b.commit.date).getTime() : 0;
    return db - da;
  });

  const branchRows = branches.map((b) => {
    const isDefault = b.name === defaultBranch;
    const cmp = b.compare || {};
    const ahead = cmp.ahead ?? 0;
    const behind = cmp.behind ?? 0;
    const statusPill = isDefault
      ? `<span class="gh-pill gh-pill--default">default</span>`
      : (ahead === 0 && behind === 0)
        ? `<span class="gh-pill gh-pill--ok">in sync</span>`
        : `<span class="gh-pill">${ahead > 0 ? `<span class="gh-ahead">↑${ahead}</span>` : ""}${behind > 0 ? ` <span class="gh-behind">↓${behind}</span>` : ""}</span>`;
    const msg = b.commit?.msg || "";
    return `
      <tr>
        <td class="gh-branch-name">${escapeHtml(b.name)}${b.protected ? ` <span class="gh-pill gh-pill--muted">protected</span>` : ""}</td>
        <td>${statusPill}</td>
        <td><code class="gh-sha">${escapeHtml((b.sha || "").slice(0, 7))}</code></td>
        <td class="gh-commit-msg" title="${escapeHtml(msg)}">${escapeHtml(msg.slice(0, 80))}</td>
        <td class="gh-commit-meta">${escapeHtml(b.commit?.author || "")}</td>
        <td class="gh-commit-meta">${ghTimeAgo(b.commit?.date)}</td>
      </tr>
    `;
  }).join("");

  const prRows = prs.length
    ? prs.map((p) => `
        <tr>
          <td><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">#${p.number}</a></td>
          <td class="gh-commit-msg">${p.draft ? `<span class="gh-pill gh-pill--muted">draft</span> ` : ""}${escapeHtml(p.title)}</td>
          <td>${escapeHtml(p.head)} → ${escapeHtml(p.base)}</td>
          <td class="gh-commit-meta">${escapeHtml(p.author)}</td>
          <td class="gh-commit-meta">${ghTimeAgo(p.updated_at)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="5" class="gh-empty">No open PRs</td></tr>`;

  const timelineRows = timeline.map((c) => `
    <tr>
      <td><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><code class="gh-sha">${escapeHtml(c.sha.slice(0, 7))}</code></a></td>
      <td class="gh-commit-msg" title="${escapeHtml(c.msg)}">${escapeHtml(c.msg.slice(0, 100))}</td>
      <td class="gh-commit-meta">${escapeHtml(c.author)}</td>
      <td class="gh-commit-meta">${ghTimeAgo(c.date)}</td>
    </tr>
  `).join("");

  $("#gh-detail-body").innerHTML = `
    <section class="gh-section">
      <h2 class="gh-section-title">Open Pull Requests <span class="gh-section-count">${prs.length}</span></h2>
      <div class="gh-table-wrap">
        <table class="gh-table">
          <thead><tr><th>#</th><th>Title</th><th>Branch</th><th>Author</th><th>Updated</th></tr></thead>
          <tbody>${prRows}</tbody>
        </table>
      </div>
    </section>

    <section class="gh-section">
      <h2 class="gh-section-title">Branches <span class="gh-section-count">${branches.length}</span></h2>
      <div class="gh-table-wrap">
        <table class="gh-table">
          <thead><tr><th>Branch</th><th>vs ${escapeHtml(defaultBranch || "default")}</th><th>SHA</th><th>Latest commit</th><th>Author</th><th>When</th></tr></thead>
          <tbody>${branchRows}</tbody>
        </table>
      </div>
    </section>

    <section class="gh-section">
      <h2 class="gh-section-title">Recent commits on ${escapeHtml(defaultBranch || "default")} <span class="gh-section-count">${timeline.length}</span></h2>
      <div class="gh-table-wrap">
        <table class="gh-table">
          <thead><tr><th>SHA</th><th>Message</th><th>Author</th><th>When</th></tr></thead>
          <tbody>${timelineRows || `<tr><td colspan="4" class="gh-empty">No commits</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;
}

// ─── Company Coverage view ─────────────────────────────────────
// One row per active CRO deal or CS client. Red rows are uncovered
// (no active proposal AND no open task) — those are the gaps that
// silently dropped off Matt's radar. Sorted: uncovered first, then
// by risk, then by days since contact.
// Top-level dispatcher for the unified Companies tab. Three modes:
//   coverage — coverage matrix with uncovered alerts (default)
//   table    — Postgres companies table (full schema, sortable, editable)
//   kanban   — companies grouped by stage as kanban columns
// Mode persisted in localStorage so refresh keeps Matt where he was.
async function renderCompanyCoverage() {
  const main = $("#companies-view");
  const mode = localStorage.getItem("mc_companies_view") || "kanban";

  // Top toggle is rendered above the mode-specific content. It re-uses the
  // existing `data-cov-page-mode` click handler.
  const modeBtn = (id, label) => `
    <button class="page-toggle-btn${mode === id ? " page-toggle-btn--active" : ""}" data-cov-page-mode="${id}">${label}</button>`;
  const topToggle = `
    <div class="page-toggle-row">
      <div class="page-toggle">
        ${modeBtn("coverage", "Coverage")}
        ${modeBtn("table", "Table")}
        ${modeBtn("kanban", "Kanban")}
      </div>
    </div>`;

  if (mode === "table" || mode === "kanban") {
    // Reuse the existing DB Companies render path. Force the kanban/table
    // sub-mode based on the page-level toggle.
    state.dbCompaniesMode = mode === "kanban" ? "kanban" : "table";
    localStorage.setItem("mc_db_companies_mode", state.dbCompaniesMode);
    const isKanban = mode === "kanban";
    // Kanban embeds the page-mode toggle in its own toolbar; only show the
    // separate top toggle for Table mode.
    main.innerHTML = `
      ${isKanban ? "" : topToggle}
      <div class="db-shell${isKanban ? " db-shell--kanban" : ""}">
        <section class="db-main${isKanban ? " db-main--kanban" : ""}" id="db-main">
          <div class="db-loading">Loading…</div>
        </section>
      </div>
    `;
    await renderDbTable("companies");
    return;
  }

  // mode === "coverage"
  main.innerHTML = `${topToggle}<div class="cov-loading">Loading company coverage…</div>`;

  let companies = [];
  try {
    const res = await fetch("/api/companies/coverage");
    const data = await res.json();
    companies = data.companies || [];
  } catch (err) {
    main.innerHTML = `${topToggle}<div class="cov-error">Failed to load coverage: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Filter: all | pipeline (CRO deals) | customers (CS clients). Persisted.
  const filter = localStorage.getItem("mc_cov_filter") || "all";
  const visible = filter === "pipeline"
    ? companies.filter(c => c.owning_agent === "cro")
    : filter === "customers"
    ? companies.filter(c => c.owning_agent === "cs")
    : companies;

  const uncoveredCount = visible.filter(c => c.is_uncovered).length;
  const croCount = companies.filter(c => c.owning_agent === "cro").length;
  const csCount = companies.filter(c => c.owning_agent === "cs").length;

  const filterBtn = (id, label, count) => `
    <button class="cov-filter-btn ${filter === id ? "cov-filter-btn--active" : ""}" data-cov-filter="${id}">
      ${label} <span class="cov-filter-count">${count}</span>
    </button>`;

  const cards = visible.map(c => renderCovCard(c)).join("");

  main.innerHTML = `
    ${topToggle}
    <div class="cov-header">
      <div class="cov-filter-row">
        ${filterBtn("all", "All", companies.length)}
        ${filterBtn("pipeline", "Pipeline", croCount)}
        ${filterBtn("customers", "Customers", csCount)}
      </div>
      <div class="cov-summary">
        <span class="cov-summary-item cov-summary-item--alert">${uncoveredCount} uncovered</span>
        <span class="cov-summary-item">${visible.length} ${filter === "all" ? "total" : filter}</span>
      </div>
      <p class="cov-subtitle">Click a card to see what's in motion. Red cards have no plan and no tasks — those are the gaps.</p>
    </div>
    <div class="cov-cards">
      ${cards || `<div class="cov-empty">No active companies</div>`}
    </div>
  `;

  // Auto-load details for any cards that were already expanded from prior session
  for (const slug of state.covExpanded) {
    if (visible.some(c => c.slug === slug)) {
      loadCovCardDetail(slug);
    }
  }
}

// Render a single company coverage card. The body is hidden until the user
// expands it; details are lazy-fetched from /api/companies/:slug/coverage on
// first expand and cached in state.covDetailCache.
function renderCovCard(c) {
  const expanded = state.covExpanded.has(c.slug);
  const days = c.days_since_contact == null
    ? "Never"
    : c.days_since_contact === 0 ? "Today"
    : c.days_since_contact === 1 ? "Yesterday"
    : `${c.days_since_contact}d ago`;
  const cardClass = [
    "cov-card",
    c.is_uncovered ? "cov-card--uncovered" : `cov-card--risk-${c.risk || "unknown"}`,
    expanded ? "cov-card--expanded" : "",
  ].filter(Boolean).join(" ");
  const reviewCount = c.tasks_needing_review || 0;
  const motionCount = c.tasks_in_motion || 0;
  const totalCount = c.active_task_count_total || 0;
  const latestLine = !c.is_uncovered && c.latest_task_title
    ? `<div class="cov-card-latest">Latest: ${escapeHtml(truncate(c.latest_task_title, 90))}</div>`
    : c.is_uncovered
    ? `<div class="cov-card-alert">No plan in motion — needs attention</div>`
    : "";

  return `
    <div class="${cardClass}" data-cov-slug="${escapeHtml(c.slug)}">
      <button class="cov-card-head" data-cov-expand="${escapeHtml(c.slug)}" aria-expanded="${expanded}">
        <span class="cov-card-chevron">▸</span>
        <div class="cov-card-head-main">
          <div class="cov-card-title-row">
            <span class="cov-card-name">${escapeHtml(c.name)}</span>
            <span class="cov-chip cov-chip--stage">${escapeHtml(c.stage)}</span>
            <span class="cov-chip cov-chip--agent-${c.owning_agent}">${(c.owning_agent || "").toUpperCase()}</span>
            <span class="cov-chip cov-chip--${c.risk || "unknown"}">${c.risk || "unknown"}</span>
          </div>
          ${latestLine}
        </div>
        <div class="cov-card-stats">
          <div class="cov-stat" title="All active tasks for this company">
            <div class="cov-stat-num cov-stat-num--review ${totalCount === 0 && !c.is_uncovered ? "cov-stat-num--zero" : ""}">${totalCount}</div>
            <div class="cov-stat-label">task${totalCount === 1 ? "" : "s"}</div>
          </div>
          <div class="cov-stat cov-stat--touch">
            <div class="cov-stat-touch">${days}</div>
            <div class="cov-stat-label">last touch</div>
          </div>
        </div>
      </button>
      <div class="cov-card-body" id="cov-body-${escapeHtml(c.slug)}" ${expanded ? "" : "hidden"}>
        ${expanded ? `<div class="cov-card-loading">Loading…</div>` : ""}
      </div>
    </div>`;
}

// Toggle visibility of one card's body. Called by the click handler after
// state.covExpanded is mutated. Lazy-fetches details on first open.
async function toggleCovCard(slug) {
  const card = document.querySelector(`[data-cov-slug="${CSS.escape(slug)}"]`);
  if (!card) return;
  const body = card.querySelector(".cov-card-body");
  const head = card.querySelector(".cov-card-head");
  const expanded = state.covExpanded.has(slug);
  if (expanded) {
    card.classList.add("cov-card--expanded");
    head.setAttribute("aria-expanded", "true");
    body.hidden = false;
    if (state.covDetailCache[slug]) {
      body.innerHTML = renderCovCardBody(state.covDetailCache[slug]);
    } else {
      body.innerHTML = `<div class="cov-card-loading">Loading…</div>`;
      await loadCovCardDetail(slug);
    }
  } else {
    card.classList.remove("cov-card--expanded");
    head.setAttribute("aria-expanded", "false");
    body.hidden = true;
  }
}

async function loadCovCardDetail(slug) {
  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(slug)}/coverage`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    state.covDetailCache[slug] = { tasks: payload.tasks || [] };
  } catch (err) {
    state.covDetailCache[slug] = { error: err.message };
  }
  const card = document.querySelector(`[data-cov-slug="${CSS.escape(slug)}"]`);
  if (!card) return;
  const body = card.querySelector(".cov-card-body");
  if (body && !body.hidden) {
    body.innerHTML = renderCovCardBody(state.covDetailCache[slug]);
  }
}

function renderCovCardBody(detail) {
  if (detail.error) {
    return `<div class="cov-card-error">Failed to load: ${escapeHtml(detail.error)}</div>`;
  }
  const { tasks = [] } = detail;

  if (tasks.length === 0) {
    return `<div class="cov-card-empty">No active tasks</div>`;
  }

  const renderTaskRow = (t) => `
    <a href="#/agent/${escapeHtml(t.agent_id || "")}" class="cov-mini cov-mini--task" data-task-id="${escapeHtml(t.id || "")}">
      <div class="cov-mini-head">
        <span class="cov-chip cov-chip--agent-${escapeHtml(t.agent_id || "x")}">${(t.agent_id || "").toUpperCase()}</span>
        <span class="cov-chip cov-chip--prio-${t.priority || "normal"}">${t.priority || "normal"}</span>
        ${t.action_type ? `<span class="cov-chip">${escapeHtml(t.action_type)}</span>` : ""}
        ${t.due_date ? `<span class="cov-chip cov-chip--due">due ${escapeHtml(t.due_date.slice(0, 10))}</span>` : ""}
      </div>
      <div class="cov-mini-title">${escapeHtml(t.title || "")}</div>
      ${t.notes ? `<div class="cov-mini-body">${escapeHtml(truncate(t.notes, 220))}</div>` : ""}
    </a>`;

  return `
    <div class="cov-tasks-section">
      <div class="cov-section-title">
        Tasks <span class="cov-section-count">${tasks.length}</span>
      </div>
      <div class="cov-tasks-list">${tasks.map(renderTaskRow).join("")}</div>
    </div>`;
}

async function renderCompanyCoverageDetail(slug) {
  return renderDbCompany(slug, {
    container: "#companies-view",
    backHref: "#/companies",
    backLabel: "All companies",
  });
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─── Projects (CS-as-PM portfolio view) ─────────────────────────
const PROJECT_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const PROJECT_STATUS_LABEL = {
  active: "Active",
  blocked: "Blocked",
  shipped: "Shipped",
  paused: "Paused",
  cancelled: "Cancelled",
};
const PROJECT_KIND_LABEL = {
  excel_model: "Excel",
  vba_macro: "VBA",
  skysuite_feature: "SkySuite",
  powerpoint: "PowerPoint",
  automation: "Automation",
  integration: "Integration",
  other: "Other",
};

async function renderProjects() {
  const main = $("#projects-view");
  if (!main) return;
  main.innerHTML = `<div class="cov-loading">Loading projects…</div>`;

  let projects = [];
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    projects = data.projects || [];
  } catch (err) {
    main.innerHTML = `<div class="cov-error">Failed to load projects: ${escape(err.message)}</div>`;
    return;
  }

  if (!projects.length) {
    main.innerHTML = `
      <header class="cov-header">
        <h1>Projects</h1>
        <p class="cov-subtitle">CS owns the portfolio. Analyst executes.</p>
      </header>
      <div class="cov-empty">No active projects.</div>`;
    return;
  }

  // Group by company
  const byCompany = {};
  for (const p of projects) {
    (byCompany[p.company_slug] = byCompany[p.company_slug] || { name: p.company_name, slug: p.company_slug, projects: [] }).projects.push(p);
  }

  // Count summary stats
  const totalOpen = projects.reduce((s, p) => s + Number(p.open_task_count || 0), 0);
  const totalKickback = projects.reduce((s, p) => s + Number(p.needs_matt || 0), 0);
  const totalOverdue = projects.reduce((s, p) => s + Number(p.overdue || 0), 0);
  const stalled = projects.filter(p => Number(p.days_stale || 0) > 5).length;

  const cardsHtml = Object.values(byCompany)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => {
      const sorted = c.projects.sort((a, b) =>
        (PROJECT_PRIORITY_RANK[a.priority] ?? 9) - (PROJECT_PRIORITY_RANK[b.priority] ?? 9)
      );
      return `
        <section class="proj-company-card">
          <header class="proj-company-head">
            <h2 class="proj-company-name">${escape(c.name)}</h2>
            <span class="proj-company-count">${sorted.length} project${sorted.length === 1 ? "" : "s"}</span>
          </header>
          <div class="proj-company-grid">
            ${sorted.map(renderProjectCard).join("")}
          </div>
        </section>`;
    }).join("");

  main.innerHTML = `
    <header class="cov-header">
      <div class="cov-header-row">
        <div>
          <h1>Projects</h1>
          <p class="cov-subtitle">CS owns the portfolio. Analyst executes assigned tasks.</p>
        </div>
        <div class="proj-stats">
          <span class="proj-stat"><b>${projects.length}</b> active</span>
          <span class="proj-stat"><b>${totalOpen}</b> open tasks</span>
          ${totalKickback > 0 ? `<span class="proj-stat proj-stat-warn"><b>${totalKickback}</b> kicked back</span>` : ""}
          ${totalOverdue > 0 ? `<span class="proj-stat proj-stat-warn"><b>${totalOverdue}</b> overdue</span>` : ""}
          ${stalled > 0 ? `<span class="proj-stat proj-stat-muted"><b>${stalled}</b> stalled</span>` : ""}
        </div>
      </div>
    </header>
    <div class="proj-companies">
      ${cardsHtml}
    </div>
  `;
}

function renderProjectCard(p) {
  const priorityClass = `proj-pri-${escape(p.priority || "normal")}`;
  const statusClass = `proj-status-${escape(p.status || "active")}`;
  const daysStale = Number(p.days_stale || 0);
  const staleClass = daysStale > 5 ? "proj-stale" : "";
  const flags = [];
  if (Number(p.needs_matt || 0) > 0) flags.push(`<span class="proj-flag proj-flag-warn">${p.needs_matt} kicked back</span>`);
  if (Number(p.overdue || 0) > 0) flags.push(`<span class="proj-flag proj-flag-warn">${p.overdue} overdue</span>`);
  if (Number(p.recently_shipped || 0) > 0) flags.push(`<span class="proj-flag proj-flag-good">${p.recently_shipped} shipped</span>`);
  if (p.blocked_on) flags.push(`<span class="proj-flag proj-flag-block" title="${escape(p.blocked_on)}">Blocked</span>`);
  return `
    <a href="#/projects/${p.project_id}" class="proj-card ${staleClass}">
      <div class="proj-card-head">
        <span class="proj-pill ${priorityClass}">${escape((p.priority || "normal").toUpperCase())}</span>
        <span class="proj-pill ${statusClass}">${escape(PROJECT_STATUS_LABEL[p.status] || p.status || "")}</span>
        <span class="proj-pill proj-kind">${escape(PROJECT_KIND_LABEL[p.kind] || p.kind || "")}</span>
        <span class="proj-pill proj-agent">${escape(p.owning_agent || "")}</span>
      </div>
      <h3 class="proj-card-title">${escape(p.project_name)}</h3>
      ${p.current_version ? `<div class="proj-card-version">v${escape(p.current_version)}</div>` : ""}
      ${p.summary ? `<p class="proj-card-summary">${escape(truncate(p.summary, 180))}</p>` : ""}
      <div class="proj-card-stats">
        <span><b>${p.open_task_count || 0}</b> open</span>
        <span><b>${p.in_progress || 0}</b> in motion</span>
        <span class="proj-card-stale">${daysStale}d stale</span>
      </div>
      ${flags.length ? `<div class="proj-card-flags">${flags.join("")}</div>` : ""}
    </a>`;
}

async function renderProjectDetail(projectId) {
  const main = $("#projects-view");
  if (!main) return;
  main.innerHTML = `<div class="cov-loading">Loading project…</div>`;

  let project = null, tasks = [];
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!res.ok) {
      if (res.status === 404) {
        main.innerHTML = `<div class="cov-error">Project not found. <a href="#/projects">Back to projects</a></div>`;
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    project = data.project;
    tasks = data.tasks || [];
  } catch (err) {
    main.innerHTML = `<div class="cov-error">Failed to load project: ${escape(err.message)}</div>`;
    return;
  }

  const grouped = { in_motion: [], kicked_back: [], review: [], snoozed: [], shipped: [] };
  for (const t of tasks) (grouped[t.lane] || grouped.review).push(t);

  const meta = [
    project.current_version ? `<span><b>Version</b> ${escape(project.current_version)}</span>` : "",
    project.target_date ? `<span><b>Target</b> ${escape(project.target_date)}</span>` : "",
    `<span><b>Stale</b> ${Number(project.days_stale || 0)}d</span>`,
    project.context_doc_path ? `<span><b>Context</b> <code>${escape(project.context_doc_path)}</code></span>` : "",
  ].filter(Boolean).join(" · ");

  const sectionHtml = (label, list, emptyText) => `
    <section class="cov-detail-section">
      <h2 class="cov-detail-section-title">${escape(label)} (${list.length})</h2>
      ${list.length === 0 ? `<div class="cov-detail-empty">${escape(emptyText)}</div>` : list.map(renderTaskRow).join("")}
    </section>`;

  main.innerHTML = `
    <header class="cov-detail-header">
      <div>
        <div class="cov-detail-crumb"><a href="#/projects">← All projects</a></div>
        <h1>${escape(project.project_name)}</h1>
        <div class="cov-detail-sub">
          <a href="#/companies/${escape(project.company_slug)}">${escape(project.company_name)}</a> ·
          <span class="proj-pill proj-pri-${escape(project.priority || "normal")}">${escape((project.priority || "normal").toUpperCase())}</span>
          <span class="proj-pill proj-status-${escape(project.status || "active")}">${escape(PROJECT_STATUS_LABEL[project.status] || project.status || "")}</span>
          <span class="proj-pill proj-kind">${escape(PROJECT_KIND_LABEL[project.kind] || project.kind || "")}</span>
          <span class="proj-pill proj-agent">${escape(project.owning_agent || "")}</span>
        </div>
        ${project.summary ? `<p class="cov-detail-summary">${escape(project.summary)}</p>` : ""}
        ${project.blocked_on ? `<p class="cov-detail-blocker"><b>Blocked on:</b> ${escape(project.blocked_on)}</p>` : ""}
        <div class="cov-detail-meta">${meta}</div>
      </div>
    </header>
    ${sectionHtml("Kicked back to CS", grouped.kicked_back, "Nothing kicked back.")}
    ${sectionHtml("In motion", grouped.in_motion, "Nothing in motion.")}
    ${sectionHtml("Needs review", grouped.review, "Nothing waiting on review.")}
    ${sectionHtml("Snoozed", grouped.snoozed, "Nothing snoozed.")}
    ${sectionHtml("Recently shipped (14d)", grouped.shipped, "Nothing shipped recently.")}
  `;
}

// ─── Boot ───────────────────────────────────────────────────────
setGreeting();
loadAll().then(() => {
  // Initial notification load is silent (don't toast for events that happened
  // before Matt opened the dashboard — those are "catch up", not live alerts).
  pollNotifications({ silent: true });
});
setInterval(loadAll, 60000); // soft refresh every minute
setInterval(() => pollNotifications({ silent: false }), 60000); // live notifications every minute
