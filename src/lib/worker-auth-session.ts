// Bounded sign-in / sign-out lifecycle for a dedicated SIGNED-IN background identity (Phase 4H.2) — pure and
// browser-safe. It has no network, environment or database access of its own: the caller injects the auth and data
// transports (the only binding is the disabled server file of the paper worker identity). Nothing in the app imports a
// binding that calls it; there is no route, schedule or background job.
//
// Lifecycle of ONE tick: sign in once → verify the issued token (shape, subject, "authenticated" role, issue time,
// lifetime) → derive a strict call deadline that ends BEFORE both the tick budget (minus the sign-out reserve) and the
// token's own expiry (minus a safety margin) → run the body with a guarded call function → stop the body at the
// deadline → sign out exactly once (local scope: only this session) → forget every token.
// Guarantees:
//   - No data call starts unless it can finish (call timeout) before the deadline; refused calls are answered locally
//     with a reply the hosted classifier treats as "nothing was written" (never as an unknown outcome).
//   - The token is refreshed at most once per tick, only between calls, and only when the token (not the budget) would
//     block the next call; a failed refresh closes the session — nothing is retried.
//   - A token the data API rejects (401 / JWT error) closes the session for the rest of the tick.
//   - Auth rate limits (429) end the tick with a bounded cooldown hint; there is no retry inside a tick.
//   - Metrics and results carry bounded codes only — never a token, password, e-mail, header or provider message.

export const SESSION_CODES = [
  "CONFIG_INVALID", "AUTH_INVALID_CREDENTIALS", "AUTH_RATE_LIMITED", "AUTH_UNAVAILABLE", "AUTH_TIMEOUT", "AUTH_MALFORMED_REPLY",
  "TOKEN_NOT_WORKER_ROLE", "TOKEN_WRONG_IDENTITY", "TOKEN_EXPIRED", "TOKEN_LIFETIME_TOO_SHORT", "CLOCK_SKEW",
  "SIGNED_IN", "TOKEN_REFRESHED", "TOKEN_REFRESH_FAILED", "TOKEN_REJECTED",
  "CALL_REFUSED_DEADLINE", "CALL_REFUSED_SESSION_CLOSED", "CALL_REFUSED_NOT_ALLOWLISTED",
  "TICK_COMPLETED", "TICK_DEADLINE_EXCEEDED", "TICK_BODY_FAILED",
  "SIGNED_OUT", "SIGN_OUT_FAILED",
] as const;
export type SessionCode = (typeof SESSION_CODES)[number];
/** `detail` is a bounded code (HTTP status, allowlisted auth error code or a fixed word) — never free text. */
export interface SessionMetric { code: SessionCode; detail?: string | null; latencyMs?: number }

