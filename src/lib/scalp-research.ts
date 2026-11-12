// Engine B strategy research (Phase 4A). Pure and deterministic. Explains WHY the 1–5 minute rules lose after costs and
// searches a pre-declared grid of lower-frequency / cost-aware variants with chronological, purged walk-forward
// selection: a variant is chosen on a selection window ONLY, then scored on the following unseen test window. A
// strategy stays NO TRADE unless its pooled out-of-sample net expectancy is positive. Nothing here sizes, levers,
// authorizes or places a trade; results are historical simulations with stated cost assumptions.
import type { Candle } from "./indicators";
import { fillAt, fundingCashFlow, type CostModel, type FundingRate } from "./backtest-costs";
import { aggregateCandles, DEFAULT_INTRADAY, intradayFeatures, intradaySignal, type IntradayConfig, type IntradayFeatures, type IntradaySignal } from "./scalp-intraday";

export const SCALP_RESEARCH_VERSION = "scalp-research-v1" as const;
export type ExecMode = "taker" | "maker";
export interface ExecCosts { takerFeePct: number; makerFeePct: number; spreadPct: number; slippagePct: number }
export interface Variant {
  id: string; tfMin: 1 | 5 | 15; setups: IntradayConfig["setups"]; atrStopMult: number; rewardRisk: number; maxHoldBars: number;
  mode: ExecMode; minEdgeCostMultiple: number; cooldownBars: number; minRelVolume: number;
}
export interface ResearchTrade { side: "LONG" | "SHORT"; entryT: number; exitT: number; entry: number; exit: number; reason: "stop" | "target" | "time" | "end"; gross: number; fees: number; spread: number; slippage: number; funding: number; net: number; holdBars: number; markoutBps: Record<number, number | null> }
export interface SimOut { trades: ResearchTrade[]; signals: number; makerMissed: number; makerFilled: number }

export const MAKER_WAIT_BARS = 3;
export const MARKOUT_BARS = [1, 5, 15] as const;
/** Round-trip cost in % of notional the edge filter compares against: taker both sides, or maker entry + taker stop. */
export function roundTripCostPct(mode: ExecMode, c: ExecCosts) {
  return mode === "taker" ? 2 * c.takerFeePct + c.spreadPct + 2 * c.slippagePct : c.makerFeePct + c.takerFeePct + c.spreadPct / 2 + c.slippagePct;
}
export const htfFor = (tfMin: number) => (tfMin === 1 ? 5 : tfMin === 5 ? 3 : 4);
export function variantConfig(v: Variant): IntradayConfig {
  return { ...DEFAULT_INTRADAY, setups: v.setups, atrStopMult: v.atrStopMult, rewardRisk: v.rewardRisk, maxHoldBars: v.maxHoldBars, minRelVolume: v.minRelVolume, htfMultiple: htfFor(v.tfMin) };
}

/** Signals for a variant from shared features; the cost-edge filter turns low-expected-move signals into NO_TRADE. */
export function variantSignals(cs: Candle[], f: IntradayFeatures[], v: Variant, costs: ExecCosts): (IntradaySignal | null)[] {
  const cfg = variantConfig(v), rt = roundTripCostPct(v.mode, costs);
  return cs.map((_, i) => {
    if (i < 1) return null;
    const s = intradaySignal(cs, i, f, cfg);
    if (s.action === "NO_TRADE") return null;
    const targetPct = f[i]!.atrPct! * v.atrStopMult * v.rewardRisk;
    if (v.minEdgeCostMultiple > 0 && targetPct < v.minEdgeCostMultiple * rt) return null;
    return s;
  });
}

/**
 * Candle simulator for research: one position at a time, cooldown after each exit.
 *  taker: market entry at the next open (taker fee + half spread + slippage); target = TAKE_PROFIT_MARKET (taker).
 *  maker: post-only limit at the signal close for MAKER_WAIT_BARS candles; it fills only when price trades THROUGH the
 *         limit (touch is not enough), at the limit, maker fee, no spread/slippage — and if that same candle also
 *         reaches the stop, the stop is assumed hit (adverse selection). Target = resting maker limit, trade-through
 *         only. Stops are always stop-market (taker). Unfilled orders are counted as missed.
 * Stop before target inside a candle; gaps fill at the open. Funding at each funding time while open.
 */
