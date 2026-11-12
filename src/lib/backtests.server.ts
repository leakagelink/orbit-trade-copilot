// Server-only backtest runner shared by the Backtests page and the AI Autopilot. Writes evidence with the service role.
// New runs use the v3 historical evaluation (data integrity, frozen splits, benchmarks); v2 evidence stays replayable.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { validateStrategy, type StrategyConfig } from "./strategy";
import { evidenceHash as hashEvidence } from "./evidence-hash";
import { evaluateStrategyHistory } from "./historical-evaluation";
import { SIMULATOR_V3 } from "./backtest-v3";

export interface BacktestRequest {
  strategyId: string; exchange: "binance" | "bybit" | "okx" | "kucoin" | "coinbase"; days: number; capital: number; feePct: number; slippagePct: number;
  /** Full bid/ask spread %, default 0.02. */ spreadPct?: number | undefined;
  /** Max share of a candle's volume per fill, default 10%. */ maxParticipationPct?: number | null | undefined;
}
export const DEFAULT_SPREAD_PCT = 0.02, DEFAULT_PARTICIPATION_PCT = 10;

/** `supabase` is the caller's own client (RLS): the strategy must belong to them. */
export async function runBacktestFor(supabase: SupabaseClient<Database>, userId: string, data: BacktestRequest): Promise<{ id: string; error?: string; status?: string }> {
  const { data: s } = await supabase.from("strategies").select("id,config,current_version").eq("id", data.strategyId).eq("user_id", userId).maybeSingle();
  if (!s) throw new Error("Strategy not found");
  const cfg = s.config as unknown as StrategyConfig;
  if (validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
  const pair = cfg.pairs[0];
  if (!pair) throw new Error("Strategy has no trading pair");
  const { fetchHistory, timeframeMs } = await import("./exchange-adapters.server");
  const tfMs = timeframeMs(cfg.timeframe);
  const end = Date.now(), start = end - data.days * 86_400_000;
  const costs = { feePct: data.feePct, slippagePct: data.slippagePct, spreadPct: data.spreadPct ?? DEFAULT_SPREAD_PCT, maxParticipationPct: data.maxParticipationPct === undefined ? DEFAULT_PARTICIPATION_PCT : data.maxParticipationPct };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: bt, error } = await supabaseAdmin.from("backtests").insert({
    user_id: userId, strategy_id: s.id, strategy_version: s.current_version, trading_pair: pair, timeframe: cfg.timeframe,
    start_date: new Date(start).toISOString(), end_date: new Date(end).toISOString(),
    starting_capital: data.capital, fee_pct: data.feePct, slippage_pct: data.slippagePct, status: "running",
  }).select("id").single();
  if (error) throw new Error(error.message);
  try {
    const fetchedAt = Date.now();
    const cs = (await fetchHistory(data.exchange, pair, cfg.timeframe, start, end)).filter((c) => c.t + tfMs <= end);
    const report = await evaluateStrategyHistory({ cfg, candles: cs, tfMs, start, end, fetchedAt, capital: data.capital, costs,
      source: { provider: data.exchange, endpoint: "public spot candles (klines)", market: "spot", pair, timeframe: cfg.timeframe } });
    if (report.status === "insufficient_data") {
      // Fail closed: nothing is simulated on incomplete data. The integrity findings are kept for the owner.
      const write = await supabaseAdmin.from("backtest_results").insert({ backtest_id: bt.id, user_id: userId, equity_curve: [] as never, trade_log: { status: "insufficient_data", simulatorVersion: SIMULATOR_V3, integrity: report.integrity, data: report.data } as never });
      if (write.error) console.error("Insufficient-data evidence could not be stored", write.error.message);
      await supabaseAdmin.from("backtests").update({ status: "insufficient_data", error: report.reason.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", bt.id);
      return { id: bt.id, error: report.reason, status: "insufficient_data" };
    }
    const first = cs[0]!;
    const r = report.full;
    const manifest = { simulatorVersion: SIMULATOR_V3, config: cfg, exchange: data.exchange, market: "spot", ...costs, tfMs, start, end, candles: cs };
    const evidenceHash = await hashEvidence({ manifest, trades: r.trades, equity: r.equity });
    const mt = r.metrics;
    const resultWrite = await supabaseAdmin.from("backtest_results").insert({
      backtest_id: bt.id, user_id: userId,
      total_return_pct: mt.netReturnPct, net_profit: mt.netProfit, max_drawdown_pct: mt.maxDrawdownPct, win_rate_pct: mt.winRatePct,
      profit_factor: mt.profitFactor, total_trades: mt.trades, avg_win: mt.avgWin, avg_loss: mt.avgLoss,
      equity_curve: r.equity as never,
      trade_log: {
        status: "completed", sharpe: mt.sharpe, candles: cs.length, exchange: data.exchange, first: first.t, trades: r.trades, equity: r.equity, manifest, evidenceHash,
        metrics: mt, reconciliation: r.reconciliation, liquidityLimited: r.liquidityLimited, data: report.data, integrity: report.integrity,
        splits: report.splits ? { plan: report.splits.plan, segments: report.splits.segments, frozen: report.splits.frozen, train: report.splits.train.metrics, validation: report.splits.validation.metrics, test: report.splits.test.metrics } : null,
        splitError: report.splitError, walkForward: report.walkForward, benchmarks: report.benchmarks, limitations: report.limitations,
        costAssumptions: data.feePct === 0 || data.slippagePct === 0 ? "Zero-cost assumptions: not promotion evidence" : "User-supplied simulation costs; not verified venue costs",
      } as never,
    });
    if (resultWrite.error) throw new Error("Complete backtest evidence could not be stored");
    await supabaseAdmin.from("backtests").update({ status: "completed", completed_at: new Date().toISOString(), start_date: new Date(first.t).toISOString() }).eq("id", bt.id);
    return { id: bt.id, status: "completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("backtests").update({ status: "failed", error: msg.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", bt.id);
    return { id: bt.id, error: msg, status: "failed" };
  }
}
