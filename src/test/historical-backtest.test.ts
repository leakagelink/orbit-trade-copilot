// Phase 2 historical backtesting: simulator v3 ordering and costs, data integrity, point-in-time evidence,
// chronological splits, metrics, benchmarks and equity reconciliation. Deterministic; no AI or network calls.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Candle } from "@/lib/indicators";
import { emptyStrategyConfig, type StrategyConfig } from "@/lib/strategy";
import { runBacktest } from "@/lib/backtest";
import { runBacktestV3, type SimOptions } from "@/lib/backtest-v3";
import { fillAt, type CostModel } from "@/lib/backtest-costs";
import { performanceMetrics } from "@/lib/backtest-metrics";
import { buyAndHoldConfig, emaCrossoverConfig, runBenchmarks } from "@/lib/backtest-baselines";
import { chronologicalSplit, evaluateFrozen, runSegment, walkForwardFolds } from "@/lib/backtest-splits";
import { candlesAvailableAt, dataManifest, evidenceAvailableAt, validateCandles } from "@/lib/historical-data";
import { evaluateStrategyHistory } from "@/lib/historical-evaluation";
import { replayMatches } from "@/lib/replay-evidence";
import { evaluateHistoricalEvidence } from "@/lib/evaluation";
import { evidenceHash } from "@/lib/evidence-hash";
import { researchOutcome, summarizeOutcomes } from "@/lib/research-outcomes";

const H = 3_600_000;
const ZERO: CostModel = { feePct: 0, spreadPct: 0, slippagePct: 0, maxParticipationPct: null };
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1e9): Candle => ({ t: i * H, o, h, l, c, v });
const flat = (n: number, p = 100) => Array.from({ length: n }, (_, i) => bar(i, p, p, p, p));
const opts = (costs: CostModel = ZERO, extra: Partial<SimOptions> = {}): SimOptions => ({ capital: 1000, tfMs: H, costs, ...extra });
function cfgWith(o: { entry?: StrategyConfig["entry"]; exit?: StrategyConfig["exit"]; sl?: number | null; tp?: number | null; size?: number }): StrategyConfig {
  const c = emptyStrategyConfig();
  return { ...c, entry: o.entry ?? { logic: "all", conditions: [{ left: "price", operator: ">", right: "0" }] }, exit: o.exit ?? { logic: "any", conditions: [] },
    risk: { ...c.risk, stop_loss_pct: o.sl ?? null, take_profit_pct: o.tp ?? null, position_size_pct: o.size ?? 100, max_open_positions: 1 } };
}
const wave = (n: number) => Array.from({ length: n }, (_, i) => { const c = 100 + 10 * Math.sin(i / 6) + i * 0.05; return bar(i, c - 0.3, c + 1.2, c - 1.4, c); });