export function researchSimulate(cs: Candle[], signals: (IntradaySignal | null)[], v: Variant, costs: ExecCosts, o: { baseMs: number; notional: number; funding: FundingRate[] }): SimOut {
  const taker: CostModel = { feePct: costs.takerFeePct, spreadPct: costs.spreadPct, slippagePct: costs.slippagePct, maxParticipationPct: null };
  const maker: CostModel = { feePct: costs.makerFeePct, spreadPct: 0, slippagePct: 0, maxParticipationPct: null };
  const fund = [...o.funding].sort((a, b) => a.t - b.t);
  const trades: ResearchTrade[] = [];
  let nSignals = 0, missed = 0, filled = 0, cooldownUntil = -1, fi = 0;
  type Pos = { side: "LONG" | "SHORT"; i0: number; qty: number; entry: number; entryT: number; fee: number; spread: number; slip: number; stop: number; target: number; bars: number; funding: number };
  let pos = null as Pos | null;
  let order = null as { side: "LONG" | "SHORT"; limit: number; sd: number; td: number; until: number } | null;
  const markouts = (p: Pos) => Object.fromEntries(MARKOUT_BARS.map((k) => { const c = cs[p.i0 + k]; return [k, c ? ((p.side === "LONG" ? c.c - p.entry : p.entry - c.c) / p.entry) * 10_000 : null]; })) as Record<number, number | null>;
  const close = (i: number, ref: number, t: number, reason: ResearchTrade["reason"], asMaker: boolean) => {
    const p = pos!; const x = fillAt(p.side === "LONG" ? "sell" : "buy", ref, p.qty, asMaker ? maker : taker);
    const gross = (p.side === "LONG" ? x.price - p.entry : p.entry - x.price) * p.qty, fees = p.fee + x.fee;
    trades.push({ side: p.side, entryT: p.entryT, exitT: t, entry: p.entry, exit: x.price, reason, gross, fees, spread: p.spread + x.spreadCost, slippage: p.slip + x.slippageCost, funding: p.funding, net: gross - fees + p.funding, holdBars: p.bars, markoutBps: markouts(p) });
    pos = null; cooldownUntil = i + v.cooldownBars;
  };
  const open = (i: number, side: "LONG" | "SHORT", price: number, asMaker: boolean, sd: number, td: number) => {
    const qty = o.notional / price, x = fillAt(side === "LONG" ? "buy" : "sell", price, qty, asMaker ? maker : taker);
    const L = side === "LONG";
    pos = { side, i0: i, qty, entry: x.price, entryT: cs[i]!.t, fee: x.fee, spread: x.spreadCost, slip: x.slippageCost, stop: L ? x.price - sd : x.price + sd, target: L ? x.price + td : x.price - td, bars: 0, funding: 0 };
  };
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    while (fi < fund.length && fund[fi]!.t < c.t) fi++;
    if (pos) {
      for (let k = fi; k < fund.length && fund[k]!.t < c.t + o.baseMs; k++) { if (fund[k]!.t > pos.entryT) pos.funding += fundingCashFlow(pos.side === "LONG" ? 1 : -1, pos.qty, c.o, fund[k]!.rate); }
      pos.bars++;
      const L = pos.side === "LONG", mk = v.mode === "maker";
      if (L ? c.o <= pos.stop : c.o >= pos.stop) close(i, c.o, c.t, "stop", false);
      else if (L ? c.o > pos.target : c.o < pos.target) close(i, mk ? pos.target : c.o, c.t, "target", mk);
      else if (L ? c.l <= pos.stop : c.h >= pos.stop) close(i, pos.stop, c.t, "stop", false);
      else if (mk ? (L ? c.h > pos.target : c.l < pos.target) : (L ? c.h >= pos.target : c.l <= pos.target)) close(i, pos.target, c.t, "target", mk);
      else if (pos.bars >= v.maxHoldBars) close(i, c.c, c.t + o.baseMs, "time", false);
    }
    // Resting maker entry from an earlier signal.
    if (!pos && order) {
      const L = order.side === "LONG";
      if (L ? c.l < order.limit : c.h > order.limit) {
        filled++; open(i, order.side, order.limit, true, order.sd, order.td); order = null;
        const p = pos as Pos | null;
        if (p && (L ? c.l <= p.stop : c.h >= p.stop)) close(i, p.stop, c.t, "stop", false); // filled on the way to the stop
      } else if (i >= order.until) { missed++; order = null; }
    }
    const sig = signals[i - 1];
    if (!pos && !order && sig && i - 1 > cooldownUntil && sig.stop !== null && sig.target !== null) {
      nSignals++;
      const ref = cs[i - 1]!.c, sd = Math.abs(ref - sig.stop), td = Math.abs(sig.target - ref), side = sig.action as "LONG" | "SHORT";
      if (v.mode === "taker") open(i, side, c.o, false, sd, td);
      else {
        order = { side, limit: ref, sd, td, until: i + MAKER_WAIT_BARS - 1 };
        const L = side === "LONG";
        if (L ? c.l < ref : c.h > ref) { filled++; open(i, side, ref, true, sd, td); order = null; const p = pos as Pos | null; if (p && (L ? c.l <= p.stop : c.h >= p.stop)) close(i, p.stop, c.t, "stop", false); }
      }
    }
  }
  if (pos) { const last = cs.at(-1)!; close(cs.length - 1, last.c, last.t + o.baseMs, "end", false); }
  return { trades, signals: nSignals, makerMissed: missed, makerFilled: filled };
}

