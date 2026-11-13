// Hosted database connection for the Futures PAPER worker (Phase 4G, workstream C) — DISABLED. It builds the worker's
// database port over SIX allowlisted service-only functions of DRAFT migration 0050 (not applied; needs draft 0049),
// called one request = one READ COMMITTED transaction. Nothing in the app imports this module; there is no route,
// cron entry, scheduler or background job, and `runHostedFuturesPaperWorkerTick` returns "disabled" without touching
// any port unless the caller passes `enabled: true` (only tests do). It holds no credential: the caller injects `rpc`
// (the server binding in `futures-paper-worker-hosted.server.ts` is additionally gated by an unset environment flag).
//
// Guarantees: a lease row with a fencing token per account (checked and renewed inside the commit transaction); one
// database snapshot per evaluation (fpw_snapshot is one statement); the owner is always derived from the account;
// every call has a deadline; a commit whose reply never arrives is resent IDENTICALLY at most once by the worker (the
// database returns the committed sequence for an identical replay, so nothing duplicates) and is otherwise left for
// the next tick to reload; errors that prove nothing was written become a transient outcome (no halt, no retry loop
// inside a tick); refusals keep the database message (secret-like text redacted) for the bounded refusal planner;
// monitoring records only codes — never messages, payloads, keys or row data.
import { viewFromRows, runFuturesPaperWorkerTick, type CommitOutcome, type TickSummary, type WorkerAccountView, type WorkerOptions, type WorkerPorts } from "./futures-paper-worker";
import type { FPTimeframe, RawSymbolBundle } from "./futures-paper-market-data";
import { buildCandleProvenance, PROVENANCE_DEFAULTS, type ProvenanceRecord } from "./futures-paper-market-provenance";

export const HOSTED_WORKER_ENABLED_BY_DEFAULT = false as const;
export const HOSTED_WORKER_RPCS = ["fpw_acquire_lease", "fpw_release_lease", "fpw_snapshot", "fpw_evaluated", "fpw_commit", "fpw_mark_review"] as const;
export type HostedRpcName = (typeof HOSTED_WORKER_RPCS)[number];
export interface RpcReply { data: unknown; error: { code?: string | null; message?: string | null } | null; status?: number }
/** One Data API call = one transaction. Must honour `signal` where it can; the adapter stops waiting at the deadline anyway. */
export type HostedRpc = (fn: HostedRpcName, args: Record<string, unknown>, signal: AbortSignal) => Promise<RpcReply>;

export const HOSTED_CODES = [
  "RPC_TIMEOUT", "RPC_NO_RESPONSE", "RPC_TRANSIENT", "RPC_REFUSED", "RPC_SCHEMA_UNAVAILABLE", "RPC_MALFORMED_REPLY",
  "LEASE_ACQUIRED", "LEASE_BUSY", "LEASE_LOST", "LEASE_RELEASED", "SNAPSHOT_EMPTY", "SNAPSHOT_MISMATCH", "CROSS_ACCOUNT_REFUSED",
  "ENTRY_WINDOW_MISSED", "ENTRY_TOO_LATE", "PROVENANCE_MISSING", "PROVENANCE_INVALID", "TICK_ABORTED", "HOLDER_INVALID",
] as const;
export type HostedCode = (typeof HOSTED_CODES)[number];
export interface HostedMetric { code: HostedCode; accountId: string | null; fn?: HostedRpcName; pgCode?: string | null; detailCode?: string | null; latencyMs?: number }

export type Classified =
  | { kind: "ok"; data: unknown }
  | { kind: "no_response"; timeout: boolean; pgCode: string | null } // the outcome is unknown: it may or may not have committed
  | { kind: "transient"; pgCode: string | null; code: HostedCode }   // the database proved nothing was written
  | { kind: "refused"; pgCode: string | null; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_CODE = /^([0-9A-Z]{5}|PGRST\d{3})$/;
const safeCode = (c: unknown) => (typeof c === "string" && PG_CODE.test(c) ? c : null);

/** Removes anything that looks like a credential or connection secret; bounds the length. */
export function redactSecrets(s: string): string {
  return String(s)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(apikey|api_key|password|passwd|secret|token|authorization)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=[redacted]")
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/@]+@/gi, "$1://[redacted]@")
    .slice(0, 500);
}