describe("defect fixes in simulator v3", () => {
  it("a prior-bar exit signal exits at the open before an intrabar stop is considered", () => {
    const cfg = cfgWith({ sl: 5, exit: { logic: "any", conditions: [{ left: "price", operator: ">", right: "105" }] } });
    const cs = [bar(0, 100, 100, 100, 100), bar(1, 100, 110, 100, 110), bar(2, 108, 108, 90, 92), bar(3, 92, 92, 92, 92)];
    const v3 = runBacktestV3(cfg, cs, opts());
    expect(v3.trades[0]).toMatchObject({ entryT: H, exitT: 2 * H, entry: 100, exit: 108, reason: "exit_signal" });
    const v2 = runBacktest(cfg, cs, { capital: 1000, feePct: 0, slippagePct: 0, tfMs: H });
    expect(v2.trades[0]).toMatchObject({ exit: 95, reason: "stop_loss" }); // the old ordering, kept for stored v2 evidence
  });
  it("evaluates the entry bar's stop loss", () => {
    const r = runBacktestV3(cfgWith({ sl: 5 }), [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 94, 99)], opts());
    expect(r.trades[0]).toMatchObject({ entryT: H, exitT: H, exit: 95, reason: "stop_loss", ambiguous: false });
  });
  it("evaluates the entry bar's take profit", () => {
    const r = runBacktestV3(cfgWith({ tp: 5 }), [bar(0, 100, 100, 100, 100), bar(1, 100, 106, 99, 104)], opts());
    expect(r.trades[0]).toMatchObject({ entryT: H, exitT: H, exit: 105, reason: "take_profit" });
  });
  it("a bar touching both stop and target resolves stop-first and is flagged ambiguous", () => {
    const r = runBacktestV3(cfgWith({ sl: 5, tp: 5 }), [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 106, 94, 100)], opts());
    expect(r.trades[0]).toMatchObject({ exit: 95, reason: "stop_loss", ambiguous: true });
  });
  it("a gap through the stop fills at the worse open, never at the stop price", () => {
    const r = runBacktestV3(cfgWith({ sl: 5 }), [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 90, 91, 88, 89)], opts());
    expect(r.trades[0]).toMatchObject({ exit: 90, reason: "stop_loss" });
  });
  it("terminal liquidation costs are in the final equity, which equals capital plus every net result", () => {
    const costs: CostModel = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: null };
    const r = runBacktestV3(cfgWith({}), flat(5), opts(costs));
    const entry = 100 * (1 + 0.0001 + 0.0005), qty = 1000 / (entry * 1.001), exit = 100 * (1 - 0.0006);
    const expected = 1000 + (exit - entry) * qty - (entry + exit) * qty * 0.001;
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.reason).toBe("end_of_test");
    expect(r.equity.at(-1)!.v).toBeCloseTo(expected, 9);
    expect(r.metrics.finalEquity).toBeCloseTo(expected, 9);
    expect(r.reconciliation.difference).toBeCloseTo(0, 9);
    expect(r.metrics.netReturnPct!).toBeLessThan(0);
  });
  it("equity reconciles with capital + net P&L across many trades with costs", () => {
    const cfg: StrategyConfig = { ...emaCrossoverConfig("BTC/USDT", "1h", 5, 13), risk: { ...emaCrossoverConfig("BTC/USDT", "1h").risk, stop_loss_pct: 2, take_profit_pct: 3, position_size_pct: 50 } };
    const r = runBacktestV3(cfg, wave(400), opts({ feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 10 }));
    expect(r.trades.length).toBeGreaterThan(5);
    expect(Math.abs(r.reconciliation.difference)).toBeLessThan(1e-6);
    expect(r.equity.at(-1)!.v).toBeCloseTo(1000 + r.trades.reduce((a, t) => a + t.net, 0), 6);
  });
});

describe("trading costs", () => {
  const c: CostModel = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: null };
  it("buys fill above and sells below the reference by half the spread plus slippage", () => {
    expect(fillAt("buy", 100, 2, c).price).toBeCloseTo(100.06, 10);
    expect(fillAt("sell", 100, 2, c).price).toBeCloseTo(99.94, 10);
    expect(fillAt("buy", 100, 2, c)).toMatchObject({ spreadCost: expect.closeTo(0.02, 10), slippageCost: expect.closeTo(0.1, 10) });
    expect(fillAt("buy", 100, 2, c).fee).toBeCloseTo(100.06 * 2 * 0.001, 10);
  });
  it("a flat-price round trip loses exactly fees + spread + slippage, each reported once", () => {
    const r = runBacktestV3(cfgWith({}), flat(4), opts(c));
    const t = r.trades[0]!;
    expect(t.net).toBeCloseTo(-(t.fees + t.spread + t.slippage), 9);
    expect(r.metrics.totalSpread).toBeCloseTo(100 * t.qty * 0.0001 * 2, 9);
    expect(r.metrics.totalSlippage).toBeCloseTo(100 * t.qty * 0.0005 * 2, 9);
  });
  it("caps a fill at the configured share of candle volume", () => {
    const cs = flat(4).map((x) => ({ ...x, v: 2 }));
    const r = runBacktestV3(cfgWith({}), cs, opts({ ...ZERO, maxParticipationPct: 10 }));
    expect(r.trades[0]!.qty).toBeCloseTo(0.2, 12);
    expect(r.liquidityLimited).toBe(1);
  });
  it("short positions profit when price falls and pay costs on both sides", () => {
    const rates = Array.from({ length: 7 }, (_, i) => ({ t: i * 8 * H, rate: 0 }));
    const cs = Array.from({ length: 48 }, (_, i) => bar(i, i < 2 ? 100 : 90, i < 2 ? 100 : 90, i < 2 ? 100 : 90, i < 2 ? 100 : 90));
    const r = runBacktestV3(cfgWith({}), cs, opts(c, { direction: "short", market: "futures", funding: rates }));
    const t = r.trades[0]!;
    expect(t.side).toBe("short");
    expect(t.entry).toBeCloseTo(100 * (1 - 0.0006), 10);
    expect(t.pnl).toBeCloseTo((t.entry - t.exit) * t.qty, 9);
    expect(t.net).toBeGreaterThan(0);
  });
});

