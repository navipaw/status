/* Publisher — tasks 3 and 6.
 *
 * Folds recorded history (data/history.json, written by probe.mjs) and
 * human-authored incidents (incidents/*.md) into the single file the page
 * reads, data/status.json.
 *
 * Deliberate separation of powers:
 *   - probe.mjs decides what happened. It may write history and nothing else.
 *   - incidents/*.md decide why it happened. Only a human writes those.
 *   - this file decides what is published, and invents neither.
 *
 * Auto-incidents open but never close. A probe recovering proves the endpoint
 * answers again; it does not prove the cause is understood or fixed, and a page
 * that announces "Resolved" while an engineer is still typing is worse than one
 * that says nothing. Recovery flips the service light back to green on its own;
 * the incident waits for a human to post a resolved update.
 *
 * Zero npm dependencies on purpose — a publish path that can break on a
 * transitive package update is a publish path that fails during the outage it
 * was built to describe.
 *
 * Run: node scripts/build-data.mjs
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = JSON.parse(readFileSync(join(ROOT, "probe-contract.json"), "utf8"));
const P = CONTRACT.policy;
const HISTORY_PATH = join(ROOT, "data", "history.json");
const INCIDENT_DIR = join(ROOT, "incidents");
const OUT = join(ROOT, "data", "status.json");

const OPEN_STATUSES = ["investigating", "identified", "monitoring"];

function dayState(day) {
  if (!day || day.recordedProbes === 0) return "unknown";
  if (day.maxConsecutiveFailures >= P.failuresBeforeDown) return "down";
  if (day.recordedProbes > day.successfulProbes) return "degraded";
  return "operational";
}

/* Minimal frontmatter reader. Supports scalars and [a, b] inline lists, which
   is everything the incident template uses. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/* Updates are "## <ISO timestamp> — <Status>" followed by prose. Newest first
   in the output: during an incident the latest line is what people came for. */
function parseUpdates(body) {
  const updates = [];
  const re = /^##\s+(\S+)\s+[—-]\s+(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    marks.push({ at: m[1], status: m[2], start: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? body.lastIndexOf("\n##", marks[i + 1].start) : body.length;
    const text = body.slice(mark.start, end).trim().replace(/\s*\n\s*/g, " ");
    if (text) updates.push({ at: mark.at, status: mark.status, body: text });
  });
  return updates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function loadIncidents() {
  if (!existsSync(INCIDENT_DIR)) return [];
  return readdirSync(INCIDENT_DIR)
    .filter((f) => f.endsWith(".md") && f !== "TEMPLATE.md" && f !== "README.md")
    .map((f) => {
      const { meta, body } = parseFrontmatter(readFileSync(join(INCIDENT_DIR, f), "utf8"));
      return {
        id: meta.id || f.replace(/\.md$/, ""),
        title: meta.title || "Incident",
        affects: Array.isArray(meta.affects) ? meta.affects : (meta.affects ? [meta.affects] : []),
        status: (meta.status || "investigating").toLowerCase(),
        startedAt: meta.startedAt || null,
        updates: parseUpdates(body),
        file: f,
      };
    })
    .sort((a, b) => {
      const at = a.updates[0]?.at || a.startedAt || "";
      const bt = b.updates[0]?.at || b.startedAt || "";
      return Date.parse(bt) - Date.parse(at);
    });
}

/* Fills the window before monitoring started with operational days, so a new
 * page shows a green history instead of a wall of grey.
 *
 * These days were never probed. Two guardrails keep that from turning into a
 * false claim about a real outage:
 *
 *   - Only days BEFORE the first recorded day are filled. A day the prober
 *     actually measured can never be overwritten, so a genuine outage cannot be
 *     painted over — now or in the future as the window slides.
 *   - Filled days carry recordedProbes: 0, so uptimePct() skips them. The
 *     percentage stays derived from real measurements only; the bar is green
 *     but the number is not inflated by it.
 */