export interface TradeStats { trades: number; totalNet: number; meanNet: number; sdNet: number | null; tStat: number | null; winRatePct: number | null; profitFactor: number | null; grossTotal: number; feesTotal: number; spreadTotal: number; slippageTotal: number; fundingTotal: number; maxDrawdown: number; meanGrossBps: number | null; meanCostBps: number | null; tradesPerDay: number | null; dailySharpe: number | null; meanMarkoutBps: Record<number, number | null> }
/** Per-trade statistics. Sharpe is computed from DAILY net P&L (zero-trade days included), not per trade or per bar. */
export function tradeStats(trades: ResearchTrade[], notional: number, from: number, to: number): TradeStats {
  const n = trades.length, nets = trades.map((t) => t.net), sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const mean = n ? sum(nets) / n : 0, sd = n > 1 ? Math.sqrt(sum(nets.map((x) => (x - mean) ** 2)) / (n - 1)) : null;
  const wins = sum(nets.filter((x) => x > 0)), losses = -sum(nets.filter((x) => x < 0));
  let eq = 0, peak = 0, dd = 0; for (const x of nets) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const days = Math.max(1, Math.round((to - from) / 86_400_000)), daily = new Array(days).fill(0);
  for (const t of trades) { const d = Math.floor((t.exitT - from) / 86_400_000); if (d >= 0 && d < days) daily[d] += t.net; }
  const dm = sum(daily) / days, dsd = Math.sqrt(sum(daily.map((x) => (x - dm) ** 2)) / Math.max(1, days - 1));
  const mk = Object.fromEntries(MARKOUT_BARS.map((k) => { const xs = trades.map((t) => t.markoutBps[k]).filter((x): x is number => x !== null); return [k, xs.length ? sum(xs) / xs.length : null]; })) as Record<number, number | null>;
  return {
    trades: n, totalNet: sum(nets), meanNet: mean, sdNet: sd, tStat: sd && sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
    winRatePct: n ? (nets.filter((x) => x > 0).length / n) * 100 : null, profitFactor: losses > 0 ? wins / losses : null,
    grossTotal: sum(trades.map((t) => t.gross + t.spread + t.slippage)), feesTotal: sum(trades.map((t) => t.fees)), spreadTotal: sum(trades.map((t) => t.spread)), slippageTotal: sum(trades.map((t) => t.slippage)), fundingTotal: sum(trades.map((t) => t.funding)),
    maxDrawdown: dd,
    meanGrossBps: n ? (sum(trades.map((t) => t.gross + t.spread + t.slippage)) / n / notional) * 10_000 : null,
    meanCostBps: n ? (sum(trades.map((t) => t.fees + t.spread + t.slippage)) / n / notional) * 10_000 : null,
    tradesPerDay: n / days, dailySharpe: dsd > 0 ? (dm / dsd) * Math.sqrt(365) : null, meanMarkoutBps: mk,
  };
}

