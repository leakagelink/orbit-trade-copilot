// Phase 4H.7 — pure units: invocation limits/fit, account choice, bounded port calls, strict classification, the
// server-side sign-in user check (and its wiring in the session module), and refusal-audit categories/reconciliation.
import { describe, expect, it } from "vitest";
import { MEASURED_SCHEDULER_LIMIT_MS, PROPOSED_INVOCATION_LIMITS, InvocationRefusal, boundedCall, classifyInvocation, pickAccount, validateInvocationLimits, workerUserCheck } from "@/lib/worker-invocation";
import { CATEGORY_OF, createJournal, kindOfHostedMetric, reconcileRefusals, type JournalEvent } from "@/lib/worker-refusal-audit";
import { runWithWorkerSession, type DataTransport } from "@/lib/worker-auth-session";
import { WORKER, fakeAuth, issued, noContent, ok } from "./helpers/fake-auth";

const L = { ...PROPOSED_INVOCATION_LIMITS };
describe("invocation limits", () => {
  it("the proposal fits the measured 5,000 ms limit with its margin, and one full step fits the budget at every call's own limit", () => {
    const r = validateInvocationLimits(L);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(MEASURED_SCHEDULER_LIMIT_MS).toBe(5_000);
    expect(L.budgetMs + L.safetyMarginMs).toBeLessThanOrEqual(5_000);
    expect(r.fit.worstEntryStepMs).toBe(600 + 4 * 450 + 600 + 200 + 400);
    expect(r.fit.worstEntryStepMs).toBeLessThanOrEqual(L.budgetMs);
    expect(r.fit.headroomMs).toBe(200);
  });
  it("refuses: over the scheduler limit, a step that cannot fit, the old 8 s call limit, lease too short/long, junk", () => {
    const code = (x: Record<string, unknown>) => { const r = validateInvocationLimits({ ...L, ...x } as never); return r.ok ? "OK" : r.code; };
    expect(code({ budgetMs: 3_900 })).toBe("EXCEEDS_SCHEDULER_LIMIT");
    expect(code({ rpcTimeoutMs: 8_000 })).toBe("STEP_DOES_NOT_FIT_BUDGET");
    expect(code({ rpcTimeoutMs: 500 })).toBe("STEP_DOES_NOT_FIT_BUDGET");
    expect(code({ leaseTtlSeconds: 3 })).toBe("LEASE_TTL_OUT_OF_RANGE");
    expect(code({ leaseTtlSeconds: 60 })).toBe("LEASE_OUTLIVES_SLOT");
    expect(code({ budgetMs: 1.5 })).toBe("NOT_POSITIVE_BUDGETMS");
    expect(validateInvocationLimits(null as never)).toEqual({ ok: false, code: "LIMITS_MISSING" });
    // The Phase 4H.2 session defaults (auth 3 s + call 8 s + sign-out 2 s) can never fit.
    expect(code({ authTimeoutMs: 3_000, rpcTimeoutMs: 8_000, signOutTimeoutMs: 2_000 })).toBe("STEP_DOES_NOT_FIT_BUDGET");
  });
  it("account choice is deterministic per slot (overlapping invocations collide on the lease) and rotates across slots", () => {
    const a = ["b", "a", "c", "a"];
    expect(pickAccount(a, 0, 60_000)).toBe("a");
    expect(pickAccount(a, 59_999, 60_000)).toBe("a");
    expect(pickAccount(a, 60_000, 60_000)).toBe("b");
    expect(pickAccount(a, 180_000, 60_000)).toBe("a");
    expect(pickAccount([], 0, 60_000)).toBeNull();
  });
});

