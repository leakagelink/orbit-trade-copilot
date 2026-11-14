// Phase 4H.7 mutation check: each mutation removes ONE new protection, runs the tests that should notice, and expects
// them to FAIL. TypeScript mutations edit the file in place and restore the original bytes (verified by SHA-256, also on
// interruption). SQL mutations never touch the draft: the mutated 0057 is written to /tmp and passed to the tests through
// FP_0057_FILE. No network, no live service. Usage: bun scripts/worker-auth/mutation-check-4h7.ts (MUT_ONLY=Q1,I3 …).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const M57 = "docs/proposed-migrations/0057_worker_credential_pin_and_refusal_tally.sql";
const INV = "src/lib/worker-invocation.ts", AUD = "src/lib/worker-refusal-audit.ts", BIND = "src/lib/futures-paper-worker-identity.server.ts", SES = "src/lib/worker-auth-session.ts";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FILES = [M57, INV, AUD, BIND, SES];
const orig = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")])), origSha = new Map(FILES.map((f) => [f, sha(orig.get(f)!)]));
type Mut = { id: string; what: string; file: string; from: string; to: string; tests: string[] };
const CT = ["src/test/phase4h7-credential-0057.test.ts"], IT = ["src/test/phase4h7-invocation.test.ts"], UT = ["src/test/phase4h7-units.test.ts"];
const MUTATIONS: Mut[] = [
  { id: "Q1", file: M57, tests: CT, what: "worker calls do not compare the credential pin", from: `    IF v_pin IS DISTINCT FROM public.fpw_credential_pin(v_uid) THEN\n      RAISE EXCEPTION 'futures paper worker: worker sign-in details changed since registration (an admin must re-register the identity)';\n    END IF;\n`, to: `` },
  { id: "Q2", file: M57, tests: CT, what: "a detected change does not disable the identity (not sticky)", from: `        UPDATE public.futures_paper_worker_identities SET enabled = false, updated_by = v_uid, updated_at = now() WHERE worker_user_id = v_uid AND enabled;`, to: `        PERFORM 1;` },
  { id: "Q3", file: M57, tests: CT, what: "a detected change does not revoke enrollments", from: `WITH r AS (UPDATE public.futures_paper_worker_enrollments SET revoked_at = now() WHERE worker_user_id = v_uid AND revoked_at IS NULL RETURNING account_id, user_id)`, to: `WITH r AS (SELECT account_id, user_id FROM public.futures_paper_worker_enrollments WHERE false)` },
  { id: "Q4", file: M57, tests: CT, what: "sessions created before re-registration are accepted", from: `    IF v_created < v_pinned_at THEN RAISE EXCEPTION 'futures paper worker: worker session predates the current registration'; END IF;\n`, to: `` },
  { id: "Q5", file: M57, tests: CT, what: "the fingerprint ignores the password hash", from: `public.fpw_cp_field(u.encrypted_password::text),`, to: `` },
  { id: "Q6", file: M57, tests: CT, what: "the fingerprint ignores linked sign-in identities", from: `FROM auth.identities i WHERE i.user_id = u.id))`, to: `FROM auth.identities i WHERE i.user_id = u.id AND false))` },
  { id: "Q7", file: M57, tests: CT, what: "refusals above the cap are dropped silently", from: `SET dropped_total = t.dropped_total + 1,`, to: `SET dropped_total = t.dropped_total + 0,` },
  { id: "Q8", file: M57, tests: CT, what: "recorded rows are not counted", from: `SET recorded_total = t.recorded_total + 1,`, to: `SET recorded_total = t.recorded_total + 0,` },
  { id: "Q9", file: M57, tests: CT, what: "the tally counters may decrease", from: ` OR NEW.recorded_total < OLD.recorded_total`, to: `` },
  { id: "Q10", file: M57, tests: CT, what: "0056 can be rolled back under 0057 (no tracked dependency)", from: `LANGUAGE sql BEGIN ATOMIC SELECT public.fpw_api_pre_request(); END;`, to: `LANGUAGE sql AS 'SELECT public.fpw_api_pre_request()';` },
  { id: "Q11", file: M57, tests: CT, what: "re-registration does not re-pin", from: `ON CONFLICT (worker_user_id) DO UPDATE SET pin = EXCLUDED.pin, pinned_at = EXCLUDED.pinned_at, pinned_by = EXCLUDED.pinned_by;`, to: `ON CONFLICT (worker_user_id) DO NOTHING;` },
  { id: "I1", file: INV, tests: UT, what: "limits are not checked against the scheduler limit", from: `  if (l.budgetMs + l.safetyMarginMs > schedulerLimitMs) return { ok: false, code: "EXCEEDS_SCHEDULER_LIMIT" };`, to: `` },
  { id: "I2", file: INV, tests: UT, what: "a full step need not fit the budget", from: `  if (fit.worstEntryStepMs > l.budgetMs) return { ok: false, code: "STEP_DOES_NOT_FIT_BUDGET" };`, to: `` },
  { id: "I3", file: INV, tests: UT, what: "an uncertain invocation is reported CAUGHT_UP", from: `if (caughtUp && reasons.length === 0)`, to: `if (caughtUp)` },
  { id: "I4", file: INV, tests: UT, what: "PROGRESS is reported as completed", from: `return { status: "PROGRESS", completed: false,`, to: `return { status: "PROGRESS", completed: true,` },
  { id: "I5", file: INV, tests: UT, what: "a port call starts without budget", from: `  if (!(o.now() + o.timeoutMs <= o.deadlineAt)) throw new InvocationRefusal("BUDGET");`, to: `` },
  { id: "I6", file: INV, tests: UT, what: "a pending email change is accepted", from: `    if (typeof pend === "string" && pend.length > 0) return "EMAIL_CHANGE_PENDING";`, to: `` },
  { id: "B1", file: BIND, tests: IT, what: "the invocation ignores maxCandles", from: `maxCandlesPerAccount: L.maxCandles,`, to: `maxCandlesPerAccount: 30,` },
  { id: "B2", file: BIND, tests: IT, what: "the session budget is not the invocation budget", from: `limits: { tickBudgetMs: L.budgetMs,`, to: `limits: { tickBudgetMs: 60_000,` },
  { id: "B3", file: BIND, tests: IT, what: "the server-side user check is not passed to the session", from: `    verifyUser: workerUserCheck(email),\n`, to: `` },
  { id: "B4", file: BIND, tests: IT, what: "each call gets the old 8 s limit", from: `hosted: { timeoutMs: L.rpcTimeoutMs, leaseTtlSeconds: L.leaseTtlSeconds },`, to: `hosted: { timeoutMs: 8_000, leaseTtlSeconds: L.leaseTtlSeconds },` },
  { id: "S1", file: SES, tests: UT, what: "the session ignores the user check at sign-in", from: `    if (ur !== null) { rec({ code: "TOKEN_USER_REFUSED", detail: ur }); return {}; } // a session exists: signed out in finally`, to: `    void ur;` },
  { id: "A1", file: AUD, tests: UT, what: "cap drops are not used to explain unmatched refusals", from: `const explained = Math.min(unmatchedA, dropped);`, to: `const explained = 0 * dropped;` },
  { id: "A2", file: AUD, tests: UT, what: "deleted rows are not reported", from: `    if (diff > 0) findings.push({ code: "ROWS_DELETED", count: diff });`, to: `` },
  { id: "A3", file: AUD, tests: UT, what: "a request-hook refusal is filed as a database record", from: `return pg === "PGRST301" ? "TOKEN_REJECTED" : "REFUSED_AT_BOUNDARY";`, to: `return pg === "PGRST301" ? "TOKEN_REJECTED" : "REFUSED_IN_DB";` },
];
const dir = mkdtempSync(join(tmpdir(), "mut4h7-"));
const restoreAll = () => { for (const f of [INV, AUD, BIND, SES]) { writeFileSync(f, orig.get(f)!); if (sha(readFileSync(f, "utf8")) !== origSha.get(f)) throw new Error(`restore failed: ${f}`); } };
process.on("SIGINT", () => { restoreAll(); process.exit(130); });
const results: { id: string; what: string; detected: boolean | null; note?: string }[] = [];
try {
  const only = process.env["MUT_ONLY"]?.split(",");
  for (const m of MUTATIONS.filter((x) => !only || only.includes(x.id))) {
    const src = orig.get(m.file)!;
    if (src.split(m.from).length !== 2) { results.push({ id: m.id, what: m.what, detected: null, note: "pattern not found exactly once" }); continue; }
    const mutated = src.replace(m.from, m.to), env: NodeJS.ProcessEnv = { ...process.env };
    if (m.file === M57) { const f = join(dir, `${m.id}.sql`); writeFileSync(f, mutated); env["FP_0057_FILE"] = f; } else writeFileSync(m.file, mutated);
    const r = spawnSync("bunx", ["vitest", "run", "--no-file-parallelism", ...m.tests], { env, encoding: "utf8", timeout: 600_000 });
    if (m.file !== M57) restoreAll();
    results.push({ id: m.id, what: m.what, detected: r.status !== 0 });
    console.log(`${m.id}\t${r.status !== 0 ? "DETECTED" : "SURVIVED"}\t${m.what}`);
  }
} finally { restoreAll(); }
for (const f of FILES) if (sha(readFileSync(f, "utf8")) !== origSha.get(f)) throw new Error(`${f} changed`);
const run = results.filter((r) => r.detected !== null);
for (const r of results.filter((x) => x.detected === null)) console.log(`${r.id}\tNOT RUN\t${r.what} (${r.note})`);
console.log(`detected ${run.filter((r) => r.detected).length}/${run.length} run; ${results.length - run.length} not run; all files restored (SHA-256 verified)`);
