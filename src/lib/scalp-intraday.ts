// Engine B, strategy "intraday" — 1–5 minute USD-M Futures scalping (pure, deterministic, no LLM, no I/O).
// Signals are computed at a candle's CLOSE from candles closed by then; higher-timeframe confirmation uses only higher-
// timeframe candles that had fully closed by that moment. Output is a PROPOSAL only (LONG / SHORT / NO_TRADE with
// reference stop/target): it carries no quantity, leverage or authorization — sizing and authorization belong to the
// Central Risk Engine. Evaluation uses scalpSimulate (next-candle-open fills, both directions, costs and funding).
import { z } from "zod";
import { ema, rsi, sma, type Candle, type Series } from "./indicators";
import { fillAt, fundingCashFlow, type CostModel, type FundingRate } from "./backtest-costs";
import type { MetricTrade } from "./backtest-metrics";

export const INTRADAY_STRATEGY_ID = "futures-scalp-intraday" as const;
export const INTRADAY_FEATURE_VERSION = "intraday-features-v1" as const;

export const intradayConfigSchema = z.object({
  emaFast: z.number().int().min(2).max(100), emaSlow: z.number().int().min(3).max(300),
  rsiPeriod: z.number().int().min(2).max(50), atrPeriod: z.number().int().min(2).max(100),
  bbPeriod: z.number().int().min(5).max(100), bbStd: z.number().gt(0).max(4),
  macdFast: z.number().int().min(2).max(50), macdSlow: z.number().int().min(3).max(100), macdSignal: z.number().int().min(2).max(50),
  relVolPeriod: z.number().int().min(5).max(200), minRelVolume: z.number().min(0).max(20),
  breakoutLookback: z.number().int().min(3).max(200),
  rsiLongMax: z.number().min(50).max(95), rsiShortMin: z.number().min(5).max(50),
  htfMultiple: z.number().int().min(2).max(60), // e.g. 5 → 1m candles confirmed by 5m candles
  minAtrPct: z.number().min(0).max(5), maxAtrPct: z.number().gt(0).max(20),
  atrStopMult: z.number().gt(0).max(10), rewardRisk: z.number().gt(0).max(10), maxHoldBars: z.number().int().min(1).max(500),
  setups: z.array(z.enum(["breakout", "pullback"])).min(1),
}).strict().refine((c) => c.emaFast < c.emaSlow && c.macdFast < c.macdSlow, "fast periods must be shorter than slow periods");
export type IntradayConfig = z.infer<typeof intradayConfigSchema>;

export const DEFAULT_INTRADAY: IntradayConfig = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, bbPeriod: 20, bbStd: 2, macdFast: 12, macdSlow: 26, macdSignal: 9,
  relVolPeriod: 20, minRelVolume: 1.5, breakoutLookback: 20, rsiLongMax: 70, rsiShortMin: 30, htfMultiple: 5,
  minAtrPct: 0.03, maxAtrPct: 1.5, atrStopMult: 1.5, rewardRisk: 1.5, maxHoldBars: 30, setups: ["breakout", "pullback"],
};

export type ScalpAction = "LONG" | "SHORT" | "NO_TRADE";
export interface IntradayFeatures {
  close: number; emaFast: number | null; emaSlow: number | null; vwap: number | null; rsi: number | null; macdHist: number | null;
  atr: number | null; atrPct: number | null; bbWidthPct: number | null; relVolume: number | null;
  breakoutHigh: number | null; breakoutLow: number | null; htfTrend: "up" | "down" | "flat" | null;
}
export interface IntradaySignal { t: number; action: ScalpAction; setup: "breakout" | "pullback" | null; reasons: string[]; stop: number | null; target: number | null; features: IntradayFeatures }