describe("boundedCall", () => {
  const now = () => Date.now();
  it("refuses to start without budget (nothing is called)", async () => {
    let called = false;
    await expect(boundedCall(async () => { called = true; return 1; }, { timeoutMs: 100, deadlineAt: Date.now() + 50, now })).rejects.toEqual(new InvocationRefusal("BUDGET"));
    expect(called).toBe(false);
  });
  it("a timer that cannot be armed refuses with nothing started", async () => {
    let called = false;
    const timers = { setTimeout: () => { throw new Error("no timers"); }, clearTimeout: () => {} };
    await expect(boundedCall(async () => { called = true; return 1; }, { timeoutMs: 10, deadlineAt: Date.now() + 1_000, now, timers })).rejects.toEqual(new InvocationRefusal("TIMER"));
    expect(called).toBe(false);
  });
  it("times out, aborts the port's signal and ignores the late result", async () => {
    let aborted = false, late = false;
    const p = boundedCall((s) => new Promise<number>((res) => { s.addEventListener("abort", () => { aborted = true; }); setTimeout(() => { late = true; res(7); }, 80); }), { timeoutMs: 20, deadlineAt: Date.now() + 1_000, now });
    await expect(p).rejects.toEqual(new InvocationRefusal("TIMEOUT"));
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(late).toBe(true);
  });
  it("the parent signal (end of the tick) cancels it", async () => {
    const parent = new AbortController();
    const p = boundedCall((s) => new Promise<number>((_r, rej) => s.addEventListener("abort", () => rej(new Error("x")))), { timeoutMs: 1_000, deadlineAt: Date.now() + 2_000, now, parent: parent.signal });
    parent.abort();
    await expect(p).rejects.toEqual(new InvocationRefusal("CANCELLED"));
  });
});