const TRANSIENT = new Set(["40001", "40P01", "55P03", "57014", "53300", "53400", "57P01", "57P02", "57P03"]);
const UNKNOWN_OUTCOME = (code: string | null, status: number | undefined) =>
  (code !== null && (code.startsWith("08") || /^PGRST00[0-3]$/.test(code))) || status === 0 || (status !== undefined && [502, 503, 504, 520, 521, 522, 523, 524].includes(status));

/** Maps one call result (or thrown error) to what it proves about the database. */
export function classifyRpc(r: { reply?: RpcReply; thrown?: unknown; timedOut?: boolean }): Classified {
  if (r.timedOut) return { kind: "no_response", timeout: true, pgCode: null };
  if (r.thrown !== undefined || !r.reply) return { kind: "no_response", timeout: false, pgCode: null };
  const { error, status, data } = r.reply;
  if (!error) return { kind: "ok", data };
  const code = safeCode(error.code), msg = String(error.message ?? "");
  if (UNKNOWN_OUTCOME(code, status)) return { kind: "no_response", timeout: false, pgCode: code };
  if (/futures paper worker lease lost/.test(msg)) return { kind: "transient", pgCode: code, code: "LEASE_LOST" };
  if (/new entries need data younger than/.test(msg)) return { kind: "transient", pgCode: code, code: "ENTRY_TOO_LATE" };
  if (code !== null && TRANSIENT.has(code)) return { kind: "transient", pgCode: code, code: "RPC_TRANSIENT" };
  if (code === "42883" || code === "42P01" || code === "PGRST202" || code === "42501" || code === "PGRST301") return { kind: "transient", pgCode: code, code: "RPC_SCHEMA_UNAVAILABLE" };
  if (code === "P0001" || code === "22023" || (code !== null && (code.startsWith("22") || code.startsWith("23")))) return { kind: "refused", pgCode: code, message: redactSecrets(msg) };
  return { kind: "transient", pgCode: code, code: "RPC_TRANSIENT" }; // any other server-reported error aborted its transaction
}

