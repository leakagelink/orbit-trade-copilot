// Engine B 1–5 minute scalping: point-in-time features, LONG/SHORT/NO_TRADE signals, both-direction simulator with
// costs and funding, and the walk-forward logistic model. Unit tests use constructed candles; they are not evidence.
import { describe, expect, it } from "vitest";
import { aggregateCandles, DEFAULT_INTRADAY, intradayConfigSchema, intradayFeatures, intradaySignal, scalpSimulate, sessionVwap, type IntradaySignal } from "@/lib/scalp-intraday";
import { calibratePlatt, classificationMetrics, predictProba, trainLogistic } from "@/lib/ml-logistic";
import { modelRows, tripleBarrierLabel, walkForwardModel, MODEL_FEATURES } from "@/lib/scalp-model";
import type { Candle } from "@/lib/indicators";

const M = 60_000, T0 = Date.UTC(2026, 0, 5);
const COSTS = { feePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null };
/** Deterministic pseudo-random walk (LCG) — reproducible test candles. */
function walk(n: number, seed = 7, drift = 0): Candle[] {
  let x = seed, p = 100; const out: Candle[] = [];
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) { const o = p; p = Math.max(1, p * (1 + drift + (rnd() - 0.5) * 0.004)); const h = Math.max(o, p) * (1 + rnd() * 0.001), l = Math.min(o, p) * (1 - rnd() * 0.001); out.push({ t: T0 + i * M, o, h, l, c: p, v: 10 + rnd() * 20 }); }
  return out;
}

describe("intraday features are point-in-time", () => {
  const cs = walk(400);
  it("features at candle i are identical whether or not later candles exist", () => {
    const full = intradayFeatures(cs, M, DEFAULT_INTRADAY);
    for (const i of [120, 250, 399]) expect(intradayFeatures(cs.slice(0, i + 1), M, DEFAULT_INTRADAY)[i]).toEqual(full[i]);
  });
  it("the higher timeframe only uses 5-minute candles that had closed", () => {
    const five = aggregateCandles(cs, M, 5);
    expect(five.every((c) => c.t % (5 * M) === 0)).toBe(true);
    expect(aggregateCandles(cs.slice(0, 7), M, 5)).toHaveLength(1); // 00:05–00:06 incomplete group is dropped
  });
  it("session VWAP resets at 00:00 UTC", () => {
    const day = [{ t: Date.UTC(2026, 0, 5, 23, 59), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: Date.UTC(2026, 0, 6, 0, 0), o: 5, h: 5, l: 5, c: 5, v: 1 }];
    expect(sessionVwap(day)).toEqual([1, 5]);
  });
  it("config validation rejects fast periods that are not shorter", () => {
    expect(intradayConfigSchema.safeParse({ ...DEFAULT_INTRADAY, emaFast: 30 }).success).toBe(false);
  });
});

describe("signals", () => {
  it("returns NO_TRADE with a reason while warming up and in a dead market", () => {
    const cs = walk(400), f = intradayFeatures(cs, M, DEFAULT_INTRADAY);
    expect(intradaySignal(cs, 10, f, DEFAULT_INTRADAY).action).toBe("NO_TRADE");
    const flat = cs.map((c) => ({ ...c, o: 100, h: 100.001, l: 99.999, c: 100 }));
    const s = intradaySignal(flat, 300, intradayFeatures(flat, M, DEFAULT_INTRADAY), DEFAULT_INTRADAY);
    expect(s.action).toBe("NO_TRADE"); expect(s.reasons[0]).toMatch(/Volatility too low/);
  });
  it("LONG/SHORT carry a stop on the losing side and a target on the winning side; trend direction dominates", () => {
    for (const [drift, more] of [[0.0004, "LONG"], [-0.0004, "SHORT"]] as const) {
      const cs = walk(2000, 5, drift), f = intradayFeatures(cs, M, DEFAULT_INTRADAY);
      const sigs = cs.map((_, i) => intradaySignal(cs, i, f, DEFAULT_INTRADAY));
      const L = sigs.filter((x) => x.action === "LONG"), S = sigs.filter((x) => x.action === "SHORT");
      for (const x of L) { expect(x.stop!).toBeLessThan(x.features.close); expect(x.target!).toBeGreaterThan(x.features.close); }
      for (const x of S) { expect(x.stop!).toBeGreaterThan(x.features.close); expect(x.target!).toBeLessThan(x.features.close); }
      const [hi, lo] = more === "LONG" ? [L.length, S.length] : [S.length, L.length];
      expect(hi).toBeGreaterThan(0); expect(hi).toBeGreaterThan(lo);
    }
  });
});

