// Phase 4H.3 mutation check for the worker token cleanup. Each mutation edits src/lib/worker-auth-session.ts in place,
// runs the lifecycle tests, and restores the original bytes (verified by SHA-256) — even if the run is interrupted.
// Local only: no network, no database, no auth service. Usage: bun scripts/worker-auth/mutation-check-4h3.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "src/lib/worker-auth-session.ts";
const TESTS = ["src/test/phase4h3-token-cleanup.test.ts", "src/test/worker-auth-session.test.ts"];
const original = readFileSync(FILE, "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGINAL_SHA = sha(original);

type Mutation = { id: string; what: string; from: string; to: string; also?: [string, string][] };
const MUTATIONS: Mutation[] = [
  { id: "M1", what: "skip sign-out after an unexpected exception (the 4H.2 cleanup gap)",
    from: "if (access !== null) signOut = await signOutOnce(access);", to: "if (access !== null && internalError === null) signOut = await signOutOnce(access);" },
  { id: "M2", what: "let unexpected exceptions escape instead of being caught by the outer structure",
    from: "catch { internal(stage); run = {}; }", to: "catch (e) { throw e; }" },
  { id: "M3", what: "only remember the token after validation passed (no sign-out for refused or faulting validation)",
    from: "issued = typeof rawAccess === \"string\" && rawAccess.length <= 8192 && JWT.test(rawAccess) ? rawAccess : null;", to: "issued = null;" },
  { id: "M4", what: "remove the refresh exception handler",
    from: "internal(\"REFRESH\"); rec({ code: \"TOKEN_REFRESH_FAILED\", detail: \"EXCEPTION\" }); closed = true; return false;", to: "throw new Error(\"refresh\");" },
  { id: "M5", what: "count 401/403/404 logout replies as signed out (claims termination without proof)",
    from: "if (typeof s === \"number\" && s >= 200 && s <= 299) status = \"SIGNED_OUT\";", to: "if (typeof s === \"number\" && ((s >= 200 && s <= 299) || s === 401 || s === 403 || s === 404)) status = \"SIGNED_OUT\";" },
  { id: "M6", what: "let a cleanup failure replace the original outcome",
    from: "outcome: firstFailure ?? \"TICK_COMPLETED\", signedIn,", to: "outcome: signOut === \"SIGN_OUT_FAILED\" ? \"SIGN_OUT_FAILED\" : (firstFailure ?? \"TICK_COMPLETED\"), signedIn," },
  { id: "M7", what: "retry a failed sign-out once",
    from: "if (access !== null) signOut = await signOutOnce(access);", to: "if (access !== null) { signOut = await signOutOnce(access); if (signOut !== \"SIGNED_OUT\") signOut = await signOutOnce(access); }" },
  { id: "M8", what: "do not close the session or forget the token at cleanup",
    from: "    closed = true;\n    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }\n    const access = issued;\n    token = null; issued = null;", to: "    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }\n    const access = issued;" },
  { id: "M8b", what: "do not close, abort or forget the session at cleanup (all three layers removed)",
    from: "    closed = true;\n    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }\n    const access = issued;\n    token = null; issued = null;", to: "    const access = issued;" },
  { id: "M9", what: "let a monitor exception escape",
    from: "} catch { monitorFailures++; /* monitoring never blocks or fails the tick */ }", to: "} catch (e) { throw e; }" },
  { id: "M10", what: "make the user object optional again (4H.2 behaviour)",
    from: "if (!isPlainObject(user) || typeof user[\"id\"] !== \"string\" || !UUID.test(user[\"id\"])) return { ok: false, code: \"AUTH_MALFORMED_REPLY\", detail: \"USER\" };\n  if (!UUID.test(c.sub) || user[\"id\"].toLowerCase() !== c.sub.toLowerCase())",
    to: "if (!UUID.test(c.sub) || (isPlainObject(user) && typeof user[\"id\"] === \"string\" && user[\"id\"] !== c.sub))" },
  { id: "M11", what: "make the expected worker identity optional again (4H.2 behaviour)",
    from: "if (typeof o.expectedSub !== \"string\" || !UUID.test(o.expectedSub) || c.sub.toLowerCase() !== o.expectedSub.toLowerCase()) return",
    to: "if (o.expectedSub && c.sub !== o.expectedSub) return" },
  { id: "M12", what: "accept a missing expected identity in the configuration",
    from: "if (!L || !expected) {", to: "if (!L) {" },
  { id: "M13", what: "accept anonymous sessions",
    from: "if (c.anonymous || user[\"is_anonymous\"] === true) return", to: "if (false) return" },
  { id: "M14", what: "no fallback timer for sign-out when the injected timers fail",
    from: "catch { globalTimer = true; h = globalThis.setTimeout(fire, ms); }", to: "catch { throw new Error(\"timer\"); }" },
  { id: "M15", what: "arm the body deadline inside a Promise executor (body runs without a deadline when timers fail)",
    from: "    let late: (v: { late: true }) => void = () => {};\n    const stop = new Promise<{ late: true }>((r) => { late = r; });\n    const h = timers.setTimeout(() => late({ late: true }), Math.max(1, bodyEnd - now()));",
    to: "    let h: unknown;\n    const stop = new Promise<{ late: true }>((r) => { h = timers.setTimeout(() => r({ late: true }), Math.max(1, bodyEnd - now())); });" },
  { id: "M16", what: "store a refresh that completes after cleanup started",
    from: "if (closed) return false; // the tick ended while refreshing", to: "// removed guard" },
  { id: "M16b", what: "store a late refresh AND drop the post-refresh closed check in the guarded call",
    from: "if (closed) return false; // the tick ended while refreshing", to: "// removed guard",
    also: [["          if (closed || !token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");", "          if (!token) return refuse(\"CALL_REFUSED_SESSION_CLOSED\");"]] },
  { id: "M17", what: "keep recording after the result was returned",
    from: "if (sealed) return; // nothing", to: "// removed seal; nothing" },
];

const results: { id: string; what: string; caught: boolean; failing: string }[] = [];
const restore = () => { writeFileSync(FILE, original); };
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });
try {
  for (const m of MUTATIONS) {
    const n = original.split(m.from).length - 1;
    if (n !== 1) throw new Error(`${m.id}: expected exactly one match, found ${n}`);
    let mutated = original.replace(m.from, m.to);
    for (const [a, b] of m.also ?? []) {
      const k = mutated.split(a).length - 1;
      if (k !== 1) throw new Error(`${m.id}: expected exactly one match for an extra edit, found ${k}`);
      mutated = mutated.replace(a, b);
    }
    writeFileSync(FILE, mutated);
    const r = spawnSync("bunx", ["vitest", "run", ...TESTS, "--reporter=json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let failing = "";
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { testResults: { assertionResults: { status: string; title: string }[] }[] };
      failing = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.title)).join(" | ");
    } catch { failing = r.status === 0 ? "" : "(test run failed to report)"; }
    results.push({ id: m.id, what: m.what, caught: r.status !== 0, failing });
    restore();
    console.log(`${m.id} ${r.status !== 0 ? "CAUGHT" : "SURVIVED"} — ${m.what}${failing ? `\n     failing: ${failing}` : ""}`);
  }
} finally { restore(); }
const after = sha(readFileSync(FILE, "utf8"));
console.log(`\nrestored ${FILE}: ${after === ORIGINAL_SHA ? "byte-identical" : "MISMATCH"} (${after})`);
console.log(`caught ${results.filter((r) => r.caught).length}/${results.length}`);
if (after !== ORIGINAL_SHA) process.exit(2);
