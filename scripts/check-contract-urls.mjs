/* Every probe URL is committed, in this repository, as a literal.
 *
 * A URL supplied from the environment cannot appear in a diff, so a change to
 * what is probed leaves no trace anywhere: not here, not in a review, not in
 * the run log. The database probe once spent nine days asking for an object
 * that no longer existed, and the page read partial outage the whole time
 * while every run went green.
 *
 * A URL is not a credential. A hostname and a path say what this service
 * measures, which is the one thing a status page exists to publish. The key
 * beside it stays a secret, named in the contract and never committed —
 * check-sanitisation.mjs is what enforces that half.
 *
 * Run: node scripts/check-contract-urls.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = JSON.parse(readFileSync(join(ROOT, "probe-contract.json"), "utf8"));

const problems = [];
let checked = 0;

for (const service of CONTRACT.services || []) {
  const url = service?.probe?.url;
  checked += 1;

  if (typeof url !== "string" || url === "") {
    problems.push(`${service?.id}: probe has no URL`);
    continue;
  }
  if (/\$\{[A-Z0-9_]+\}/.test(url)) {
    problems.push(`${service.id}: probe URL is resolved from the environment (${url}) — commit it instead`);
    continue;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") problems.push(`${service.id}: probe URL is not https (${url})`);
  } catch {
    problems.push(`${service.id}: probe URL does not parse (${url})`);
  }
}

if (problems.length) {
  problems.forEach((p) => console.error(`✗ ${p}`));
  console.error(`\n${problems.length} problem(s) in ${checked} probe URL(s).`);
  process.exit(1);
}
console.log(`${checked} probe URL(s) checked, all committed literals over https.`);
