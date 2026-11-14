// Phase 4H.5 — L7 per-call cancellation and the local part of L2–L5 in the worker session module. FAKE transports and
// fake auth only (no network, no auth service, no database, no worker account).
import { describe, expect, it, vi } from "vitest";
import { classifyRpc } from "@/lib/futures-paper-worker-hosted";
import { runWithWorkerSession, SESSION_CODES, SESSION_DEFAULTS, SESSION_GUARDS, verifyIssuedSession, type DataReply, type DataTransport, type GuardedCall, type SessionLimits, type SessionOptions } from "@/lib/worker-auth-session";
import { fakeAuth, fakeJwt, issued, noContent, ok, SESSION, WORKER, type Step } from "./helpers/fake-auth";

const LIMITS: SessionLimits = { tickBudgetMs: 5_000, rpcTimeoutMs: 120, authTimeoutMs: 500, signOutTimeoutMs: 500 };
const allow = (fn: string) => { if (!["a", "b"].includes(fn)) throw new Error("not allowlisted"); return `w_${fn}`; };
type Sent = { fn: string; args: unknown; signal: AbortSignal; settle: (r: DataReply) => void };
function hangingData() {
  const sent: Sent[] = [];
  const data: DataTransport = (fn, args, _t, signal) => new Promise<DataReply>((res) => { sent.push({ fn, args, signal, settle: res }); });
  return { sent, data };
}
function setup(o: Partial<SessionOptions> & { steps?: { signIn?: Step[]; refresh?: Step[]; signOut?: Step[] } } = {}) {
  const auth = fakeAuth(o.steps ?? { signIn: [ok(issued(Date.now()))], signOut: [noContent] });
  const opts: SessionOptions = { auth, data: async () => ({ data: 1, error: null, status: 200 }), resolveFn: allow, limits: LIMITS, clock: { now: () => Date.now() }, expectedUserId: WORKER, ...o };
  return { auth, opts };
}
const codes = (r: { metrics: { code: string }[] }) => r.metrics.map((m) => m.code);
const signOuts = (a: { log: string[] }) => a.log.filter((x) => x === "signOut").length;
const sig = () => new AbortController().signal;
/** Injected timers: arm number `n` (1-based) throws / never fires; every other arm uses the platform timer. */
function timersWith(kind: "throw" | "never", which: (n: number) => boolean) {
  let n = 0;
  return { setTimeout: (f: () => void, ms: number) => { n++; if (which(n)) { if (kind === "throw") throw new Error("timer unavailable"); return { never: true }; } return globalThis.setTimeout(f, ms); },
    clearTimeout: (h: unknown) => { if (h && typeof h === "object" && "never" in h) return; globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>); } };
}

