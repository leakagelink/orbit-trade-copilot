// Phase 4H.5 mutation check: each mutation removes ONE new protection, runs the tests that should notice, and expects
// them to FAIL. Session mutations edit src/lib/worker-auth-session.ts in place and restore the original bytes
// (verified by SHA-256, also on interruption). SQL mutations never touch the drafts: the mutated 0055 is written to /tmp
// and passed to the tests through FP_0055_FILE. PG mutations run only when FUTURES_PAPER_PG_URL points at a THROWAWAY
// local server (scripts/futures-paper/concurrency-check-4h5.sh with MUTATIONS=1). No network, no live service.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SESSION = "src/lib/worker-auth-session.ts", M55 = "docs/proposed-migrations/0055_futures_paper_worker_security_remediation.sql";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const original = readFileSync(SESSION, "utf8"), ORIGINAL_SHA = sha(original), m55 = readFileSync(M55, "utf8"), M55_SHA = sha(m55);
const PG = process.env["FUTURES_PAPER_PG_URL"];
if (PG && !/^postgres:\/\/postgres@127\.0\.0\.1:\d+\//.test(PG)) throw new Error("throwaway local PostgreSQL only");
type Mut = { id: string; what: string; target: "session" | "sql"; from: string; to: string; tests: string[]; pg?: boolean };
const ST = ["src/test/phase4h5-session.test.ts"], MT = ["src/test/phase4h5-migration-0055.test.ts"], PT = ["src/test/phase4h5-worker-security.pg.test.ts"];
const MUTATIONS: Mut[] = [
  { id: "S1", target: "session", tests: ST, what: "ignore a timer fault and send the call without its own limit", from: `catch { closed = true; return refuse("CALL_REFUSED_TIMER"); }`, to: `catch { h = null; }` },
  { id: "S2", target: "session", tests: ST, what: "give the transport the caller's signal instead of the combined one", from: `o.data(target, args, access, own.signal)`, to: `o.data(target, args, access, signal)` },
  { id: "S3", target: "session", tests: ST, what: "do not cancel in-flight calls at the end of the tick", from: `if (tickCtl.signal.aborted) onTick(); else tickCtl.signal.addEventListener("abort", onTick, { once: true });`, to: `void onTick;` },
  { id: "S4", target: "session", tests: ST, what: "no platform backup timer for injected timers", from: `const backstop: Timers | null = o.timers ? platformTimers : null;`, to: `const backstop: Timers | null = null;` },
  { id: "S5", target: "session", tests: ST, what: "send an identical in-flight request again", from: `if (same) { rec({ code: "CALL_COALESCED" }); return same; }`, to: `void same;` },
  { id: "S6", target: "session", tests: ST, what: "no limit on requests in flight", from: `if (inFlight.size >= SESSION_GUARDS.maxInFlight) return refuse("CALL_REFUSED_IN_FLIGHT_LIMIT");`, to: `` },
  { id: "S7", target: "session", tests: ST, what: "use the late reply after cancellation", from: `if ("cancelled" in r) {`, to: `if ("cancelled" in r && false) {` },
  { id: "S8", target: "session", tests: ST, what: "accept a token without a session id", from: `if (c.sid === null || !UUID.test(c.sid)) return`, to: `if (false) return` },
  { id: "S9", target: "session", tests: ST, what: "accept a refresh that changes the session id", from: `if (o.expectedSid != null && c.sid.toLowerCase() !== o.expectedSid.toLowerCase()) return`, to: `if (false) return` },
  { id: "S10", target: "session", tests: ST, what: "accept a stale token", from: `- o.maxClockSkewMs) return { ok: false, code: "TOKEN_STALE" };`, to: `- o.maxClockSkewMs && false) return { ok: false, code: "TOKEN_STALE" };` },
  { id: "S11", target: "session", tests: ST, what: "do not report the residual token lifetime after a failed sign-out", from: `residualTokenUntil: signOut === "SIGN_OUT_FAILED" ? residualTokenUntil : null,`, to: `residualTokenUntil: null,` },
  { id: "Q1", target: "sql", tests: MT, what: "no role guard for registered worker identities", from: `IF NEW.role::text IN ('admin', 'super_admin') THEN`, to: `IF false THEN` },
  { id: "Q2", target: "sql", tests: MT, what: "no account-ownership guard", from: `RAISE EXCEPTION 'futures paper worker identity: a registered worker identity cannot own a Futures paper account'`, to: `RAISE NOTICE 'futures paper worker identity: a registered worker identity cannot own a Futures paper account'` },
  { id: "Q3", target: "sql", tests: MT, what: "accept a signed-out (unknown) session", from: `IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (signed out or unknown)'; END IF;`, to: `` },
  { id: "Q4", target: "sql", tests: MT, what: "no maximum session age", from: `IF v_created IS NULL OR v_created < clock_timestamp() - public.fpw_worker_session_max_age() THEN`, to: `IF false THEN` },
  { id: "Q5", target: "sql", tests: MT, what: "no session id required", from: `IF v_sid IS NULL OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN`, to: `IF v_sid IS NOT NULL AND v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN` },
  { id: "Q6", target: "sql", tests: MT, what: "refused acquire not recorded", from: `PERFORM public.fpw_record_refusal('acquire_lease', p_account, v_state, v_msg);`, to: `NULL;` },
  { id: "Q7", target: "sql", tests: MT, what: "account_mfa_allowed() without the worker condition", from: `AND NOT EXISTS(SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id=auth.uid()) AND NOT EXISTS(SELECT 1 FROM public.workspace_sessions`, to: `AND NOT EXISTS(SELECT 1 FROM public.workspace_sessions` },
  { id: "Q8", target: "sql", tests: MT, what: "no restrictive worker guard on tables", from: `EXECUTE format('CREATE POLICY fpw_worker_identity_guard`, to: `PERFORM format('CREATE POLICY fpw_worker_identity_guard` },
  { id: "Q9", target: "sql", tests: MT, what: "checkpoint hash skips a column (code) of the worker audit", from: `public.fpw_cp_field(user_id::text), public.fpw_cp_field(code),`, to: `public.fpw_cp_field(user_id::text),` },
  { id: "Q10", target: "sql", tests: MT, what: "old 0053/0054 wrappers stay reachable", from: `    public.fpw_id_mark_review(uuid, uuid, bigint, text) FROM authenticated;`, to: `    public.fpw_id_mark_review(uuid, uuid, bigint, text) FROM anon;` },
  { id: "Q11", target: "sql", tests: MT, what: "checkpoints open to any signed-in user", from: `IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper audit checkpoint: admin only'; END IF;`, to: `` },
  { id: "P1", target: "sql", tests: PT, pg: true, what: "worker calls do not hold the shared identity lock", from: `IF p_lock THEN PERFORM pg_advisory_xact_lock_shared(public.fpw_identity_lock_key(v_uid)); END IF;`, to: `` },
  { id: "P2", target: "sql", tests: PT, pg: true, what: "worker reads take no row locks (snapshot)", from: `      PERFORM public.fpw_id_check(p_account, true);\n      v := public.fpw_id_snapshot(p_account, p_holder, p_fence);`, to: `      v := public.fpw_id_snapshot(p_account, p_holder, p_fence);` },
  { id: "P3", target: "sql", tests: PT, pg: true, what: "registration does not take the identity lock (write skew with promotion)", from: `    PERFORM pg_advisory_xact_lock(public.fpw_identity_lock_key(p_worker));  -- 0055: serializes with promotion, account creation and worker calls`, to: `` },
];
const dir = mkdtempSync(join(tmpdir(), "mut4h5-"));
const restore = () => { writeFileSync(SESSION, original); if (sha(readFileSync(SESSION, "utf8")) !== ORIGINAL_SHA) throw new Error("restore failed"); };
process.on("SIGINT", () => { restore(); process.exit(130); });
const results: { id: string; what: string; detected: boolean | null; note?: string }[] = [];
try {
  const only = process.env["MUT_ONLY"]?.split(",");
  for (const m of MUTATIONS.filter((x) => !only || only.includes(x.id))) {
    if (m.pg && !PG) { results.push({ id: m.id, what: m.what, detected: null, note: "PG mutation skipped (no throwaway server)" }); continue; }
    const src = m.target === "session" ? original : m55;
    if (src.split(m.from).length !== 2) { results.push({ id: m.id, what: m.what, detected: null, note: "pattern not found exactly once" }); continue; }
    const mutated = src.replace(m.from, m.to);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (m.target === "session") writeFileSync(SESSION, mutated); else { const f = join(dir, `${m.id}.sql`); writeFileSync(f, mutated); env["FP_0055_FILE"] = f; }
    const r = spawnSync("bunx", ["vitest", "run", "--no-file-parallelism", ...m.tests], { env, encoding: "utf8", timeout: 600_000 });
    if (m.target === "session") restore();
    results.push({ id: m.id, what: m.what, detected: r.status !== 0 });
  }
} finally { restore(); }
if (sha(readFileSync(M55, "utf8")) !== M55_SHA) throw new Error("draft 0055 changed");
for (const r of results) console.log(`${r.id}\t${r.detected === null ? "NOT RUN" : r.detected ? "DETECTED" : "SURVIVED"}\t${r.what}${r.note ? ` (${r.note})` : ""}`);
const run = results.filter((r) => r.detected !== null);
console.log(`detected ${run.filter((r) => r.detected).length}/${run.length} run; ${results.length - run.length} not run`);
