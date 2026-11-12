// Forward paper trading worker (Phase 3). Reads public candles, runs the pure engine one closed candle at a time and
// commits each candle atomically through the paper ledger RPC (compare-and-set on the strategy cursor). Simulated only:
// this module and everything it imports cannot reach exchange order, credential, wallet, bot or Autopilot code.
import { PaperDataError, stepPaperBar, utcDay, PAPER_ENGINE_VERSION, type PaperState, type PaperStepResult } from "./paper-engine";
import type { PaperAccountContext, PaperRiskPolicy } from "./paper-risk";
import type { CostModel } from "./backtest-costs";
import type { Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";

export const PAPER_MAX_BARS_PER_TICK = 30;
export const PAPER_HISTORY_WINDOW = 300;

export interface PaperStrategyRow {
  id: string; user_id: string; config: StrategyConfig; costs: CostModel; risk: PaperRiskPolicy; pair: string; timeframe: string;
  tf_ms: number | string; status: "active" | "paused" | "stopped"; cursor_t: number | string; state: PaperState;
}
export interface PaperAccountRow { user_id: string; max_exposure: number | string; max_daily_loss: number | string; max_open_positions: number; max_position_notional: number | string; halted: boolean; halted_at: string | null }
export interface PaperPeer { id: string; open_exposure: number | string; open_positions: number; day_utc: string | null; day_net: number | string }
export interface PaperCommitPayload { bar: PaperStepResult["record"]; events: PaperStepResult["events"]; trades: PaperStepResult["trades"]; state: PaperState; data_fetched_at: number }
export interface PaperStore {
  listRunnable(): Promise<PaperStrategyRow[]>;
  account(userId: string): Promise<{ account: PaperAccountRow; peers: PaperPeer[] }>;
  hasPro(userId: string): Promise<boolean>;
  commit(strategyId: string, expectedCursor: number, payload: PaperCommitPayload): Promise<void>;
  mark(strategyId: string, fields: { data_status: string; status?: "paused"; status_reason?: string }): Promise<void>;
}
export type PaperCandleSource = (pair: string, timeframe: string) => Promise<{ candles: Candle[]; fetchedAt: number }>;
export type PaperOutcome = "committed" | "up_to_date" | "stale" | "data_outage" | "data_gap" | "invalid_data" | "cursor_conflict" | "risk_recheck" | "commit_failed";

export class PaperLedgerUnavailable extends Error {}

/** Account limits plus what the owner's OTHER paper strategies hold, for the candle's UTC day. */
export function paperAccountContext(account: PaperAccountRow, peers: PaperPeer[], selfId: string, barT: number): PaperAccountContext {
  const day = utcDay(barT);
  const others = peers.filter((p) => p.id !== selfId);
  return {
    maxExposure: Number(account.max_exposure), maxDailyLoss: Number(account.max_daily_loss), maxOpenPositions: Number(account.max_open_positions), maxPositionNotional: Number(account.max_position_notional),
    otherExposure: others.reduce((a, p) => a + Number(p.open_exposure), 0), otherOpenPositions: others.reduce((a, p) => a + Number(p.open_positions), 0),
    otherDayNet: others.filter((p) => p.day_utc === day).reduce((a, p) => a + Number(p.day_net), 0),
  };
}

/** Longest run of consecutive candles ending at `idx`, capped at the history window. */
function contiguousHistory(closed: Candle[], idx: number, tfMs: number) {
  let start = idx;
  while (start > 0 && idx - start + 1 < PAPER_HISTORY_WINDOW && closed[start]!.t - closed[start - 1]!.t === tfMs) start--;
  return closed.slice(start, idx + 1);
}

export async function processPaperStrategy(store: PaperStore, s: PaperStrategyRow, load: () => Promise<{ candles: Candle[]; fetchedAt: number }>, now: number): Promise<{ outcome: PaperOutcome; committed: number; detail?: string }> {
  const tf = Number(s.tf_ms);
  let data: { candles: Candle[]; fetchedAt: number };
  try { data = await load(); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await store.mark(s.id, { data_status: `Market data outage: ${detail}`.slice(0, 300) });
    return { outcome: "data_outage", committed: 0, detail }; // nothing simulated, nothing filled
  }
  // Only candles that had fully closed by now; duplicates or disorder make the feed untrustworthy for this tick.
  const closed = data.candles.filter((c) => c.t + tf <= now);
  for (let k = 1; k < closed.length; k++) if (closed[k]!.t <= closed[k - 1]!.t) {
    await store.mark(s.id, { data_status: "Market data rejected: duplicate or out-of-order candles" });
    return { outcome: "invalid_data", committed: 0 };
  }
  const latest = closed.at(-1);
  const stale = !latest || now - (latest.t + tf) > 2 * tf;
  let cursor = Number(s.cursor_t);
  const pending = closed.filter((c) => c.t > cursor);
  if (!pending.length) {
    await store.mark(s.id, { data_status: stale ? "Market data stale: no newly closed candle" : "Up to date" });
    return { outcome: stale ? "stale" : "up_to_date", committed: 0 };
  }
  if (pending[0]!.t !== cursor + tf) {
    const missing = new Date(cursor + tf).toISOString();
    const behind = closed[0]!.t > cursor + tf;
    await store.mark(s.id, { data_status: "Market data gap", status: "paused", status_reason: behind
      ? `The worker fell behind: candle ${missing} is older than the available market data; paused for review — nothing was filled across the gap`
      : `Candle ${missing} is missing from the market data; paused for review — nothing was filled across the gap` });
    return { outcome: "data_gap", committed: 0, detail: missing };
  }
  const { account, peers } = await store.account(s.user_id);
  const pro = await store.hasPro(s.user_id);
  const haltedAt = account.halted ? Date.parse(account.halted_at ?? "") || 0 : null;
  let state = s.state;
  let committed = 0;
  for (const bar of pending.slice(0, PAPER_MAX_BARS_PER_TICK)) {
    if (bar.t !== cursor + tf) break; // a later gap is handled on the next tick
    const idx = closed.indexOf(bar);
    let res: PaperStepResult;
    try {
      res = stepPaperBar({
        strategyKey: s.id, state, history: contiguousHistory(closed, idx, tf), tfMs: tf, cfg: s.config, costs: s.costs, policy: s.risk,
        entriesAllowed: s.status === "active" && pro, haltedAt, account: paperAccountContext(account, peers, s.id, bar.t),
      });
    } catch (e) {
      if (!(e instanceof PaperDataError)) throw e;
      await store.mark(s.id, { data_status: "Market data rejected", status: "paused", status_reason: `${e.message}; paused for review — nothing was filled` });
      return { outcome: "invalid_data", committed, detail: e.message };
    }
    try {
      await store.commit(s.id, cursor, { bar: res.record, events: res.events, trades: res.trades, state: res.state, data_fetched_at: data.fetchedAt });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (/paper_cursor_conflict|paper_bar_out_of_sequence|duplicate key/.test(detail)) return { outcome: "cursor_conflict", committed, detail };
      if (/paper_risk_conflict|paper_entry_blocked/.test(detail)) {
        await store.mark(s.id, { data_status: `Risk re-check refused this candle (${detail.slice(0, 120)}); it is recomputed next tick` });
        return { outcome: "risk_recheck", committed, detail };
      }
      await store.mark(s.id, { data_status: `Commit failed: ${detail}`.slice(0, 300) });
      return { outcome: "commit_failed", committed, detail };
    }
    cursor = bar.t; state = res.state; committed++;
  }
  await store.mark(s.id, { data_status: stale ? "Market data stale" : "Up to date" });
  return { outcome: "committed", committed };
}

export async function runPaperTick(store: PaperStore, source: PaperCandleSource, now = Date.now()) {
  const rows = await store.listRunnable();
  const feeds = new Map<string, Promise<{ candles: Candle[]; fetchedAt: number }>>();
  const results: { id: string; outcome: PaperOutcome; committed: number; detail?: string }[] = [];
  for (const s of rows) {
    const key = `${s.pair}|${s.timeframe}`;
    const load = () => { if (!feeds.has(key)) feeds.set(key, source(s.pair, s.timeframe)); return feeds.get(key)!; };
    try { results.push({ id: s.id, ...(await processPaperStrategy(store, s, load, now)) }); }
    catch (e) { results.push({ id: s.id, outcome: "commit_failed", committed: 0, detail: e instanceof Error ? e.message : String(e) }); }
  }
  return results;
}

const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/.test(e.message ?? ""));