describe("both-direction simulator", () => {
  const base = (k: number, o: number, h: number, l: number, c: number): Candle => ({ t: T0 + k * M, o, h, l, c, v: 100 });
  const sig = (action: "LONG" | "SHORT", stop: number, target: number): IntradaySignal => ({ t: T0, action, setup: "breakout", reasons: [], stop, target, features: null as never });
  const opts = { baseMs: M, costs: COSTS, notional: 1000, funding: [] };
  it("fills at the next open with spread, slippage and fees; stop wins when both are touched", () => {
    const cs = [base(0, 100, 100, 100, 100), base(1, 100, 100, 100, 100), base(2, 100, 103, 98, 100)];
    const r = scalpSimulate(cs, DEFAULT_INTRADAY, opts, [sig("LONG", 99, 102), null, null]);
    const t = r.trades[0]!;
    expect(t.entry).toBeCloseTo(100 * (1 + 0.00005 + 0.0001), 9);
    expect(t.reason).toBe("stop");
    expect(t.net).toBeCloseTo(t.pnl - t.fees, 9);
    expect(t.net).toBeLessThan(-10); // ~ -1% of 1000 plus costs
  });
  it("a short profits when price falls and receives positive funding", () => {
    const fund = [{ t: T0 + 1.5 * M, rate: 0.0001 }];
    const cs = [base(0, 100, 100, 100, 100), base(1, 100, 100, 100, 100), base(2, 100, 100, 100, 100), base(3, 99, 99, 97, 97)];
    const r = scalpSimulate(cs, DEFAULT_INTRADAY, { ...opts, funding: fund }, [sig("SHORT", 102, 98), null, null, null]);
    const t = r.trades[0]!;
    expect(t.side).toBe("SHORT"); expect(t.reason).toBe("target"); expect(t.pnl).toBeGreaterThan(0);
    expect(t.funding).toBeGreaterThan(0); // positive rate: shorts receive
  });
});

describe("model research", () => {
  it("logistic regression learns a separable rule, is deterministic and calibrates on held-out rows", () => {
    const X = Array.from({ length: 400 }, (_, i) => [Math.sin(i * 1.7), Math.cos(i * 0.9)]);
    const y = X.map((x) => (x[0]! + 0.3 * x[1]! > 0 ? 1 : 0));
    const m = trainLogistic(X.slice(0, 300), y.slice(0, 300), ["a", "b"]);
    expect(trainLogistic(X.slice(0, 300), y.slice(0, 300), ["a", "b"])).toEqual(m);
    const c = calibratePlatt(m, X.slice(300), y.slice(300));
    const met = classificationMetrics(X.slice(300).map((x) => predictProba(c, x)), y.slice(300));
    expect(met.auc!).toBeGreaterThan(0.95); expect(met.brier).toBeLessThan(met.brierBaseline);
  });
  it("triple-barrier labels need the full horizon (null near the end) and use only later candles", () => {
    const cs = walk(200);
    expect(tripleBarrierLabel(cs, 199, "LONG", 0.2, DEFAULT_INTRADAY, COSTS)).toBeNull();
    const a = tripleBarrierLabel(cs, 100, "LONG", 0.2, DEFAULT_INTRADAY, COSTS);
    expect(tripleBarrierLabel(cs.slice(0, 100 + DEFAULT_INTRADAY.maxHoldBars + 2), 100, "LONG", 0.2, DEFAULT_INTRADAY, COSTS)).toBe(a);
  });
  it("feature rows are versioned and point-in-time", () => {
    const cs = walk(300), rows = modelRows(cs, M, DEFAULT_INTRADAY);
    expect(rows[250]!.length).toBe(MODEL_FEATURES.length);
    expect(modelRows(cs.slice(0, 251), M, DEFAULT_INTRADAY)[250]).toEqual(rows[250]);
  });
  it("walk-forward signals appear only inside test windows, and training rows stop before validation", () => {
    const cs = walk(3000, 11);
    const r = walkForwardModel(cs, DEFAULT_INTRADAY, { baseMs: M, costs: COSTS, notional: 1000, funding: [] }, { trainBars: 1200, validationBars: 400, testBars: 400, thresholds: [0.5, 0.55, 0.6], minValidationTrades: 5 });
    expect(r.folds.length).toBeGreaterThan(0);
    const firstTest = r.folds[0]!.testRange[0];
    r.signals.forEach((s, i) => { if (s) expect(cs[i]!.t).toBeGreaterThanOrEqual(firstTest); });
    for (const f of r.folds) { expect(f.trainRange[1]).toBeLessThan(f.validationRange[0]); expect(f.validationRange[1]).toBeLessThan(f.testRange[0]); }
  });
});
