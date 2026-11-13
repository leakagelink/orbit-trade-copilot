// Bounded sign-in / sign-out lifecycle for a dedicated SIGNED-IN background identity (Phase 4H.2; cleanup hardening
// Phase 4H.3) — pure and
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
//   - Phase 4H.3: one outer try/catch/finally covers the whole lifecycle; whenever a usable access token was received,
//     local sign-out is attempted exactly once, even after an unexpected exception (reported as TICK_INTERNAL_ERROR with
//     the stage). The first failure is the outcome; a failed sign-out is reported separately (SIGN_OUT_FAILED) and never
//     replaces it. Only a 2xx logout reply counts as signed out. The expected worker identity is mandatory.

export const SESSION_CODES = [
  "CONFIG_INVALID", "AUTH_INVALID_CREDENTIALS", "AUTH_RATE_LIMITED", "AUTH_UNAVAILABLE", "AUTH_TIMEOUT", "AUTH_MALFORMED_REPLY",
  "TOKEN_NOT_WORKER_ROLE", "TOKEN_WRONG_IDENTITY", "TOKEN_EXPIRED", "TOKEN_LIFETIME_TOO_SHORT", "CLOCK_SKEW",
  "SIGNED_IN", "TOKEN_REFRESHED", "TOKEN_REFRESH_FAILED", "TOKEN_REJECTED",
  "CALL_REFUSED_DEADLINE", "CALL_REFUSED_SESSION_CLOSED", "CALL_REFUSED_NOT_ALLOWLISTED",
  "TICK_COMPLETED", "TICK_DEADLINE_EXCEEDED", "TICK_BODY_FAILED", "TICK_INTERNAL_ERROR",
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
  /** REQUIRED (Phase 4H.3): the enrolled worker's user id; the token subject and the reply's user id must equal it. */
  expectedUserId: string;
  monitor?: { record(m: SessionMetric): void };
}
/** Where an unexpected exception happened (bounded). */
export type SessionStage = "SIGN_IN" | "VERIFY" | "REFRESH" | "CALL" | "BODY";
/** SIGNED_OUT only when the auth server acknowledged the local logout with 2xx; NOT_REQUIRED when no usable token came back. */
export type SignOutStatus = "SIGNED_OUT" | "SIGN_OUT_FAILED" | "NOT_REQUIRED";
export interface SessionResult<T> {
  /** The FIRST failure of the tick (or TICK_COMPLETED); the sign-out result never replaces it. */
  outcome: SessionCode; result?: T; retryAfterMs?: number;
  /** True when a usable access token was received (a server-side session may exist). */
  signedIn: boolean;
  /** Same as `signOut === "SIGNED_OUT"`. It never claims the session ended when the logout was not acknowledged. */
  signedOut: boolean; signOut: SignOutStatus;
  refreshes: number; callDeadlineAt: number | null;
  /** Stage of the first unexpected exception, if any. */
  internalError: SessionStage | null;
  /** Monitor records that threw or rejected (ignored; they never affect the tick). */
  monitorFailures: number;
  metrics: SessionMetric[];
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
export function readTokenClaims(token: string): { sub: string; role: string; exp: number; iat: number | null; anonymous: boolean } | null {
  if (typeof token !== "string" || token.length > 8192 || !JWT.test(token)) return null;
  try {
    const p = b64urlJson(token.split(".")[1]!) as Record<string, unknown>;
    if (typeof p["sub"] !== "string" || typeof p["role"] !== "string" || typeof p["exp"] !== "number" || !Number.isFinite(p["exp"])) return null;
    return { sub: p["sub"], role: p["role"], exp: p["exp"], iat: typeof p["iat"] === "number" && Number.isFinite(p["iat"]) ? p["iat"] : null, anonymous: p["is_anonymous"] === true };
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
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/**
 * Checks an issued session (sign-in or refresh) against the local clock; never returns token text in a failure.
 * Phase 4H.3: the reply's `user` object is MANDATORY and its `id` must be a UUID equal to the token subject, which must
 * equal the expected enrolled worker. Decoded claims are NOT signature verification — the data API verifies the
 * signature on every call, and the database (the per-call identity check of draft 0054) independently re-checks the caller's current
 * identity status, roles and enrollment on every worker call.
 */
export function verifyIssuedSession(body: unknown, now: number, o: { minTokenLifetimeMs: number; maxClockSkewMs: number; expectedSub: string }): Verified {
  if (!isPlainObject(body)) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "BODY" };
  const access = body["access_token"], refresh = body["refresh_token"], expiresIn = body["expires_in"], user = body["user"];
  if (typeof access !== "string" || typeof refresh !== "string" || refresh.length < 8 || refresh.length > 4096) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "TOKENS" };
  const c = readTokenClaims(access);
  if (!c) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "CLAIMS" };
  if (!isPlainObject(user) || typeof user["id"] !== "string" || !UUID.test(user["id"])) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "USER" };
  if (!UUID.test(c.sub) || user["id"].toLowerCase() !== c.sub.toLowerCase()) return { ok: false, code: "AUTH_MALFORMED_REPLY", detail: "SUBJECT" };
  if (c.role !== "authenticated") return { ok: false, code: "TOKEN_NOT_WORKER_ROLE", detail: AUTH_ERROR_CODE.test(c.role) ? c.role : "OTHER" };
  if (c.anonymous || user["is_anonymous"] === true) return { ok: false, code: "TOKEN_NOT_WORKER_ROLE", detail: "anonymous" };
  if (typeof o.expectedSub !== "string" || !UUID.test(o.expectedSub) || c.sub.toLowerCase() !== o.expectedSub.toLowerCase()) return { ok: false, code: "TOKEN_WRONG_IDENTITY" };
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

