// Engine B model research for the 1–5 minute scalping strategy: versioned features, leak-free triple-barrier labels and
// a walk-forward logistic model with calibration and NO TRADE thresholds. Pure. Produces signals for scalpSimulate;
// never sizes, levers or authorizes a trade.
import type { Candle } from "./indicators";
import { fillAt, type CostModel } from "./backtest-costs";
import { intradayFeatures, scalpSimulate, INTRADAY_FEATURE_VERSION, type IntradayConfig, type IntradaySignal, type ScalpSimOptions } from "./scalp-intraday";
import { calibratePlatt, classificationMetrics, predictProba, trainLogistic, type LogisticModel } from "./ml-logistic";

export const SCALP_MODEL_FEATURE_VERSION = `${INTRADAY_FEATURE_VERSION}+model-v1` as const;
export const MODEL_FEATURES = ["close_vs_ema_fast_atr", "ema_spread_atr", "close_vs_vwap_atr", "rsi_centered", "macd_hist_atr", "atr_pct", "bb_width_pct", "log_rel_volume", "htf_trend", "ret1_atr", "ret5_atr", "dist_high_atr", "dist_low_atr"];

/** One feature row per candle (null while any input is warming up). Uses candles 0..i only. */
export function modelRows(cs: Candle[], baseMs: number, cfg: IntradayConfig): (number[] | null)[] {
  const f = intradayFeatures(cs, baseMs, cfg);
  return f.map((x, i) => {
    if (i < 5 || [x.emaFast, x.emaSlow, x.vwap, x.rsi, x.macdHist, x.atr, x.atrPct, x.bbWidthPct, x.relVolume, x.breakoutHigh, x.breakoutLow].some((v) => v == null) || x.htfTrend == null || !(x.atr! > 0) || !(x.relVolume! > 0)) return null;
    const a = x.atr!, c = x.close;
    return [(c - x.emaFast!) / a, (x.emaFast! - x.emaSlow!) / a, (c - x.vwap!) / a, x.rsi! / 100 - 0.5, x.macdHist! / a, x.atrPct!, x.bbWidthPct!, Math.log(x.relVolume!),
      x.htfTrend === "up" ? 1 : x.htfTrend === "down" ? -1 : 0, (c - cs[i - 1]!.c) / a, (c - cs[i - 5]!.c) / a, (x.breakoutHigh! - c) / a, (c - x.breakoutLow!) / a];
  });
}

/**
 * Triple-barrier label for a trade decided at candle i's close: market entry at candle i+1's open (with costs), ATR
 * stop/target, time barrier maxHoldBars. 1 if the trade's net result is positive. Uses candles i+1..i+maxHoldBars+1 —
 * so rows within that horizon of a split boundary must be purged.
 */
export function tripleBarrierLabel(cs: Candle[], i: number, side: "LONG" | "SHORT", atr: number, cfg: IntradayConfig, costs: CostModel): 0 | 1 | null {
  const e = cs[i + 1]; if (!e) return null;
  const L = side === "LONG", fi = fillAt(L ? "buy" : "sell", e.o, 1, costs);
  const dist = cfg.atrStopMult * atr, stop = L ? fi.price - dist : fi.price + dist, target = L ? fi.price + cfg.rewardRisk * dist : fi.price - cfg.rewardRisk * dist;
  let exitRef: number | null = null;
  for (let k = i + 2; k <= i + 1 + cfg.maxHoldBars; k++) {
    const c = cs[k]; if (!c) return null;
    if (L ? c.o <= stop : c.o >= stop) { exitRef = c.o; break; }
    if (L ? c.o >= target : c.o <= target) { exitRef = c.o; break; }
    if (L ? c.l <= stop : c.h >= stop) { exitRef = stop; break; }
    if (L ? c.h > target : c.l < target) { exitRef = target; break; }
    if (k === i + 1 + cfg.maxHoldBars) exitRef = c.c;
  }
  if (exitRef === null) return null;
  const fo = fillAt(L ? "sell" : "buy", exitRef, 1, costs);
  const net = (L ? fo.price - fi.price : fi.price - fo.price) - fi.fee - fo.fee;
  return net > 0 ? 1 : 0;
}

export interface FoldResult { trainRange: [number, number]; validationRange: [number, number]; testRange: [number, number]; threshold: number | null; long: ReturnType<typeof classificationMetrics> | null; short: ReturnType<typeof classificationMetrics> | null; signals: number }

/**
 * Walk-forward: for each fold, train long and short models on the train window, calibrate and pick the confidence
 * threshold on the following validation window (purged), then emit signals ONLY for the next test window. A candle's
 * signal is LONG/SHORT when its calibrated probability clears the threshold and beats the other side; else NO_TRADE.
 */
