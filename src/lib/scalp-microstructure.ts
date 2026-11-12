// Engine B, strategy "ultrafast" — seconds-level USD-M Futures scalping market intelligence (pure, deterministic, no
// LLM, no I/O). Feature math and a rule-based LONG / SHORT / NO_TRADE signal from top-of-book, depth and aggressive
// trade flow. It needs a CONTINUOUS live feed (persistent WebSocket), which the current hosting does not provide, so
// nothing here runs live: it is used for offline research on recorded data. Proposals carry no size or leverage.
import { z } from "zod";

export const ULTRAFAST_STRATEGY_ID = "futures-scalp-ultrafast" as const;
export const ULTRAFAST_FEATURE_VERSION = "ultrafast-features-v1" as const;

export interface BookTop { t: number; receivedAt: number; bid: number; bidQty: number; ask: number; askQty: number }
export interface DepthLevel { price: number; qty: number }
export interface Depth { t: number; bids: DepthLevel[]; asks: DepthLevel[] }
export interface Trade { t: number; price: number; qty: number; buyerAggressor: boolean }

export const spreadBps = (b: BookTop) => ((b.ask - b.bid) / ((b.ask + b.bid) / 2)) * 10_000;
export const mid = (b: BookTop) => (b.ask + b.bid) / 2;
/** Size-weighted microprice: leans toward the side with less resting quantity (where price is likely to move). */
export const microprice = (b: BookTop) => (b.bidQty + b.askQty > 0 ? (b.ask * b.bidQty + b.bid * b.askQty) / (b.bidQty + b.askQty) : mid(b));
/** Order book imbalance in [-1, 1] over the top `levels` of depth (or the top of book when depth is absent). */
export function bookImbalance(top: BookTop, depth?: Depth | null, levels = 5) {
  const bq = depth ? depth.bids.slice(0, levels).reduce((a, l) => a + l.qty, 0) : top.bidQty;
  const aq = depth ? depth.asks.slice(0, levels).reduce((a, l) => a + l.qty, 0) : top.askQty;
  return bq + aq > 0 ? (bq - aq) / (bq + aq) : 0;
}
/** Aggressive buy/sell volume and trade-flow imbalance in [-1, 1] over trades with t in (now − windowMs, now]. */
export function tradeFlow(trades: Trade[], now: number, windowMs: number) {
  let buy = 0, sell = 0, n = 0;
  for (let i = trades.length - 1; i >= 0; i--) { const x = trades[i]!; if (x.t > now) continue; if (x.t <= now - windowMs) break; if (x.buyerAggressor) buy += x.qty; else sell += x.qty; n++; }
  return { buyVolume: buy, sellVolume: sell, trades: n, imbalance: buy + sell > 0 ? (buy - sell) / (buy + sell) : 0 };
}
/** Resting-liquidity change (%) between two depth snapshots, per side, over the top `levels`. */
export function liquidityChange(prev: Depth, cur: Depth, levels = 5) {
  const s = (d: Depth, k: "bids" | "asks") => d[k].slice(0, levels).reduce((a, l) => a + l.qty * l.price, 0);
  const ch = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : null);
  return { bidPct: ch(s(prev, "bids"), s(cur, "bids")), askPct: ch(s(prev, "asks"), s(cur, "asks")) };
}
/** Mid-price return in bps over the lookback, from a time-ordered series of book tops. */
export function momentumBps(tops: BookTop[], now: number, lookbackMs: number) {
  const cur = [...tops].reverse().find((b) => b.t <= now), past = [...tops].reverse().find((b) => b.t <= now - lookbackMs);
  return cur && past ? ((mid(cur) - mid(past)) / mid(past)) * 10_000 : null;
}
/** Volatility burst: short-window realized volatility of trade prices relative to the long window (ratio). */
export function volatilityBurst(trades: Trade[], now: number, shortMs: number, longMs: number) {
  const rv = (w: number) => { const xs = trades.filter((x) => x.t > now - w && x.t <= now); let s = 0; for (let i = 1; i < xs.length; i++) s += Math.log(xs[i]!.price / xs[i - 1]!.price) ** 2; return xs.length > 2 ? Math.sqrt(s / w) : null; };
  const a = rv(shortMs), b = rv(longMs);
  return a !== null && b !== null && b > 0 ? a / b : null;
}
/** Data freshness and exchange→receipt latency for the latest book update. */
export const freshness = (b: BookTop, now: number) => ({ ageMs: now - b.receivedAt, latencyMs: b.receivedAt - b.t });