describe("L7 — every data call has its own limit, armed before the request, and is really cancelled", () => {
  it("a timer that cannot be armed refuses the call BEFORE anything is sent; the session closes and signs out once", async () => {
    const { sent, data } = hangingData();
    const { auth, opts } = setup({ data, timers: timersWith("throw", (n) => n === 3) }); // 1 sign-in, 2 body deadline, 3 the call
    let first: DataReply | null = null, second: DataReply | null = null;
    const r = await runWithWorkerSession(opts, async (call) => { first = await call("a", {}, sig()); second = await call("b", {}, sig()); return 1; });
    expect(sent).toEqual([]);
    expect([first!.status, first!.error?.message]).toEqual([401, "worker session: call not started (CALL_REFUSED_TIMER)"]);
    expect(classifyRpc({ reply: first! as never }).kind).toBe("transient"); // "nothing was written"
    expect(second!.error?.message).toMatch(/CALL_REFUSED_SESSION_CLOSED/);
    expect([r.outcome, signOuts(auth)]).toEqual(["CALL_REFUSED_TIMER", 1]);
  });
  it("a call whose reply never arrives is aborted at its own limit: the transport's signal fires and the caller gets 'outcome unknown'", async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data });
    const t0 = Date.now();
    const r = await runWithWorkerSession(opts, async (call) => call("a", { x: 1 }, sig()));
    expect(sent).toHaveLength(1); expect(sent[0]!.signal.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.result).toEqual({ data: null, error: { code: null, message: "worker session: call cancelled after it was sent (outcome unknown)" }, status: 0 });
    expect(classifyRpc({ reply: r.result as never }).kind).toBe("no_response");
    expect(r.metrics.find((m) => m.code === "CALL_ABORTED")?.detail).toBe("TIMEOUT");
  });
  it("an injected per-call timer that never fires is backed up by the platform timer (the call still ends at its limit)", async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data, timers: timersWith("never", (n) => n >= 3) });
    const r = await runWithWorkerSession(opts, async (call) => call("a", {}, sig()));
    expect(sent[0]!.signal.aborted).toBe(true); expect((r.result as DataReply).status).toBe(0);
  });
  it("the caller's own deadline (the hosted adapter's signal) cancels the request too", async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data, limits: { ...LIMITS, rpcTimeoutMs: 2_000 } });
    const r = await runWithWorkerSession(opts, async (call) => { const c = new AbortController(); globalThis.setTimeout(() => c.abort(), 20); return call("a", {}, c.signal); });
    expect(sent[0]!.signal.aborted).toBe(true);
    expect(r.metrics.find((m) => m.code === "CALL_ABORTED")?.detail).toBe("CALLER");
  });
  it("no request outlives the tick: a request still in flight when the body returns is aborted before sign-out; nothing is recorded later", async () => {
    const { sent, data } = hangingData();
    const { auth, opts } = setup({ data, limits: { ...LIMITS, rpcTimeoutMs: 2_000 } });
    let late: Promise<DataReply> | null = null;
    const r = await runWithWorkerSession(opts, async (call) => { late = call("a", {}, sig()); return "done"; });
    expect(sent[0]!.signal.aborted).toBe(true);
    expect([r.outcome, signOuts(auth)]).toEqual(["TICK_COMPLETED", 1]);
    const n = r.metrics.length; sent[0]!.settle({ data: 1, error: null, status: 200 }); await late;
    expect(r.metrics.length).toBe(n);
    expect(((await late!) as DataReply).status).toBe(0);
  });
  it("a late reply after cancellation never changes session state (a late 401 does not close or re-label the session)", async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data });
    const r = await runWithWorkerSession(opts, async (call) => {
      const first = await call("a", {}, sig());
      sent[0]!.settle({ data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 });
      await new Promise((x) => globalThis.setTimeout(x, 5));
      const p = call("b", {}, sig()); sent[1]!.settle({ data: 2, error: null, status: 200 });
      return [first.status, (await p).data];
    });
    expect(r.result).toEqual([0, 2]);
    expect(codes(r)).not.toContain("TOKEN_REJECTED");
  });
  it("an identical request still in flight is never sent twice (the resend shares the first reply); different requests are sent", async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data, limits: { ...LIMITS, rpcTimeoutMs: 2_000 } });
    const r = await runWithWorkerSession(opts, async (call) => {
      const args = { p_account: "x", p_payload: { a: 1 } };
      const p1 = call("a", args, sig()), p2 = call("a", { ...args }, sig()), p3 = call("a", { ...args, p_payload: { a: 2 } }, sig());
      expect(sent).toHaveLength(2);
      sent[0]!.settle({ data: 7, error: null, status: 200 }); sent[1]!.settle({ data: 8, error: null, status: 200 });
      return [(await p1).data, (await p2).data, (await p3).data];
    });
    expect(r.result).toEqual([7, 7, 8]);
    expect(codes(r).filter((c) => c === "CALL_COALESCED")).toHaveLength(1);
  });
  it(`at most ${SESSION_GUARDS.maxInFlight} requests are in flight; the next is refused locally ('nothing was written')`, async () => {
    const { sent, data } = hangingData();
    const { opts } = setup({ data, limits: { ...LIMITS, rpcTimeoutMs: 2_000 } });
    const r = await runWithWorkerSession(opts, async (call) => {
      const ps = [1, 2, 3, 4].map((i) => call("a", { i }, sig()));
      const fifth = await call("b", { i: 5 }, sig());
      for (const s of sent) s.settle({ data: 0, error: null, status: 200 });
      await Promise.all(ps);
      const pa = call("b", { i: 6 }, sig()); // capacity is released when calls settle
      sent[4]!.settle({ data: 0, error: null, status: 200 });
      const after = await pa;
      return [sent.length, fifth.error?.message, after.status];
    });
    expect(r.result).toEqual([5, "worker session: call not started (CALL_REFUSED_IN_FLIGHT_LIMIT)", 200]);
  });
  it("listeners and timers are released after every call (no growth across calls)", async () => {
    const ctl = new AbortController(), add = vi.spyOn(ctl.signal, "addEventListener"), rem = vi.spyOn(ctl.signal, "removeEventListener");
    const { opts } = setup();
    await runWithWorkerSession(opts, async (call) => { for (let i = 0; i < 10; i++) await call("a", { i }, ctl.signal); return 1; });
    expect(add).toHaveBeenCalledTimes(10); expect(rem).toHaveBeenCalledTimes(10);
  });
  it("restart: a late reply from an earlier tick has no effect on the next tick, which starts with a fresh session", async () => {
    const { sent, data } = hangingData();
    const a = setup({ data, steps: { signIn: [ok(issued(Date.now())), ok(issued(Date.now()))], signOut: [noContent, noContent] } });
    const r1 = await runWithWorkerSession(a.opts, async (call) => { void call("a", {}, sig()); return 1; });
    const r2 = await runWithWorkerSession(a.opts, async (call) => { sent[0]!.settle({ data: null, error: { code: "PGRST301", message: "x" }, status: 401 }); const p = call("b", {}, sig()); sent[1]!.settle({ data: 3, error: null, status: 200 }); return (await p).data; });
    expect([r1.outcome, r2.outcome, r2.result, signOuts(a.auth)]).toEqual(["TICK_COMPLETED", "TICK_COMPLETED", 3, 2]);
  });
});

