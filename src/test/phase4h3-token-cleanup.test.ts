// Phase 4H.3 — unconditional token cleanup and mandatory identity (pure module and the disabled binding with fake
// transports only: no network, no auth service, no database, no worker account).
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIdentityFuturesPaperTick, type IdentityTickOptions } from "@/lib/futures-paper-worker-identity.server";
import { runWithWorkerSession, SESSION_CODES, verifyIssuedSession, type DataTransport, type SessionLimits, type SessionMetric, type SessionOptions, type SessionResult } from "@/lib/worker-auth-session";
import { fakeAuth, fakeJwt, issued, noContent, ok, SESSION, WORKER, type Step } from "./helpers/fake-auth";

const T0 = 1_800_000_000_000;
const LIMITS: SessionLimits = { tickBudgetMs: 20_000, rpcTimeoutMs: 2_000, authTimeoutMs: 1_000, signOutTimeoutMs: 1_000 };
const LONG: SessionLimits = { ...LIMITS, tickBudgetMs: 600_000 };
const SECRET = "SECRET-password=hunter2-worker@example.com";
const allow = (fn: string) => { if (!["a", "b"].includes(fn)) throw new Error("not allowlisted"); return `w_${fn}`; };
const sig = () => new AbortController().signal;
const globalTimers = { setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms), clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };

function setup(steps: { signIn?: Step[]; refresh?: Step[]; signOut?: Step[] }, o: Partial<SessionOptions> = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const auth = fakeAuth(steps);
  const calls: { fn: string; token: string }[] = [];
  const data: DataTransport = async (fn, _args, token) => { calls.push({ fn, token }); return { data: 1, error: null, status: 200 }; };
  const opts: SessionOptions = { auth, data, resolveFn: allow, limits: LIMITS, clock, expectedUserId: WORKER, ...o };
  return { clock, auth, calls, opts };
}
const codes = (r: { metrics: { code: string }[] }) => r.metrics.map((m) => m.code);
const signOuts = (a: { log: string[] }) => a.log.filter((x) => x === "signOut").length;
/** A sign-in body whose `user` getter throws — an unexpected exception while the token is validated. */
function throwingUserBody(now: number) {
  const b = issued(now) as Record<string, unknown>;
  Object.defineProperty(b, "user", { enumerable: true, get() { throw new Error(SECRET); } });
  return b;
}
function expectNoSecrets(r: SessionResult<unknown>, ...tokens: string[]) {
  const text = JSON.stringify(r);
  for (const s of [SECRET, "hunter2", "worker@example.com", ...tokens]) expect(text).not.toContain(s);
  for (const m of r.metrics) expect(SESSION_CODES).toContain(m.code);
}