export interface AuthReply { status: number; body: unknown; retryAfterSec?: number | null }
/** The binding captures the credentials; this module never sees a password or e-mail. */
export interface WorkerAuthTransport {
  signIn(signal: AbortSignal): Promise<AuthReply>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<AuthReply>;
  signOut(accessToken: string, signal: AbortSignal): Promise<AuthReply>;
}
export interface DataReply { data: unknown; error: { code?: string | null; message?: string | null } | null; status?: number }
export type DataTransport = (fn: string, args: Record<string, unknown>, accessToken: string, signal: AbortSignal) => Promise<DataReply>;
export type GuardedCall = (fn: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<DataReply>;

export interface SessionLimits {
  /** Whole tick, sign-in to sign-out. Required: it must be below the scheduler's request timeout (not documented exactly). */
  tickBudgetMs: number;
  /** The per-call deadline used by the data port (hosted `timeoutMs`). */
  rpcTimeoutMs: number;
  authTimeoutMs?: number;
  signOutTimeoutMs?: number;
  tokenSafetyMs?: number;
  minTokenLifetimeMs?: number;
  maxClockSkewMs?: number;
  maxRefreshes?: 0 | 1;
  rateLimitCooldownMs?: { min: number; max: number };
}
/** Engineering defaults — NOT APPROVED policy values (register S1–S8 in docs/phase-4h2/token-lifecycle-report.md). */
export const SESSION_DEFAULTS = Object.freeze({
  authTimeoutMs: 3_000, signOutTimeoutMs: 2_000, tokenSafetyMs: 60_000, minTokenLifetimeMs: 120_000,
  maxClockSkewMs: 30_000, maxRefreshes: 1 as 0 | 1, rateLimitCooldownMs: Object.freeze({ min: 60_000, max: 900_000 }),
});

type Timers = { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
export interface SessionOptions {
  auth: WorkerAuthTransport; data: DataTransport;
  /** Maps an allowed logical name to the database function; throws for anything else. */
  resolveFn: (fn: string) => string;
  limits: SessionLimits; clock: { now(): number }; timers?: Timers;
  /** When known, the token subject must equal it. */
  expectedUserId?: string | null;
  monitor?: { record(m: SessionMetric): void };
}
export interface SessionResult<T> {
  outcome: SessionCode; result?: T; retryAfterMs?: number;
  signedIn: boolean; signedOut: boolean; refreshes: number; callDeadlineAt: number | null; metrics: SessionMetric[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const AUTH_ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const INVALID_CREDENTIAL_CODES = new Set(["invalid_credentials", "invalid_grant", "email_not_confirmed", "user_banned", "user_not_found", "validation_failed"]);
/** Local refusal: classified by the hosted adapter as transient ("nothing was written"), never as an unknown outcome. */
export const LOCAL_REFUSAL_STATUS = 401;

function b64urlJson(part: string): unknown {
  const s = part.replace(/-/g, "+").replace(/_/g, "/"), pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return JSON.parse(globalThis.atob(s + pad));
}
/** Reads timing/identity claims WITHOUT verifying the signature (the data API verifies it); returns null when malformed. */
export function readTokenClaims(token: string): { sub: string; role: string; exp: number; iat: number | null } | null {
  if (typeof token !== "string" || token.length > 8192 || !JWT.test(token)) return null;
  try {
    const p = b64urlJson(token.split(".")[1]!) as Record<string, unknown>;
    if (typeof p["sub"] !== "string" || typeof p["role"] !== "string" || typeof p["exp"] !== "number" || !Number.isFinite(p["exp"])) return null;
    return { sub: p["sub"], role: p["role"], exp: p["exp"], iat: typeof p["iat"] === "number" && Number.isFinite(p["iat"]) ? p["iat"] : null };
  } catch { return null; }
}
const errorCode = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>, c = b["error_code"] ?? b["error"] ?? b["code"];
  return typeof c === "string" && AUTH_ERROR_CODE.test(c) ? c : null;
};
export function cooldownMs(retryAfterSec: number | null | undefined, bounds: { min: number; max: number } = SESSION_DEFAULTS.rateLimitCooldownMs): number {
  const ms = typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.ceil(retryAfterSec) * 1000 : bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, ms));
}

type Token = { access: string; refresh: string; sub: string; expiryAt: number };
type Verified = { ok: true; token: Token } | { ok: false; code: SessionCode; detail?: string | null };
/** Checks an issued session (sign-in or refresh) against the local clock; never returns token text in a failure. */
export function verifyIssuedSession(body: unknown, now: number, o: { minTokenLifetimeMs: number; maxClockSkewMs: number; expectedSub?: string | null }): Verified {
  if (!body || typeof body !== "object") return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "BODY" };
  const b = body as Record<string, unknown>, user = b["user"] as Record<string, unknown> | undefined;
  const access = b["access_token"], refresh = b["refresh_token"], expiresIn = b["expires_in"];
  if (typeof access !== "string" || typeof refresh !== "string" || refresh.length < 8 || refresh.length > 4096) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "TOKENS" };
  const c = readTokenClaims(access);
  if (!c) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "CLAIMS" };
  if (!UUID.test(c.sub) || (user && typeof user["id"] === "string" && user["id"] !== c.sub)) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "SUBJECT" };
  if (c.role !== "authenticated") return { ok: false, code: "TOKEN_NOT_WORKER_ROLE", detail: AUTH_ERROR_CODE.test(c.role) ? c.role : "OTHER" };
  if (o.expectedSub && c.sub !== o.expectedSub) return { ok: false, code: "TOKEN_WRONG_IDENTITY" };
  if (c.iat !== null && c.iat * 1000 > now + o.maxClockSkewMs) return { ok: false, code: "CLOCK_SKEW", detail: "IAT_IN_FUTURE" };
  const byClaim = c.exp * 1000, byReply = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : Number.POSITIVE_INFINITY;
  const expiryAt = Math.min(byClaim, byReply);
  if (expiryAt <= now) return { ok: false, code: "TOKEN_EXPIRED" };
  if (expiryAt - now < o.minTokenLifetimeMs) return { ok: false, code: "TOKEN_LIFETIME_TOO_SHORT" };
  return { ok: true, token: { access, refresh, sub: c.sub, expiryAt } };
}