describe("L2–L5 (local part) — session id, fresh token, refresh keeps the session, uncertain sign-out reported", () => {
  const T0 = Date.now(), o = { minTokenLifetimeMs: 120_000, maxClockSkewMs: 30_000, expectedSub: WORKER };
  it("a token without a session id, without iat, or issued too long ago is refused (and still signed out once)", async () => {
    expect(verifyIssuedSession(issued(T0, { sid: null }), T0, o)).toEqual({ ok: false, code: "AUTH_MALFORMED_REPLY", detail: "SESSION" });
    expect(verifyIssuedSession(issued(T0, { sid: "not-a-uuid" }), T0, o)).toEqual({ ok: false, code: "AUTH_MALFORMED_REPLY", detail: "SESSION" });
    const noIat = { ...issued(T0), access_token: fakeJwt({ sub: WORKER, role: "authenticated", exp: T0 / 1000 + 3600, session_id: SESSION }) };
    expect(verifyIssuedSession(noIat, T0, o)).toEqual({ ok: false, code: "AUTH_MALFORMED_REPLY", detail: "IAT" });
    expect(verifyIssuedSession(issued(T0, { iatSec: Math.floor((T0 - SESSION_GUARDS.maxTokenAgeMs - 31_000) / 1000) }), T0, o)).toEqual({ ok: false, code: "TOKEN_STALE" });
    const { auth, opts } = setup({ steps: { signIn: [ok(issued(Date.now(), { sid: null }))], signOut: [noContent] } });
    const body = vi.fn();
    const r = await runWithWorkerSession(opts, body);
    expect([r.outcome, signOuts(auth), body.mock.calls.length]).toEqual(["AUTH_MALFORMED_REPLY", 1, 0]);
  });
  it("a refresh that returns a different session id is refused; no call starts and the ORIGINAL token is signed out once", async () => {
    const first = issued(Date.now(), { lifeSec: 200 });
    const { auth, opts } = setup({ limits: { ...LIMITS, tickBudgetMs: 600_000, rpcTimeoutMs: 2_000 }, clock: { now: (() => { let k = 0; return () => Date.now() + (k++ > 3 ? 150_000 : 0); })() },
      steps: { signIn: [ok(first)], refresh: [ok(issued(Date.now(), { sid: "00000000-0000-4000-a000-00000000beef" }))], signOut: [noContent] } });
    const seen: string[] = [];
    const r = await runWithWorkerSession({ ...opts, data: async (fn) => { seen.push(fn); return { data: 1, error: null, status: 200 }; } }, async (call: GuardedCall) => call("a", {}, sig()));
    expect(r.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")?.detail).toBe("TOKEN_WRONG_IDENTITY");
    expect([seen, signOuts(auth), auth.signOutTokens]).toEqual([[], 1, [first.access_token]]);
  });
  it("an unacknowledged sign-out reports how long the token may stay usable; an acknowledged one reports nothing", async () => {
    const a = setup({ steps: { signIn: [ok(issued(Date.now(), { lifeSec: 900 }))], signOut: [{ status: 500, body: null }] } });
    const r = await runWithWorkerSession(a.opts, async () => 1);
    expect(r.signOut).toBe("SIGN_OUT_FAILED"); expect(r.residualTokenUntil).toBeGreaterThan(Date.now() + 800_000);
    const b = setup();
    expect((await runWithWorkerSession(b.opts, async () => 1)).residualTokenUntil).toBeNull();
  });
  it("S1–S8 defaults are unchanged; the new codes are bounded", () => {
    expect(SESSION_DEFAULTS).toEqual({ authTimeoutMs: 3_000, signOutTimeoutMs: 2_000, tokenSafetyMs: 60_000, minTokenLifetimeMs: 120_000, maxClockSkewMs: 30_000, maxRefreshes: 1, rateLimitCooldownMs: { min: 60_000, max: 900_000 } });
    for (const c of ["TOKEN_STALE", "CALL_REFUSED_TIMER", "CALL_REFUSED_IN_FLIGHT_LIMIT", "CALL_ABORTED", "CALL_COALESCED"]) expect(SESSION_CODES).toContain(c);
  });
});