describe("funding", () => {
  const cs = flat(48);
  const rates = Array.from({ length: 7 }, (_, i) => ({ t: i * 8 * H, rate: 0.0001 }));
  it("a long pays and a short receives positive funding for every funding time it is open", () => {
    const long = runBacktestV3(cfgWith({}), cs, opts(ZERO, { market: "futures", funding: rates }));
    const short = runBacktestV3(cfgWith({}), cs, opts(ZERO, { market: "futures", funding: rates, direction: "short" }));
    const qty = long.trades[0]!.qty;
    // Open from 01:00 to the final bar (47:00): funding times 08:00, 16:00, 24:00, 32:00, 40:00 → 5 payments.
    expect(long.trades[0]!.funding).toBeCloseTo(-5 * qty * 100 * 0.0001, 9);
    expect(short.trades[0]!.funding).toBeCloseTo(5 * qty * 100 * 0.0001, 9);
    expect(long.metrics.totalFunding).toBeCloseTo(long.trades[0]!.funding, 12);
    expect(long.reconciliation.difference).toBeCloseTo(0, 9);
  });
  it("a Futures backtest without funding history is rejected, never run with zero funding", () => {
    expect(() => runBacktestV3(cfgWith({}), cs, opts(ZERO, { market: "futures" }))).toThrow(/Futures backtest rejected/);
    expect(() => runBacktestV3(cfgWith({}), cs, opts(ZERO, { market: "futures", funding: rates.slice(0, 3) }))).toThrow(/does not cover/);
  });
  it("a short on a Spot market is refused", () => {
    expect(() => runBacktestV3(cfgWith({}), cs, opts(ZERO, { direction: "short" }))).toThrow(/Futures/);
  });
});

describe("historical data integrity", () => {
  const range = { tfMs: H, start: 0, end: 10 * H };
  it("complete, ordered data passes with 100% completeness", () => {
    const v = validateCandles(flat(10), range);
    expect(v.ok).toBe(true);
    expect(v.coverage).toMatchObject({ expected: 10, actual: 10, missing: 0, completenessPct: 100 });
  });
  it("detects a missing candle and reports completeness below 100%", () => {
    const cs = flat(10).filter((c) => c.t !== 4 * H);
    const v = validateCandles(cs, range);
    expect(v.ok).toBe(false);
    expect(v.issues.find((x) => x.kind === "missing")?.t).toBe(4 * H);
    expect(v.coverage.completenessPct).toBe(90);
  });
  it("detects duplicates, reversed order, invalid prices and negative volume", () => {
    const cs = flat(10);
    const kinds = (x: Candle[]) => validateCandles(x, range).issues.map((i) => i.kind);
    expect(kinds([...cs.slice(0, 5), cs[4]!, ...cs.slice(5)])).toContain("duplicate");
    expect(kinds([cs[0]!, cs[2]!, cs[1]!, ...cs.slice(3)])).toContain("out_of_order");
    expect(kinds(cs.map((c, i) => (i === 3 ? { ...c, l: 0 } : c)))).toContain("invalid_price");
    expect(kinds(cs.map((c, i) => (i === 3 ? { ...c, v: -1 } : c)))).toContain("invalid_volume");
    expect(kinds(cs.map((c, i) => (i === 3 ? { ...c, h: 99 } : c)))).toContain("impossible_range");
  });
  it("detects that the requested range is not covered at the start or the end", () => {
    expect(validateCandles(flat(10).slice(3), range).issues.map((i) => i.kind)).toContain("coverage_start");
    expect(validateCandles(flat(10).slice(0, 7), range).issues.map((i) => i.kind)).toContain("coverage_end");
  });
  it("the data manifest fingerprint changes when any candle changes", async () => {
    const cs = flat(10), cov = validateCandles(cs, range).coverage;
    const src = { provider: "binance", endpoint: "klines", market: "spot" as const, pair: "BTC/USDT", timeframe: "1h" };
    const a = await dataManifest({ source: src, tfMs: H, start: 0, end: 10 * H, decisionCutoff: 10 * H, fetchedAt: 1, candles: cs, coverage: cov });
    const b = await dataManifest({ source: src, tfMs: H, start: 0, end: 10 * H, decisionCutoff: 10 * H, fetchedAt: 1, candles: cs.map((c, i) => (i === 9 ? { ...c, c: 100.01 } : c)), coverage: cov });
    expect(a.candleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.candleSha256).not.toBe(b.candleSha256);
    expect(a.decisionCutoff).toBe(10 * H);
  });
  it("complete data runs the full period, frozen periods, walk-forward folds and both benchmarks", async () => {
    const base = emaCrossoverConfig("BTC/USDT", "1h", 5, 13);
    const r = await evaluateStrategyHistory({ cfg: { ...base, risk: { ...base.risk, stop_loss_pct: 2 } }, candles: wave(300), source: { provider: "binance", endpoint: "klines", market: "spot", pair: "BTC/USDT", timeframe: "1h" }, tfMs: H, start: 0, end: 300 * H, fetchedAt: 1, capital: 1000, costs: { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 10 } });
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r.integrity.coverage.completenessPct).toBe(100);
    expect(r.splits?.segments.map((x) => x.name)).toEqual(["train", "validation", "test"]);
    expect(r.walkForward.length).toBeGreaterThan(0);
    expect(r.benchmarks.map((b) => b.key)).toEqual(["buy_and_hold", "ema_12_26"]);
    expect(Math.abs(r.full.reconciliation.difference)).toBeLessThan(1e-6);
  });
  it("evaluation fails closed on incomplete data: nothing is simulated", async () => {
    const cs = flat(100).filter((c) => c.t !== 50 * H);
    const r = await evaluateStrategyHistory({ cfg: cfgWith({}), candles: cs, source: { provider: "binance", endpoint: "klines", market: "spot", pair: "BTC/USDT", timeframe: "1h" }, tfMs: H, start: 0, end: 100 * H, fetchedAt: 1, capital: 1000, costs: ZERO });
    expect(r.status).toBe("insufficient_data");
    expect("full" in r).toBe(false);
  });
});

