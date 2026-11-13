// Phase 4H.2 — worker token lifecycle (pure module, fake transports; no network, no auth service, no database).
import { describe, expect, it, vi } from "vitest";
import { classifyRpc } from "@/lib/futures-paper-worker-hosted";
import { cooldownMs, readTokenClaims, runWithWorkerSession, SESSION_CODES, validateLimits, verifyIssuedSession, type DataTransport, type SessionLimits, type SessionOptions } from "@/lib/worker-auth-session";
import { fakeAuth, fakeJwt, issued, noContent, ok, WORKER, type Step } from "./helpers/fake-auth";

const T0 = 1_800_000_000_000;
const LIMITS: SessionLimits = { tickBudgetMs: 20_000, rpcTimeoutMs: 2_000, authTimeoutMs: 1_000, signOutTimeoutMs: 1_000 };
const allow = (fn: string) => { if (!["a", "b"].includes(fn)) throw new Error("not allowlisted"); return `w_${fn}`; };
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

describe("sign-in, verification and sign-out", () => {
  it("a normal tick signs in once, runs the body with the token, signs out once (local session) and forgets the token", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
    const r = await runWithWorkerSession(s.opts, async (call) => { await call("a", {}, new AbortController().signal); await call("b", {}, new AbortController().signal); return "done"; });
    expect(r).toMatchObject({ outcome: "TICK_COMPLETED", result: "done", signedIn: true, signedOut: true, refreshes: 0 });
    expect(s.auth.log).toEqual(["signIn", "signOut"]);
    expect(s.calls.map((c) => c.fn)).toEqual(["w_a", "w_b"]);
    expect(s.auth.signOutTokens).toEqual([s.calls[0]!.token]);
    expect(codes(r)).toEqual(["SIGNED_IN", "TICK_COMPLETED", "SIGNED_OUT"]);
    // The call deadline is strictly below both the tick budget (minus the sign-out reserve) and the token lifetime.
    expect(r.callDeadlineAt).toBe(T0 + 20_000 - 1_000);
  });
  it("the call deadline follows the token when the token ends first (deadline = expiry - safety)", async () => {
    const s = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], signOut: [noContent] }, { limits: { ...LIMITS, tickBudgetMs: 600_000 } });
    const r = await runWithWorkerSession(s.opts, async () => 0);
    expect(r.callDeadlineAt).toBe(T0 + 200_000 - 60_000);
  });
  it("signs out even when the body throws or returns a rejected promise; the error text is not kept", async () => {
    for (const body of [async () => { throw new Error("password=hunter2 token=abc"); }, () => { throw new Error("sync"); }]) {
      const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
      const r = await runWithWorkerSession(s.opts, body as () => Promise<never>);
      expect(r).toMatchObject({ outcome: "TICK_BODY_FAILED", signedOut: true });
      expect(JSON.stringify(r)).not.toMatch(/hunter2|token=abc|sync/);
    }
  });
  it("failed sign-in: invalid credentials, unavailable (5xx/network), timeout and malformed replies never run the body or sign out", async () => {
    const cases: [Step, string, string | null][] = [
      [{ status: 400, body: { error_code: "invalid_credentials", msg: "Invalid login credentials for x@y.z" } }, "AUTH_INVALID_CREDENTIALS", "invalid_credentials"],
      [{ status: 400, body: { error: "invalid_grant", error_description: "secret detail" } }, "AUTH_INVALID_CREDENTIALS", "invalid_grant"],
      [{ status: 503, body: { message: "upstream" } }, "AUTH_UNAVAILABLE", "HTTP_503"],
      ["throw", "AUTH_UNAVAILABLE", "NETWORK"],
      ["hang", "AUTH_TIMEOUT", null],
    ];
    for (const [step, code, detail] of cases) {
      const s = setup({ signIn: [step] }, { limits: { ...LIMITS, authTimeoutMs: 30 } });
      const body = vi.fn(async () => 1);
      const r = await runWithWorkerSession(s.opts, body);
      expect([r.outcome, r.signedIn, r.signedOut], code).toEqual([code, false, false]);
      expect(r.metrics[0]!.detail ?? null).toBe(detail);
      expect(body).not.toHaveBeenCalled();
      expect(s.auth.log).toEqual(["signIn"]);
      expect(JSON.stringify(r)).not.toMatch(/x@y\.z|secret detail|upstream/);
    }
  });
  it("issued tokens are verified; a refused token is still signed out (a session exists on the server)", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [issued(T0, { lifeSec: -5 }), "TOKEN_EXPIRED"],
      [issued(T0, { lifeSec: 90 }), "TOKEN_LIFETIME_TOO_SHORT"],
      [issued(T0, { lifeSec: 3600, expiresIn: 60 }), "TOKEN_LIFETIME_TOO_SHORT"], // the shorter of claim and reply wins
      [issued(T0, { role: "service_role" }), "TOKEN_NOT_WORKER_ROLE"],
      [issued(T0, { role: "anon" }), "TOKEN_NOT_WORKER_ROLE"],
      [issued(T0, { iatSec: Math.floor(T0 / 1000) + 3600 }), "CLOCK_SKEW"],
      [{ ...issued(T0), user: { id: "00000000-0000-4000-8000-000000000999" } }, "AUTH_MALFORMED_REPLY"],
      [{ ...issued(T0), refresh_token: undefined }, "AUTH_MALFORMED_REPLY"],
    ];
    for (const [body, code] of cases) {
      const s = setup({ signIn: [ok(body)], signOut: [noContent] });
      const fn = vi.fn(async () => 1);
      const r = await runWithWorkerSession(s.opts, fn);
      expect([r.outcome, r.signedOut], code).toEqual([code, true]);
      expect(fn).not.toHaveBeenCalled();
      expect(s.auth.log).toEqual(["signIn", "signOut"]);
    }
    const bad = setup({ signIn: [ok({ access_token: "not-a-jwt", refresh_token: "rt-xxxxxxxx" })] });
    const r = await runWithWorkerSession(bad.opts, async () => 1);
    expect([r.outcome, r.signedIn, bad.auth.log]).toEqual(["AUTH_MALFORMED_REPLY", false, ["signIn"]]); // nothing usable to sign out
  });
  it("a token for a different identity than expected is refused and signed out", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] }, { expectedUserId: "00000000-0000-4000-8000-00000000beef" });
    const r = await runWithWorkerSession(s.opts, async () => 1);
    expect([r.outcome, r.signedOut]).toEqual(["TOKEN_WRONG_IDENTITY", true]);
  });
  // Phase 4H.3: 401/403/404 no longer count as signed out — they do not prove the server session ended.
  it("sign-out failures are recorded with bounded codes; only a 2xx logout counts as signed out", async () => {
    const cases: [Step, string, string | null, boolean][] = [
      [{ status: 401, body: null }, "SIGN_OUT_FAILED", "HTTP_401", false],
      [{ status: 403, body: null }, "SIGN_OUT_FAILED", "HTTP_403", false],
      [{ status: 404, body: null }, "SIGN_OUT_FAILED", "HTTP_404", false],
      [{ status: 429, body: null, retryAfterSec: 30 }, "SIGN_OUT_FAILED", "HTTP_429", false],
      [{ status: 500, body: { message: "boom" } }, "SIGN_OUT_FAILED", "HTTP_500", false],
      ["throw", "SIGN_OUT_FAILED", "NETWORK", false],
      ["hang", "SIGN_OUT_FAILED", "TIMEOUT", false],
    ];
    for (const [step, code, detail, out] of cases) {
      const s = setup({ signIn: [ok(issued(T0))], signOut: [step] }, { limits: { ...LIMITS, signOutTimeoutMs: 30 } });
      const r = await runWithWorkerSession(s.opts, async () => 1);
      expect([r.outcome, r.signedOut, r.metrics.at(-1)!.code, r.metrics.at(-1)!.detail ?? null]).toEqual(["TICK_COMPLETED", out, code, detail]);
      expect(s.auth.log.filter((x) => x === "signOut")).toHaveLength(1); // exactly one attempt, never retried
    }
  });
});

