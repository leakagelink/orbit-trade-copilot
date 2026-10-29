import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateStrategy, type StrategyConfig } from "./strategy";
import { runBacktest } from "./backtest";

const input = z.object({
  strategyId: z.string().uuid(),
  exchange: z.enum(["binance", "bybit", "okx", "kucoin", "coinbase"]),
  days: z.number().int().min(1).max(365),
  capital: z.number().positive().max(1e9),
  feePct: z.number().min(0).max(2),
  slippagePct: z.number().min(0).max(2),
});

export const runBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => input.parse(i))
  .handler(async ({ data, context }) => {
    const { data: s } = await context.supabase.from("strategies").select("id,config,current_version").eq("id", data.strategyId).maybeSingle();
    if (!s) throw new Error("Strategy not found");
    const cfg = s.config as unknown as StrategyConfig;
    if (validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
    const pair = cfg.pairs[0]!;
    const { fetchHistory, timeframeMs } = await import("./exchange-adapters.server");
    const tfMs = timeframeMs(cfg.timeframe);
    const end = Date.now(), start = end - data.days * 86_400_000;

    const { data: bt, error } = await context.supabase.from("backtests").insert({
      user_id: context.userId, strategy_id: s.id, strategy_version: s.current_version, trading_pair: pair, timeframe: cfg.timeframe,
      start_date: new Date(start).toISOString(), end_date: new Date(end).toISOString(),
      starting_capital: data.capital, fee_pct: data.feePct, slippage_pct: data.slippagePct, status: "running",
    }).select("id").single();
    if (error) throw new Error(error.message);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      const cs = await fetchHistory(data.exchange, pair, cfg.timeframe, start, end);
      if (cs.length < 60) throw new Error(`Only ${cs.length} candles available — choose a longer period or timeframe`);
      const r = runBacktest(cfg, cs, { capital: data.capital, feePct: data.feePct, slippagePct: data.slippagePct, tfMs });
      const step = Math.max(1, Math.ceil(r.equity.length / 400));
      const { sharpe, ...st } = r.stats;
      await supabaseAdmin.from("backtest_results").insert({
        backtest_id: bt.id, user_id: context.userId, ...st,
        equity_curve: r.equity.filter((_, i) => i % step === 0) as never,
        trade_log: { sharpe, candles: cs.length, exchange: data.exchange, first: cs[0]!.t, trades: r.trades.slice(-500) } as never,
      });
      await supabaseAdmin.from("backtests").update({ status: "completed", completed_at: new Date().toISOString(), start_date: new Date(cs[0]!.t).toISOString() }).eq("id", bt.id);
      return { id: bt.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabaseAdmin.from("backtests").update({ status: "failed", error: msg.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", bt.id);
      return { id: bt.id, error: msg };
    }
  });