/** Codes that describe a failure of the tick. The FIRST one recorded is the tick's outcome; cleanup never replaces it. */
const FAILURE_CODES: ReadonlySet<SessionCode> = new Set<SessionCode>([
  "CONFIG_INVALID", "AUTH_INVALID_CREDENTIALS", "AUTH_RATE_LIMITED", "AUTH_UNAVAILABLE", "AUTH_TIMEOUT", "AUTH_MALFORMED_REPLY",
  "TOKEN_NOT_WORKER_ROLE", "TOKEN_WRONG_IDENTITY", "TOKEN_EXPIRED", "TOKEN_LIFETIME_TOO_SHORT", "CLOCK_SKEW",
  "TOKEN_REFRESH_FAILED", "TOKEN_REJECTED", "TICK_DEADLINE_EXCEEDED", "TICK_BODY_FAILED", "TICK_INTERNAL_ERROR",
]);

/**
 * One signed-in tick. The body receives a guarded call function and the call deadline; it must not keep a token.
 *
 * Cleanup structure (Phase 4H.3): the whole lifecycle after configuration — clock reads, timers, sign-in, token
 * validation, refresh, the body, the guarded calls and their transports — runs inside ONE try/catch/finally. The
 * finally block attempts a local-scope sign-out EXACTLY ONCE whenever a usable access token (JWT-shaped) was received,
 * even after an unexpected exception, then forgets every token. The sign-out step itself never throws, never retries,
 * never changes the tick outcome and reports `SIGN_OUT_FAILED` (never `signedOut: true`) unless the auth server
 * acknowledged the logout with a 2xx reply.
 */