export function walkForwardModel(cs: Candle[], cfg: IntradayConfig, sim: ScalpSimOptions, o: { trainBars: number; validationBars: number; testBars: number; thresholds: number[]; minValidationTrades: number }) {
  const baseMs = sim.baseMs, costs: CostModel = sim.costs;
  const rows = modelRows(cs, baseMs, cfg), atr = intradayFeatures(cs, baseMs, cfg).map((x) => x.atr);
  const purge = cfg.maxHoldBars + 2;
  const labels = (i: number, side: "LONG" | "SHORT") => (rows[i] && atr[i] ? tripleBarrierLabel(cs, i, side, atr[i]!, cfg, costs) : null);
  const signals: (IntradaySignal | null)[] = new Array(cs.length).fill(null);
  const folds: FoldResult[] = [];
  const models: { fold: number; long: LogisticModel; short: LogisticModel; threshold: number | null }[] = [];
  for (let s = 0; s + o.trainBars + purge + o.validationBars + purge + o.testBars <= cs.length; s += o.testBars) {
    const tr: [number, number] = [s, s + o.trainBars - 1 - purge]; // last `purge` rows dropped: their labels look into validation
    const va: [number, number] = [s + o.trainBars, s + o.trainBars + o.validationBars - 1 - purge];
    const te: [number, number] = [s + o.trainBars + o.validationBars, s + o.trainBars + o.validationBars + o.testBars - 1];
    const set = (r: [number, number], side: "LONG" | "SHORT") => { const X: number[][] = [], y: number[] = [], at: number[] = []; for (let i = r[0]; i <= r[1]; i++) { const l = labels(i, side); if (l !== null) { X.push(rows[i]!); y.push(l); at.push(i); } } return { X, y, at }; };
    const tl = set(tr, "LONG"), ts = set(tr, "SHORT"), vl = set(va, "LONG"), vs = set(va, "SHORT");
    if (tl.X.length < 200 || vl.X.length < 50 || new Set(tl.y).size < 2 || new Set(ts.y).size < 2) continue;
    const ml = calibratePlatt(trainLogistic(tl.X, tl.y, [...MODEL_FEATURES]), vl.X, vl.y);
    const msh = calibratePlatt(trainLogistic(ts.X, ts.y, [...MODEL_FEATURES]), vs.X, vs.y);
    const emit = (r: [number, number], t: number, into: (IntradaySignal | null)[]) => {
      let n = 0;
      for (let i = r[0]; i <= r[1]; i++) {
        const x = rows[i]; if (!x || !atr[i]) continue;
        const pl = predictProba(ml, x), ps = predictProba(msh, x);
        const side = pl >= t && pl > ps ? "LONG" : ps >= t && ps > pl ? "SHORT" : null;
        if (!side) continue;
        const c = cs[i]!, dist = cfg.atrStopMult * atr[i]!;
        into[i] = { t: c.t, action: side, setup: null, reasons: [`model p=${(side === "LONG" ? pl : ps).toFixed(3)} >= ${t}`], stop: side === "LONG" ? c.c - dist : c.c + dist, target: side === "LONG" ? c.c + cfg.rewardRisk * dist : c.c - cfg.rewardRisk * dist, features: null as never };
        n++;
      }
      return n;
    };
    // Confidence threshold chosen on the validation window only: the one with the best net expectancy after costs in
    // the simulator, among thresholds with enough trades and a positive result. None qualifies -> NO TRADE all fold.
    let threshold: number | null = null, best = 0;
    for (const t of o.thresholds) {
      const vsig: (IntradaySignal | null)[] = new Array(cs.length).fill(null);
      emit(va, t, vsig);
      const r = scalpSimulate(cs.slice(0, va[1] + 1), cfg, { ...sim, tradeFrom: cs[va[0]]!.t, tradeTo: cs[va[1]]!.t }, vsig);
      const exp = r.trades.length ? r.trades.reduce((a, x) => a + x.net, 0) / r.trades.length : 0;
      if (r.trades.length >= o.minValidationTrades && exp > best) { best = exp; threshold = t; }
    }
    const testL = set(te, "LONG"), testS = set(te, "SHORT");
    const n = threshold === null ? 0 : emit(te, threshold, signals);
    folds.push({ trainRange: [cs[tr[0]]!.t, cs[tr[1]]!.t], validationRange: [cs[va[0]]!.t, cs[va[1]]!.t], testRange: [cs[te[0]]!.t, cs[te[1]]!.t], threshold,
      long: testL.X.length ? classificationMetrics(testL.X.map((x) => predictProba(ml, x)), testL.y) : null,
      short: testS.X.length ? classificationMetrics(testS.X.map((x) => predictProba(msh, x)), testS.y) : null, signals: n });
    models.push({ fold: folds.length, long: ml, short: msh, threshold });
  }
  return { featureVersion: SCALP_MODEL_FEATURE_VERSION, folds, signals, models };
}