describe("rate limits", () => {
  it("429 on sign-in ends the tick with a bounded cooldown hint and no retry", async () => {
    for (const [ra, want] of [[undefined, 60_000], [5, 60_000], [120, 120_000], [86_400, 900_000], [Number.NaN, 60_000]] as const) {
      const s = setup({ signIn: [{ status: 429, body: { error_code: "over_request_rate_limit" }, retryAfterSec: ra ?? null }] });
      const r = await runWithWorkerSession(s.opts, async () => 1);
      expect([r.outcome, r.retryAfterMs, r.signedIn, s.auth.log]).toEqual(["AUTH_RATE_LIMITED", want, false, ["signIn"]]);
    }
    expect(cooldownMs(10, { min: 1_000, max: 5_000 })).toBe(5_000);
  });
  it("429 on refresh closes the session (no retry) and the tick still signs out", async () => {
    const s = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], refresh: [{ status: 429, body: null }], signOut: [noContent] }, { limits: { ...LIMITS, tickBudgetMs: 600_000 } });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(140_000); return (await call("a", {}, new AbortController().signal)).error?.message; });
    expect(r.outcome).toBe("TOKEN_REFRESH_FAILED");
    expect(r.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")!.detail).toBe("HTTP_429");
    expect(s.auth.log).toEqual(["signIn", "refresh", "signOut"]);
    expect(s.calls).toEqual([]);
  });
});