describe("classifyInvocation — partial state is never a completed tick", () => {
  const sum = (codes: string[], committed: number, hosted: string[] = [], halted: string[] = []) => ({ status: "ran", committed, halted, metrics: codes.map((code) => ({ code })), hosted: hosted.map((code) => ({ code })) });
  const T = { outcome: "TICK_COMPLETED" };
  it("CAUGHT_UP only when the session completed, nothing was uncertain and the account waits for the next candle", () => {
    expect(classifyInvocation({ session: T, summary: sum(["COMMITTED", "COMMITTED", "WAIT_CANDLE_NOT_CLOSED"], 2) })).toEqual({ status: "CAUGHT_UP", completed: true, committed: 2, reasons: [] });
    expect(classifyInvocation({ session: T, summary: sum(["ACCOUNT_STOPPED"], 0) }).completed).toBe(true);
  });
  it("commits followed by a budget stop are PROGRESS (durable, not completed); an uncertain commit is never completed", () => {
    expect(classifyInvocation({ session: T, summary: sum(["COMMITTED", "LOAD_FAILED"], 1, ["RPC_TRANSIENT"]) })).toMatchObject({ status: "PROGRESS", completed: false, committed: 1 });
    expect(classifyInvocation({ session: T, summary: sum(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"], 0, ["RPC_TIMEOUT"]) })).toMatchObject({ status: "INCOMPLETE", completed: false });
    expect(classifyInvocation({ session: T, summary: sum(["LOST_RESPONSE_RESENT", "COMMITTED", "WAIT_CANDLE_NOT_CLOSED"], 1, ["RPC_TIMEOUT"]) })).toMatchObject({ status: "PROGRESS", completed: false });
    expect(classifyInvocation({ session: { outcome: "TICK_DEADLINE_EXCEEDED" }, summary: sum(["COMMITTED", "WAIT_CANDLE_NOT_CLOSED"], 1) })).toMatchObject({ status: "PROGRESS", completed: false });
    expect(classifyInvocation({ session: { outcome: "TICK_DEADLINE_EXCEEDED" }, summary: null })).toMatchObject({ status: "INCOMPLETE", completed: false });
  });
  it("busy only when the database answered busy; a failed acquire is INCOMPLETE; halts and session failures are explicit", () => {
    expect(classifyInvocation({ session: T, summary: sum(["LEASE_BUSY"], 0, ["LEASE_BUSY"]) }).status).toBe("SKIPPED_BUSY");
    expect(classifyInvocation({ session: T, summary: sum(["LEASE_BUSY"], 0, ["RPC_TIMEOUT"]) }).status).toBe("INCOMPLETE");
    expect(classifyInvocation({ session: T, summary: sum(["HALT_FOR_REVIEW"], 0, [], ["acct"]) }).status).toBe("HALTED");
    expect(classifyInvocation({ session: { outcome: "TOKEN_USER_REFUSED" }, summary: null }).status).toBe("SESSION_FAILED");
    expect(classifyInvocation({ session: null }).status).toBe("SESSION_FAILED");
  });
});

describe("workerUserCheck (server-side early stop)", () => {
  const good = { id: WORKER, email: "Paper-Worker@algovirt.test", phone: "", app_metadata: { provider: "email", providers: ["email"] }, identities: [{ provider: "email" }] };
  const chk = workerUserCheck("paper-worker@algovirt.test", () => Date.parse("2026-11-14T00:00:00Z"));
  it("accepts the unchanged email-only account", () => { expect(chk(good)).toBeNull(); });
  it.each([
    [{ email: "x@evil.test" }, "EMAIL_CHANGED"], [{ new_email: "x@evil.test" }, "EMAIL_CHANGE_PENDING"], [{ email_change_sent_at: "2026-11-13T00:00:00Z" }, "EMAIL_CHANGE_PENDING"],
    [{ phone: "+15550001" }, "PHONE_LINKED"], [{ app_metadata: { provider: "google", providers: ["google"] } }, "PROVIDER_CHANGED"],
    [{ app_metadata: { provider: "email", providers: ["email", "google"] } }, "PROVIDER_CHANGED"], [{ identities: [{ provider: "email" }, { provider: "google" }] }, "IDENTITY_LINKED"],
    [{ banned_until: "2099-01-01T00:00:00Z" }, "BANNED"], [{ is_sso_user: true }, "NOT_EMAIL_ACCOUNT"], [{ app_metadata: null }, "PROVIDER_UNKNOWN"],
  ])("refuses %j → %s", (patch, code) => { expect(chk({ ...good, ...patch })).toBe(code); });
  it("refuses when not configured", () => { expect(workerUserCheck("")(good)).toBe("CHECK_NOT_CONFIGURED"); });
});

describe("session wiring of verifyUser", () => {
  const limits = { tickBudgetMs: 3_600, rpcTimeoutMs: 450, authTimeoutMs: 600, signOutTimeoutMs: 400, maxRefreshes: 0 as const };
  const data: DataTransport = async () => ({ data: 1, error: null, status: 200 });
  it("a refused user ends the tick before the body as TOKEN_USER_REFUSED and signs out exactly once", async () => {
    const auth = fakeAuth({ signIn: [ok(issued(Date.now()))], signOut: [noContent] });
    let bodyRan = false;
    const r = await runWithWorkerSession({ auth, data, resolveFn: (f) => f, limits, clock: { now: () => Date.now() }, expectedUserId: WORKER, verifyUser: () => "EMAIL_CHANGED" }, async () => { bodyRan = true; });
    expect([r.outcome, r.signOut, bodyRan, auth.log]).toEqual(["TOKEN_USER_REFUSED", "SIGNED_OUT", false, ["signIn", "signOut"]]);
    expect(r.metrics.find((m) => m.code === "TOKEN_USER_REFUSED")?.detail).toBe("EMAIL_CHANGED");
  });
  it("a throwing or malformed check refuses (fail closed) with a bounded code; no check keeps the old behaviour", async () => {
    for (const [v, want] of [[() => { throw new Error("secret text"); }, "CHECK_FAILED"], [() => "lower case & free text", "OTHER"], [() => undefined, "OTHER"]] as const) {
      const auth = fakeAuth({ signIn: [ok(issued(Date.now()))], signOut: [noContent] });
      const r = await runWithWorkerSession({ auth, data, resolveFn: (f) => f, limits, clock: { now: () => Date.now() }, expectedUserId: WORKER, verifyUser: v as never }, async () => 1);
      expect([r.outcome, r.metrics.find((m) => m.code === "TOKEN_USER_REFUSED")?.detail]).toEqual(["TOKEN_USER_REFUSED", want]);
      expect(JSON.stringify(r)).not.toMatch(/secret text|free text/);
    }
    const auth = fakeAuth({ signIn: [ok(issued(Date.now()))], signOut: [noContent] });
    const r = await runWithWorkerSession({ auth, data, resolveFn: (f) => f, limits, clock: { now: () => Date.now() }, expectedUserId: WORKER }, async () => 1);
    expect(r.outcome).toBe("TICK_COMPLETED");
  });
});

describe("refusal audit categories and reconciliation", () => {
  it("maps hosted metrics to what they prove: only envelope refusals are database records (A); the rest is platform-log evidence (B)", () => {
    expect(kindOfHostedMetric({ code: "RPC_REFUSED", pgCode: "P0001" })).toBe("REFUSED_IN_DB");
    expect(kindOfHostedMetric({ code: "RPC_SCHEMA_UNAVAILABLE", pgCode: "42501" })).toBe("REFUSED_AT_BOUNDARY");
    expect(kindOfHostedMetric({ code: "RPC_SCHEMA_UNAVAILABLE", pgCode: "PGRST301" })).toBe("TOKEN_REJECTED");
    expect(kindOfHostedMetric({ code: "RPC_TIMEOUT" })).toBe("TIMED_OUT");
    expect(kindOfHostedMetric({ code: "RPC_TRANSIENT", pgCode: "57014" })).toBe("DB_TIMEOUT");
    expect(kindOfHostedMetric({ code: "RPC_TRANSIENT", pgCode: null })).toBe("NOT_SENT");
    expect(kindOfHostedMetric({ code: "RPC_NO_RESPONSE" })).toBe("OUTCOME_UNKNOWN");
    expect(kindOfHostedMetric({ code: "LEASE_ACQUIRED" })).toBeNull();
    expect(Object.entries(CATEGORY_OF).filter(([, c]) => c === "A").map(([k]) => k)).toEqual(["REFUSED_IN_DB"]);
  });
  const journal = (calls: { fn: string; code: string; pgCode?: string; at: number }[], end = true): JournalEvent[] => {
    let t = 0; const j = createJournal("inv-1", () => t);
    j.start(); for (const c of calls) { t = c.at; j.hosted(c); } if (end) j.end("INCOMPLETE");
    return j.events;
  };
  it("matches A-class refusals one-to-one, explains cap drops by the counter, and never expects a row for B", () => {
    const j = journal([{ fn: "fpw_id2_snapshot", code: "RPC_REFUSED", pgCode: "P0001", at: 1_000 }, { fn: "fpw_id2_commit", code: "RPC_REFUSED", pgCode: "P0001", at: 2_000 }, { fn: "fpw_id2_commit", code: "RPC_SCHEMA_UNAVAILABLE", pgCode: "42501", at: 3_000 }, { fn: "fpw_id2_commit", code: "RPC_TIMEOUT", at: 4_000 }]);
    const r = reconcileRefusals({ journal: j, rows: [{ id: 1, fn: "snapshot", sqlstate: "P0001", created_at: 1_010 }], tally: { baseline_rows: 0, recorded_total: 1, dropped_total: 1 } });
    expect(r).toEqual({ byCategory: { A: 2, B: 2, C: 0 }, matched: 1, findings: [{ code: "DROPPED_BY_CAP", count: 1 }], complete: true });
  });
  it("reports missing rows, deleted/added rows, foreign rows, journal gaps and journals without an end (category C)", () => {
    const j = journal([{ fn: "fpw_id2_snapshot", code: "RPC_REFUSED", pgCode: "P0001", at: 1_000 }], false);
    const gap = [...j.slice(0, 1), ...j.slice(2)].concat([{ ...j[1]!, seq: 5 }]);
    const r = reconcileRefusals({ journal: gap, rows: [{ id: 9, fn: "commit", sqlstate: "P0001", created_at: 1_200 }], tally: { baseline_rows: 0, recorded_total: 3, dropped_total: 0 } });
    expect(r.complete).toBe(false);
    expect(r.byCategory.C).toBe(1);
    expect(r.findings.map((f) => f.code).sort()).toEqual(["DB_ONLY_REFUSAL", "JOURNAL_GAP", "JOURNAL_INCOMPLETE", "MISSING_IN_DB", "ROWS_DELETED"]);
    expect(reconcileRefusals({ journal: [], rows: [{ id: 1, fn: "commit", sqlstate: "P0001", created_at: 0 }], tally: { baseline_rows: 0, recorded_total: 0, dropped_total: 0 } }).findings).toEqual([{ code: "ROWS_ADDED", count: 1 }]);
    expect(reconcileRefusals({ journal: [], rows: [{ id: 1, fn: "commit", sqlstate: "P0001", created_at: 0 }], tally: null }).findings).toEqual([{ code: "TALLY_MISSING", count: 1 }]);
  });
  it("the journal never throws into the worker and carries no free text", () => {
    const j = createJournal("inv", () => 1, () => { throw new Error("logger down"); });
    j.start(); j.hosted({ code: "RPC_REFUSED", fn: "fpw_id2_commit; drop table", pgCode: "P0001" }); j.end("status with spaces");
    expect(j.events.map((e) => [e.type, e.fn ?? null, e.status ?? null])).toEqual([["INVOCATION_START", null, null], ["CALL", null, null], ["INVOCATION_END", null, "OTHER"]]);
  });
});