describe("1. sign-out is attempted exactly once after ANY unexpected exception once a usable token exists", () => {
  it("exception after successful sign-in (clock fails before the body): outcome kept, signed out once, body never runs", async () => {
    let broken = false;
    const first = issued(T0);
    const s = setup({ signIn: [ok(first)], signOut: [noContent] }, { monitor: { record: (m) => { if (m.code === "SIGNED_IN") broken = true; } } });
    s.opts.clock = { now: () => { if (broken) throw new Error(SECRET); return T0; } };
    const body = vi.fn(async () => 1);
    const r = await runWithWorkerSession(s.opts, body);
    expect([r.outcome, r.internalError, r.signOut, r.signedOut, r.signedIn]).toEqual(["TICK_INTERNAL_ERROR", "BODY", "SIGNED_OUT", true, true]);
    expect(body).not.toHaveBeenCalled();
    expect(s.auth.log).toEqual(["signIn", "signOut"]);
    expect(s.auth.signOutTokens).toEqual([first.access_token]);
    expectNoSecrets(r, first.access_token, first.refresh_token);
  });
  it("exception after successful sign-in (timers fail): sign-out still runs on a fallback timer, exactly once", async () => {
    let broken = false;
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] }, {
      monitor: { record: (m) => { if (m.code === "SIGNED_IN") broken = true; } },
      timers: { setTimeout: (f, ms) => { if (broken) throw new Error("timer"); return globalTimers.setTimeout(f, ms); }, clearTimeout: (h) => { if (broken) throw new Error("timer"); globalTimers.clearTimeout(h); } },
    });
    const r = await runWithWorkerSession(s.opts, async () => 1);
    expect([r.outcome, r.internalError, r.signOut, signOuts(s.auth)]).toEqual(["TICK_INTERNAL_ERROR", "BODY", "SIGNED_OUT", 1]);
  });
  it("exception during token validation (throwing reply field, or clock failing at validation): signed out once", async () => {
    const a = setup({ signIn: [ok(throwingUserBody(T0))], signOut: [noContent] });
    const r1 = await runWithWorkerSession(a.opts, async () => 1);
    expect([r1.outcome, r1.internalError, r1.signOut, signOuts(a.auth)]).toEqual(["TICK_INTERNAL_ERROR", "VERIFY", "SIGNED_OUT", 1]);
    expectNoSecrets(r1);

    let n = 0;
    const first = issued(T0);
    const b = setup({ signIn: [ok(first)], signOut: [noContent] });
    // reads: t0, bounded start, bounded end, then the validation read fails
    b.opts.clock = { now: () => { if (++n === 4) throw new Error(SECRET); return T0; } };
    const r2 = await runWithWorkerSession(b.opts, async () => 1);
    expect([r2.outcome, r2.internalError, r2.signOut, b.auth.signOutTokens]).toEqual(["TICK_INTERNAL_ERROR", "VERIFY", "SIGNED_OUT", [first.access_token]]);
  });
  it("exception during refresh: the session closes, no data call starts, and the ORIGINAL token is signed out once", async () => {
    const first = issued(T0, { lifeSec: 200 });
    const badRefresh = (async () => ok(throwingUserBody(T0 + 140_000))) as Step;
    const s = setup({ signIn: [ok(first)], refresh: [badRefresh], signOut: [noContent] }, { limits: LONG });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(140_000); const x = await call("a", {}, sig()); const y = await call("b", {}, sig()); return [x.error?.message, y.error?.message]; });
    expect([r.outcome, r.internalError, r.refreshes, r.signOut]).toEqual(["TICK_INTERNAL_ERROR", "REFRESH", 1, "SIGNED_OUT"]);
    expect(r.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")?.detail).toBe("EXCEPTION");
    expect(r.result).toEqual(["worker session: call not started (CALL_REFUSED_SESSION_CLOSED)", "worker session: call not started (CALL_REFUSED_SESSION_CLOSED)"]);
    expect(s.calls).toEqual([]);
    expect(s.auth.log).toEqual(["signIn", "refresh", "signOut"]);
    expect(s.auth.signOutTokens).toEqual([first.access_token]);
    // a refresh transport that throws synchronously is a bounded NETWORK failure, not an escape
    const t = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], signOut: [noContent] }, { limits: LONG });
    t.opts.auth = { ...t.auth, refresh: () => { throw new Error(SECRET); } };
    const r2 = await runWithWorkerSession(t.opts, async (call) => { t.clock.advance(140_000); return (await call("a", {}, sig())).status; });
    expect([r2.outcome, r2.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")?.detail, signOuts(t.auth)]).toEqual(["TOKEN_REFRESH_FAILED", "NETWORK", 1]);
    expectNoSecrets(r2);
  });
  it("exception during the worker body (sync throw, rejection, non-Error values, a hostile thrown object): signed out once", async () => {
    const hostile = new Proxy({}, { get() { throw new Error(SECRET); } });
    const bodies = [() => { throw new Error(SECRET); }, async () => { throw new Error(SECRET); }, async () => { throw undefined; }, async () => { throw hostile; }, () => Promise.reject(null)];
    for (const body of bodies) {
      const first = issued(T0);
      const s = setup({ signIn: [ok(first)], signOut: [noContent] });
      const r = await runWithWorkerSession(s.opts, body as () => Promise<never>);
      expect([r.outcome, r.internalError, r.signOut, signOuts(s.auth)]).toEqual(["TICK_BODY_FAILED", null, "SIGNED_OUT", 1]);
      expectNoSecrets(r, first.access_token);
    }
  });
  it("exception during monitoring (throws on every record, on sign-in only, or rejects asynchronously) never changes the tick", async () => {
    const monitors: NonNullable<SessionOptions["monitor"]>[] = [
      { record: () => { throw new Error(SECRET); } },
      { record: (m: SessionMetric) => { if (m.code === "SIGNED_IN" || m.code === "SIGNED_OUT") throw new Error(SECRET); } },
      { record: () => Promise.reject(new Error(SECRET)) as unknown as void },
    ];
    for (const monitor of monitors) {
      const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] }, { monitor });
      const r = await runWithWorkerSession(s.opts, async (call) => (await call("a", {}, sig())).data);
      await new Promise((res) => setTimeout(res, 0));
      expect([r.outcome, r.result, r.signOut, signOuts(s.auth), s.calls.length]).toEqual(["TICK_COMPLETED", 1, "SIGNED_OUT", 1, 1]);
      expect(r.monitorFailures).toBeGreaterThan(0);
      expect(codes(r)).toEqual(["SIGNED_IN", "TICK_COMPLETED", "SIGNED_OUT"]);
    }
  });
  it("exception in a transport: data transport throws (body sees it), sign-out transport throws synchronously — bounded, once", async () => {
    const s = setup({ signIn: [ok(issued(T0))] });
    s.opts.data = () => { throw new Error(SECRET); };
    s.opts.auth = { ...s.auth, signOut: (at, signal) => { s.auth.signOut(at, signal); throw new Error(SECRET); } };
    const r = await runWithWorkerSession(s.opts, async (call) => { await call("a", {}, sig()); return 1; });
    expect([r.outcome, r.signOut, r.signedOut, r.metrics.at(-1)]).toEqual(["TICK_BODY_FAILED", "SIGN_OUT_FAILED", false, expect.objectContaining({ code: "SIGN_OUT_FAILED", detail: "NETWORK" })]);
    expect(signOuts(s.auth)).toBe(1);
    expectNoSecrets(r);
  });
  it("sign-out failure after an unexpected exception: the original failure is kept, signedOut is false, one attempt, no retry", async () => {
    const failures: [Step | "brokenTimers", string][] = [[{ status: 500, body: { message: SECRET } }, "HTTP_500"], [{ status: 401, body: null }, "HTTP_401"], [{ status: 429, body: null }, "HTTP_429"], ["throw", "NETWORK"], ["hang", "TIMEOUT"]];
    for (const [step, detail] of failures) {
      const s = setup({ signIn: [ok(throwingUserBody(T0))], signOut: [step as Step] }, { limits: { ...LIMITS, signOutTimeoutMs: 30 } });
      const r = await runWithWorkerSession(s.opts, async () => 1);
      expect([r.outcome, r.internalError, r.signOut, r.signedOut, r.signedIn], detail).toEqual(["TICK_INTERNAL_ERROR", "VERIFY", "SIGN_OUT_FAILED", false, true]);
      expect(r.metrics.at(-1), detail).toMatchObject({ code: "SIGN_OUT_FAILED", detail });
      expect(signOuts(s.auth), detail).toBe(1);
      expectNoSecrets(r);
    }
    // and after an exception in the body stage with every timer broken
    let broken = false;
    const s = setup({ signIn: [ok(issued(T0))], signOut: [{ status: 503, body: null }] }, {
      monitor: { record: (m) => { if (m.code === "SIGNED_IN") broken = true; } },
      timers: { setTimeout: (f, ms) => { if (broken) throw new Error("timer"); return globalTimers.setTimeout(f, ms); }, clearTimeout: (h) => globalTimers.clearTimeout(h) },
    });
    const r = await runWithWorkerSession(s.opts, async () => 1);
    expect([r.outcome, r.signOut, signOuts(s.auth), r.metrics.at(-1)?.detail]).toEqual(["TICK_INTERNAL_ERROR", "SIGN_OUT_FAILED", 1, "HTTP_503"]);
  });
  it("the first failure stays the outcome: a refresh failure is not replaced by a later body failure or a failed sign-out", async () => {
    const s = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], refresh: [{ status: 400, body: { error_code: "refresh_token_not_found" } }], signOut: [{ status: 500, body: null }] }, { limits: LONG });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(140_000); await call("a", {}, sig()); throw new Error("then the body fails"); });
    expect([r.outcome, r.signOut]).toEqual(["TOKEN_REFRESH_FAILED", "SIGN_OUT_FAILED"]);
    expect(codes(r)).toEqual(["SIGNED_IN", "TOKEN_REFRESH_FAILED", "CALL_REFUSED_SESSION_CLOSED", "TICK_BODY_FAILED", "SIGN_OUT_FAILED"]);
  });
});