export interface HostedPortOptions {
  rpc: HostedRpc; holder: string; clock: { now(): number }; monitor?: { record(m: HostedMetric): void };
  timeoutMs?: number; leaseTtlSeconds?: number; maxFetchAgeMs?: number; closeGraceMs?: number; maxFutureSkewMs?: number;
  timers?: { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}
type Cached = { bundles: RawSymbolBundle[]; at: number };

/** The worker's database port plus market/intent wrappers that feed provenance and enforce the entry window. */
export function createHostedWorkerPorts(o: HostedPortOptions) {
  if (!UUID.test(o.holder)) throw new Error("hosted futures paper worker: holder must be a UUID");
  const timeoutMs = o.timeoutMs ?? 8_000, ttl = o.leaseTtlSeconds ?? 120;
  const timers = o.timers ?? { setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms), clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
  const fences = new Map<string, number>(), views = new Map<string, WorkerAccountView>(), fetched = new Map<string, Cached>();
  let current: string | null = null;
  const rec = (m: HostedMetric) => { try { o.monitor?.record(m); } catch { /* monitoring never blocks the ledger */ } };

  async function call(fn: HostedRpcName, args: Record<string, unknown>, accountId: string | null): Promise<Classified> {
    if (!(HOSTED_WORKER_RPCS as readonly string[]).includes(fn)) throw new Error("hosted futures paper worker: function not allowlisted");
    const ctl = new AbortController(), t0 = o.clock.now(); let h: unknown;
    const deadline = new Promise<{ timedOut: true }>((res) => { h = timers.setTimeout(() => { ctl.abort(); res({ timedOut: true }); }, timeoutMs); });
    let out: Classified;
    try {
      const r = await Promise.race([o.rpc(fn, args, ctl.signal).then((reply) => ({ reply }), (thrown: unknown) => ({ thrown: thrown ?? "error" })), deadline]);
      out = classifyRpc(r);
    } finally { timers.clearTimeout(h); }
    if (out.kind === "no_response") rec({ code: out.timeout ? "RPC_TIMEOUT" : "RPC_NO_RESPONSE", accountId, fn, pgCode: out.pgCode, latencyMs: o.clock.now() - t0 });
    else if (out.kind === "transient") rec({ code: out.code, accountId, fn, pgCode: out.pgCode, latencyMs: o.clock.now() - t0 });
    else if (out.kind === "refused") rec({ code: "RPC_REFUSED", accountId, fn, pgCode: out.pgCode, latencyMs: o.clock.now() - t0 });
    return out;
  }
  const lease = (accountId: string) => ({ p_account: accountId, p_holder: o.holder, p_fence: fences.get(accountId) ?? null });

  const db: WorkerPorts["db"] = {
    async tryAcquireLease(accountId, holder) {
      if (holder !== o.holder) { rec({ code: "HOLDER_INVALID", accountId }); return false; }
      const r = await call("fpw_acquire_lease", { p_account: accountId, p_holder: o.holder, p_ttl_seconds: ttl }, accountId);
      if (r.kind !== "ok") return false; // unavailable or refused: nothing is processed for this account
      if (r.data === null || r.data === undefined) { rec({ code: "LEASE_BUSY", accountId }); return false; }
      const f = Number(r.data);
      if (!Number.isSafeInteger(f) || f < 1) { rec({ code: "RPC_MALFORMED_REPLY", accountId, fn: "fpw_acquire_lease" }); return false; }
      fences.set(accountId, f); current = accountId; rec({ code: "LEASE_ACQUIRED", accountId }); return true;
    },
    async releaseLease(accountId) {
      if (fences.has(accountId)) { await call("fpw_release_lease", lease(accountId), accountId).catch(() => undefined); rec({ code: "LEASE_RELEASED", accountId }); }
      fences.delete(accountId); views.delete(accountId); if (current === accountId) current = null;
      for (const [k, v] of fetched) if (v.at < o.clock.now() - 10 * 60_000) fetched.delete(k);
    },
    async load(accountId) {
      if (!fences.has(accountId)) throw new Error("LEASE_LOST");
      const r = await call("fpw_snapshot", lease(accountId), accountId);
      if (r.kind !== "ok") throw new Error(r.kind === "refused" ? "SNAPSHOT_REFUSED" : "SNAPSHOT_UNAVAILABLE");
      if (r.data === null || typeof r.data !== "object") { rec({ code: "SNAPSHOT_EMPTY", accountId }); throw new Error("SNAPSHOT_EMPTY"); }
      const s = r.data as { account?: Record<string, unknown>; account_budget?: Record<string, unknown> | null; usage?: unknown[]; costs?: unknown[]; approvals?: unknown[]; positions?: unknown[] };
      if (!s.account || String(s.account["id"]) !== accountId || ![s.usage, s.costs, s.approvals, s.positions].every(Array.isArray)) {
        rec({ code: "SNAPSHOT_MISMATCH", accountId }); throw new Error("SNAPSHOT_MISMATCH");
      }
      const v = viewFromRows(s.account, s.account_budget ?? null, s.usage as Record<string, unknown>[], s.costs as Record<string, unknown>[], s.approvals as Record<string, unknown>[], s.positions as Record<string, unknown>[]);
      views.set(accountId, v); current = accountId; return v;
    },
    async evaluatedProposals(userId, proposalIds) {
      const v = current ? views.get(current) : undefined;
      if (!current || !v || v.userId !== userId) { rec({ code: "CROSS_ACCOUNT_REFUSED", accountId: current }); throw new Error("CROSS_ACCOUNT_REFUSED"); }
      const r = await call("fpw_evaluated", { ...lease(current), p_user: userId, p_ids: proposalIds }, current);
      if (r.kind !== "ok" || !Array.isArray(r.data)) throw new Error("EVALUATED_UNAVAILABLE");
      return (r.data as unknown[]).map(String);
    },
    async commit(accountId, expectedSeq, barT, payload): Promise<CommitOutcome> {
      const v = views.get(accountId);
      if (!v || !fences.has(accountId)) { rec({ code: "LEASE_LOST", accountId }); return { kind: "transient", message: "LEASE_LOST" }; }
      const c = fetched.get(fetchKey(v.symbols, v.timeframe, barT));
      if (!c) { rec({ code: "PROVENANCE_MISSING", accountId }); return { kind: "transient", message: "PROVENANCE_MISSING" }; }
      const prov = await buildCandleProvenance(c.bundles, { symbols: v.symbols, timeframe: v.timeframe, barT, now: o.clock.now(),
        maxFetchAgeMs: o.maxFetchAgeMs ?? PROVENANCE_DEFAULTS.maxFetchAgeMs, closeGraceMs: o.closeGraceMs ?? PROVENANCE_DEFAULTS.closeGraceMs, maxFutureSkewMs: o.maxFutureSkewMs ?? PROVENANCE_DEFAULTS.maxFutureSkewMs });
      if (!prov.ok) { rec({ code: "PROVENANCE_INVALID", accountId, detailCode: prov.code }); return { kind: "transient", message: "PROVENANCE_INVALID" }; }
      const r = await call("fpw_commit", { ...lease(accountId), p_expected_seq: expectedSeq, p_bar_t: barT, p_payload: payload, p_provenance: prov.records satisfies ProvenanceRecord[] }, accountId);
      if (r.kind === "no_response") throw new Error("NO_RESPONSE"); // the worker resends the identical payload once, then reloads next tick
      if (r.kind === "transient") return { kind: "transient", message: r.code };
      if (r.kind === "refused") return { kind: "refused", message: r.message };
      const seq = Number(r.data);
      if (!Number.isSafeInteger(seq) || seq < 0) { rec({ code: "RPC_MALFORMED_REPLY", accountId, fn: "fpw_commit" }); return { kind: "refused", message: "futures paper worker: malformed commit reply" }; }
      fetched.delete(fetchKey(v.symbols, v.timeframe, barT));
      return { kind: "committed", seq };
    },
    async markForReview(accountId, code) {
      const safe = /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNCLASSIFIED";
      const r = await call("fpw_mark_review", { ...lease(accountId), p_code: safe }, accountId);
      if (r.kind !== "ok") throw new Error("REVIEW_HOLD_NOT_RECORDED");
    },
  };
  const fetchKey = (symbols: string[], tf: FPTimeframe, barT: number) => `${tf}|${[...symbols].sort().join(",")}|${barT}`;
  const wrapMarket = (m: WorkerPorts["market"]): WorkerPorts["market"] => ({
    async candles(symbols, timeframe, barT) {
      const bundles = await m.candles(symbols, timeframe, barT);
      fetched.set(fetchKey(symbols, timeframe, barT), { bundles, at: o.clock.now() });
      if (fetched.size > 256) fetched.delete(fetched.keys().next().value as string);
      return bundles;
    },
  });
  /** New entries only while the candle is younger than the account's max data age (database clock re-checks at commit). */
  const wrapIntents = (i: WorkerPorts["intents"]): WorkerPorts["intents"] => ({
    async forCandle(accountId, barT) {
      const v = views.get(accountId); if (!v) return [];
      const age = o.clock.now() - (barT + v.tfMs), limit = Number(v.config?.limits?.maxDataAgeMs);
      if (!Number.isFinite(limit) || age > limit) { rec({ code: "ENTRY_WINDOW_MISSED", accountId }); return []; }
      return i.forCandle(accountId, barT);
    },
  });
  return { db, wrapMarket, wrapIntents };
}

export interface HostedTickOptions extends Omit<WorkerOptions, "holder"> {
  rpc: HostedRpc; holder: string; market: WorkerPorts["market"]; intents: WorkerPorts["intents"];
  clock: WorkerPorts["clock"]; monitor?: { record(m: HostedMetric | import("./futures-paper-worker").WorkerMetric): void };
  hosted?: Omit<HostedPortOptions, "rpc" | "holder" | "clock" | "monitor">;
}
/** One hosted tick. OFF unless `enabled: true`; each account runs in isolation so one failure never stops another. */
export async function runHostedFuturesPaperWorkerTick(o: HostedTickOptions): Promise<TickSummary & { hosted: HostedMetric[] }> {
  if (o?.enabled !== true) return { status: "disabled", committed: 0, halted: [], metrics: [{ code: "DISABLED", accountId: null, barT: null }], hosted: [] };
  const hosted: HostedMetric[] = [];
  const monitor = { record: (m: HostedMetric) => { hosted.push(m); try { o.monitor?.record(m); } catch { /* never blocks */ } } };
  const p = createHostedWorkerPorts({ ...(o.hosted ?? {}), rpc: o.rpc, holder: o.holder, clock: o.clock, monitor });
  const ports: WorkerPorts = { db: p.db, market: p.wrapMarket(o.market), intents: p.wrapIntents(o.intents), clock: o.clock, monitor: { record: (m) => { try { o.monitor?.record(m); } catch { /* */ } } } };
  const sum: TickSummary & { hosted: HostedMetric[] } = { status: "ran", committed: 0, halted: [], metrics: [], hosted };
  for (const accountId of o.accounts.slice(0, o.maxAccounts ?? 20)) {
    try {
      const r = await runFuturesPaperWorkerTick(ports, { ...o, enabled: true, holder: o.holder, accounts: [accountId] });
      sum.committed += r.committed; sum.halted.push(...r.halted); sum.metrics.push(...r.metrics);
    } catch { monitor.record({ code: "TICK_ABORTED", accountId }); }
  }
  return sum;
}
