// Phase 4A strategy research: cost arithmetic, maker/taker fills with adverse selection, cooldowns, daily-return
// statistics, purged walk-forward selection, and a leakage test (changing unseen test data cannot change a choice).
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/indicators";
import type { IntradaySignal } from "@/lib/scalp-intraday";
import { featuresFor, researchFolds, researchGrid, researchSimulate, roundTripCostPct, tradeStats, variantSignals, walkForwardSelect, MAKER_WAIT_BARS, type ResearchTrade, type Variant } from "@/lib/scalp-research";
import { calibrateGbdt, gbdtProba, trainGbdt } from "@/lib/ml-gbdt";
import { trainLogistic, predictProba, classificationMetrics } from "@/lib/ml-logistic";
import { walkForwardModel } from "@/lib/scalp-model";
import { DEFAULT_INTRADAY } from "@/lib/scalp-intraday";

const M = 60_000, T0 = Date.UTC(2026, 0, 1);
const COSTS = { takerFeePct: 0.05, makerFeePct: 0.02, spreadPct: 0.01, slippagePct: 0.01 };
const V = (x: Partial<Variant> = {}): Variant => ({ id: "v", tfMin: 1, setups: ["breakout"], atrStopMult: 1, rewardRisk: 1, maxHoldBars: 10, mode: "taker", minEdgeCostMultiple: 0, cooldownBars: 0, minRelVolume: 1.5, ...x });
const flat = (n: number, p = 100): Candle[] => Array.from({ length: n }, (_, k) => ({ t: T0 + k * M, o: p, h: p, l: p, c: p, v: 10 }));
const sig = (action: "LONG" | "SHORT", stop: number, target: number): IntradaySignal => ({ t: 0, action, setup: "breakout", reasons: [], stop, target, features: null as never });
function walk(n: number, seed = 7): Candle[] {
  let s = seed, p = 100; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.004)); const h = Math.max(o, p) * (1 + rnd() * 0.001), l = Math.min(o, p) * (1 - rnd() * 0.001); return { t: T0 + k * M, o, h, l, c: p, v: 5 + rnd() * 20 }; });
}

