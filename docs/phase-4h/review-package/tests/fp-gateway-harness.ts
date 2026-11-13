// Test harness for DRAFT 0050 (worker gateway) on top of DRAFT 0049, in PGlite — neither is applied anywhere real.
// `pgliteRpc` emulates the hosted Data API: one call = one autocommit READ COMMITTED statement as service_role, errors
// returned as { code, message } like PostgREST. Every policy value is a TEST INPUT, not approved policy.
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { FPConfig, FPIntent } from "@/lib/futures-paper-engine";
import type { HostedRpc, HostedRpcName, RpcReply } from "@/lib/futures-paper-worker-hosted";
import type { WorkerPorts } from "@/lib/futures-paper-worker";
import { CFG, M, as, makeDb, rawBundle, type OHLC } from "./fp-v3-harness";

export const MIGRATION_0050 = readFileSync("docs/proposed-migrations/0050_futures_paper_worker_gateway.sql", "utf8");
export const ROLLBACK_0050 = readFileSync("docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql", "utf8");
export const ROLLBACK_0049 = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql", "utf8");
/** FP_WITH_0051=1 additionally applies DRAFT 0051 (Phase 4H) so the Phase 4G gateway suites can be re-run through it. */
export async function makeGatewayDb() {
  const db = await makeDb(); await db.exec(MIGRATION_0050);
  if (process.env["FP_WITH_0051"] === "1") await db.exec(readFileSync("docs/proposed-migrations/0051_futures_paper_event_completeness.sql", "utf8"));
  if (process.env["FP_WITH_0051"] === "1" && process.env["FP_WITH_0052"] === "1") {
    await db.exec(`SELECT set_config('futures_paper.change_reason', 'test fixture (PGlite)', false)`);
    await db.exec(readFileSync("docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql", "utf8"));
  }
  return db;
}
/** Test config with a one-hour data age so recorded past candles may still approve entries (a TEST INPUT). */
export const CFG_H: FPConfig = { ...CFG, limits: { ...CFG.limits, maxDataAgeMs: 3_600_000 } };

const CAST: Record<string, string> = { p_account: "::uuid", p_holder: "::uuid", p_user: "::uuid", p_fence: "::bigint", p_expected_seq: "::bigint", p_bar_t: "::bigint", p_ttl_seconds: "::integer", p_payload: "::jsonb", p_provenance: "::jsonb", p_code: "::text" };
export async function callFn(db: PGlite, fn: string, args: Record<string, unknown>, role: "service_role" | "authenticated" | "anon" = "service_role"): Promise<RpcReply> {
  const keys = Object.keys(args), params: unknown[] = [];
  const list = keys.map((k) => {
    const v = args[k]; params.push(k === "p_payload" || k === "p_provenance" || k === "p_ids" ? JSON.stringify(v) : v);
    return k === "p_ids" ? `${k} => ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))` : `${k} => $${params.length}${CAST[k] ?? ""}`;
  });
  try { const r = await as<{ r: unknown }>(db, role, `SELECT public.${fn}(${list.join(", ")}) AS r`, params); return { data: r.rows[0]!.r, error: null, status: 200 }; }
  catch (e) { return { data: null, error: { code: (e as { code?: string }).code ?? null, message: (e as Error).message }, status: 400 }; }
}
export interface ShimHooks { before?: (fn: HostedRpcName, args: Record<string, unknown>) => Promise<RpcReply | void | "hang" | "throw"> | RpcReply | void | "hang" | "throw"; after?: (fn: HostedRpcName, reply: RpcReply, args: Record<string, unknown>) => Promise<RpcReply | "throw"> | RpcReply | "throw" }
export function pgliteRpc(db: PGlite, hooks: ShimHooks = {}): HostedRpc & { calls: HostedRpcName[] } {
  const calls: HostedRpcName[] = [];
  const f = (async (fn, args, signal) => {
    calls.push(fn);
    const pre = await hooks.before?.(fn, args);
    if (pre === "throw") throw new TypeError("fetch failed");
    if (pre === "hang") return new Promise<RpcReply>((_res, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    if (pre) return pre;
    const reply = await callFn(db, fn, args);
    const post = hooks.after ? await hooks.after(fn, reply, args) : reply;
    if (post === "throw") throw new TypeError("fetch failed after the server replied");
    return post;
  }) as HostedRpc & { calls: HostedRpcName[] };
  f.calls = calls; return f;
}

// Deterministic public-looking candles within the last hour (the gateway refuses fetches older than 15 minutes).
export const NOW = Math.floor(Date.now() / M) * M + 3_000;
export const path = (sym: string, k: number): OHLC => { const b = sym === "BTCUSDT" ? 100 : 50, o = b + Math.sin(k / 2), c = b + Math.sin((k + 1) / 2); return [o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]; };
export function marketFrom(t0: number, over?: (sym: string, barT: number, b: ReturnType<typeof rawBundle>) => ReturnType<typeof rawBundle>, fetchedAt = () => NOW): WorkerPorts["market"] {
  return { candles: async (symbols, timeframe, barT) => symbols.map((s) => { const b = rawBundle(s, barT, M, { trade: path(s, (barT - t0) / M) }, fetchedAt(), timeframe); return over ? over(s, barT, b) : b; }) };
}
export function intentsFrom(t0: number, tag: string, every = 4, strategyId = "s1"): WorkerPorts["intents"] {
  return { forCandle: async (acct, barT): Promise<FPIntent[]> => {
    const k = (barT - t0) / M; if (k % every !== 0) return [];
    const c = path("BTCUSDT", k)[3], long = k % (2 * every) === 0;
    return [{ maxHoldBars: 3, proposal: { proposalId: `${tag}-${acct.slice(-6)}-${k}`, engine: "scalp_intraday", strategyId, symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: long ? "LONG" : "SHORT", referencePrice: null, stopPrice: long ? c - 1 : c + 1, takeProfitPrice: long ? c + 2 : c - 2, createdAt: barT + M } }];
  } };
}
export const HOLDER_A = "00000000-0000-4000-8000-00000000aaaa", HOLDER_B = "00000000-0000-4000-8000-00000000bbbb";
export const n = async (db: PGlite, sql: string, p: unknown[] = []) => Number((await db.query<{ n: number }>(sql, p)).rows[0]!.n);
export const expireLease = (db: PGlite, id: string) => db.query(`UPDATE public.futures_paper_worker_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE account_id = $1`, [id]);