describe("point-in-time evidence and look-ahead", () => {
  it("only candles fully closed by the decision cut-off are available", () => {
    expect(candlesAvailableAt(flat(5), 3 * H, H).map((c) => c.t)).toEqual([0, H, 2 * H]);
  });
  it("evidence published after the cut-off, or with no publication time, is excluded", () => {
    const items = [{ id: "a", publishedAt: 100 }, { id: "b", publishedAt: 201 }, { id: "c", publishedAt: null }, { id: "d" }];
    expect(evidenceAvailableAt(items, 200).map((x) => x.id)).toEqual(["a"]);
  });
  it("changing future candles never changes trades that closed earlier", () => {
    const cfg = { ...emaCrossoverConfig("BTC/USDT", "1h", 5, 13) };
    const cs = wave(300), cut = 200;
    const altered = cs.map((c, i) => (i >= cut ? { ...c, o: c.o * 1.5, h: c.h * 1.5, l: c.l * 1.5, c: c.c * 1.5 } : c));
    const before = (x: Candle[]) => runBacktestV3(cfg, x, opts()).trades.filter((t) => t.exitT < cs[cut]!.t);
    expect(before(cs).length).toBeGreaterThan(2);
    expect(before(altered)).toEqual(before(cs));
  });
});

describe("chronological splits", () => {
  const cs = wave(300);
  it("train < validation < test, disjoint, separated by purge + embargo bars", () => {
    const [tr, va, te] = chronologicalSplit(cs, { trainPct: 60, validationPct: 20, purgeBars: 2, embargoBars: 3 });
    expect(tr!.startIdx).toBe(0);
    expect(va!.startIdx - tr!.endIdx - 1).toBe(5);
    expect(te!.startIdx - va!.endIdx - 1).toBe(5);
    expect(te!.endIdx).toBe(299);
    expect(tr!.endT).toBeLessThan(va!.startT);
    expect(va!.endT).toBeLessThan(te!.startT);
  });
  it("a segment's results ignore every later candle and open no trade before the segment starts", () => {
    const [, va] = chronologicalSplit(cs);
    const altered = cs.map((c, i) => (i > va!.endIdx ? { ...c, o: 1, h: 1, l: 1, c: 1 } : c));
    const a = runSegment(emaCrossoverConfig("BTC/USDT", "1h", 5, 13), cs, va!, opts());
    const b = runSegment(emaCrossoverConfig("BTC/USDT", "1h", 5, 13), altered, va!, opts());
    expect(b.trades).toEqual(a.trades);
    expect(a.trades.every((t) => t.entryT >= va!.startT && t.exitT <= va!.endT)).toBe(true);
  });
  it("the strategy is chosen on validation and frozen before the test period; test candles cannot change the choice", async () => {
    const good = emaCrossoverConfig("BTC/USDT", "1h", 5, 13), never = cfgWith({ entry: { logic: "all", conditions: [{ left: "price", operator: "<", right: "0" }] } });
    const r = await evaluateFrozen([never, good], cs, opts());
    const altered = cs.map((c, i) => (i >= r.segments[2]!.startIdx ? { ...c, o: c.o * 3, h: c.h * 3, l: c.l * 3, c: c.c * 3 } : c));
    const r2 = await evaluateFrozen([never, good], altered, opts());
    expect(r.frozen.frozenBefore).toBe("test");
    expect(r2.frozen).toEqual(r.frozen);
    expect(r.frozen.configSha256).toBe(await evidenceHash(r.frozen.index === 1 ? good : never));
  });
  it("walk-forward folds move forward in time without overlapping test periods", () => {
    const folds = walkForwardFolds(cs, { trainBars: 100, testBars: 50, purgeBars: 2, embargoBars: 2 });
    expect(folds).toHaveLength(3);
    for (let i = 0; i < folds.length; i++) {
      expect(folds[i]!.train.endIdx + 5).toBe(folds[i]!.test.startIdx);
      if (i) expect(folds[i]!.test.startIdx).toBe(folds[i - 1]!.test.endIdx + 1);
    }
  });
});

