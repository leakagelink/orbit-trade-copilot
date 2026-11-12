// Pure chronological train / validation / test splits and walk-forward folds. Never shuffles time.
// Each segment is simulated on candles that END at the segment's last bar, so later candles cannot influence it;
// earlier candles may warm up indicators but no trade is opened before the segment starts.
import type { Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";
import { evidenceHash } from "./evidence-hash";
import { runBacktestV3, type SimOptions } from "./backtest-v3";
import { performanceMetrics } from "./backtest-metrics";

export interface Segment { name: string; startIdx: number; endIdx: number; startT: number; endT: number }
export interface SplitPlan { trainPct: number; validationPct: number; purgeBars: number; embargoBars: number }
export const DEFAULT_SPLIT: SplitPlan = { trainPct: 60, validationPct: 20, purgeBars: 2, embargoBars: 2 };

/** Train → (purge + embargo gap) → validation → (gap) → test. Throws when a segment would be empty. */
export function chronologicalSplit(cs: Candle[], p: SplitPlan = DEFAULT_SPLIT): Segment[] {
  const n = cs.length, gap = p.purgeBars + p.embargoBars;
  if (p.trainPct <= 0 || p.validationPct <= 0 || p.trainPct + p.validationPct >= 100 || p.purgeBars < 0 || p.embargoBars < 0) throw new Error("Invalid split plan");
  const usable = n - 2 * gap;
  const trainN = Math.floor(usable * p.trainPct / 100), valN = Math.floor(usable * p.validationPct / 100), testN = usable - trainN - valN;
  if (trainN < 2 || valN < 2 || testN < 2) throw new Error(`Not enough candles for train/validation/test with a ${gap}-bar gap (${n} candles)`);
  const mk = (name: string, s: number, e: number): Segment => ({ name, startIdx: s, endIdx: e, startT: cs[s]!.t, endT: cs[e]!.t });
  const train = mk("train", 0, trainN - 1);
  const validation = mk("validation", trainN + gap, trainN + gap + valN - 1);
  const test = mk("test", validation.endIdx + 1 + gap, n - 1);
  return [train, validation, test];
}

/** Rolling walk-forward: each fold trains on `trainBars`, skips the gap, then tests on the next `testBars`. */
export function walkForwardFolds(cs: Candle[], o: { trainBars: number; testBars: number; purgeBars: number; embargoBars: number }) {
  const gap = o.purgeBars + o.embargoBars, folds: { train: Segment; test: Segment }[] = [];
  for (let s = 0; s + o.trainBars + gap + o.testBars <= cs.length; s += o.testBars) {
    const te = s + o.trainBars + gap;
    folds.push({ train: { name: `fold ${folds.length + 1} train`, startIdx: s, endIdx: s + o.trainBars - 1, startT: cs[s]!.t, endT: cs[s + o.trainBars - 1]!.t },
      test: { name: `fold ${folds.length + 1} test`, startIdx: te, endIdx: te + o.testBars - 1, startT: cs[te]!.t, endT: cs[te + o.testBars - 1]!.t } });
  }
  return folds;
}

/** Simulates one segment using only candles up to its end; equity starts at capital at the segment start. */
export function runSegment(cfg: StrategyConfig, cs: Candle[], seg: Segment, o: SimOptions) {
  const r = runBacktestV3(cfg, cs.slice(0, seg.endIdx + 1), { ...o, tradeFrom: seg.startT });
  const equity = [{ t: seg.startT, v: o.capital }, ...r.equity.filter((e) => e.t > seg.startT)];
  return { segment: seg, metrics: performanceMetrics(r.trades, equity, o.capital, o.tfMs), trades: r.trades, equity, reconciliation: r.reconciliation };
}

export const configHash = (cfg: StrategyConfig) => evidenceHash(cfg);

/**
 * Picks one candidate using train + validation only, records its SHA-256 (frozen) and only then evaluates the test
 * period once. Test candles can never influence the choice.
 */
export async function evaluateFrozen(candidates: StrategyConfig[], cs: Candle[], o: SimOptions, plan: SplitPlan = DEFAULT_SPLIT) {
  if (!candidates.length) throw new Error("At least one strategy candidate is required");
  const [train, validation, test] = chronologicalSplit(cs, plan) as [Segment, Segment, Segment];
  const scored = candidates.map((cfg, index) => ({ index, train: runSegment(cfg, cs, train, o), validation: runSegment(cfg, cs, validation, o) }));
  const best = scored.reduce((a, b) => ((b.validation.metrics.netProfit > a.validation.metrics.netProfit) ? b : a));
  const chosen = candidates[best.index]!;
  const frozen = { index: best.index, configSha256: await configHash(chosen), frozenBefore: "test" as const, selectedBy: "validation net profit" };
  const testRun = runSegment(chosen, cs, test, o);
  return { plan, segments: [train, validation, test], frozen, train: best.train, validation: best.validation, test: testRun };
}
