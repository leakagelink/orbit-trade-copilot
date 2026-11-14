// Server-only binding of the Futures PAPER worker as a dedicated SIGNED-IN identity (Phase 4H finalization, DRAFT 0053;
// token lifecycle Phase 4H.2, DRAFT 0054 — none applied) — DISABLED. Nothing imports this file; no route, server
// function, cron entry, scheduler or background job calls it. It refuses to run unless BOTH FUTURES_PAPER_WORKER_HOSTED
// is exactly "enabled" and FUTURES_PAPER_WORKER_IDENTITY is exactly "signed-in" (neither is set anywhere), and its
// credentials (FUTURES_PAPER_WORKER_EMAIL / FUTURES_PAPER_WORKER_PASSWORD, server-only secrets) exist, together with the
// enrolled worker's user id (FUTURES_PAPER_WORKER_USER_ID, not a secret; Phase 4H.3): the issued token's subject and the
// sign-in reply's user id must both equal it, otherwise the tick signs out and stops before any data call.
//
// It never uses the privileged server key or the admin client: it signs in with the publishable key like any user, so
// row-level security and the 0053/0054 registry/enrollment checks apply. Phase 4H.2 replaces the earlier long-lived
// client (background auto-refresh, no sign-out) with ONE bounded session per tick (`worker-auth-session.ts`): sign in
// once, verify the issued token, strict call deadline below both the tick budget and the token lifetime, at most one
// refresh, no retries, sign out (local scope) at the end. Requests are plain `fetch` calls with redirects refused and
// no library timers. It never reads back, returns, logs or forwards a credential or token, and can call ONLY the six
// 0053 wrappers (mapped from the Phase 4G allowlist).
// Phase 4H.5: by default it calls the six envelope wrappers of DRAFT 0055 instead (`gateway: "0055"`), which record
// refused calls in the database and bind every call to a live, young auth session; `gateway: "0054"` keeps the 0053
// names for the older suites. Either way only six allowlisted names can ever be requested.
import { runHostedFuturesPaperWorkerTick, type HostedRpc, type HostedTickOptions } from "./futures-paper-worker-hosted";
import { decodeIdentityEnvelope, IDENTITY_RPC, IDENTITY_RPC_V2, identityRpcName, identityRpcNameV2, WorkerIdentityError } from "./futures-paper-worker-identity";
import { runWithWorkerSession, type AuthReply, type DataReply, type DataTransport, type SessionLimits, type SessionResult, type WorkerAuthTransport } from "./worker-auth-session";
import { boundedCall, classifyInvocation, pickAccount, validateInvocationLimits, workerUserCheck, InvocationRefusal, type FitReport, type InvocationClassification, type InvocationLimits } from "./worker-invocation";
import { createJournal, type JournalEvent } from "./worker-refusal-audit";
import type { FPTimeframe, RawSymbolBundle } from "./futures-paper-market-data";
import type { FPIntent } from "./futures-paper-engine";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type IdentityGateway = "0054" | "0055";
const WRAPPERS: Readonly<Record<IdentityGateway, ReadonlySet<string>>> = Object.freeze({ "0054": new Set(Object.values(IDENTITY_RPC)), "0055": new Set(Object.values(IDENTITY_RPC_V2)) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface IdentityConfig { url: string; key: string; email: string; password: string }

/** Plain-fetch transports; the credentials stay in this closure and are only ever sent to the configured auth endpoint. */
export function identityTransports(cfg: IdentityConfig, fetchImpl: Fetch = (i, init) => globalThis.fetch(i, init), gateway: IdentityGateway = "0055"): { auth: WorkerAuthTransport; data: DataTransport } {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(cfg.url)) throw new WorkerIdentityError("IDENTITY_NOT_CONFIGURED");
  const base = cfg.url, json = { "Content-Type": "application/json", Accept: "application/json" };
  const read = async (r: Response): Promise<unknown> => { const t = await r.text(); if (!t) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
  const post = async (path: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<AuthReply> => {
    const r = await fetchImpl(base + path, { method: "POST", headers: { ...json, apikey: cfg.key, ...headers }, body: body === undefined ? null : JSON.stringify(body), signal, redirect: "error" });
    const ra = Number(r.headers.get("retry-after"));
    return { status: r.status, body: await read(r), retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null };
  };
  const auth: WorkerAuthTransport = {
    signIn: (signal) => post("/auth/v1/token?grant_type=password", { email: cfg.email, password: cfg.password }, {}, signal),
    refresh: (refreshToken, signal) => post("/auth/v1/token?grant_type=refresh_token", { refresh_token: refreshToken }, {}, signal),
    signOut: (accessToken, signal) => post("/auth/v1/logout?scope=local", undefined, { Authorization: `Bearer ${accessToken}` }, signal),
  };
  const data: DataTransport = async (fn, args, accessToken, signal): Promise<DataReply> => {
    if (!WRAPPERS[gateway].has(fn)) throw new WorkerIdentityError("IDENTITY_DISABLED"); // only the six wrappers of the chosen draft
    const r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...json, apikey: cfg.key, Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(args), signal, redirect: "error" });
    const b = await read(r);
    if (r.ok) return gateway === "0055" ? decodeIdentityEnvelope(b) : { data: b, error: null, status: r.status };
    const e = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    return { data: null, error: { code: typeof e["code"] === "string" ? e["code"] : null, message: typeof e["message"] === "string" ? e["message"] : null }, status: r.status };
  };
  return { auth, data };
}

export type IdentityTickOptions = Omit<HostedTickOptions, "rpc"> & { session: Omit<SessionLimits, "rpcTimeoutMs">; fetchImpl?: Fetch; gateway?: IdentityGateway };
/** One signed-in hosted tick: sign in → hosted tick over the six wrappers → sign out. Disabled unless both flags are set. */
export async function runIdentityFuturesPaperTick(o: IdentityTickOptions): Promise<SessionResult<Awaited<ReturnType<typeof runHostedFuturesPaperWorkerTick>>>> {
  if (process.env["FUTURES_PAPER_WORKER_HOSTED"] !== "enabled" || process.env["FUTURES_PAPER_WORKER_IDENTITY"] !== "signed-in") throw new WorkerIdentityError("IDENTITY_DISABLED");
  const url = process.env["SUPABASE_URL"], key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const email = process.env["FUTURES_PAPER_WORKER_EMAIL"], password = process.env["FUTURES_PAPER_WORKER_PASSWORD"];
  const workerUserId = process.env["FUTURES_PAPER_WORKER_USER_ID"];
  if (!url || !key || !email || !password || !workerUserId || !UUID.test(workerUserId)) throw new WorkerIdentityError("IDENTITY_NOT_CONFIGURED");
  const gateway: IdentityGateway = o.gateway === "0054" ? "0054" : "0055";
  const { auth, data } = identityTransports({ url, key, email, password }, o.fetchImpl, gateway);
  const rpcTimeoutMs = o.hosted?.timeoutMs ?? 8_000;
  return runWithWorkerSession({ auth, data, resolveFn: gateway === "0055" ? identityRpcNameV2 : identityRpcName, clock: o.clock, limits: { ...o.session, rpcTimeoutMs }, expectedUserId: workerUserId },
    (call) => runHostedFuturesPaperWorkerTick({ ...o, rpc: call as HostedRpc, hosted: { ...(o.hosted ?? {}), timeoutMs: rpcTimeoutMs } }));
}

// ---------- Phase 4H.7: one bounded, resumable invocation inside the measured 5,000 ms scheduler limit ----------
/** Market and intent sources must honour the signal; the invocation also stops waiting at their own limits. */
export interface BoundedMarket { candles(symbols: string[], timeframe: FPTimeframe, barT: number, signal: AbortSignal): Promise<RawSymbolBundle[]> }
export interface BoundedIntents { forCandle(accountId: string, barT: number, signal: AbortSignal): Promise<FPIntent[]> }
export interface InvocationOptions {
  enabled?: boolean; accounts: string[]; limits: InvocationLimits; market: BoundedMarket; intents: BoundedIntents;
  clock: { now(): number }; fetchImpl?: Fetch; gateway?: IdentityGateway;
  /** Per-invocation lease holder; a fresh random id by default, so an overlapping invocation can never share a fence. */
  holder?: string;
  /** Caller's logger for the invocation journal (category B evidence). It never blocks or fails the invocation. */
  journal?: (e: JournalEvent) => void;
  schedulerLimitMs?: number;
}
export interface InvocationReport extends InvocationClassification {
  accountId: string | null; holder: string | null; elapsedMs: number; budgetMs: number | null; fit: FitReport | null;
  sessionOutcome: string | null; signOut: string | null; journal: JournalEvent[];
}
const freshHolder = (): string => globalThis.crypto.randomUUID();
/**
 * ONE bounded invocation: refuses any limit profile that cannot finish inside the scheduler limit, picks one account for
 * the time slot, runs one session with no refresh, at most `maxCandles` candles, one market attempt, no backoff sleep
 * and per-port limits, then signs out. Disabled unless both environment flags are set; nothing schedules it.
 */
export async function runBoundedIdentityInvocation(o: InvocationOptions): Promise<InvocationReport> {
  if (process.env["FUTURES_PAPER_WORKER_HOSTED"] !== "enabled" || process.env["FUTURES_PAPER_WORKER_IDENTITY"] !== "signed-in") throw new WorkerIdentityError("IDENTITY_DISABLED");
  const t0 = o.clock.now();
  const base = { accountId: null, holder: null, budgetMs: null, fit: null, sessionOutcome: null, signOut: null, journal: [] as JournalEvent[] };
  if (o.enabled !== true) return { ...base, status: "DISABLED", completed: false, committed: 0, reasons: ["DISABLED"], elapsedMs: 0 };
  const chk = validateInvocationLimits(o.limits, o.schedulerLimitMs);
  if (!chk.ok) return { ...base, status: "CONFIG_INVALID", completed: false, committed: 0, reasons: [chk.code], elapsedMs: 0 };
  const L = chk.limits;
  const url = process.env["SUPABASE_URL"], key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const email = process.env["FUTURES_PAPER_WORKER_EMAIL"], password = process.env["FUTURES_PAPER_WORKER_PASSWORD"];
  const workerUserId = process.env["FUTURES_PAPER_WORKER_USER_ID"];
  if (!url || !key || !email || !password || !workerUserId || !UUID.test(workerUserId)) throw new WorkerIdentityError("IDENTITY_NOT_CONFIGURED");
  const accountId = pickAccount(o.accounts, t0, L.scheduleIntervalMs);
  if (!accountId) return { ...base, status: "NO_ACCOUNT", completed: false, committed: 0, reasons: ["NO_ACCOUNT"], elapsedMs: 0, budgetMs: L.budgetMs, fit: chk.fit };
  const holder = o.holder && UUID.test(o.holder) ? o.holder : freshHolder();
  const j = createJournal(holder, () => o.clock.now(), o.journal);
  j.start();
  const gateway: IdentityGateway = o.gateway === "0054" ? "0054" : "0055";
  const { auth, data } = identityTransports({ url, key, email, password }, o.fetchImpl, gateway);
  const now = () => o.clock.now();
  const session = await runWithWorkerSession({
    auth, data, resolveFn: gateway === "0055" ? identityRpcNameV2 : identityRpcName, clock: o.clock, expectedUserId: workerUserId,
    limits: { tickBudgetMs: L.budgetMs, rpcTimeoutMs: L.rpcTimeoutMs, authTimeoutMs: L.authTimeoutMs, signOutTimeoutMs: L.signOutTimeoutMs, maxRefreshes: 0 },
    verifyUser: workerUserCheck(email),
  }, (call, ctx) => {
    // Ports wait only while the commit that follows them can still fit; the session refuses any later call anyway.
    const portDeadline = () => ctx.callDeadlineAt - L.rpcTimeoutMs;
    const market = { candles: (symbols: string[], timeframe: FPTimeframe, barT: number) => boundedCall((s) => o.market.candles(symbols, timeframe, barT, s), { timeoutMs: L.marketTimeoutMs, deadlineAt: portDeadline(), now, parent: ctx.signal }) };
    const intents = { forCandle: (acct: string, barT: number) => boundedCall((s) => o.intents.forCandle(acct, barT, s), { timeoutMs: L.intentsTimeoutMs, deadlineAt: portDeadline(), now, parent: ctx.signal }) };
    return runHostedFuturesPaperWorkerTick({
      enabled: true, holder, accounts: [accountId], maxAccounts: 1, maxCandlesPerAccount: L.maxCandles, fetchAttempts: 1, fetchBackoffMs: 0, maxReloads: 1, maxRecompute: 1,
      rpc: call as HostedRpc, market, intents, clock: { now, sleep: async () => undefined },
      hosted: { timeoutMs: L.rpcTimeoutMs, leaseTtlSeconds: L.leaseTtlSeconds },
      monitor: { record: (m) => { if ("fn" in m || "pgCode" in m) j.hosted(m as { code: string; fn?: string | null; pgCode?: string | null }); } },
    });
  });
  const c = classifyInvocation({ session, summary: session.result ?? null });
  j.end(c.status);
  return { ...c, accountId, holder, elapsedMs: o.clock.now() - t0, budgetMs: L.budgetMs, fit: chk.fit, sessionOutcome: session.outcome, signOut: session.signOut, journal: [...j.events] };
}
export { InvocationRefusal };