describe("2. no sign-out attempt when sign-in never produced a usable session", () => {
  it("rejected, limited, unavailable, timed-out, empty, non-JWT or token-less replies, a throwing status, and a clock failing before sign-in", async () => {
    const hostileReply = Object.defineProperty({ body: null }, "status", { get() { throw new Error(SECRET); } });
    const cases: [Step | "clock", string, string | null][] = [
      [{ status: 400, body: { error_code: "invalid_credentials" } }, "AUTH_INVALID_CREDENTIALS", null],
      [{ status: 429, body: null }, "AUTH_RATE_LIMITED", null],
      [{ status: 500, body: null }, "AUTH_UNAVAILABLE", null],
      ["throw", "AUTH_UNAVAILABLE", null],
      ["hang", "AUTH_TIMEOUT", null],
      [(async () => null) as unknown as Step, "AUTH_UNAVAILABLE", null],
      [ok({ access_token: "not-a-jwt", refresh_token: "rt-xxxxxxxx", user: { id: WORKER } }), "AUTH_MALFORMED_REPLY", null],
      [ok({ refresh_token: "rt-xxxxxxxx", user: { id: WORKER } }), "AUTH_MALFORMED_REPLY", null],
      [ok(null), "AUTH_MALFORMED_REPLY", null],
      [(async () => hostileReply) as unknown as Step, "TICK_INTERNAL_ERROR", "SIGN_IN"],
      ["clock", "TICK_INTERNAL_ERROR", "SIGN_IN"],
    ];
    for (const [step, outcome, stage] of cases) {
      const s = setup({ signIn: step === "clock" ? [] : [step] }, { limits: { ...LIMITS, authTimeoutMs: 30 } });
      if (step === "clock") s.opts.clock = { now: () => { throw new Error(SECRET); } };
      const body = vi.fn(async () => 1);
      const r = await runWithWorkerSession(s.opts, body);
      expect([r.outcome, r.internalError, r.signedIn, r.signOut, r.signedOut], outcome).toEqual([outcome, stage, false, "NOT_REQUIRED", false]);
      expect(s.auth.log.filter((x) => x !== "signIn")).toEqual([]);
      expect(body).not.toHaveBeenCalled();
      expectNoSecrets(r);
    }
  });
  it("timers that fail from the start: no sign-in request is ever sent without its deadline", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] }, { timers: { setTimeout: () => { throw new Error("timer"); }, clearTimeout: () => {} } });
    const r = await runWithWorkerSession(s.opts, async () => 1);
    expect([r.outcome, r.internalError, r.signOut, s.auth.log]).toEqual(["TICK_INTERNAL_ERROR", "SIGN_IN", "NOT_REQUIRED", []]);
  });
  it("configuration errors (bad limits, missing or malformed expected identity, a throwing limits object) never sign in", async () => {
    const throwingLimits = Object.defineProperty({}, "tickBudgetMs", { enumerable: true, get() { throw new Error("x"); } }) as SessionLimits;
    for (const o of [{ limits: { ...LIMITS, tickBudgetMs: 0 } }, { expectedUserId: undefined as unknown as string }, { expectedUserId: "" }, { expectedUserId: "worker" }, { limits: throwingLimits }]) {
      const s = setup({ signIn: [ok(issued(T0))] }, o);
      const r = await runWithWorkerSession(s.opts, async () => 1);
      expect([r.outcome, r.signOut, s.auth.log]).toEqual(["CONFIG_INVALID", "NOT_REQUIRED", []]);
    }
  });
});

