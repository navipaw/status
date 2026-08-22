/* Publish guard.
 *
 * Everything in incidents/ becomes a public web page, so this fails the build
 * on the categories of leak that are mechanically detectable: credential
 * material, stack traces, internal hosts, and raw log lines.
 *
 * It is a backstop and nothing more. It cannot tell whether prose names a
 * customer or blames a vendor — that is what review is for. The README says so
 * too, deliberately, so nobody treats a green check as a reading.
 *
 * Run: node scripts/check-sanitisation.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = JSON.parse(readFileSync(join(ROOT, "probe-contract.json"), "utf8"));
const INCIDENT_DIR = join(ROOT, "incidents");

/* Matched by shape, not by real variable name: a list of actual credential
   names would itself be an inventory worth publishing nowhere. */
const CREDENTIAL_PATTERNS = CONTRACT.forbiddenSecretPatterns || [
  "SERVICE_ROLE", "SECRET_KEY", "WEBHOOK_SECRET", "AUTH_TOKEN", "API_KEY", "_SECRET",
];

const RULES = [
  { name: "key material (JWT)", re: /eyJ[A-Za-z0-9_-]{10,}/ },
  { name: "key material (sb_ prefix)", re: /sb_(publishable|secret)_[A-Za-z0-9_-]+/ },
  { name: "key material (sk/pk/rk)", re: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{10,}/ },
  { name: "stack trace", re: /^\s*at\s+\S+\s+\(.*:\d+:\d+\)/m },
  { name: "database error code", re: /\bSQLSTATE\b|\b5\d{4}\b:\s/ },
  { name: "internal hostname", re: /\b[a-z0-9-]+\.(internal|local|cluster\.local)\b/i },
  { name: "private IP address", re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  // Incident prose only, and deliberately still here now that probe-contract.json
  // carries the ref as a committed literal. Naming the backend in a write-up of
  // what broke is a different act from the contract recording what it measures:
  // one is an aside in customer-facing copy, the other is the definition of the
  // check. Do not "resolve the inconsistency" by deleting this.
  { name: "backend project ref in prose", re: /\b[a-z]{20}\.[a-z]+\.co\b/ },
  { name: "email address", re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/ },
];

function checkText(name, text) {
  const problems = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) problems.push(`${rule.name} — matched ${JSON.stringify(m[0].slice(0, 40))}`);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Assignment, not mention: naming a credential to say "we never store it"
    // is fine; giving it a value is not. The name is matched as a fragment of a
    // wider identifier, so FOO_SECRET_KEY trips the SECRET_KEY pattern.
    const name = `[A-Z0-9_]*${pattern}[A-Z0-9_]*`;
    if (new RegExp(`"${name}"\\s*:\\s*"[^"]+"`).test(text) ||
        new RegExp(`\\b${name}\\b\\s*[=:]\\s*["']?\\S`).test(text)) {
      problems.push(`credential assignment matching ${pattern}`);
    }
  }
  return problems;
}

function main() {
  if (!existsSync(INCIDENT_DIR)) {
    console.log("no incidents/ directory — nothing to check");
    return;
  }
  const files = readdirSync(INCIDENT_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  let failed = 0;

  for (const f of files) {
    const text = readFileSync(join(INCIDENT_DIR, f), "utf8");
    // The template carries deliberate placeholders; skip its example prose.
    const problems = f === "TEMPLATE.md" ? [] : checkText(f, text);
    if (problems.length) {
      failed += problems.length;
      console.error(`✗ incidents/${f}`);
      problems.forEach((p) => console.error(`    ${p}`));
    } else {
      console.log(`✓ incidents/${f}`);
    }
  }

  if (failed) {
    console.error(`\n${failed} problem(s) found. These files publish to a public ` +
      `page — fix them before this can go out.`);
    process.exit(1);
  }
  console.log(`\n${files.length} file(s) checked, no mechanical leaks found. ` +
    `This does not replace reading what you wrote.`);
}

main();