export async function runWithWorkerSession<T>(o: SessionOptions, body: (call: GuardedCall, ctx: { callDeadlineAt: number; signal: AbortSignal }) => Promise<T>): Promise<SessionResult<T>> {
  const metrics: SessionMetric[] = [];
  let firstFailure: SessionCode | null = null, internalError: SessionStage | null = null, monitorFailures = 0, sealed = false;
  const rec = (m: SessionMetric) => {
    if (sealed) return; // nothing is recorded or reported after the result was returned (e.g. a late refusal)
    metrics.push(m);
    if (firstFailure === null && FAILURE_CODES.has(m.code)) firstFailure = m.code;
    try {
      const p = o.monitor?.record(m) as unknown;
      if (p && typeof (p as { then?: unknown }).then === "function") (p as Promise<unknown>).then(undefined, () => { monitorFailures++; });
    } catch { monitorFailures++; /* monitoring never blocks or fails the tick */ }
  };
  const internal = (stage: SessionStage) => { internalError ??= stage; rec({ code: "TICK_INTERNAL_ERROR", detail: stage }); };
  const finish = (x: { result?: T; retryAfterMs?: number }, signedIn: boolean, signOut: SignOutStatus, refreshes: number, callDeadlineAt: number | null): SessionResult<T> => {
    sealed = true;
    const out: SessionResult<T> = { outcome: firstFailure ?? "TICK_COMPLETED", signedIn, signedOut: signOut === "SIGNED_OUT", signOut, refreshes, callDeadlineAt, internalError, monitorFailures, metrics: [...metrics] };
    if (x.result !== undefined) out.result = x.result;
    if (x.retryAfterMs !== undefined) out.retryAfterMs = x.retryAfterMs;
    return out;
  };

  let L: Required<SessionLimits> | null = null, expected: string | null = null;
  try { L = validateLimits(o.limits); expected = typeof o.expectedUserId === "string" && UUID.test(o.expectedUserId) ? o.expectedUserId : null; } catch { L = null; }
  if (!L || !expected) { rec({ code: "CONFIG_INVALID", detail: L ? "EXPECTED_USER" : "LIMITS" }); return finish({}, false, "NOT_REQUIRED", 0, null); }
  const lim = L, expectedSub = expected;
  const timers: Timers = o.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
  const now = () => o.clock.now();
  const safeNow = (): number | null => { try { const t = now(); return typeof t === "number" && Number.isFinite(t) ? t : null; } catch { return null; } };
  const httpDetail = (st: unknown) => `HTTP_${typeof st === "number" && Number.isSafeInteger(st) && st >= 100 && st <= 599 ? st : "XXX"}`;

  /** Runs one sign-in/refresh request with its own deadline. Transport failures resolve; only clock/timer faults throw. */
  async function bounded(ms: number, f: (s: AbortSignal) => Promise<AuthReply>): Promise<{ reply?: AuthReply; timedOut?: true; thrown?: true; latencyMs: number }> {
    const ctl = new AbortController(), s0 = now();
    // The timer is armed BEFORE the request starts and outside a Promise executor, so a timer fault throws here and
    // the request is never sent without a deadline (a sent-but-unread sign-in could leave an unknown session).
    let fire: (v: { timedOut: true }) => void = () => {};
    const timeout = new Promise<{ timedOut: true }>((r) => { fire = r; });
    const h = timers.setTimeout(() => { ctl.abort(); fire({ timedOut: true }); }, Math.max(1, ms));
    try {
      let p: Promise<AuthReply>;
      try { p = Promise.resolve(f(ctl.signal)); } catch { p = Promise.reject(new Error("transport")); }
      const r = await Promise.race([p.then((reply) => (reply && typeof reply === "object" ? { reply } : { thrown: true as const }), () => ({ thrown: true as const })), timeout]);
      return { ...r, latencyMs: now() - s0 };
    } finally { timers.clearTimeout(h); }
  }

  // Session state lives only in this closure; every token is cleared in the finally block below.
  let token: Token | null = null, issued: string | null = null, closed = false, refreshes = 0, callDeadlineAt: number | null = null;
  let stage: SessionStage = "SIGN_IN";
  const tickCtl = new AbortController();
  const vopts = (sub: string) => ({ minTokenLifetimeMs: lim.minTokenLifetimeMs, maxClockSkewMs: lim.maxClockSkewMs, expectedSub: sub });

  async function signInAndRun(): Promise<{ result?: T; retryAfterMs?: number }> {
    const t0 = now(), bodyEnd = t0 + lim.tickBudgetMs - lim.signOutTimeoutMs; // the sign-out reserve keeps the whole tick inside its budget
    if (!Number.isFinite(bodyEnd)) throw new Error("clock");
    const deadlineFor = (t: Token) => Math.min(bodyEnd, t.expiryAt - lim.tokenSafetyMs);
    // ---------- sign in (exactly once, never retried) ----------
    const si = await bounded(lim.authTimeoutMs, (s) => o.auth.signIn(s));
    if (si.timedOut) { rec({ code: "AUTH_TIMEOUT", latencyMs: si.latencyMs }); return {}; }
    if (si.thrown || !si.reply) { rec({ code: "AUTH_UNAVAILABLE", detail: "NETWORK", latencyMs: si.latencyMs }); return {}; }
    const st = si.reply.status, replyBody = si.reply.body;
    if (st === 429) { rec({ code: "AUTH_RATE_LIMITED", detail: "HTTP_429", latencyMs: si.latencyMs }); return { retryAfterMs: cooldownMs(si.reply.retryAfterSec, lim.rateLimitCooldownMs) }; }
    if (typeof st !== "number" || st < 200 || st > 299) {
      const ec = errorCode(replyBody);
      const bad = (st === 400 || st === 401 || st === 403 || st === 422) && (ec === null || INVALID_CREDENTIAL_CODES.has(ec));
      rec({ code: bad ? "AUTH_INVALID_CREDENTIALS" : "AUTH_UNAVAILABLE", detail: ec ?? httpDetail(st), latencyMs: si.latencyMs });
      return {};
    }
    // A session now exists on the auth server: from here on it is signed out in the finally block, whatever happens.
    stage = "VERIFY";
    const rawAccess = isPlainObject(replyBody) ? replyBody["access_token"] : null;
    issued = typeof rawAccess === "string" && rawAccess.length <= 8192 && JWT.test(rawAccess) ? rawAccess : null;
    const v = verifyIssuedSession(replyBody, now(), vopts(expectedSub));
    if (!v.ok) { rec({ code: v.code, detail: v.detail ?? null }); return {}; }
    token = v.token; issued = token.access; callDeadlineAt = deadlineFor(token);
    rec({ code: "SIGNED_IN", latencyMs: si.latencyMs });

    let refreshing: Promise<boolean> | null = null;
    const tryRefresh = async (): Promise<boolean> => {
      try {
        if (!token || closed || refreshes >= lim.maxRefreshes) return false;
        if (now() + lim.authTimeoutMs + lim.rpcTimeoutMs > bodyEnd) return false; // no budget for a refresh and a call
        refreshes++;
        const cur = token;
        const r = await bounded(lim.authTimeoutMs, (s) => o.auth.refresh(cur.refresh, s));
        if (closed) return false; // the tick ended while refreshing: never store a token after cleanup started
        const rs = r.reply?.status;
        if (!r.reply || r.timedOut || r.thrown || typeof rs !== "number" || rs < 200 || rs > 299) {
          const detail = r.timedOut ? "TIMEOUT" : r.thrown || !r.reply ? "NETWORK" : rs === 429 ? "HTTP_429" : errorCode(r.reply.body) ?? httpDetail(rs);
          rec({ code: "TOKEN_REFRESH_FAILED", detail, latencyMs: r.latencyMs }); closed = true; return false;
        }
        const nv = verifyIssuedSession(r.reply.body, now(), vopts(cur.sub));
        if (!nv.ok) { rec({ code: "TOKEN_REFRESH_FAILED", detail: nv.code }); closed = true; return false; }
        token = nv.token; issued = token.access; callDeadlineAt = deadlineFor(token);
        rec({ code: "TOKEN_REFRESHED", latencyMs: r.latencyMs });
        return true;
      } catch {
        internal("REFRESH"); rec({ code: "TOKEN_REFRESH_FAILED", detail: "EXCEPTION" }); closed = true; return false;
      }
    };
    const refuse = (code: SessionCode): DataReply => { rec({ code }); return { data: null, error: { code: null, message: `worker session: call not started (${code})` }, status: LOCAL_REFUSAL_STATUS }; };
    const call: GuardedCall = async (fn, args, signal) => {
      // Before the transport is invoked nothing can have been written, so an internal fault is answered as "not started".
      let target: string, access: string;
      try {
        try { target = o.resolveFn(fn); } catch { return refuse("CALL_REFUSED_NOT_ALLOWLISTED"); }
        if (closed || !token || tickCtl.signal.aborted) return refuse("CALL_REFUSED_SESSION_CLOSED");
        if (now() + lim.rpcTimeoutMs > bodyEnd) return refuse("CALL_REFUSED_DEADLINE");
        if (now() + lim.rpcTimeoutMs > (callDeadlineAt ?? 0)) { // only the token blocks this call: refresh at most once
          refreshing ??= tryRefresh().finally(() => { refreshing = null; });
          const ok = await refreshing;
          if (closed || !token) return refuse("CALL_REFUSED_SESSION_CLOSED");
          if (!ok || now() + lim.rpcTimeoutMs > (callDeadlineAt ?? 0)) return refuse("CALL_REFUSED_DEADLINE");
        }
        access = token.access;
      } catch { internal("CALL"); closed = true; return refuse("CALL_REFUSED_SESSION_CLOSED"); }
      // The transport may have written: its own exceptions reach the body unchanged (the hosted classifier treats a
      // thrown call as an UNKNOWN outcome and never resends a commit).
      const r = await o.data(target, args, access, signal);
      try {
        const code = r?.error?.code ?? null;
        if (r && (r.status === 401 || code === "PGRST301" || code === "PGRST302" || code === "PGRST303")) {
          if (!closed) rec({ code: "TOKEN_REJECTED", detail: typeof code === "string" && /^PGRST30[1-3]$/.test(code) ? code : httpDetail(r.status ?? 0) });
          closed = true;
        }
      } catch { internal("CALL"); closed = true; }
      return r;
    };

    // ---------- body, stopped at the body deadline ----------
    stage = "BODY";
    // Armed before the body starts (outside a Promise executor): if the deadline cannot be armed, the body never runs.
    let late: (v: { late: true }) => void = () => {};
    const stop = new Promise<{ late: true }>((r) => { late = r; });
    const h = timers.setTimeout(() => late({ late: true }), Math.max(1, bodyEnd - now()));
    try {
      let p: Promise<T>;
      try { p = Promise.resolve(body(call, { callDeadlineAt: callDeadlineAt!, signal: tickCtl.signal })); } catch { p = Promise.reject(new Error("body")); }
      const r = await Promise.race([p.then((value) => ({ value }), () => ({ failed: true as const })), stop]);
      if ("late" in r) { closed = true; tickCtl.abort(); rec({ code: "TICK_DEADLINE_EXCEEDED" }); return {}; }
      if ("failed" in r) { rec({ code: "TICK_BODY_FAILED" }); return {}; }
      if (firstFailure === null) rec({ code: "TICK_COMPLETED" });
      return { result: r.value };
    } finally { timers.clearTimeout(h); }
  }

  /** Exactly one local-scope sign-out attempt. Never throws, never retries, never exposes the token. */
  async function signOutOnce(access: string): Promise<SignOutStatus> {
    const ms = Math.max(1, lim.signOutTimeoutMs), ctl = new AbortController(), s0 = safeNow();
    let h: unknown = null, globalTimer = false, detail = "EXCEPTION", status: SignOutStatus = "SIGN_OUT_FAILED";
    try {
      const timeout = new Promise<{ timedOut: true }>((r) => {
        const fire = () => { try { ctl.abort(); } catch { /* */ } r({ timedOut: true }); };
        try { h = timers.setTimeout(fire, ms); } catch { globalTimer = true; h = globalThis.setTimeout(fire, ms); } // a faulty injected timer must not skip sign-out
      });
      let p: Promise<AuthReply>;
      try { p = Promise.resolve(o.auth.signOut(access, ctl.signal)); } catch { p = Promise.reject(new Error("transport")); }
      const r = await Promise.race([p.then((reply) => ({ reply }), () => ({ thrown: true as const })), timeout]);
      if ("timedOut" in r) detail = "TIMEOUT";
      else if ("thrown" in r || !r.reply || typeof r.reply !== "object") detail = "NETWORK";
      else {
        const s = r.reply.status;
        if (typeof s === "number" && s >= 200 && s <= 299) status = "SIGNED_OUT";
        else detail = s === 429 ? "HTTP_429" : httpDetail(s); // 401/403/404 do NOT prove the server session ended
      }
    } catch { detail = "EXCEPTION"; status = "SIGN_OUT_FAILED"; }
    finally { try { if (globalTimer) globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>); else timers.clearTimeout(h); } catch { /* */ } }
    const e = safeNow(), latencyMs = s0 !== null && e !== null ? e - s0 : undefined;
    rec(status === "SIGNED_OUT" ? { code: "SIGNED_OUT", ...(latencyMs !== undefined ? { latencyMs } : {}) } : { code: "SIGN_OUT_FAILED", detail, ...(latencyMs !== undefined ? { latencyMs } : {}) });
    return status;
  }

  let run: { result?: T; retryAfterMs?: number } = {};
  let signOut: SignOutStatus = "NOT_REQUIRED", signedIn = false;
  try { run = await signInAndRun(); }
  catch { internal(stage); run = {}; }
  finally {
    // ---------- cleanup: close the session, sign out exactly once (local scope), forget every token ----------
    closed = true;
    try { if (!tickCtl.signal.aborted) tickCtl.abort(); } catch { /* */ }
    const access = issued;
    token = null; issued = null;
    signedIn = access !== null;
    if (access !== null) signOut = await signOutOnce(access);
  }
  return finish(run, signedIn, signOut, refreshes, callDeadlineAt);
}
