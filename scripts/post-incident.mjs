/* Writes an incident update from the Actions form (.github/workflows/incident.yml).
 *
 * Produces exactly the same file a human would write by hand, so the two
 * authoring paths cannot drift: same frontmatter, same "## <iso> — <Status>"
 * update format, parsed by the same build-data.mjs.
 *
 * Reusing a slug appends an update to the existing incident rather than
 * starting a new one — during a long outage you post four or five updates to a
 * single incident, and each one replacing the last would destroy the timeline
 * customers use to see it is being worked on.
 *
 * Run: node scripts/post-incident.mjs   (reads SLUG/TITLE/STATUS/MESSAGE/AFFECTS_* from env)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "incidents");

const env = (k, required = true) => {
  const v = (process.env[k] || "").trim();
  if (required && !v) { console.error(`missing input: ${k}`); process.exit(1); }
  return v;
};

const slugRaw = env("SLUG");
const slug = slugRaw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
if (!slug) { console.error(`slug reduced to nothing: ${JSON.stringify(slugRaw)}`); process.exit(1); }

const title = env("TITLE");
const status = env("STATUS").toLowerCase();
const message = env("MESSAGE").replace(/\r/g, "").trim();

const affects = [];
if (env("AFFECTS_WEB", false) === "true") affects.push("web");
if (env("AFFECTS_DB", false) === "true") affects.push("database");

const now = new Date();
// Whole minutes: a status page timeline does not need seconds, and round
// timestamps read as deliberate rather than machine-spat.
now.setUTCSeconds(0, 0);
const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");

const capital = status.charAt(0).toUpperCase() + status.slice(1);
const update = `## ${at} — ${capital}\n\n${message}\n`;
const file = join(DIR, `${slug}.md`);

mkdirSync(DIR, { recursive: true });

if (existsSync(file)) {
  // Append. Frontmatter is rewritten so status and affects reflect the latest
  // post, but startedAt and the existing updates are preserved.
  const text = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) { console.error(`${file} has no frontmatter; refusing to overwrite it`); process.exit(1); }

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  const merged = [
    "---",
    `id: ${meta.id || slug}`,
    `title: ${title}`,
    `affects: [${affects.length ? affects.join(", ") : (meta.affects || "").replace(/^\[|\]$/g, "")}]`,
    `status: ${status}`,
    `startedAt: ${meta.startedAt || at}`,
    "---",
    "",
    update.trim(),
    "",
    m[2].trim(),
    "",
  ].join("\n");

  writeFileSync(file, merged);
  console.log(`appended ${capital} update to incidents/${slug}.md`);
} else {
  const created = [
    "---",
    `id: ${slug}`,
    `title: ${title}`,
    `affects: [${affects.join(", ")}]`,
    `status: ${status}`,
    `startedAt: ${at}`,
    "---",
    "",
    update.trim(),
    "",
  ].join("\n");

  writeFileSync(file, created);
  console.log(`created incidents/${slug}.md (${capital})`);
}

if (!affects.length) {
  console.log("::warning::no affected service ticked — the incident will publish " +
    "without an 'Affects:' line");
}
