// /api/github/* — read-only GitHub dashboard for Mission Control.
// Shells out to the `gh` CLI (already authed as mattlaz1 with repo scope).
// Results cached in-memory for 60s to avoid hammering the API.

const express = require("express");
const { execFile } = require("child_process");

const router = express.Router();
const OWNER = process.env.GITHUB_OWNER || "mattlaz1";
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 20 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try {
        resolve(stdout ? JSON.parse(stdout) : null);
      } catch (parseErr) {
        reject(new Error(`gh output not JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await loader();
  cache.set(key, { val, at: Date.now() });
  return val;
}

function pickDevBranch(branches, defaultBranch) {
  const names = branches.map((b) => b.name);
  const candidates = ["dev", "development", "develop", "staging"];
  for (const c of candidates) if (names.includes(c)) return c;
  return defaultBranch === "main" && names.includes("master")
    ? "master"
    : defaultBranch === "master" && names.includes("main")
      ? "main"
      : null;
}

// ---------- list of repos (summary cards) ----------
router.get("/repos", async (req, res) => {
  // Optional ?enabled=repo1,repo2,... — only fetch expensive summaries for these.
  // Repos not in the enabled list are returned as lightweight stubs.
  const enabledParam = (req.query.enabled || "").trim();
  const enabledSet = enabledParam ? new Set(enabledParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;

  try {
    const repos = await cached("repos", CACHE_TTL_MS, () =>
      gh([
        "repo",
        "list",
        OWNER,
        "--limit",
        "100",
        "--json",
        "name,defaultBranchRef,pushedAt,updatedAt,description,isPrivate,isArchived,url",
      ])
    );

    // Build lightweight summary per repo in parallel, with per-repo cache
    const summaries = await Promise.all(
      repos
        .filter((r) => !r.isArchived)
        .map(async (r) => {
          // If an enabled list was provided and this repo isn't in it, return a stub.
          if (enabledSet && !enabledSet.has(r.name)) {
            return {
              name: r.name,
              url: r.url,
              description: r.description || "",
              isPrivate: r.isPrivate,
              pushedAt: r.pushedAt,
              updatedAt: r.updatedAt,
              defaultBranch: r.defaultBranchRef?.name || "main",
              disabled: true,
            };
          }
          const defaultBranch = r.defaultBranchRef?.name || "main";
          const key = `summary:${r.name}`;
          try {
            const summary = await cached(key, CACHE_TTL_MS, async () => {
              const [branches, prs] = await Promise.all([
                gh([
                  "api",
                  `repos/${OWNER}/${r.name}/branches?per_page=100`,
                  "--jq",
                  "[.[] | {name: .name, sha: .commit.sha}]",
                ]).catch(() => []),
                gh([
                  "api",
                  `repos/${OWNER}/${r.name}/pulls?state=open&per_page=30`,
                  "--jq",
                  "[.[] | {number, title, head: .head.ref, base: .base.ref, author: .user.login, draft: .draft, url: .html_url, updated_at}]",
                ]).catch(() => []),
              ]);

              const devBranch = pickDevBranch(branches || [], defaultBranch);
              let devVsProd = null;
              if (devBranch && devBranch !== defaultBranch) {
                try {
                  const cmp = await gh([
                    "api",
                    `repos/${OWNER}/${r.name}/compare/${defaultBranch}...${devBranch}`,
                    "--jq",
                    "{ahead: .ahead_by, behind: .behind_by, status: .status}",
                  ]);
                  devVsProd = { devBranch, defaultBranch, ...cmp };
                } catch {}
              }

              // Latest commit on default branch + dev branch
              const fetchLatest = async (branch) => {
                try {
                  const commits = await gh([
                    "api",
                    `repos/${OWNER}/${r.name}/commits?per_page=1&sha=${branch}`,
                    "--jq",
                    "[.[0] | {sha: .sha, msg: (.commit.message | split(\"\\n\")[0]), author: .commit.author.name, date: .commit.author.date}]",
                  ]);
                  return Array.isArray(commits) ? commits[0] : commits;
                } catch {
                  return null;
                }
              };
              const [latest, latestDev] = await Promise.all([
                fetchLatest(defaultBranch),
                devBranch && devBranch !== defaultBranch ? fetchLatest(devBranch) : Promise.resolve(null),
              ]);

              return {
                name: r.name,
                url: r.url,
                description: r.description || "",
                isPrivate: r.isPrivate,
                pushedAt: r.pushedAt,
                updatedAt: r.updatedAt,
                defaultBranch,
                devBranch,
                branches: (branches || []).length,
                openPRs: (prs || []).length,
                prs: prs || [],
                devVsProd,
                latest,
                latestDev,
              };
            });
            return summary;
          } catch (err) {
            return {
              name: r.name,
              url: r.url,
              description: r.description || "",
              isPrivate: r.isPrivate,
              pushedAt: r.pushedAt,
              updatedAt: r.updatedAt,
              defaultBranch,
              error: err.message,
            };
          }
        })
    );

    summaries.sort((a, b) => new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0));
    res.json({ owner: OWNER, fetched_at: new Date().toISOString(), repos: summaries });
  } catch (err) {
    res.status(500).json({ error: err.message, stderr: err.stderr });
  }
});

// ---------- single repo detail ----------
router.get("/repos/:repo", async (req, res) => {
  const repo = req.params.repo;
  try {
    const data = await cached(`detail:${repo}`, CACHE_TTL_MS, async () => {
      const [info, branches, prs] = await Promise.all([
        gh([
          "api",
          `repos/${OWNER}/${repo}`,
          "--jq",
          "{name, description, default_branch, pushed_at, updated_at, private, html_url, open_issues_count}",
        ]),
        gh([
          "api",
          `repos/${OWNER}/${repo}/branches?per_page=100`,
          "--jq",
          "[.[] | {name: .name, sha: .commit.sha, protected: .protected}]",
        ]),
        gh([
          "api",
          `repos/${OWNER}/${repo}/pulls?state=open&per_page=50`,
          "--jq",
          "[.[] | {number, title, head: .head.ref, base: .base.ref, author: .user.login, draft: .draft, url: .html_url, updated_at, created_at}]",
        ]),
      ]);

      const defaultBranch = info.default_branch;

      // Get ahead/behind + last commit for every branch vs default, in parallel
      const branchDetails = await Promise.all(
        branches.map(async (b) => {
          const [cmp, commit] = await Promise.all([
            b.name === defaultBranch
              ? Promise.resolve({ ahead: 0, behind: 0, status: "identical" })
              : gh([
                  "api",
                  `repos/${OWNER}/${repo}/compare/${defaultBranch}...${b.name}`,
                  "--jq",
                  "{ahead: .ahead_by, behind: .behind_by, status: .status}",
                ]).catch(() => null),
            gh([
              "api",
              `repos/${OWNER}/${repo}/commits/${b.sha}`,
              "--jq",
              "{sha: .sha, msg: (.commit.message | split(\"\\n\")[0]), author: .commit.author.name, date: .commit.author.date}",
            ]).catch(() => null),
          ]);
          return { ...b, compare: cmp, commit };
        })
      );

      // Recent commit timeline on default branch
      const timeline = await gh([
        "api",
        `repos/${OWNER}/${repo}/commits?per_page=25&sha=${defaultBranch}`,
        "--jq",
        "[.[] | {sha: .sha, msg: (.commit.message | split(\"\\n\")[0]), author: .commit.author.name, date: .commit.author.date, url: .html_url}]",
      ]).catch(() => []);

      return { info, branches: branchDetails, prs, timeline };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, stderr: err.stderr });
  }
});

// ---------- force refresh (bust cache) ----------
router.post("/refresh", (_req, res) => {
  cache.clear();
  res.json({ ok: true });
});

module.exports = router;