describe("3. tokens are forgotten after cleanup", () => {
  it("a call captured by the body and used after the tick is refused locally and never reaches the data transport", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
    let kept: ((fn: string) => Promise<unknown>) | null = null;
    await runWithWorkerSession(s.opts, async (call) => { kept = (fn) => call(fn, {}, sig()); return 1; });
    expect(await kept!("a")).toMatchObject({ error: { message: "worker session: call not started (CALL_REFUSED_SESSION_CLOSED)" } });
    expect(s.calls).toEqual([]);
  });
  it("a refresh still in flight when the body is cut off stores nothing, starts no call and records nothing after the result", async () => {
    // Manual timers: nothing fires unless the test fires it, so the order of events is exact.
    const pending = new Map<number, () => void>(); let nextId = 0;
    const timers = { setTimeout: (f: () => void) => { const id = nextId++; pending.set(id, f); return id; }, clearTimeout: (h: unknown) => { pending.delete(h as number); } };
    let release: (v: unknown) => void = () => {};
    const lateRefresh = (() => new Promise((res) => { release = res; })) as unknown as Step;
    const first = issued(T0, { lifeSec: 200 });
    const s = setup({ signIn: [ok(first)], refresh: [lateRefresh], signOut: [noContent] }, { limits: LONG, timers });
    const seen: string[] = [];
    s.opts.monitor = { record: (m) => { seen.push(m.code); } };
    let late: unknown = "not settled";
    const r = await runWithWorkerSession(s.opts, async (call) => {
      s.clock.advance(140_000);                         // the token now blocks the next call → refresh
      void call("a", {}, sig()).then((x) => { late = x; });
      await Promise.resolve(); await Promise.resolve();
      expect(s.auth.log).toEqual(["signIn", "refresh"]); // the refresh is in flight
      pending.get(1)!();                                // fire the body deadline (timer 0 = sign-in, cleared; 1 = body; 2 = refresh)
      return new Promise<number>(() => {});             // the body itself hangs
    });
    expect([r.outcome, r.signOut, s.auth.signOutTokens]).toEqual(["TICK_DEADLINE_EXCEEDED", "SIGNED_OUT", [first.access_token]]);
    const frozen = codes(r), seenAtReturn = seen.length;
    release(ok(issued(T0 + 140_000, { lifeSec: 3600 })));
    for (let k = 0; k < 10; k++) await Promise.resolve();
    expect(late).toMatchObject({ error: { message: "worker session: call not started (CALL_REFUSED_SESSION_CLOSED)" } });
    expect(s.calls).toEqual([]);
    expect(codes(r)).toEqual(frozen);
    expect(seen.length).toBe(seenAtReturn);
    expect(s.auth.log).toEqual(["signIn", "refresh", "signOut"]);
  });
});

