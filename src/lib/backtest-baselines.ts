// Benchmarks run through the same v3 simulator, candles, capital and cost model as the strategy under test.
import type { Candle } from "./indicators";
import { emptyStrategyConfig, type StrategyConfig } from "./strategy";
import { runBacktestV3, type SimOptions } from "./backtest-v3";

/** Enters at the first tradable open (the same first bar the strategy can trade) with all capital and holds. */
export function buyAndHoldConfig(pair: string, timeframe: string): StrategyConfig {
  const c = emptyStrategyConfig();
  return { ...c, pairs: [pair], timeframe, entry: { logic: "all", conditions: [{ left: "price", operator: ">", right: "0" }] }, exit: { logic: "any", conditions: [] },
    risk: { ...c.risk, stop_loss_pct: null, take_profit_pct: null, trailing_stop_pct: null, position_size_pct: 100, max_open_positions: 1, daily_loss_limit_pct: null } };
}

/** Long when EMA(12) crosses above EMA(26), flat when it crosses below; all capital, no stops. */
export function emaCrossoverConfig(pair: string, timeframe: string, fast = 12, slow = 26): StrategyConfig {
  const c = emptyStrategyConfig();
  return { ...c, pairs: [pair], timeframe,
    indicators: [{ id: "ema_fast", type: "EMA", params: { period: fast } }, { id: "ema_slow", type: "EMA", params: { period: slow } }],
    entry: { logic: "all", conditions: [{ left: "ema_fast", operator: "crosses_above", right: "ema_slow" }] },
    exit: { logic: "any", conditions: [{ left: "ema_fast", operator: "crosses_below", right: "ema_slow" }] },
    risk: { ...c.risk, stop_loss_pct: null, take_profit_pct: null, trailing_stop_pct: null, position_size_pct: 100, max_open_positions: 1, daily_loss_limit_pct: null } };
}

export function runBenchmarks(pair: string, timeframe: string, cs: Candle[], o: SimOptions) {
  const bh = runBacktestV3(buyAndHoldConfig(pair, timeframe), cs, o);
  const ema = runBacktestV3(emaCrossoverConfig(pair, timeframe), cs, o);
  return [
    { key: "buy_and_hold", label: "Buy and hold", metrics: bh.metrics, equity: bh.equity, trades: bh.trades.length },
    { key: "ema_12_26", label: "EMA 12/26 crossover", metrics: ema.metrics, equity: ema.equity, trades: ema.trades.length },
  ];
}