describe("Scalping strategy research", () => {
  it("round-trip costs: taker both sides vs maker entry + taker stop", () => {
    expect(roundTripCostPct("taker", COSTS)).toBeCloseTo(0.13, 12);
    expect(roundTripCostPct("maker", COSTS)).toBeCloseTo(0.085, 12);
  });

  it("taker: fills at the next open with costs and exits at the target as taker", () => {
    const cs = flat(10); cs[3] = { ...cs[3]!, h: 101.5 };
    const s = new Array(cs.length).fill(null); s[1] = sig("LONG", 99, 101);
    const r = researchSimulate(cs, s, V(), COSTS, { baseMs: M, notional: 1000, funding: [] });
    const t = r.trades[0]!;
    expect(t.entry).toBeCloseTo(100 * (1 + 0.00005 + 0.0001), 9); expect(t.reason).toBe("target");
    expect(t.fees).toBeCloseTo((t.entry + t.exit) * 10 * 0.0005, 9); // qty = 1000 / open 100
    expect(t.net).toBeCloseTo(t.gross - t.fees + t.funding, 9);
  });

  it("maker: a touch does not fill, a trade-through fills at the limit, and a same-candle stop is assumed (adverse selection)", () => {
    const touch = flat(10); const s = new Array(10).fill(null); s[1] = sig("LONG", 99, 101);
    expect(researchSimulate(touch, s, V({ mode: "maker" }), COSTS, { baseMs: M, notional: 1000, funding: [] }).trades).toHaveLength(0);
    const through = flat(10); through[2] = { ...through[2]!, l: 99.9 }; through[4] = { ...through[4]!, h: 101.2 };
    const r = researchSimulate(through, s, V({ mode: "maker" }), COSTS, { baseMs: M, notional: 1000, funding: [] });
    expect(r.makerFilled).toBe(1); expect(r.trades[0]!.entry).toBe(100); expect(r.trades[0]!.fees).toBeCloseTo(1000 * 0.0002 + 1010 * 0.0002, 6); expect(r.trades[0]!.reason).toBe("target");
    const adverse = flat(10); adverse[2] = { ...adverse[2]!, l: 98.5 };
    const a = researchSimulate(adverse, s, V({ mode: "maker" }), COSTS, { baseMs: M, notional: 1000, funding: [] });
    expect(a.trades[0]!.reason).toBe("stop"); expect(a.trades[0]!.net).toBeLessThan(-10);
  });

  it("maker: an order not filled within its wait is counted as missed; cooldown blocks immediate re-entry", () => {
    const cs = flat(20); const s = new Array(20).fill(null); s[1] = sig("LONG", 99, 101);
    const r = researchSimulate(cs, s, V({ mode: "maker" }), COSTS, { baseMs: M, notional: 1000, funding: [] });
    expect(r.makerMissed).toBe(1); expect(MAKER_WAIT_BARS).toBe(3);
    const cs2 = flat(30); cs2[3] = { ...cs2[3]!, h: 101.5 }; const s2 = new Array(30).fill(null); s2[1] = sig("LONG", 99, 101); s2[4] = sig("LONG", 99, 101); s2[20] = sig("LONG", 99, 101);
    expect(researchSimulate(cs2, s2, V({ cooldownBars: 10 }), COSTS, { baseMs: M, notional: 1000, funding: [] }).trades).toHaveLength(2);
    expect(researchSimulate(cs2, s2, V({ cooldownBars: 0 }), COSTS, { baseMs: M, notional: 1000, funding: [] }).trades).toHaveLength(3);
  });

  it("the cost-edge filter drops signals whose target is below k × round-trip cost", () => {
    const cs = walk(3000), f = featuresFor(cs, 1);
    const all = variantSignals(cs, f, V({ setups: ["breakout", "pullback"] }), COSTS).filter(Boolean).length;
    const filtered = variantSignals(cs, f, V({ setups: ["breakout", "pullback"], minEdgeCostMultiple: 3 }), COSTS).filter(Boolean);
    expect(filtered.length).toBeLessThanOrEqual(all);
    for (const s of filtered) expect(s!.features.atrPct! * 1 * 1).toBeGreaterThanOrEqual(3 * 0.13 - 1e-12);
  });

  it("statistics use daily P&L for Sharpe and report gross vs cost in basis points", () => {
    const mk = (d: number, net: number): ResearchTrade => ({ side: "LONG", entryT: T0 + d * 86_400_000, exitT: T0 + d * 86_400_000 + 1, entry: 1, exit: 1, reason: "time", gross: net + 1, fees: 1, spread: 0, slippage: 0, funding: 0, net, holdBars: 1, markoutBps: { 1: 1, 5: 2, 15: null } });
    const s = tradeStats([mk(0, 2), mk(1, -1), mk(1, 3)], 1000, T0, T0 + 4 * 86_400_000);
    expect(s.trades).toBe(3); expect(s.totalNet).toBe(4); expect(s.tradesPerDay).toBe(0.75);
    const daily = [2, 2, 0, 0], m = 1, sd = Math.sqrt(daily.reduce((a, x) => a + (x - m) ** 2, 0) / 3);
    expect(s.dailySharpe).toBeCloseTo((m / sd) * Math.sqrt(365), 9);
    expect(s.meanGrossBps).toBeCloseTo(((4 + 3) / 3 / 1000) * 10_000, 9); expect(s.meanCostBps).toBeCloseTo((1 / 1000) * 10_000, 9);
    expect(s.meanMarkoutBps[1]).toBe(1); expect(s.meanMarkoutBps[15]).toBeNull();
  });

  it("the grid is pre-declared and unique; folds are purged and chronological", () => {
    const g = researchGrid(); expect(g).toHaveLength(576); expect(new Set(g.map((v) => v.id)).size).toBe(576);
    const f = researchFolds(T0, T0 + 60 * 86_400_000, { selectionDays: 21, purgeDays: 1, testDays: 7 });
    expect(f.length).toBe(5);
    for (const x of f) { expect(x.testFrom - x.selTo).toBe(86_400_000); expect(x.testTo).toBeGreaterThan(x.testFrom); }
    // The longest holding period in the grid (40 × 15m + maker wait) is shorter than the purge.
    expect(Math.max(...g.map((v) => (v.maxHoldBars + MAKER_WAIT_BARS) * v.tfMin * M))).toBeLessThan(86_400_000);
  });

  it("selects on the selection window only; NO TRADE when nothing is positive; refuses a too-short purge", () => {
    const fold = { selFrom: 0, selTo: 100, testFrom: 110, testTo: 200 };
    const tr = (t: number, net: number): ResearchTrade => ({ side: "LONG", entryT: t, exitT: t + 1, entry: 1, exit: 1, reason: "time", gross: net, fees: 0, spread: 0, slippage: 0, funding: 0, net, holdBars: 1, markoutBps: { 1: null, 5: null, 15: null } });
    const good = Array.from({ length: 40 }, (_, k) => tr(k, k % 4 === 0 ? -1 : 2)).concat([tr(150, -5)]), bad = Array.from({ length: 40 }, (_, k) => tr(k, -1)).concat([tr(150, 50)]);
    const [c] = walkForwardSelect(new Map([["good", good], ["bad", bad]]), [fold], { minTrades: 30, minTStat: 2 });
    expect(c!.chosen).toBe("good"); expect(c!.test.map((t) => t.net)).toEqual([-5]); // the bad variant's +50 in test is never seen
    const [none] = walkForwardSelect(new Map([["bad", bad]]), [fold], { minTrades: 30, minTStat: 2 });
    expect(none!.chosen).toBeNull(); expect(none!.test).toEqual([]);
    expect(() => walkForwardSelect(new Map([["x", [{ ...tr(99, 1), exitT: 120 }]]]), [fold], { minTrades: 1, minTStat: 0 })).toThrow(/purge/);
  });

  it("leakage: changing candles inside the unseen test window cannot change the selection for that fold", () => {
    const cs = walk(40 * 1440 / 10, 11).map((c, k) => ({ ...c, t: T0 + k * 10 * M })); // 10-minute candles, 40 days
    const tf = 1 as const;
    const folds = researchFolds(cs[0]!.t, cs.at(-1)!.t, { selectionDays: 21, purgeDays: 1, testDays: 7 });
    const variants = researchGrid().filter((v) => v.tfMin === 1).slice(0, 48);
    const run = (candles: Candle[]) => {
      const f = featuresFor(candles, tf);
      const by = new Map(variants.map((v) => [v.id, researchSimulate(candles, variantSignals(candles, f, v, COSTS), v, COSTS, { baseMs: 10 * M, notional: 1000, funding: [] }).trades]));
      return walkForwardSelect(by, folds, { minTrades: 1, minTStat: -99 });
    };
    const base = run(cs);
    const shocked = cs.map((c) => (c.t >= folds[0]!.testFrom ? { ...c, o: c.o * 1.2, h: c.h * 1.25, l: c.l * 1.15, c: c.c * 1.2, v: c.v * 3 } : c));
    const after = run(shocked);
    expect(after[0]!.chosen).toBe(base[0]!.chosen);
    expect(after[0]!.selection).toEqual(base[0]!.selection);
  });
});