describe("4. token verification: mandatory user object matched to the subject and the expected enrolled worker", () => {
  const V = { minTokenLifetimeMs: 1, maxClockSkewMs: 1, expectedSub: WORKER };
  it("missing, null, array, id-less, non-UUID or mismatching user objects are refused as malformed (never silently accepted)", () => {
    const base = issued(T0);
    for (const [user, detail] of [[undefined, "USER"], [null, "USER"], [[{ id: WORKER }], "USER"], [{}, "USER"], [{ id: 7 }, "USER"], [{ id: "worker" }, "USER"], [{ id: "00000000-0000-4000-8000-000000000999" }, "SUBJECT"]] as const) {
      const b = { ...base, user } as Record<string, unknown>; if (user === undefined) delete b["user"];
      expect(verifyIssuedSession(b, T0, V), JSON.stringify(user)).toEqual({ ok: false, code: "AUTH_MALFORMED_REPLY", detail });
    }
    expect(verifyIssuedSession(base, T0, V).ok).toBe(true);
    expect(verifyIssuedSession({ ...base, user: { id: WORKER.toUpperCase() } }, T0, V).ok).toBe(true); // UUID case is not identity
  });
  it("anonymous sessions and any identity other than the expected worker are refused", () => {
    const anonClaim = { ...issued(T0), access_token: fakeJwt({ sub: WORKER, role: "authenticated", exp: T0 / 1000 + 3600, iat: T0 / 1000, session_id: SESSION, is_anonymous: true }) };
    expect(verifyIssuedSession(anonClaim, T0, V)).toMatchObject({ ok: false, code: "TOKEN_NOT_WORKER_ROLE", detail: "anonymous" });
    expect(verifyIssuedSession({ ...issued(T0), user: { id: WORKER, is_anonymous: true } }, T0, V)).toMatchObject({ ok: false, code: "TOKEN_NOT_WORKER_ROLE" });
    const other = "00000000-0000-4000-8000-00000000beef";
    expect(verifyIssuedSession(issued(T0, { sub: other }), T0, V)).toEqual({ ok: false, code: "TOKEN_WRONG_IDENTITY" });
    expect(verifyIssuedSession(issued(T0), T0, { ...V, expectedSub: "" })).toEqual({ ok: false, code: "TOKEN_WRONG_IDENTITY" });
  });
  it("a refused identity is still signed out once and no data call starts; a refresh without a user object closes the session", async () => {
    const s = setup({ signIn: [ok({ ...issued(T0), user: undefined })], signOut: [noContent] });
    const body = vi.fn(async () => 1);
    const r = await runWithWorkerSession(s.opts, body);
    expect([r.outcome, r.signOut, signOuts(s.auth), body.mock.calls.length]).toEqual(["AUTH_MALFORMED_REPLY", "SIGNED_OUT", 1, 0]);
    const t = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], refresh: [ok({ ...issued(T0 + 140_000), user: undefined })], signOut: [noContent] }, { limits: LONG });
    const r2 = await runWithWorkerSession(t.opts, async (call) => { t.clock.advance(140_000); return (await call("a", {}, sig())).status; });
    expect([r2.outcome, r2.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")?.detail, t.calls.length]).toEqual(["TOKEN_REFRESH_FAILED", "AUTH_MALFORMED_REPLY", 0]);
  });
  it("decoded claims are not signature verification: a token with a garbage signature passes the LOCAL check (the data API must verify it)", () => {
    const b = issued(T0), [h, p] = b.access_token.split(".");
    expect(verifyIssuedSession({ ...b, access_token: `${h}.${p}.AAAA` }, T0, V).ok).toBe(true);
  });
});