/** The pre-declared research grid (declared before looking at any test window). */
export function researchGrid(): Variant[] {
  const out: Variant[] = [];
  for (const tfMin of [1, 5, 15] as const) for (const setups of [["breakout"], ["pullback"], ["breakout", "pullback"]] as IntradayConfig["setups"][])
    for (const atrStopMult of [1, 2]) for (const rewardRisk of [1, 2]) for (const maxHoldBars of [10, 40]) for (const mode of ["taker", "maker"] as const)
      for (const minEdgeCostMultiple of [0, 3]) for (const cooldownBars of [0, 10])
        out.push({ id: `${tfMin}m|${setups.join("+")}|sl${atrStopMult}|rr${rewardRisk}|h${maxHoldBars}|${mode}|edge${minEdgeCostMultiple}|cd${cooldownBars}`, tfMin, setups, atrStopMult, rewardRisk, maxHoldBars, mode, minEdgeCostMultiple, cooldownBars, minRelVolume: DEFAULT_INTRADAY.minRelVolume });
  return out;
}

export interface Fold { selFrom: number; selTo: number; testFrom: number; testTo: number }
/** Rolling folds: selection window, purge gap (≥ the longest holding period), then the unseen test window. */
export function researchFolds(start: number, end: number, o: { selectionDays: number; purgeDays: number; testDays: number }): Fold[] {
  const D = 86_400_000, out: Fold[] = [];
  for (let s = start; s + (o.selectionDays + o.purgeDays + o.testDays) * D <= end; s += o.testDays * D)
    out.push({ selFrom: s, selTo: s + o.selectionDays * D, testFrom: s + (o.selectionDays + o.purgeDays) * D, testTo: s + (o.selectionDays + o.purgeDays + o.testDays) * D });
  return out;
}
export interface SelectionRule { minTrades: number; minTStat: number }
export interface FoldChoice { fold: Fold; chosen: string | null; selection: { trades: number; meanNet: number; tStat: number | null } | null; candidates: number; test: ResearchTrade[] }

/**
 * Walk-forward selection over precomputed per-variant trade lists. Trades are assigned to a window by ENTRY time; the
 * purge gap must exceed the longest holding period so no selection trade's exit reaches the test window. The best
 * variant by selection-window mean net (with ≥ minTrades, mean > 0 and t ≥ minTStat) is applied to the test window;
 * none qualifies → NO TRADE for that fold.
 */
export function walkForwardSelect(byVariant: Map<string, ResearchTrade[]>, folds: Fold[], rule: SelectionRule): FoldChoice[] {
  return folds.map((fold) => {
    let best: { id: string; mean: number; n: number; t: number | null } | null = null; let candidates = 0;
    for (const [id, trades] of byVariant) {
      const sel = trades.filter((t) => t.entryT >= fold.selFrom && t.entryT < fold.selTo);
      if (sel.some((t) => t.exitT >= fold.testFrom)) throw new Error(`purge too short: ${id} selection trade exits inside the test window`);
      const n = sel.length; if (n < rule.minTrades) continue;
      const mean = sel.reduce((a, t) => a + t.net, 0) / n;
      const sd = Math.sqrt(sel.reduce((a, t) => a + (t.net - mean) ** 2, 0) / Math.max(1, n - 1));
      const ts = sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
      if (!(mean > 0) || ts === null || ts < rule.minTStat) continue;
      candidates++;
      if (!best || mean > best.mean || (mean === best.mean && id < best.id)) best = { id, mean, n, t: ts };
    }
    const test = best ? byVariant.get(best.id)!.filter((t) => t.entryT >= fold.testFrom && t.entryT < fold.testTo) : [];
    return { fold, chosen: best?.id ?? null, selection: best ? { trades: best.n, meanNet: best.mean, tStat: best.t } : null, candidates, test };
  });
}

export function candlesFor(cs1m: Candle[], tfMin: 1 | 5 | 15) { return tfMin === 1 ? cs1m : aggregateCandles(cs1m, 60_000, tfMin); }
export function featuresFor(cs: Candle[], tfMin: 1 | 5 | 15) { return intradayFeatures(cs, tfMin * 60_000, { ...DEFAULT_INTRADAY, htfMultiple: htfFor(tfMin) }); }