describe("expiry, refresh and deadlines", () => {
  const long = { ...LIMITS, tickBudgetMs: 600_000 };
  it("refreshes at most once, only when the token (not the budget) blocks the next call, and uses the new token", async () => {
    const first = issued(T0, { lifeSec: 200 });
    const s = setup({ signIn: [ok(first)], refresh: [(async () => ok(issued(T0 + 140_000, { lifeSec: 3600 })))], signOut: [noContent] }, { limits: long });
    const r = await runWithWorkerSession(s.opts, async (call) => {
      const sig = new AbortController().signal;
      await call("a", {}, sig);              // well inside the first token
      s.clock.advance(140_000);              // the next call would end inside the safety margin
      await call("b", {}, sig);
      await call("a", {}, sig);
      return 0;
    });
    expect(r).toMatchObject({ outcome: "TICK_COMPLETED", refreshes: 1, signedOut: true });
    expect(s.auth.refreshTokens).toEqual([first.refresh_token]);
    expect(s.calls[0]!.token).toBe(first.access_token);
    expect(s.calls[1]!.token).not.toBe(first.access_token);
    expect(s.auth.signOutTokens).toEqual([s.calls[1]!.token]); // the newest session is signed out
  });
  it("refresh failure (rejected, network, timeout, invalid token, other identity) stops all further calls; nothing is retried", async () => {
    const other = issued(T0 + 140_000, { sub: "00000000-0000-4000-8000-000000000777" });
    const cases: [Step, string][] = [[{ status: 400, body: { error_code: "refresh_token_not_found" } }, "refresh_token_not_found"], ["throw", "NETWORK"], ["hang", "TIMEOUT"], [ok(issued(T0 + 140_000, { lifeSec: -1 })), "TOKEN_EXPIRED"], [ok(other), "TOKEN_WRONG_IDENTITY"]];
    for (const [step, detail] of cases) {
      const s = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], refresh: [step], signOut: [noContent] }, { limits: { ...long, authTimeoutMs: 30 } });
      const r = await runWithWorkerSession(s.opts, async (call) => {
        const sig = new AbortController().signal;
        s.clock.advance(140_000);
        const a = await call("a", {}, sig), b = await call("b", {}, sig);
        return [a.error?.message, b.error?.message];
      });
      expect([r.outcome, r.metrics.find((m) => m.code === "TOKEN_REFRESH_FAILED")?.detail], detail).toEqual(["TOKEN_REFRESH_FAILED", detail]);
      expect(r.result).toEqual(["worker session: call not started (CALL_REFUSED_SESSION_CLOSED)", "worker session: call not started (CALL_REFUSED_SESSION_CLOSED)"]);
      expect(s.calls).toEqual([]);
      expect(s.auth.log).toEqual(["signIn", "refresh", "signOut"]);
    }
  });
  it("with refreshes disabled an expiring token refuses the call (deadline) instead of refreshing", async () => {
    const s = setup({ signIn: [ok(issued(T0, { lifeSec: 200 }))], signOut: [noContent] }, { limits: { ...long, maxRefreshes: 0 } });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(140_000); return (await call("a", {}, new AbortController().signal)).error?.message; });
    expect(r.result).toBe("worker session: call not started (CALL_REFUSED_DEADLINE)");
    expect(s.auth.log).toEqual(["signIn", "signOut"]);
  });
  it("no call starts after the call deadline; refused calls look like 'nothing was written' to the hosted classifier", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(17_500); return call("a", {}, new AbortController().signal); }); // 17.5 s + 2 s call > 19 s
    expect(r.result!.error!.message).toBe("worker session: call not started (CALL_REFUSED_DEADLINE)");
    expect(classifyRpc({ reply: r.result! })).toMatchObject({ kind: "transient" });
    expect(s.calls).toEqual([]);
  });
  it("a body that outlives the deadline is cut off: the session closes, the tick signal aborts and sign-out still runs within budget", async () => {
    const s = setup({ signIn: [ok(issued(Date.now()))], signOut: [noContent] }, { limits: { tickBudgetMs: 400, rpcTimeoutMs: 100, authTimeoutMs: 100, signOutTimeoutMs: 100 }, clock: { now: () => Date.now() } });
    let seen: AbortSignal | null = null, late: string | null | undefined;
    const t = Date.now();
    const r = await runWithWorkerSession(s.opts, async (call, ctx) => {
      seen = ctx.signal;
      await new Promise((res) => setTimeout(res, 600)); // e.g. a hanging market fetch
      late = (await call("a", {}, new AbortController().signal)).error?.message;
      return 1;
    });
    expect(r.outcome).toBe("TICK_DEADLINE_EXCEEDED");
    expect(Date.now() - t).toBeLessThan(550);
    expect(seen!.aborted).toBe(true);
    expect(s.auth.log).toEqual(["signIn", "signOut"]);
    await new Promise((res) => setTimeout(res, 300));
    expect(late).toBe("worker session: call not started (CALL_REFUSED_SESSION_CLOSED)");
    expect(s.calls).toEqual([]);
  });
  it("a token the data API rejects (401 / PGRST301–303) closes the session for the rest of the tick", async () => {
    for (const reply of [{ status: 401, error: { code: "PGRST303", message: "JWT expired" } }, { status: 401, error: { code: "PGRST301", message: "JWSError" } }, { status: 401, error: { code: null, message: null } }]) {
      const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
      let n = 0;
      s.opts.data = async () => { n++; return { data: null, ...reply }; };
      const r = await runWithWorkerSession(s.opts, async (call) => { const sig = new AbortController().signal; await call("a", {}, sig); return (await call("b", {}, sig)).error?.message; });
      expect([r.outcome, n, r.result]).toEqual(["TOKEN_REJECTED", 1, "worker session: call not started (CALL_REFUSED_SESSION_CLOSED)"]);
      expect(s.auth.log).toEqual(["signIn", "signOut"]);
    }
  });
  it("only allowlisted functions are reachable", async () => {
    const s = setup({ signIn: [ok(issued(T0))], signOut: [noContent] });
    const r = await runWithWorkerSession(s.opts, async (call) => (await call("fpw_admin_set_identity", {}, new AbortController().signal)).error?.message);
    expect(r.result).toBe("worker session: call not started (CALL_REFUSED_NOT_ALLOWLISTED)");
    expect(s.calls).toEqual([]);
  });
});