describe("5. the disabled binding requires the expected worker identity", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const URL_ = "https://backend.test", KEY = "sb_publishable_TESTKEYxxxxxxxxxxxxxxxx";
  const env = (uid: string | null) => {
    vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled"); vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
    vi.stubEnv("SUPABASE_URL", URL_); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
    vi.stubEnv("FUTURES_PAPER_WORKER_EMAIL", "paper-worker@algovirt.test"); vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", "pw-Do-Not-Log");
    if (uid !== null) vi.stubEnv("FUTURES_PAPER_WORKER_USER_ID", uid);
  };
  const opts = (fetchImpl: IdentityTickOptions["fetchImpl"]) => ({ enabled: true, accounts: ["x"], clock: { now: () => Date.now(), sleep: async () => {} }, session: { tickBudgetMs: 60_000 }, fetchImpl }) as unknown as IdentityTickOptions;
  it("refuses before any request when the expected worker id is missing or not a UUID", async () => {
    for (const uid of [null, "", "paper-worker"]) {
      env(uid);
      const fetchImpl = vi.fn();
      await expect(runIdentityFuturesPaperTick(opts(fetchImpl as never))).rejects.toThrow(/IDENTITY_NOT_CONFIGURED/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("the expected worker id is configured nowhere in the repository and is unset in this environment", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    expect(process.env["FUTURES_PAPER_WORKER_USER_ID"]).toBeUndefined();
    for (const f of [".env", ".env.example", "wrangler.jsonc", "wrangler.toml", "supabase/config.toml"].filter((x) => existsSync(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/FUTURES_PAPER_WORKER_USER_ID/);
  });
  it("a sign-in that returns a different identity is signed out once and never reaches a worker function", async () => {
    env(WORKER);
    const paths: string[] = [];
    const fetchImpl = async (url: string) => {
      paths.push(url.replace(URL_, ""));
      if (url.endsWith("grant_type=password")) return new Response(JSON.stringify(issued(Date.now(), { sub: "00000000-0000-4000-8000-00000000beef" })), { status: 200 });
      if (url.endsWith("/logout?scope=local")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    };
    const r = await runIdentityFuturesPaperTick(opts(fetchImpl));
    expect([r.outcome, r.signOut]).toEqual(["TOKEN_WRONG_IDENTITY", "SIGNED_OUT"]);
    expect(paths).toEqual(["/auth/v1/token?grant_type=password", "/auth/v1/logout?scope=local"]);
  });
});