describe("Gradient-boosted trees (pure TypeScript)", () => {
  const data = (n: number, seed: number) => { let s = seed; const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; const X: number[][] = [], y: number[] = []; for (let i = 0; i < n; i++) { const a = r(), b = r(), c = r(); X.push([a, b, c]); y.push(a * b > 0 ? (r() < 0.4 ? 1 : 0) : (r() < -0.4 ? 1 : 0)); } return { X, y }; };
  it("captures an interaction the logistic baseline cannot, deterministically", () => {
    const tr = data(3000, 1), va = data(1000, 2), te = data(1000, 3), names = ["a", "b", "c"];
    const g1 = calibrateGbdt(trainGbdt(tr.X, tr.y, names, { trees: 60, depth: 2, minLeaf: 30 }), va.X, va.y);
    const g2 = calibrateGbdt(trainGbdt(tr.X, tr.y, names, { trees: 60, depth: 2, minLeaf: 30 }), va.X, va.y);
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    const lr = trainLogistic(tr.X, tr.y, names);
    const aucG = classificationMetrics(te.X.map((x) => gbdtProba(g1, x)), te.y).auc!, aucL = classificationMetrics(te.X.map((x) => predictProba(lr, x)), te.y).auc!;
    expect(aucG).toBeGreaterThan(0.75); expect(aucL).toBeLessThan(0.6);
    expect(Number.isFinite(gbdtProba(g1, [99, -99, 0]))).toBe(true);
    expect(() => trainGbdt([[NaN, 0, 0], ...tr.X.slice(0, 60)], [0, ...tr.y.slice(0, 60)], names)).toThrow();
  });
  it("runs inside the same purged walk-forward as the logistic baseline", () => {
    const cs = walk(3200, 5);
    const o = { trainBars: 1200, validationBars: 400, testBars: 400, thresholds: [0.5, 0.55, 0.6], minValidationTrades: 5 };
    const sim = { baseMs: M, costs: { feePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null }, notional: 1000, funding: [] };
    const lg = walkForwardModel(cs, DEFAULT_INTRADAY, sim, o), gb = walkForwardModel(cs, DEFAULT_INTRADAY, sim, { ...o, model: "gbdt", gbdt: { trees: 30, minLeaf: 30 } });
    expect(gb.folds.map((f) => f.testRange)).toEqual(lg.folds.map((f) => f.testRange));
    expect(gb.models[0]?.long.version).toBe("gbdt-hist-v1");
  });
});