describe("configuration and secrecy", () => {
  it("refuses limits that cannot fit one call, a token shorter than safety + call, or out-of-range values", async () => {
    for (const l of [{ ...LIMITS, tickBudgetMs: 3_000 }, { ...LIMITS, tickBudgetMs: 0 }, { ...LIMITS, tickBudgetMs: 700_000 }, { ...LIMITS, rpcTimeoutMs: -1 }, { ...LIMITS, minTokenLifetimeMs: 61_000 }, { ...LIMITS, tickBudgetMs: 1.5 }, { ...LIMITS, maxRefreshes: 2 as 0 }]) {
      expect(validateLimits(l), JSON.stringify(l)).toBeNull();
      const s = setup({ signIn: [ok(issued(T0))] }, { limits: l });
      const r = await runWithWorkerSession(s.opts, async () => 1);
      expect([r.outcome, s.auth.log]).toEqual(["CONFIG_INVALID", []]);
    }
  });
  it("no token, refresh token, password, e-mail or provider text appears in any result, metric, monitor record or console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const seen: unknown[] = [];
    const first = issued(T0, { lifeSec: 200, refresh: "rt-SECRET-REFRESH-1" }), second = issued(T0 + 140_000, { refresh: "rt-SECRET-REFRESH-2" });
    const s = setup({ signIn: [ok(first)], refresh: [ok(second)], signOut: [{ status: 500, body: { message: "logout failed for worker@example.com" } }] }, { limits: { ...LIMITS, tickBudgetMs: 600_000 }, monitor: { record: (m) => seen.push(m) } });
    s.opts.data = async () => ({ data: null, error: { code: "P0001", message: "refused" }, status: 400 });
    const r = await runWithWorkerSession(s.opts, async (call) => { s.clock.advance(140_000); return (await call("a", {}, new AbortController().signal)).status; });
    const text = JSON.stringify([r, seen]);
    for (const secret of [first.access_token, second.access_token, "rt-SECRET-REFRESH", "worker@example.com", "logout failed", first.access_token.split(".")[1]!]) expect(text).not.toContain(secret);
    for (const sp of spies) { expect(sp).not.toHaveBeenCalled(); sp.mockRestore(); }
    for (const m of [...r.metrics, ...(seen as { code: string }[])]) expect(SESSION_CODES).toContain(m.code);
  });
  it("claim reader and verifier are strict", () => {
    expect(readTokenClaims("a.b")).toBeNull();
    expect(readTokenClaims(fakeJwt({ sub: WORKER, role: "authenticated" }))).toBeNull(); // no exp
    expect(readTokenClaims(fakeJwt({ sub: WORKER, role: "authenticated", exp: 1 }))).toMatchObject({ sub: WORKER, exp: 1 });
    expect(verifyIssuedSession(null, T0, { minTokenLifetimeMs: 1, maxClockSkewMs: 1, expectedSub: WORKER })).toMatchObject({ ok: false, code: "AUTH_MALFORMED_REPLY" });
    const v = verifyIssuedSession(issued(T0, { expiresIn: null }), T0, { minTokenLifetimeMs: 1, maxClockSkewMs: 1, expectedSub: WORKER });
    expect(v.ok && v.token.expiryAt).toBe(T0 + 3_600_000);
  });
});