/** Production store over the service-role client. Throws PaperLedgerUnavailable until draft migration 0044 is applied. */
export async function supabasePaperStore(): Promise<PaperStore> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The paper tables are not in the generated types until 0044 is applied.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const probe = await db.from("paper_strategies").select("id", { head: true, count: "exact" }).limit(1);
  if (missingTable(probe.error)) throw new PaperLedgerUnavailable("Paper ledger not enabled (draft migration 0044 awaits approval)");
  if (probe.error) throw new Error(probe.error.message);
  return {
    async listRunnable() {
      const r = await db.from("paper_strategies").select("id,user_id,config,costs,risk,pair,timeframe,tf_ms,status,cursor_t,state,engine_version").in("status", ["active", "paused"]).eq("engine_version", PAPER_ENGINE_VERSION);
      if (r.error) throw new Error(r.error.message);
      return r.data;
    },
    async account(userId) {
      const [a, p] = await Promise.all([
        db.from("paper_accounts").select("*").eq("user_id", userId).single(),
        db.from("paper_strategies").select("id,open_exposure,open_positions,day_utc,day_net").eq("user_id", userId).neq("status", "stopped"),
      ]);
      if (a.error || p.error) throw new Error("Paper account unavailable");
      return { account: a.data, peers: p.data };
    },
    async hasPro(userId) { const { data, error } = await db.rpc("has_pro_access", { _uid: userId }); if (error) throw new Error(error.message); return data === true; },
    async commit(id, expected, payload) { const { error } = await db.rpc("paper_commit_bar", { p_strategy: id, p_expected_cursor: expected, p_payload: payload }); if (error) throw new Error(error.message); },
    async mark(id, fields) { await db.from("paper_strategies").update({ ...fields, last_checked_at: new Date().toISOString() }).eq("id", id).neq("status", "stopped"); },
  };
}

export async function runScheduledPaperTick() {
  let store: PaperStore;
  try { store = await supabasePaperStore(); }
  catch (e) { if (e instanceof PaperLedgerUnavailable) return { enabled: false as const, reason: e.message, results: [] }; throw e; }
  const { fetchPaperCandles } = await import("./paper-market-data.server");
  const results = await runPaperTick(store, (pair, tf) => fetchPaperCandles(pair, tf, 500));
  return { enabled: true as const, results };
}