/**
 * Adverse selection: average signed mid-price move (bps) `horizonMs` after each signal, in the signal's direction.
 * Negative = the market tends to move against the entries (they are "picked off"). Uses only data after each signal.
 */
export function markoutBps(signals: { t: number; side: 1 | -1 }[], priceAt: (t: number) => number | null, horizonMs: number) {
  const xs: number[] = [];
  for (const s of signals) { const a = priceAt(s.t), b = priceAt(s.t + horizonMs); if (a && b) xs.push(s.side * ((b - a) / a) * 10_000); }
  const mean = xs.length ? xs.reduce((u, v) => u + v, 0) / xs.length : null;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((u, v) => u + (v - mean!) ** 2, 0) / (xs.length - 1)) : null;
  return { n: xs.length, meanBps: mean, stderrBps: sd !== null ? sd / Math.sqrt(xs.length) : null };
}

export const ultrafastConfigSchema = z.object({
  minBookImbalance: z.number().min(0).max(1), minFlowImbalance: z.number().min(0).max(1), flowWindowMs: z.number().int().min(100).max(60_000),
  minMicropriceEdgeBps: z.number().min(0).max(100), maxSpreadBps: z.number().gt(0).max(100), maxDataAgeMs: z.number().int().min(10).max(10_000),
  maxLatencyMs: z.number().int().min(1).max(10_000), maxVolBurst: z.number().gt(0).max(100), roundTripCostBps: z.number().min(0).max(200), minExpectedMoveMultiple: z.number().min(1).max(10),
  expectedMoveBps: z.number().min(0).max(1000), // measured offline (markout study) — not guessed; 0 → NO_TRADE
}).strict();
export type UltrafastConfig = z.infer<typeof ultrafastConfigSchema>;

export interface UltrafastSignal { t: number; action: "LONG" | "SHORT" | "NO_TRADE"; reasons: string[]; features: Record<string, number | null> }

/** Seconds-level decision. Every guard fails closed to NO_TRADE with its reason. */
export function ultrafastSignal(now: number, top: BookTop | null, depth: Depth | null, trades: Trade[], cfg: UltrafastConfig): UltrafastSignal {
  const no = (r: string, f: Record<string, number | null> = {}): UltrafastSignal => ({ t: now, action: "NO_TRADE", reasons: [r], features: f });
  if (!top) return no("No order-book data");
  const fr = freshness(top, now);
  if (fr.ageMs > cfg.maxDataAgeMs) return no(`Order book stale (${fr.ageMs} ms)`);
  if (fr.latencyMs > cfg.maxLatencyMs || fr.latencyMs < -1000) return no(`Feed latency out of bounds (${fr.latencyMs} ms)`);
  const sp = spreadBps(top), obi = bookImbalance(top, depth), mp = microprice(top), edge = ((mp - mid(top)) / mid(top)) * 10_000;
  const flow = tradeFlow(trades, now, cfg.flowWindowMs), vb = volatilityBurst(trades, now, 2_000, 60_000);
  const f = { spreadBps: sp, bookImbalance: obi, micropriceEdgeBps: edge, flowImbalance: flow.imbalance, flowTrades: flow.trades, volBurst: vb, ageMs: fr.ageMs, latencyMs: fr.latencyMs };
  if (!(sp > 0) || sp > cfg.maxSpreadBps) return no(`Spread ${sp.toFixed(2)} bps outside 0–${cfg.maxSpreadBps}`, f);
  if (vb !== null && vb > cfg.maxVolBurst) return no(`Volatility burst ×${vb.toFixed(1)}`, f);
  if (cfg.expectedMoveBps < cfg.minExpectedMoveMultiple * cfg.roundTripCostBps) return no(`Measured expected move ${cfg.expectedMoveBps} bps does not cover ${cfg.minExpectedMoveMultiple}× round-trip costs (${cfg.roundTripCostBps} bps)`, f);
  const long = obi >= cfg.minBookImbalance && flow.imbalance >= cfg.minFlowImbalance && edge >= cfg.minMicropriceEdgeBps;
  const short = obi <= -cfg.minBookImbalance && flow.imbalance <= -cfg.minFlowImbalance && edge <= -cfg.minMicropriceEdgeBps;
  if (long && !short) return { t: now, action: "LONG", reasons: ["Bid-heavy book, aggressive buying and microprice above mid"], features: f };
  if (short && !long) return { t: now, action: "SHORT", reasons: ["Ask-heavy book, aggressive selling and microprice below mid"], features: f };
  return no("Book, flow and microprice do not agree", f);
}
