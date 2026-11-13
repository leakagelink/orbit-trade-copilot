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
import { runHostedFuturesPaperWorkerTick, type HostedRpc, type HostedTickOptions } from "./futures-paper-worker-hosted";
import { IDENTITY_RPC, identityRpcName, WorkerIdentityError } from "./futures-paper-worker-identity";
import { runWithWorkerSession, type AuthReply, type DataReply, type DataTransport, type SessionLimits, type SessionResult, type WorkerAuthTransport } from "./worker-auth-session";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const WRAPPERS: ReadonlySet<string> = new Set(Object.values(IDENTITY_RPC));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface IdentityConfig { url: string; key: string; email: string; password: string }

/** Plain-fetch transports; the credentials stay in this closure and are only ever sent to the configured auth endpoint. */
export function identityTransports(cfg: IdentityConfig, fetchImpl: Fetch = (i, init) => globalThis.fetch(i, init)): { auth: WorkerAuthTransport; data: DataTransport } {
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
    if (!WRAPPERS.has(fn)) throw new WorkerIdentityError("IDENTITY_DISABLED"); // only the six 0053 wrappers
    const r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...json, apikey: cfg.key, Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(args), signal, redirect: "error" });
    const b = await read(r);
    if (r.ok) return { data: b, error: null, status: r.status };
    const e = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    return { data: null, error: { code: typeof e["code"] === "string" ? e["code"] : null, message: typeof e["message"] === "string" ? e["message"] : null }, status: r.status };
  };
  return { auth, data };
}

export type IdentityTickOptions = Omit<HostedTickOptions, "rpc"> & { session: Omit<SessionLimits, "rpcTimeoutMs">; fetchImpl?: Fetch };
/** One signed-in hosted tick: sign in → hosted tick over the six wrappers → sign out. Disabled unless both flags are set. */
export async function runIdentityFuturesPaperTick(o: IdentityTickOptions): Promise<SessionResult<Awaited<ReturnType<typeof runHostedFuturesPaperWorkerTick>>>> {
  if (process.env["FUTURES_PAPER_WORKER_HOSTED"] !== "enabled" || process.env["FUTURES_PAPER_WORKER_IDENTITY"] !== "signed-in") throw new WorkerIdentityError("IDENTITY_DISABLED");
  const url = process.env["SUPABASE_URL"], key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const email = process.env["FUTURES_PAPER_WORKER_EMAIL"], password = process.env["FUTURES_PAPER_WORKER_PASSWORD"];
  const workerUserId = process.env["FUTURES_PAPER_WORKER_USER_ID"];
  if (!url || !key || !email || !password || !workerUserId || !UUID.test(workerUserId)) throw new WorkerIdentityError("IDENTITY_NOT_CONFIGURED");
  const { auth, data } = identityTransports({ url, key, email, password }, o.fetchImpl);
  const rpcTimeoutMs = o.hosted?.timeoutMs ?? 8_000;
  return runWithWorkerSession({ auth, data, resolveFn: identityRpcName, clock: o.clock, limits: { ...o.session, rpcTimeoutMs }, expectedUserId: workerUserId },
    (call) => runHostedFuturesPaperWorkerTick({ ...o, rpc: call as HostedRpc, hosted: { ...(o.hosted ?? {}), timeoutMs: rpcTimeoutMs } }));
}
