// Phase 4H.3 evidence: redundancy diagnostics for the two equivalent mutations (M8, M16) of mutation-check-4h3.ts.
// Each run removes ONE guard of a two-guard pair (expected: survives, because the other guard still holds) or BOTH
// (expected: caught). Same procedure as mutation-check-4h3.ts: edit src/lib/worker-auth-session.ts in place, run the
// lifecycle tests, restore the original bytes (verified by SHA-256). Local only: no network, database or auth service.
// Usage: bun scripts/worker-auth/mutation-redundancy-4h3.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "src/lib/worker-auth-session.ts";
const TESTS = ["src/test/phase4h3-token-cleanup.test.ts", "src/test/worker-auth-session.test.ts"];
const original = readFileSync(FILE, "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGINAL_SHA = sha(original);

const CLEANUP_CLOSE = "    closed = true;\n    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }\n    const access = issued;\n    token = null; issued = null;";
const CLEANUP_ABORT = "    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }\n    const access = issued;";
const CALL_CHECK = "if (closed || !token || tickCtl.signal.aborted) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");";
const REFRESH_GUARD = "if (closed) return false; // the tick ended while refreshing";
const POST_REFRESH = "          if (closed || !token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");";

type Edit = [string, string];
type Run = { id: string; what: string; expect: "SURVIVE" | "CAUGHT"; edits: Edit[] };
const RUNS: Run[] = [
  { id: "R1", what: "M8 pair, guard B only: cleanup no longer aborts the tick signal (closed + token clearing kept)", expect: "SURVIVE",
    edits: [[CLEANUP_ABORT, "    const access = issued;"]] },
  { id: "R2", what: "M8 pair, guard B only: guarded call no longer checks the aborted tick signal (closed + token clearing kept)", expect: "SURVIVE",
    edits: [[CALL_CHECK, "if (closed || !token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");"]] },
  { id: "R3", what: "M8 + R2: cleanup keeps closed/token AND the call ignores the aborted signal (both guards removed)", expect: "CAUGHT",
    edits: [[CLEANUP_CLOSE, CLEANUP_ABORT], [CALL_CHECK, "if (closed || !token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");"]] },
  { id: "R4", what: "M16 pair, guard B only: post-refresh call check ignores closed (refresh guard kept)", expect: "SURVIVE",
    edits: [[POST_REFRESH, "          if (!token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");"]] },
  { id: "R5", what: "M16 + R4 (= M16b): refresh guard removed AND post-refresh check ignores closed (both guards removed)", expect: "CAUGHT",
    edits: [[REFRESH_GUARD, "// removed guard"], [POST_REFRESH, "          if (!token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");"]] },
];

const restore = () => { writeFileSync(FILE, original); };
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });
let asExpected = 0;
try {
  for (const m of RUNS) {
    let mutated = original;
    for (const [a, b] of m.edits) {
      const k = mutated.split(a).length - 1;
      if (k !== 1) throw new Error(`${m.id}: expected exactly one match, found ${k}`);
      mutated = mutated.replace(a, b);
    }
    writeFileSync(FILE, mutated);
    const r = spawnSync("bunx", ["vitest", "run", ...TESTS, "--reporter=json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let failing = "";
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { testResults: { assertionResults: { status: string; title: string }[] }[] };
      failing = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.title)).join(" | ");
    } catch { failing = r.status === 0 ? "" : "(test run failed to report)"; }
    restore();
    const got = r.status !== 0 ? "CAUGHT" : "SURVIVE";
    if (got === m.expect) asExpected++;
    console.log(`${m.id} ${got === "CAUGHT" ? "CAUGHT" : "SURVIVED"} (expected ${m.expect === "CAUGHT" ? "CAUGHT" : "SURVIVED"}) — ${m.what}${failing ? `\n     failing: ${failing}` : ""}`);
  }
} finally { restore(); }
const after = sha(readFileSync(FILE, "utf8"));
console.log(`\nrestored ${FILE}: ${after === ORIGINAL_SHA ? "byte-identical" : "MISMATCH"} (${after})`);
console.log(`as expected ${asExpected}/${RUNS.length}`);
if (after !== ORIGINAL_SHA) process.exit(2);