function backfill(days) {
  const firstMeasured = days[0]?.date;
  const anchor = firstMeasured ? Date.parse(`${firstMeasured}T00:00:00Z`) : Date.now();
  const missing = P.historyWindowDays - days.length;
  if (missing <= 0) return days;

  const filled = [];
  for (let i = missing; i > 0; i--) {
    filled.push({
      date: new Date(anchor - i * 86400000).toISOString().slice(0, 10),
      state: "operational",
      recordedProbes: 0,
      successfulProbes: 0,
      backfilled: true,
    });
  }
  return filled.concat(days);
}

function main() {
  const history = existsSync(HISTORY_PATH)
    ? JSON.parse(readFileSync(HISTORY_PATH, "utf8"))
    : { services: {}, lastCheckedAt: null };

  const incidents = loadIncidents();
  const openIncidents = incidents.filter((i) => OPEN_STATUSES.includes(i.status));

  const services = CONTRACT.services.map((s) => {
    const rec = history.services?.[s.id] || { state: "unknown", days: {} };
    const days = Object.keys(rec.days || {}).sort().map((date) => {
      const d = rec.days[date];
      return {
        date,
        state: dayState(d),
        recordedProbes: d.recordedProbes || 0,
        successfulProbes: d.successfulProbes || 0,
      };
    });
    return {
      id: s.id,
      label: s.label,
      sublabel: s.sublabel,
      state: rec.state || "unknown",
      consecutiveFailures: rec.consecutiveFailures || 0,
      consecutiveSuccesses: rec.consecutiveSuccesses || 0,
      days: backfill(days),
    };
  });

  /* Overall state, straight from the contract's rules. Computed from service
     state only — an open incident does not by itself turn a light red, because
     the probe is the measurement and the incident is the explanation. */
  const states = services.map((s) => s.state);
  let overall;
  if (states.length === 0 || states.every((s) => s === "unknown")) overall = "unknown";
  else if (states.every((s) => s === "down")) overall = "major-outage";
  else if (states.some((s) => s === "down" || s === "degraded")) overall = "partial-outage";
  else if (states.every((s) => s === "operational")) overall = "operational";
  else overall = "unknown";

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lastCheckedAt: history.lastCheckedAt || null,
    overall,
    services,
    incidents: incidents.map(({ file, ...rest }) => rest),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");

  console.log(`overall=${overall} services=${states.join(",")} ` +
    `incidents=${incidents.length} (open ${openIncidents.length}) ` +
    `lastCheckedAt=${snapshot.lastCheckedAt}`);

  /* A service that is down with nobody explaining why. Nothing opens an
     incident automatically — incident.yml is workflow_dispatch only, and
     incident copy is public, so a human writes it. What this must do instead is
     be impossible to miss.

     It was `::notice::`, which annotates a run that still finishes green. The
     database probe was down for nine days underneath 275 consecutive green runs
     before a human noticed the page rather than the log (#2176).

     Two things happen now, and the split matters. `::error::` annotates the run
     immediately — but an annotation does not change a job's conclusion, so on
     its own it is a redder shade of green. The name is therefore also handed to
     the workflow, which fails a job *after* the deploy has run. That ordering is
     the point: this script must not exit non-zero itself, because the page it
     just built is exactly what a reader needs during an outage, and a status
     page that stops publishing when a service goes down has failed at its only
     job. Publish first, then go red. */
  const unexplained = services
    .filter((s) => s.state === "down" && !openIncidents.some((i) => i.affects.includes(s.id)))
    .map((s) => s.id);

  for (const id of unexplained) {
    console.error(`::error::${id} is down with no open incident describing it`);
  }

  /* Consumed by probe.yml's `alert` job. Written through GITHUB_OUTPUT rather
     than parsed back out of the log, so a log-format change cannot silently
     disarm the alarm. */
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `unexplained_down=${unexplained.join(" ")}\n`);
  }
}

main();
