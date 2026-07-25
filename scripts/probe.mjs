/* Checks each service and folds the result into data/history.json.
 *
 * A single failed request is never an outage: each check retries, and it takes
 * several consecutive failed cycles to report down.
 *
 * Response bodies are never logged. This repository is public, and anything
 * echoed into a run log is a permanent public artefact — only status codes are
 * recorded.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = JSON.parse(readFileSync(join(ROOT, "probe-contract.json"), "utf8"));
const HISTORY_PATH = join(ROOT, "data", "history.json");

const P = CONTRACT.policy;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Resolves a secret name from the environment. The contract only ever names a
   secret; it never carries a value. If the secret is missing we record a
   failure rather than probing without auth, because an unauthenticated 401
   would look identical to a real outage. */
function secretValue(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

function buildHeaders(probe) {
  const headers = { accept: "application/json" };
  for (const h of probe.secretHeaders || []) {
    const value = secretValue(h.secret);
    headers[h.header] = (h.valuePrefix || "") + value;
  }
  return headers;
}

/* One attempt. Returns {ok, status} and never throws for a network error —
   an unreachable host is a legitimate probe result, not a crash. */
async function attempt(probe) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), P.requestTimeoutMs);
  try {
    const res = await fetch(probe.url, {
      method: probe.method,
      headers: buildHeaders(probe),
      redirect: P.followRedirects ? "follow" : "manual",
      signal: controller.signal,
    });

    if (!probe.expect.status.includes(res.status)) {
      return { ok: false, status: res.status, reason: "status" };
    }
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes(probe.expect.contentTypeIncludes)) {
      return { ok: false, status: res.status, reason: "content-type" };
    }
    if (probe.expect.jsonBodyMatches) {
      const body = await res.json();
      for (const [k, v] of Object.entries(probe.expect.jsonBodyMatches)) {
        if (body[k] !== v) return { ok: false, status: res.status, reason: "body" };
      }
    }
    return { ok: true, status: res.status };
  } catch (e) {
    // e.message can contain the URL but never a secret; still, only the class
    // of failure is recorded, not the message.
    return { ok: false, status: 0, reason: e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/* A probe URL may be written as ${NAME} so it can be supplied from the
   environment instead of committed. This repository is public and a URL names
   the infrastructure behind it, so anything more specific than a public
   marketing hostname is kept out of the tree. */
function resolveUrl(url) {
  return url.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`missing ${name}`);
    return v;
  });
}

async function probeService(service) {
  /* Checked before the first request, not inside it. attempt() deliberately
     swallows every throw so a network error reads as a probe result — which
     means a missing value raised in there would be miscounted as the service
     failing. Fail fast, out here, where the caller can tell the difference. */
  for (const h of service.probe.secretHeaders || []) {
    if (!process.env[h.secret]) throw new Error(`missing secret ${h.secret}`);
  }
  const probe = { ...service.probe, url: resolveUrl(service.probe.url) };

  for (let i = 0; i < P.attemptsPerProbe; i++) {
    const r = await attempt(probe);
    if (r.ok) return { ok: true, status: r.status, attempts: i + 1 };
    if (i < P.attemptsPerProbe - 1) await sleep(P.retryBackoffMs);
  }
  return { ok: false, attempts: P.attemptsPerProbe };
}

function emptyHistory() {
  return {
    version: 1,
    services: Object.fromEntries(
      CONTRACT.services.map((s) => [s.id, {
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        state: "unknown",
        days: {},
      }]),
    ),
    lastCheckedAt: null,
  };
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return emptyHistory();
  try {
    const h = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
    // Backfill any service added to the contract since the last run.
    for (const s of CONTRACT.services) {
      if (!h.services[s.id]) {
        h.services[s.id] = { consecutiveFailures: 0, consecutiveSuccesses: 0, state: "unknown", days: {} };
      }
    }
    return h;
  } catch {
    // A corrupt history is not a reason to report an outage. Start clean and
    // let the days rebuild; the page will show unknown until they do.
    return emptyHistory();
  }
}

/* Day state is derived from the day's own counters, per the contract:
   down    = at least one run of failuresBeforeDown consecutive failures
   degraded= at least one failure, but never that many in a row
   operational = at least one probe, zero failures */
function dayState(day) {
  if (!day || day.recordedProbes === 0) return "unknown";
  if (day.maxConsecutiveFailures >= P.failuresBeforeDown) return "down";
  if (day.recordedProbes > day.successfulProbes) return "degraded";
  return "operational";
}

function prune(days) {
  const cutoff = new Date(Date.now() - P.historyWindowDays * 86400000)
    .toISOString().slice(0, 10);
  for (const date of Object.keys(days)) {
    if (date < cutoff) delete days[date];
  }
}

async function main() {
  const history = loadHistory();
  const now = new Date();
  let probeFaults = 0;
  const today = now.toISOString().slice(0, 10); // dayBoundary: UTC

  for (const service of CONTRACT.services) {
    const rec = history.services[service.id];
    let result;
    try {
      result = await probeService(service);
    } catch (e) {
      /* The probe could not be *attempted* — a missing secret, a malformed
         contract. That is evidence about this repository's configuration, not
         about the service, so it must not count as a failure: three of these
         in a row would otherwise publish "Down" and open an incident for a
         service that is perfectly healthy. Record nothing, hold the day's
         counters, and make the run shout. */
      console.error(`::error::[${service.id}] probe could not run: ${e.message}. ` +
        `Recording no result — this is a configuration fault, not an outage.`);
      rec.state = "unknown";
      rec.consecutiveFailures = 0;
      rec.consecutiveSuccesses = 0;
      probeFaults += 1;
      continue;
    }

    if (result.ok) {
      rec.consecutiveSuccesses += 1;
      rec.consecutiveFailures = 0;
    } else {
      rec.consecutiveFailures += 1;
      rec.consecutiveSuccesses = 0;
    }

    /* State only flips after the contract's thresholds. Note the asymmetry:
       going down takes failuresBeforeDown, coming back takes
       successesBeforeUp. Recovering faster than we fail would make a flapping
       service look healthy. */
    if (rec.consecutiveFailures >= P.failuresBeforeDown) rec.state = "down";
    else if (rec.consecutiveSuccesses >= P.successesBeforeUp) rec.state = "operational";
    else if (rec.state === "unknown" && result.ok) rec.state = "operational";

    const day = rec.days[today] || {
      recordedProbes: 0, successfulProbes: 0,
      maxConsecutiveFailures: 0, runningFailures: 0,
    };
    day.recordedProbes += 1;
    if (result.ok) {
      day.successfulProbes += 1;
      day.runningFailures = 0;
    } else {
      day.runningFailures += 1;
      day.maxConsecutiveFailures = Math.max(day.maxConsecutiveFailures, day.runningFailures);
    }
    rec.days[today] = day;
    prune(rec.days);

    console.log(`[${service.id}] ${result.ok ? "ok" : "FAIL"} ` +
      `attempts=${result.attempts} state=${rec.state} ` +
      `consecFail=${rec.consecutiveFailures} consecOk=${rec.consecutiveSuccesses}`);
  }

  /* lastCheckedAt is only advanced if every probe actually ran. If one could
     not, the snapshot must go stale and the page must fall to Unknown rather
     than presenting a partial reading as a complete one. */
  if (probeFaults === 0) {
    history.lastCheckedAt = now.toISOString();
  } else {
    console.error(`::error::${probeFaults} probe(s) could not run; leaving ` +
      `lastCheckedAt at ${history.lastCheckedAt} so the page reports Unknown.`);
  }
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`wrote ${HISTORY_PATH}`);
}

export { dayState };
main();
