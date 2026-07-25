/* Generates the five review fixtures the plan's readiness gate requires:
 * operational, partial-outage, major-outage, unknown (stale) and empty history.
 *
 * Fixtures are deterministic — a fixed base date, no Date.now() — so the review
 * page renders identically today and in a year. Each fixture carries
 * previewNowOffsetMinutes so preview.html can supply a clock relative to the
 * fixture's own lastCheckedAt; otherwise every non-stale fixture would age into
 * the stale state and the gate would quietly stop testing what it claims to.
 *
 * Run: node scripts/make-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "fixtures");
const WINDOW = 90;
const BASE = Date.parse("2026-07-25T14:15:00Z"); // fixed clock for all fixtures
const PROBES_PER_DAY = 96; // 15-minute interval

const SERVICES = [
  { id: "web", label: "Web app", sublabel: "The NaviPaw website and app at www.navipaw.com" },
  { id: "database", label: "Database API", sublabel: "Saving and loading your NaviPaw data" },
];

const iso = (ms) => new Date(ms).toISOString();
const dayISO = (ms) => iso(ms).slice(0, 10);

/* leadingUnknown models a page younger than its own 90-day window: days before
   launch have no data and must render unknown rather than implied-green. */
function days({ leadingUnknown = 12, downOn = [], degradedOn = [], all = null }) {
  const out = [];
  for (let i = 0; i < WINDOW; i++) {
    const date = dayISO(BASE - (WINDOW - 1 - i) * 86400000);
    let state = all ?? "operational";
    if (all === null) {
      if (i < leadingUnknown) state = "unknown";
      else if (downOn.includes(i)) state = "down";
      else if (degradedOn.includes(i)) state = "degraded";
    }
    let recorded = PROBES_PER_DAY, successful = PROBES_PER_DAY;
    if (state === "unknown") { recorded = 0; successful = 0; }
    else if (state === "down") { successful = Math.round(PROBES_PER_DAY * 0.42); }
    else if (state === "degraded") { successful = PROBES_PER_DAY - 3; }
    out.push({ date, state, recordedProbes: recorded, successfulProbes: successful });
  }
  return out;
}

const service = (spec, state, dayOpts) => ({
  ...SERVICES.find((s) => s.id === spec),
  state,
  consecutiveFailures: state === "down" ? 4 : state === "degraded" ? 1 : 0,
  consecutiveSuccesses: state === "operational" ? 37 : 0,
  days: days(dayOpts),
});

const snapshot = (overall, services, incidents, checkedAtOffsetMin, previewOffsetMin) => ({
  version: 1,
  generatedAt: iso(BASE + checkedAtOffsetMin * 60000),
  lastCheckedAt: iso(BASE + checkedAtOffsetMin * 60000),
  overall,
  services,
  incidents,
  previewNowOffsetMinutes: previewOffsetMin,
});

const dbIncident = {
  id: "2026-07-25-database",
  title: "Elevated errors reaching Database API",
  status: "investigating",
  affects: ["database"],
  startedAt: iso(BASE - 41 * 60000),
  updates: [
    { at: iso(BASE - 41 * 60000), status: "Investigating",
      body: "We are investigating failed health checks against the Database API. Saving and loading data may fail." },
  ],
};

const resolvedIncident = {
  id: "2026-07-18-database",
  title: "Elevated errors reaching Database API",
  status: "resolved",
  affects: ["database"],
  startedAt: "2026-07-18T14:11:00Z",
  resolvedAt: "2026-07-18T14:42:00Z",
  updates: [
    { at: "2026-07-18T14:42:00Z", status: "Resolved",
      body: "Database API responses recovered. Customers who could not load schedules or save changes should retry." },
    { at: "2026-07-18T14:11:00Z", status: "Investigating",
      body: "We were investigating failed health checks against the Database API." },
  ],
};

const FIXTURES = {
  // Everything green. One historical blip so the 90-day bar isn't a flat wall.
  operational: snapshot("operational", [
    service("web", "operational", { downOn: [], degradedOn: [70] }),
    service("database", "operational", { downOn: [68], degradedOn: [] }),
  ], [resolvedIncident], 0, 4),

  // One service down, one healthy — the most common real incident shape.
  "partial-outage": snapshot("partial-outage", [
    service("web", "operational", { degradedOn: [70] }),
    service("database", "down", { downOn: [89] }),
  ], [dbIncident, resolvedIncident], 0, 6),

  // Everything down. Note this page is still being served — that is the point.
  "major-outage": snapshot("major-outage", [
    service("web", "down", { downOn: [89] }),
    service("database", "down", { downOn: [89] }),
  ], [{
    id: "2026-07-25-major",
    title: "NaviPaw is unreachable",
    status: "investigating",
    affects: ["web", "database"],
    startedAt: iso(BASE - 22 * 60000),
    updates: [
      { at: iso(BASE - 22 * 60000), status: "Investigating",
        body: "Both the web app and the Database API are failing health checks. We are investigating." },
    ],
  }], 0, 8),

  // Data published 3 hours ago: past staleAfterMinutes, so every reading is
  // downgraded to unknown even though the file below claims "operational".
  unknown: snapshot("operational", [
    service("web", "operational", {}),
    service("database", "operational", {}),
  ], [resolvedIncident], 0, 180),

  // Brand new page: nothing probed yet. Must not look like an outage.
  empty: snapshot("unknown", [
    service("web", "unknown", { all: "unknown" }),
    service("database", "unknown", { all: "unknown" }),
  ], [], 0, 4),
};

mkdirSync(OUT, { recursive: true });
for (const [name, data] of Object.entries(FIXTURES)) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote fixtures/${name}.json`);
}