/** Wilder ATR (same definition as indicators.ts). */
export function atrSeries(cs: Candle[], p: number): Series {
  const out: Series = new Array(cs.length).fill(null);
  if (cs.length < p) return out;
  const tr = cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1]!.c), Math.abs(c.l - cs[i - 1]!.c))));
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p; out[p - 1] = a;
  for (let i = p; i < cs.length; i++) { a = (a * (p - 1) + tr[i]!) / p; out[i] = a; }
  return out;
}
/** Session VWAP from typical price, resetting at 00:00 UTC. */
export function sessionVwap(cs: Candle[]): Series {
  let day = -1, pv = 0, vol = 0;
  return cs.map((c) => {
    const d = Math.floor(c.t / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += ((c.h + c.l + c.c) / 3) * c.v; vol += c.v;
    return vol > 0 ? pv / vol : null;
  });
}
/** Bollinger band width as % of the middle band. */
export function bbWidthPct(closes: number[], per: number, k: number): Series {
  const mid = sma(closes, per);
  return closes.map((_, i) => {
    const m = mid[i]; if (m == null || m === 0) return null;
    const w = closes.slice(i - per + 1, i + 1); const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / per);
    return ((2 * k * sd) / m) * 100;
  });
}
/** Groups base candles into higher-timeframe candles aligned to UTC multiples; only complete groups are emitted. */
export function aggregateCandles(cs: Candle[], baseMs: number, multiple: number): Candle[] {
  const span = baseMs * multiple, out: Candle[] = [];
  let cur: Candle | null = null, n = 0;
  for (const c of cs) {
    const start = Math.floor(c.t / span) * span;
    if (!cur || cur.t !== start) { if (cur && n === multiple) out.push(cur); cur = { t: start, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; n = 1; continue; }
    cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; n++;
  }
  if (cur && n === multiple) out.push(cur);
  return out;
}

/** Feature table for every candle (index i uses only candles 0..i). */
export function intradayFeatures(cs: Candle[], baseMs: number, cfg: IntradayConfig): IntradayFeatures[] {
  const closes = cs.map((c) => c.c);
  const ef = ema(closes, cfg.emaFast), es = ema(closes, cfg.emaSlow), r = rsi(closes, cfg.rsiPeriod), a = atrSeries(cs, cfg.atrPeriod);
  const mf = ema(closes, cfg.macdFast), ms = ema(closes, cfg.macdSlow);
  const line = closes.map((_, i) => (mf[i] != null && ms[i] != null ? mf[i]! - ms[i]! : null));
  const sig = ema(line, cfg.macdSignal);
  const vw = sessionVwap(cs), bw = bbWidthPct(closes, cfg.bbPeriod, cfg.bbStd), vavg = sma(cs.map((c) => c.v), cfg.relVolPeriod);
  // Higher timeframe: a 5m candle covering [T, T+5m) is usable from the close of the base candle ending at T+5m.
  const htf = aggregateCandles(cs, baseMs, cfg.htfMultiple), span = baseMs * cfg.htfMultiple;
  const hc = htf.map((c) => c.c), hf = ema(hc, cfg.emaFast), hs = ema(hc, cfg.emaSlow);
  let h = -1;
  return cs.map((c, i) => {
    const decidedAt = c.t + baseMs;
    while (h + 1 < htf.length && htf[h + 1]!.t + span <= decidedAt) h++;
    const trend = h >= 0 && hf[h] != null && hs[h] != null ? (hf[h]! > hs[h]! ? "up" : hf[h]! < hs[h]! ? "down" : "flat") : null;
    const prev = i >= cfg.breakoutLookback ? cs.slice(i - cfg.breakoutLookback, i) : null;
    const prevVol = i >= 1 ? vavg[i - 1] : null;
    return {
      close: c.c, emaFast: ef[i] ?? null, emaSlow: es[i] ?? null, vwap: vw[i] ?? null, rsi: r[i] ?? null,
      macdHist: line[i] != null && sig[i] != null ? line[i]! - sig[i]! : null, atr: a[i] ?? null, atrPct: a[i] != null ? (a[i]! / c.c) * 100 : null,
      bbWidthPct: bw[i] ?? null, relVolume: prevVol != null && prevVol! > 0 ? c.v / prevVol! : null,
      breakoutHigh: prev ? Math.max(...prev.map((x) => x.h)) : null, breakoutLow: prev ? Math.min(...prev.map((x) => x.l)) : null, htfTrend: trend,
    };
  });
}

/** LONG / SHORT / NO_TRADE at the close of candle i. Missing or conflicting evidence is NO_TRADE, with reasons. */
export function intradaySignal(cs: Candle[], i: number, f: IntradayFeatures[], cfg: IntradayConfig): IntradaySignal {
  const x = f[i]!, c = cs[i]!, p = cs[i - 1], fp = f[i - 1];
  const out = (action: ScalpAction, reasons: string[], setup: IntradaySignal["setup"] = null, stop: number | null = null, target: number | null = null): IntradaySignal => ({ t: c.t, action, setup, reasons, stop, target, features: x });
  const need = [x.emaFast, x.emaSlow, x.vwap, x.rsi, x.macdHist, x.atr, x.atrPct, x.bbWidthPct, x.relVolume, x.breakoutHigh, x.breakoutLow];
  if (need.some((v) => v == null) || !p || !fp || fp.emaFast == null || x.htfTrend == null) return out("NO_TRADE", ["Insufficient history for every indicator and the higher-timeframe trend"]);
  if (x.atrPct! < cfg.minAtrPct) return out("NO_TRADE", [`Volatility too low (ATR ${x.atrPct!.toFixed(3)}% < ${cfg.minAtrPct}%): costs would dominate`]);
  if (x.atrPct! > cfg.maxAtrPct) return out("NO_TRADE", [`Volatility burst (ATR ${x.atrPct!.toFixed(3)}% > ${cfg.maxAtrPct}%)`]);
  const up = x.emaFast! > x.emaSlow! && c.c > x.vwap! && x.htfTrend === "up";
  const down = x.emaFast! < x.emaSlow! && c.c < x.vwap! && x.htfTrend === "down";
  const cands: { action: "LONG" | "SHORT"; setup: "breakout" | "pullback"; why: string }[] = [];
  if (cfg.setups.includes("breakout") && x.relVolume! >= cfg.minRelVolume) {
    if (up && c.c > x.breakoutHigh! && x.macdHist! > 0 && x.rsi! < cfg.rsiLongMax) cands.push({ action: "LONG", setup: "breakout", why: `Close above ${cfg.breakoutLookback}-candle high on ${x.relVolume!.toFixed(2)}× volume` });
    if (down && c.c < x.breakoutLow! && x.macdHist! < 0 && x.rsi! > cfg.rsiShortMin) cands.push({ action: "SHORT", setup: "breakout", why: `Close below ${cfg.breakoutLookback}-candle low on ${x.relVolume!.toFixed(2)}× volume` });
  }
  if (cfg.setups.includes("pullback")) {
    if (up && p.l <= fp.emaFast! && c.c > x.emaFast! && c.c > c.o && x.rsi! > 40 && x.rsi! < cfg.rsiLongMax) cands.push({ action: "LONG", setup: "pullback", why: "Pullback to the fast EMA in an up-trend, closed back above it" });
    if (down && p.h >= fp.emaFast! && c.c < x.emaFast! && c.c < c.o && x.rsi! < 60 && x.rsi! > cfg.rsiShortMin) cands.push({ action: "SHORT", setup: "pullback", why: "Pullback to the fast EMA in a down-trend, closed back below it" });
  }
  const dirs = new Set(cands.map((k) => k.action));
  if (dirs.size === 0) return out("NO_TRADE", [up ? "Up-trend but no breakout or pullback trigger" : down ? "Down-trend but no breakout or pullback trigger" : "No aligned trend across EMA, VWAP and higher timeframe"]);
  if (dirs.size > 1) return out("NO_TRADE", ["Conflicting LONG and SHORT triggers"]);
  const k = cands[0]!, dist = cfg.atrStopMult * x.atr!;
  const stop = k.action === "LONG" ? c.c - dist : c.c + dist;
  const target = k.action === "LONG" ? c.c + cfg.rewardRisk * dist : c.c - cfg.rewardRisk * dist;
  return out(k.action, cands.map((q) => q.why), k.setup, stop, target);
}

export interface ScalpSimOptions { baseMs: number; costs: CostModel; notional: number; funding: FundingRate[] | null; tradeFrom?: number; tradeTo?: number }
export interface ScalpTrade extends MetricTrade { side: "LONG" | "SHORT"; setup: string; entry: number; exit: number; reason: "stop" | "target" | "time" | "end" }

/**
 * Evaluation simulator: signal at candle i's close → market fill at candle i+1's open (spread + slippage + taker fee);
 * stop/target checked inside each later candle, stop first when both are touched; gaps fill at the worse open; time stop
 * after maxHoldBars at that candle's close. Fixed notional per trade, one position at a time. Funding is applied at each
 * funding timestamp while a position is open; with no funding history (null) the caller must reject the run.
 */
export function scalpSimulate(cs: Candle[], cfg: IntradayConfig, o: ScalpSimOptions, signals?: (IntradaySignal | null)[]) {
  const f = intradayFeatures(cs, o.baseMs, cfg);
  const trades: ScalpTrade[] = [];
  const funding = [...(o.funding ?? [])].sort((a, b) => a.t - b.t);
  let pos: { side: "LONG" | "SHORT"; setup: string; qty: number; entry: number; entryT: number; entryFee: number; spread: number; slip: number; stop: number; target: number; bars: number; funding: number; fi: number } | null = null;
  const from = o.tradeFrom ?? -Infinity, to = o.tradeTo ?? Infinity;
  const close = (exitRef: number, t: number, reason: ScalpTrade["reason"]) => {
    const p = pos!, side = p.side === "LONG" ? "sell" : "buy";
    const x = fillAt(side, exitRef, p.qty, o.costs);
    const dir = p.side === "LONG" ? 1 : -1;
    const pnl = dir * (x.price - p.entry) * p.qty;
    const fees = p.entryFee + x.fee;
    trades.push({ side: p.side, setup: p.setup, entry: p.entry, exit: x.price, reason, entryT: p.entryT, exitT: t, pnl, fees, spread: p.spread + x.spreadCost, slippage: p.slip + x.slippageCost, funding: p.funding, net: pnl - fees + p.funding });
    pos = null;
  };
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    if (pos) {
      // Funding events that fall inside this candle while the position is open.
      while (pos.fi < funding.length && funding[pos.fi]!.t <= c.t + o.baseMs) {
        const ev = funding[pos.fi++]!; if (ev.t > pos.entryT) pos.funding += fundingCashFlow(pos.side === "LONG" ? 1 : -1, pos.qty, c.o, ev.rate);
      }
      pos.bars++;
      const L = pos.side === "LONG";
      if (L ? c.o <= pos.stop : c.o >= pos.stop) close(c.o, c.t, "stop");
      else if (L ? c.o >= pos.target : c.o <= pos.target) close(c.o, c.t, "target");
      else if (L ? c.l <= pos.stop : c.h >= pos.stop) close(pos.stop, c.t, "stop");
      else if (L ? c.h > pos.target : c.l < pos.target) close(pos.target, c.t, "target");
      else if (pos.bars >= cfg.maxHoldBars) close(c.c, c.t + o.baseMs, "time");
    }
    // Entry from the PREVIOUS candle's closing signal, at this candle's open.
    const sig = signals ? signals[i - 1] ?? null : intradaySignal(cs, i - 1, f, cfg);
    if (!pos && sig && sig.action !== "NO_TRADE" && cs[i - 1]!.t >= from && c.t <= to && sig.stop !== null && sig.target !== null) {
      const side = sig.action === "LONG" ? "buy" : "sell";
      const qty = o.notional / c.o;
      const x = fillAt(side, c.o, qty, o.costs);
      // Stop/target keep their distance from the signal close, re-anchored to the actual fill.
      const ref = cs[i - 1]!.c, sd = Math.abs(ref - sig.stop), td = Math.abs(sig.target - ref);
      const L = sig.action === "LONG";
      let fi = 0; while (fi < funding.length && funding[fi]!.t <= c.t) fi++;
      pos = { side: sig.action, setup: sig.setup ?? "", qty, entry: x.price, entryT: c.t, entryFee: x.fee, spread: x.spreadCost, slip: x.slippageCost, stop: L ? x.price - sd : x.price + sd, target: L ? x.price + td : x.price - td, bars: 0, funding: 0, fi };
    }
  }
  if (pos) { const last = cs.at(-1)!; close(last.c, last.t + o.baseMs, "end"); }
  return { trades, features: f };
}