describe("metrics", () => {
  const tr = (net: number, entryT = 0, exitT = 2 * H) => ({ entryT, exitT, pnl: net + 1, fees: 1, spread: 0, slippage: 0, funding: 0, net });
  it("win rate, profit factor, expectancy and holding period use net results", () => {
    const m = performanceMetrics([tr(10), tr(-5), tr(20, 0, 4 * H)], [{ t: 0, v: 1000 }, { t: H, v: 1025 }], 1000, H);
    expect(m.winRatePct).toBeCloseTo(66.6667, 3);
    expect(m.profitFactor).toBe(6);
    expect(m.expectancy).toBeCloseTo(25 / 3, 10);
    expect(m.netReturnPct).toBeCloseTo(2.5, 10);
    expect(m.totalFees).toBe(3);
    expect(m.avgHoldingMs).toBeCloseTo((8 * H) / 3, 6);
  });
  it("equity 1000 → 1200 → 960 is a 20% maximum drawdown", () => {
    expect(performanceMetrics([], [{ t: 0, v: 1000 }, { t: H, v: 1200 }, { t: 2 * H, v: 960 }], 1000, H).maxDrawdownPct).toBeCloseTo(20, 10);
  });
  it("Sharpe uses the sample deviation annualised by the bar frequency", () => {
    const eq = [1000, 1010, 1005, 1020].map((v, i) => ({ t: i * H, v }));
    const r = [1010 / 1000 - 1, 1005 / 1010 - 1, 1020 / 1005 - 1], mean = r.reduce((a, b) => a + b) / 3;
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / 2);
    expect(performanceMetrics([], eq, 1000, H).sharpe).toBeCloseTo((mean / sd) * Math.sqrt(8760), 8);
    expect(performanceMetrics([], eq, 1000, 86_400_000).sharpe).toBeCloseTo((mean / sd) * Math.sqrt(365), 8);
  });
  it("profit factor is undefined, not infinite, when there are no losing trades", () => {
    const m = performanceMetrics([tr(5)], [], 1000, H);
    expect(m.profitFactor).toBeNull();
    expect(m.profitFactorNote).toMatch(/No losing trades/);
  });
});

