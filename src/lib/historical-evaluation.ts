// Pure historical evaluation of one deterministic strategy: data integrity first (fail closed), then the v3
// simulation over the full period, frozen train/validation/test, walk-forward folds and benchmarks on identical data.
import type { Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";
import { dataManifest, validateCandles, type DataSource } from "./historical-data";
import { runBacktestV3, SIMULATOR_V3, type SimOptions } from "./backtest-v3";
import { DEFAULT_SPLIT, evaluateFrozen, runSegment, walkForwardFolds, type SplitPlan } from "./backtest-splits";
import { runBenchmarks } from "./backtest-baselines";
import type { CostModel } from "./backtest-costs";

export const MIN_CANDLES = 60;
export const HISTORICAL_LIMITATIONS = [
  "Historical simulation only: not live qualification, not paper or live fills, and not evidence of future profit.",
  "Fees, spread, slippage and volume limits are your assumptions, not verified venue costs.",
  "Stops and targets inside one candle are resolved stop-first because the true order of prices is unknown.",
  "Sharpe ratio uses a zero risk-free rate and 365-day annualisation (markets that trade every day).",
];

export interface HistoricalInput {
  cfg: StrategyConfig; candles: Candle[]; source: DataSource; tfMs: number;
  start: number; end: number; fetchedAt: number; capital: number; costs: CostModel; split?: SplitPlan;
}

export async function evaluateStrategyHistory(i: HistoricalInput) {
  const integrity = validateCandles(i.candles, { tfMs: i.tfMs, start: i.start, end: i.end, minCandles: MIN_CANDLES });
  const data = await dataManifest({ source: i.source, tfMs: i.tfMs, start: i.start, end: i.end, decisionCutoff: i.end, fetchedAt: i.fetchedAt, candles: i.candles, coverage: integrity.coverage });
  if (!integrity.ok) return { status: "insufficient_data" as const, integrity, data, reason: `Historical data is incomplete or invalid (${integrity.issues.length} issue${integrity.issues.length === 1 ? "" : "s"}): ${integrity.issues.slice(0, 3).map((x) => x.detail).join("; ")}. No candles were invented; choose a shorter period or a larger timeframe.` };
  const o: SimOptions = { capital: i.capital, tfMs: i.tfMs, costs: i.costs, market: i.source.market };
  const full = runBacktestV3(i.cfg, i.candles, o);
  const plan = i.split ?? DEFAULT_SPLIT;
  let splits: Awaited<ReturnType<typeof evaluateFrozen>> | null = null, splitError: string | null = null;
  try { splits = await evaluateFrozen([i.cfg], i.candles, o, plan); } catch (e) { splitError = e instanceof Error ? e.message : String(e); }
  const n = i.candles.length;
  const folds = walkForwardFolds(i.candles, { trainBars: Math.max(MIN_CANDLES, Math.floor(n / 3)), testBars: Math.max(20, Math.floor(n / 6)), purgeBars: plan.purgeBars, embargoBars: plan.embargoBars });
  const walkForward = folds.map((f) => ({ train: f.train, test: f.test, metrics: runSegment(i.cfg, i.candles, f.test, o).metrics }));
  const benchmarks = runBenchmarks(i.cfg.pairs[0] ?? i.source.pair, i.cfg.timeframe, i.candles, o);
  return { status: "completed" as const, simulatorVersion: SIMULATOR_V3, integrity, data, full, splits, splitError, walkForward, benchmarks, limitations: HISTORICAL_LIMITATIONS };
}