export function validateLimits(l: SessionLimits): Required<SessionLimits> | null {
  const v = { ...SESSION_DEFAULTS, ...l } as Required<SessionLimits>;
  const pos = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
  if (![v.tickBudgetMs, v.rpcTimeoutMs, v.authTimeoutMs, v.signOutTimeoutMs, v.tokenSafetyMs, v.minTokenLifetimeMs, v.maxClockSkewMs].every(pos)) return null;
  if (v.tickBudgetMs > 600_000 || (v.maxRefreshes !== 0 && v.maxRefreshes !== 1)) return null;
  if (v.authTimeoutMs + v.rpcTimeoutMs + v.signOutTimeoutMs > v.tickBudgetMs) return null;      // at least one call must fit
  if (v.minTokenLifetimeMs <= v.tokenSafetyMs + v.rpcTimeoutMs) return null;                       // a fresh token must allow a call
  if (!pos(v.rateLimitCooldownMs?.min) || !pos(v.rateLimitCooldownMs?.max) || v.rateLimitCooldownMs.min > v.rateLimitCooldownMs.max) return null;
  return v;
}

/** One signed-in tick. The body receives a guarded call function and the call deadline; it must not keep a token. */
export async function runWithWorkerSession<T>(o: SessionOptions, body: (call: GuardedCall, ctx: { callDeadlineAt: number; signal: AbortSignal }) => Promise<T>): Promise<SessionResult<T>> {
  const metrics: SessionMetric[] = [];
  const rec = (m: SessionMetric) => { metrics.push(m); try { o.monitor?.record(m); } catch { /* monitoring never blocks */ } };
  const L = validateLimits(o.limits);
  if (!L) { rec({ code: "CONFIG_INVALID" }); return { outcome: "CONFIG_INVALID", signedIn: false, signedOut: false, refreshes: 0, callDeadlineAt: null, metrics }; }
  const timers: Timers = o.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
  const now = () => o.clock.now();
  const t0 = now(), bodyEnd = t0 + L.tickBudgetMs - L.signOutTimeoutMs; // the sign-out reserve keeps the whole tick inside its budget
  const httpDetail = (st: number) => `HTTP_${Number.isSafeInteger(st) && st >= 100 && st <= 599 ? st : "XXX"}`;

  /** Runs one transport call with its own deadline; never throws. */
  async function bounded(ms: number, f: (s: AbortSignal) => Promise<AuthReply>): Promise<{ reply?: AuthReply; timedOut?: true; thrown?: true; latencyMs: number }> {
    const ctl = new AbortController(), s0 = now(); let h: unknown;
    const timeout = new Promise<{ timedOut: true }>((r) => { h = timers.setTimeout(() => { ctl.abort(); r({ timedOut: true }); }, Math.max(1, ms)); });
    try {
      let p: Promise<AuthReply>;
      try { p = f(ctl.signal); } catch { p = Promise.reject(new Error("transport")); }
      const r = await Promise.race([p.then((reply) => ({ reply }), () => ({ thrown: true as const })), timeout]);
      return { ...r, latencyMs: now() - s0 };
    } finally { timers.clearTimeout(h); }
  }

  // Session state lives only in this closure; it is cleared before returning.
  let token: Token | null = null, issued: string | null = null, closed = false, refreshes = 0, callDeadlineAt: number | null = null;
  const tickCtl = new AbortController();
  const deadlineFor = (t: Token) => Math.min(bodyEnd, t.expiryAt - L.tokenSafetyMs);
  const vopts = (expectedSub: string | null) => ({ minTokenLifetimeMs: L.minTokenLifetimeMs, maxClockSkewMs: L.maxClockSkewMs, expectedSub });

  async function signInAndRun(): Promise<{ outcome: SessionCode; result?: T; retryAfterMs?: number }> {
    // ---------- sign in (exactly once, never retried) ----------
    const si = await bounded(L!.authTimeoutMs, (s) => o.auth.signIn(s));
    if (si.timedOut) { rec({ code: "AUTH_TIMEOUT", latencyMs: si.latencyMs }); return { outcome: "AUTH_TIMEOUT" }; }
    if (si.thrown || !si.reply) { rec({ code: "AUTH_UNAVAILABLE", detail: "NETWORK", latencyMs: si.latencyMs }); return { outcome: "AUTH_UNAVAILABLE" }; }
    const st = si.reply.status;
    if (st === 429) { rec({ code: "AUTH_RATE_LIMITED", detail: "HTTP_429", latencyMs: si.latencyMs }); return { outcome: "AUTH_RATE_LIMITED", retryAfterMs: cooldownMs(si.reply.retryAfterSec, L!.rateLimitCooldownMs) }; }
    if (st < 200 || st > 299) {
      const ec = errorCode(si.reply.body);
      const bad = (st === 400 || st === 401 || st === 403 || st === 422) && (ec === null || INVALID_CREDENTIAL_CODES.has(ec));
      const code: SessionCode = bad ? "AUTH_INVALID_CREDENTIALS" : "AUTH_UNAVAILABLE";
      rec({ code, detail: ec ?? httpDetail(st), latencyMs: si.latencyMs });
      return { outcome: code };
    }
    const b = si.reply.body as Record<string, unknown> | null;
    // A session now exists on the auth server: it is signed out below even if the token is refused here.
    issued = b && typeof b["access_token"] === "string" && JWT.test(b["access_token"]) ? b["access_token"] : null;
    const v = verifyIssuedSession(si.reply.body, now(), vopts(o.expectedUserId ?? null));
    if (!v.ok) { rec({ code: v.code, detail: v.detail ?? null }); return { outcome: v.code }; }
    token = v.token; issued = token.access; callDeadlineAt = deadlineFor(token);
    rec({ code: "SIGNED_IN", latencyMs: si.latencyMs });

    let refreshing: Promise<boolean> | null = null;
    const tryRefresh = async (): Promise<boolean> => {
      if (!token || closed || refreshes >= L!.maxRefreshes) return false;
      if (now() + L!.authTimeoutMs + L!.rpcTimeoutMs > bodyEnd) return false; // no budget for a refresh and a call
      refreshes++;
      const cur = token;
      const r = await bounded(L!.authTimeoutMs, (s) => o.auth.refresh(cur.refresh, s));
      if (!r.reply || r.timedOut || r.thrown || r.reply.status < 200 || r.reply.status > 299) {
        const detail = r.timedOut ? "TIMEOUT" : r.thrown || !r.reply ? "NETWORK" : r.reply.status === 429 ? "HTTP_429" : errorCode(r.reply.body) ?? httpDetail(r.reply.status);
        rec({ code: "TOKEN_REFRESH_FAILED", detail, latencyMs: r.latencyMs }); closed = true; return false;
      }
      const nv = verifyIssuedSession(r.reply.body, now(), vopts(cur.sub));
      if (!nv.ok) { rec({ code: "TOKEN_REFRESH_FAILED", detail: nv.code }); closed = true; return false; }
      token = nv.token; issued = token.access; callDeadlineAt = deadlineFor(token);
      rec({ code: "TOKEN_REFRESHED", latencyMs: r.latencyMs });
      return true;
    };
    const refuse = (code: SessionCode): DataReply => { rec({ code }); return { data: null, error: { code: null, message: `worker session: call not started (${code})` }, status: LOCAL_REFUSAL_STATUS }; };
    const call: GuardedCall = async (fn, args, signal) => {
      let target: string;
      try { target = o.resolveFn(fn); } catch { return refuse("CALL_REFUSED_NOT_ALLOWLISTED"); }
      if (closed || !token || tickCtl.signal.aborted) return refuse("CALL_REFUSED_SESSION_CLOSED");
      if (now() + L!.rpcTimeoutMs > bodyEnd) return refuse("CALL_REFUSED_DEADLINE");
      if (now() + L!.rpcTimeoutMs > (callDeadlineAt ?? 0)) { // only the token blocks this call: refresh at most once
        refreshing ??= tryRefresh().finally(() => { refreshing = null; });
        const ok = await refreshing;
        if (closed || !token) return refuse("CALL_REFUSED_SESSION_CLOSED");
        if (!ok || now() + L!.rpcTimeoutMs > (callDeadlineAt ?? 0)) return refuse("CALL_REFUSED_DEADLINE");
      }
      const r = await o.data(target, args, token.access, signal);
      const code = r?.error?.code ?? null;
      if (r && (r.status === 401 || code === "PGRST301" || code === "PGRST302" || code === "PGRST303")) {
        if (!closed) rec({ code: "TOKEN_REJECTED", detail: typeof code === "string" && /^PGRST30[1-3]$/.test(code) ? code : httpDetail(r.status ?? 0) });
        closed = true;
      }
      return r;
    };

    // ---------- body, stopped at the body deadline ----------
    let h: unknown;
    const stop = new Promise<{ late: true }>((r) => { h = timers.setTimeout(() => r({ late: true }), Math.max(1, bodyEnd - now())); });
    try {
      let p: Promise<T>;
      try { p = body(call, { callDeadlineAt: callDeadlineAt!, signal: tickCtl.signal }); } catch { p = Promise.reject(new Error("body")); }
      const r = await Promise.race([p.then((value) => ({ value }), () => ({ failed: true as const })), stop]);
      if ("late" in r) { closed = true; tickCtl.abort(); rec({ code: "TICK_DEADLINE_EXCEEDED" }); return { outcome: "TICK_DEADLINE_EXCEEDED" }; }
      if ("failed" in r) { rec({ code: "TICK_BODY_FAILED" }); return { outcome: "TICK_BODY_FAILED" }; }
      const auth = metrics.find((m) => m.code === "TOKEN_REJECTED" || m.code === "TOKEN_REFRESH_FAILED");
      if (auth) return { outcome: auth.code, result: r.value };
      rec({ code: "TICK_COMPLETED" });
      return { outcome: "TICK_COMPLETED", result: r.value };
    } finally { timers.clearTimeout(h); }
  }

  let run: Awaited<ReturnType<typeof signInAndRun>> = { outcome: "TICK_BODY_FAILED" };
  try { run = await signInAndRun(); }
  finally {
    // ---------- sign out exactly once (local scope), then forget every token ----------
    closed = true; if (!tickCtl.signal.aborted) tickCtl.abort();
    token = null;
  }
  const access = issued; issued = null;
  let signedOut = false;
  if (access) {
    const so = await bounded(L.signOutTimeoutMs, (s) => o.auth.signOut(access, s));
    const s = so.reply?.status ?? 0;
    if (so.reply && ((s >= 200 && s <= 299) || s === 401 || s === 403 || s === 404)) { signedOut = true; rec({ code: "SIGNED_OUT", detail: s >= 200 && s <= 299 ? null : "ALREADY_INVALID", latencyMs: so.latencyMs }); }
    else rec({ code: "SIGN_OUT_FAILED", detail: so.timedOut ? "TIMEOUT" : so.thrown || !so.reply ? "NETWORK" : s === 429 ? "HTTP_429" : httpDetail(s), latencyMs: so.latencyMs });
  }
  const out: SessionResult<T> = { outcome: run.outcome, signedIn: access !== null, signedOut, refreshes, callDeadlineAt, metrics };
  if (run.result !== undefined) out.result = run.result;
  if (run.retryAfterMs !== undefined) out.retryAfterMs = run.retryAfterMs;
  return out;
}