describe("benchmarks", () => {
  it("buy-and-hold and EMA 12/26 use exactly the strategy's candles, first tradable bar, capital and costs", () => {
    const cs = wave(300), costs: CostModel = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 10 };
    const strategy = runBacktestV3(emaCrossoverConfig("BTC/USDT", "1h", 5, 13), cs, opts(costs));
    const [bh, ema] = runBenchmarks("BTC/USDT", "1h", cs, opts(costs));
    expect(bh!.equity[0]).toEqual(strategy.equity[0]);
    expect(bh!.equity.at(-1)!.t).toBe(strategy.equity.at(-1)!.t);
    expect(ema!.equity.length).toBe(strategy.equity.length);
    const direct = runBacktestV3(buyAndHoldConfig("BTC/USDT", "1h"), cs, opts(costs));
    expect(direct.trades[0]!.entryT).toBe(cs[1]!.t);
    expect(bh!.metrics.netProfit).toBeCloseTo(direct.metrics.netProfit, 10);
    expect(bh!.metrics.totalFees).toBeGreaterThan(0);
  });
});

describe("stored evidence compatibility", () => {
  // A saved strategy must have a stop loss to be valid; the benchmark configuration alone has none.
  const base = emaCrossoverConfig("BTC/USDT", "1h", 5, 13), cfg = { ...base, risk: { ...base.risk, stop_loss_pct: 2, position_size_pct: 50 } }, cs = wave(200);
  const costs = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 10 };
  const sim = runBacktestV3(cfg, cs, opts(costs));
  const manifest = { simulatorVersion: "next-bar-v3", config: cfg, market: "spot", ...costs, tfMs: H, candles: cs };
  it("v3 evidence replays exactly and tampering is detected", async () => {
    const e = { manifest, trades: sim.trades, equity: sim.equity, evidenceHash: "a".repeat(64) };
    expect(await replayMatches(e, 1000)).toBe(true);
    expect(await replayMatches({ ...e, trades: sim.trades.slice(1) }, 1000)).toBe(false);
  });
  it("v3 evidence passes the independent evaluation's reconciliation checks", () => {
    const r = evaluateHistoricalEvidence({ manifest, trades: sim.trades, equity: sim.equity, evidenceHash: "a".repeat(64) }, true, undefined, 1000);
    expect(r.violations).toEqual([]);
    expect(r.metrics?.netProfit).toBeCloseTo(sim.metrics.netProfit, 8);
  });
});

describe("stored Research AI decisions: forward-only outcomes", () => {
  const D = Date.parse("2026-11-01T12:00:00Z"), day = 86_400_000;
  const proposal = (over: Record<string, unknown> = {}) => ({ advisoryOnly: true, executionAllowed: false, status: "scenario", direction: "long", referenceClose: 100, asOf: "2026-10-31T00:00:00Z", hypotheticalEntry: 100, stopLoss: 95, takeProfit: 110, rewardRisk: 2, positionSize: null, confidence: null, reasons: [], limitations: [], ...over });
  const daily = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });
  const before = daily(Date.parse("2026-11-01T00:00:00Z"), 100, 200, 50, 100); // already open at decision time: must be ignored
  const after = daily(Date.parse("2026-11-02T00:00:00Z"), 100, 111, 99, 108);
  it("uses only bars opening after the decision; a bar that had already started is ignored", () => {
    const r = researchOutcome({ proposalId: "p", runId: "r", symbol: "BTC-USD", decidedAt: D, proposal: proposal() }, [before, after], after.t + 2 * day);
    expect(r).toMatchObject({ status: "closed", reason: "take_profit" });
    expect((r as { entry: number }).entry).toBeCloseTo(100 * 1.0005, 10);
  });
  it("excludes a decision whose evidence is dated after it (leak), and labels no-trade decisions", () => {
    expect(researchOutcome({ proposalId: "p", runId: "r", symbol: "X", decidedAt: D, proposal: proposal({ asOf: "2026-11-05T00:00:00Z" }) }, [after], D + 5 * day).status).toBe("excluded");
    expect(researchOutcome({ proposalId: "p", runId: "r", symbol: "X", decidedAt: D, proposal: proposal({ status: "withheld", direction: "none" }) }, [after], D + 5 * day).status).toBe("no_scenario");
  });
  it("shows no average until 30 outcomes have closed", () => {
    const one = researchOutcome({ proposalId: "p", runId: "r", symbol: "BTC-USD", decidedAt: D, proposal: proposal() }, [after], after.t + 2 * day);
    expect(summarizeOutcomes([one]).averageNetPct).toBeNull();
  });
  it("the outcome server function reaches no AI provider or order code", () => {
    const src = readFileSync("src/lib/historical-evaluation.functions.ts", "utf8");
    const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./plan.server", "./research-outcomes", "./yahoo-chart.server", "@/integrations/supabase/auth-middleware", "@tanstack/react-start"].sort());
  });
});
