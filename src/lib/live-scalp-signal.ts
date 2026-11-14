// Phase 4H.8 — live scalping signal pipeline (Engine B, 1m/5m with order-book confirmation). Pure and deterministic:
// a snapshot of the live feed in, one LiveSignal out. Rules only — no AI, no I/O. A signal is a PROPOSAL reference: it
// carries no quantity, leverage or authorization (the Central Risk Engine sizes; execution is gated separately).
// The confidence value is the share of rule factors that agree; it is UNCALIBRATED and is never a probability.
// Validation status is UNVALIDATED: earlier research (scalp-research.ts) found no positive out-of-sample net expectancy
// for 1–5 minute rules after costs, so live signals are for PAPER observation only.
import { ema, rsi, type Candle } from "./indicators";
import { atrSeries, sessionVwap } from "./scalp-intraday";
import { bookImbalance, microprice, mid, spreadBps, tradeFlow, volatilityBurst, type BookTop } from "./scalp-microstructure";
import type { FeedEngine, LiveSymbol, MarkEvent, SymbolHealth, TopOfBook, TradeEvent } from "./live-feed";

export const LIVE_SCALP_STRATEGY_ID = "futures-scalp-live" as const;
export const LIVE_SCALP_VERSION = "live-scalp-v1" as const;
export const LIVE_SCALP_FEATURES = "live-scalp-features-v1" as const;
export type LiveAction = "LONG" | "SHORT" | "NO_TRADE" | "INSUFFICIENT_DATA";

/** Strategy parameters — PROPOSED engineering values, not risk policy and not approved (owner decision OD-S1). */
export interface LiveSignalConfig {
  emaFast: number; emaSlow: number; rsiPeriod: number; atrPeriod: number; rsiLong: [number, number]; rsiShort: [number, number];
  momentumBars: number; minAtrPct: number; maxAtrPct: number; maxSpreadBps: number; minDepthNotional: number; maxVolBurst: number;
  minBookImbalance: number; minFlowImbalance: number; flowWindowMs: number; atrStopMult: number; rewardRisk: number;
  minTargetCostMultiple: number; signalTtlMs: number; expectedHoldMs: number; maxCandleAgeMs: number; referenceNotional: number;
  takerFeePct: number; minMicroAgree: number;
}
export const PROPOSED_SIGNAL_CONFIG: Readonly<LiveSignalConfig> = Object.freeze({
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14, rsiLong: [50, 70], rsiShort: [30, 50], momentumBars: 3,
  minAtrPct: 0.03, maxAtrPct: 1.5, maxSpreadBps: 2, minDepthNotional: 250_000, maxVolBurst: 4, minBookImbalance: 0.1, minFlowImbalance: 0.1,
  flowWindowMs: 30_000, atrStopMult: 1.5, rewardRisk: 1.5, minTargetCostMultiple: 3, signalTtlMs: 15_000, expectedHoldMs: 15 * 60_000,
  maxCandleAgeMs: 75_000, referenceNotional: 1_000, takerFeePct: 0.05, minMicroAgree: 2,
}) as LiveSignalConfig;

export interface SignalInput {
  symbol: LiveSymbol; now: number; candles1m: readonly Candle[]; candles5m: readonly Candle[];
  top: TopOfBook | null; depth: { bids: [number, number][]; asks: [number, number][] } | null; trades: readonly TradeEvent[]; mark: MarkEvent | null; health: SymbolHealth;
}
export interface SignalCosts { feePctRoundTrip: number; spreadPct: number; slippagePctRoundTrip: { long: number | null; short: number | null }; fundingPct: { long: number; short: number }; totalPct: { long: number | null; short: number | null }; basis: string }
export interface LiveSignal {
  id: string; strategyId: typeof LIVE_SCALP_STRATEGY_ID; strategyVersion: typeof LIVE_SCALP_VERSION; featureVersion: typeof LIVE_SCALP_FEATURES;
  symbol: LiveSymbol; action: LiveAction; decidedAt: number; decisionCandleT: number | null; expiresAt: number; validation: "UNVALIDATED";
  entryReference: number | null; stopReference: number | null; takeProfitReference: number | null; costs: SignalCosts | null;
  confidence: { score: number | null; agreeing: number; total: number; calibration: "UNCALIBRATED"; label: string };
  freshness: { ready: boolean; bookAgeMs: number | null; tradeAgeMs: number | null; markAgeMs: number | null; candle1mAgeMs: number | null; candle5mAgeMs: number | null; bookSource: TopOfBook["source"] | null };
  features: Record<string, number | string | boolean | null>; reasons: string[]; rejections: string[];
}
const CONF_LABEL = "Share of rule factors that agree — uncalibrated, not a probability";

export function snapshotFor(engine: FeedEngine, symbol: LiveSymbol, now: number): SignalInput {
  return { symbol, now, candles1m: engine.candles(symbol, "1m"), candles5m: engine.candles(symbol, "5m"), top: engine.top(symbol, now), depth: engine.depth(symbol, now, 100), trades: engine.trades(symbol), mark: engine.mark(symbol), health: engine.health(symbol, now) };
}
/** Average fill price for `notional` quote walking the given side; null if the visible depth cannot fill it. */
export function walkBook(levels: [number, number][], notional: number): { avg: number; levels: number } | null {
  let left = notional, qty = 0, cost = 0, n = 0;
  for (const [p, q] of levels) { if (left <= 1e-9) break; const take = Math.min(q, left / p); qty += take; cost += take * p; left -= take * p; n++; }
  return left > 1e-6 || qty <= 0 ? null : { avg: cost / qty, levels: n };
}
const last = <T,>(xs: readonly T[]) => xs[xs.length - 1];
const r = (x: number | null, d = 6) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

export function evaluateLiveSignal(inp: SignalInput, cfg: LiveSignalConfig = PROPOSED_SIGNAL_CONFIG): LiveSignal {
  const { symbol, now, candles1m: c1, candles5m: c5, top, depth, mark, health } = inp;
  const lc1 = last(c1), lc5 = last(c5);
  const trade = last(inp.trades);
  const freshness: LiveSignal["freshness"] = {
    ready: health.ready, bookAgeMs: top ? now - top.receivedAt : null, tradeAgeMs: trade ? now - trade.receivedAt : null, markAgeMs: mark ? now - mark.receivedAt : null,
    candle1mAgeMs: lc1 ? now - (lc1.t + 60_000) : null, candle5mAgeMs: lc5 ? now - (lc5.t + 300_000) : null, bookSource: top?.source ?? null,
  };
  const base = (action: LiveAction, reasons: string[], rejections: string[], extra: Partial<LiveSignal> = {}): LiveSignal => ({
    id: `${LIVE_SCALP_STRATEGY_ID}:${LIVE_SCALP_VERSION}:${symbol}:${lc1?.t ?? "none"}`, strategyId: LIVE_SCALP_STRATEGY_ID, strategyVersion: LIVE_SCALP_VERSION, featureVersion: LIVE_SCALP_FEATURES,
    symbol, action, decidedAt: now, decisionCandleT: lc1?.t ?? null, expiresAt: now + cfg.signalTtlMs, validation: "UNVALIDATED",
    entryReference: null, stopReference: null, takeProfitReference: null, costs: null,
    confidence: { score: null, agreeing: 0, total: 8, calibration: "UNCALIBRATED", label: CONF_LABEL }, freshness, features: {}, reasons, rejections, ...extra,
  });

  // 1. Data sufficiency — any gap is INSUFFICIENT_DATA, never a guess.
  const missing: string[] = [...health.reasons];
  if (!health.tradeFlowComplete) missing.push("trade flow window contains a trade-id gap");
  if (!top) missing.push("no fresh best bid/ask");
  if (!depth) missing.push("order book not synced or stale");
  if (!mark) missing.push("no mark price");
  const need1 = Math.max(cfg.emaSlow, cfg.rsiPeriod + 1, cfg.atrPeriod) + cfg.momentumBars + 1;
  if (c1.length < need1) missing.push(`only ${c1.length} closed 1m candles (need ${need1})`);
  if (c5.length < cfg.emaSlow + 1) missing.push(`only ${c5.length} closed 5m candles (need ${cfg.emaSlow + 1})`);
  if (lc1 && now - (lc1.t + 60_000) > cfg.maxCandleAgeMs) missing.push(`latest closed 1m candle is ${Math.round((now - lc1.t - 60_000) / 1000)} s old`);
  if (lc5 && now - (lc5.t + 300_000) > 300_000 + cfg.maxCandleAgeMs) missing.push("latest closed 5m candle is too old");
  for (let i = 1; i < c1.length; i++) if (c1[i]!.t !== c1[i - 1]!.t + 60_000) { missing.push("1m candle history has a gap"); break; }
  if (missing.length) return base("INSUFFICIENT_DATA", [], missing);

  // 2. Features (only closed candles; the live book/trades at decision time).
  const closes1 = c1.map((c) => c.c), closes5 = c5.map((c) => c.c);
  const ef = last(ema(closes1, cfg.emaFast))!, es = last(ema(closes1, cfg.emaSlow))!, rs = last(rsi(closes1, cfg.rsiPeriod))!;
  const atr = last(atrSeries([...c1], cfg.atrPeriod))!, vwap = last(sessionVwap([...c1]))!;
  const ef5 = last(ema(closes5, cfg.emaFast))!, es5 = last(ema(closes5, cfg.emaSlow))!;
  const close = lc1!.c, mom = ((close - c1[c1.length - 1 - cfg.momentumBars]!.c) / c1[c1.length - 1 - cfg.momentumBars]!.c) * 10_000;
  const bt: BookTop = { t: top!.exchangeTs, receivedAt: top!.receivedAt, bid: top!.bid, bidQty: top!.bidQty, ask: top!.ask, askQty: top!.askQty };
  const sp = spreadBps(bt), m = mid(bt), mp = microprice(bt), edgeBps = ((mp - m) / m) * 10_000;
  const obi = bookImbalance(bt, { t: bt.t, bids: depth!.bids.slice(0, 10).map(([price, qty]) => ({ price, qty })), asks: depth!.asks.slice(0, 10).map(([price, qty]) => ({ price, qty })) }, 10);
  const tradesForFlow = inp.trades.map((x) => ({ t: x.receivedAt, price: x.price, qty: x.qty, buyerAggressor: x.buyerAggressor }));
  const flow = tradeFlow(tradesForFlow, now, cfg.flowWindowMs), vb = volatilityBurst(tradesForFlow, now, 5_000, 120_000);
  const depthBid = depth!.bids.slice(0, 10).reduce((a, [p, q]) => a + p * q, 0), depthAsk = depth!.asks.slice(0, 10).reduce((a, [p, q]) => a + p * q, 0);
  const atrPct = (atr / close) * 100, rel5 = ef5 > es5 ? "up" : ef5 < es5 ? "down" : "flat";
  const features = {
    close, emaFast: r(ef), emaSlow: r(es), vwap: r(vwap), rsi: r(rs, 3), atr: r(atr), atrPct: r(atrPct, 4), momentumBps: r(mom, 3), trend5m: rel5,
    emaFast5m: r(ef5), emaSlow5m: r(es5), bid: top!.bid, ask: top!.ask, spreadBps: r(sp, 4), microprice: r(mp), micropriceEdgeBps: r(edgeBps, 4),
    bookImbalance10: r(obi, 4), flowImbalance: r(flow.imbalance, 4), flowTrades: flow.trades, volBurst: r(vb, 3), depthBid10: r(depthBid, 0), depthAsk10: r(depthAsk, 0),
    markPrice: mark!.markPrice, indexPrice: mark!.indexPrice, fundingRate: mark!.fundingRate, nextFundingTime: mark!.nextFundingTime,
  };

  // 3. Costs from the live book: proposed taker fee, live spread, book walk for the reference notional, funding if held over.
  const buy = walkBook(depth!.asks, cfg.referenceNotional), sell = walkBook(depth!.bids, cfg.referenceNotional);
  const slipLong = buy && sell ? ((buy.avg - top!.ask) / top!.ask + (top!.bid - sell.avg) / top!.bid) * 100 : null;
  const spreadPct = ((top!.ask - top!.bid) / m) * 100, crosses = now + cfg.expectedHoldMs >= mark!.nextFundingTime;
  const fundingPct = { long: crosses ? mark!.fundingRate * 100 : 0, short: crosses ? -mark!.fundingRate * 100 : 0 };
  const fee = 2 * cfg.takerFeePct;
  const total = (s: number | null, f: number) => (s === null ? null : fee + spreadPct + s + Math.max(0, f));
  const costs: SignalCosts = {
    feePctRoundTrip: fee, spreadPct: r(spreadPct, 5)!, slippagePctRoundTrip: { long: r(slipLong, 5), short: r(slipLong, 5) }, fundingPct,
    totalPct: { long: r(total(slipLong, fundingPct.long), 5), short: r(total(slipLong, fundingPct.short), 5) },
    basis: `taker ${cfg.takerFeePct}% per side (proposed, account fee tier not read), live spread, book walk for ${cfg.referenceNotional} USDT, funding ${crosses ? "included (hold crosses the next funding time)" : "not reached within the expected hold"}`,
  };

  // 4. Market-condition guards → NO_TRADE with reasons.
  const rejections: string[] = [];
  if (atrPct < cfg.minAtrPct) rejections.push(`volatility too low (ATR ${atrPct.toFixed(3)}% < ${cfg.minAtrPct}%)`);
  if (atrPct > cfg.maxAtrPct) rejections.push(`volatility too high (ATR ${atrPct.toFixed(3)}% > ${cfg.maxAtrPct}%)`);
  if (!(sp > 0) || sp > cfg.maxSpreadBps) rejections.push(`spread ${sp.toFixed(2)} bps outside 0–${cfg.maxSpreadBps}`);
  if (Math.min(depthBid, depthAsk) < cfg.minDepthNotional) rejections.push(`thin book (top-10 depth ${Math.round(Math.min(depthBid, depthAsk))} < ${cfg.minDepthNotional} USDT)`);
  if (vb !== null && vb > cfg.maxVolBurst) rejections.push(`volatility burst ×${vb.toFixed(1)}`);
  if (slipLong === null) rejections.push(`visible depth cannot fill ${cfg.referenceNotional} USDT`);

  // 5. Direction: core trend factors must all agree; micro factors must mostly agree.
  const L = { trend1m: ef > es, vwap: close > vwap, trend5m: rel5 === "up", momentum: mom > 0, rsi: rs > cfg.rsiLong[0] && rs < cfg.rsiLong[1], book: obi >= cfg.minBookImbalance, flow: flow.imbalance >= cfg.minFlowImbalance, micro: edgeBps > 0 };
  const S = { trend1m: ef < es, vwap: close < vwap, trend5m: rel5 === "down", momentum: mom < 0, rsi: rs > cfg.rsiShort[0] && rs < cfg.rsiShort[1], book: obi <= -cfg.minBookImbalance, flow: flow.imbalance <= -cfg.minFlowImbalance, micro: edgeBps < 0 };
  const count = (x: Record<string, boolean>) => Object.values(x).filter(Boolean).length;
  const core = (x: typeof L) => x.trend1m && x.vwap && x.trend5m && x.momentum && x.rsi;
  const micro = (x: typeof L) => [x.book, x.flow, x.micro].filter(Boolean).length >= cfg.minMicroAgree;
  const side: "LONG" | "SHORT" | null = core(L) && micro(L) ? "LONG" : core(S) && micro(S) ? "SHORT" : null;
  const agree = side === "LONG" ? count(L) : side === "SHORT" ? count(S) : Math.max(count(L), count(S));
  const confidence = { score: r(agree / 8, 4), agreeing: agree, total: 8, calibration: "UNCALIBRATED" as const, label: CONF_LABEL };
  if (!side) {
    const lean = count(L) >= count(S) ? L : S, name = lean === L ? "LONG" : "SHORT";
    const failed = Object.entries(lean).filter(([, v]) => !v).map(([k]) => k);
    rejections.push(`${name} factors not aligned: ${failed.join(", ")}`);
    return base("NO_TRADE", [], rejections, { costs, features, confidence });
  }
  const entry = side === "LONG" ? top!.ask : top!.bid, stopDist = atr * cfg.atrStopMult;
  const stop = side === "LONG" ? entry - stopDist : entry + stopDist, tp = side === "LONG" ? entry + stopDist * cfg.rewardRisk : entry - stopDist * cfg.rewardRisk;
  const targetPct = ((stopDist * cfg.rewardRisk) / entry) * 100, cost = side === "LONG" ? costs.totalPct.long : costs.totalPct.short;
  if (cost !== null && targetPct < cfg.minTargetCostMultiple * cost) rejections.push(`target ${targetPct.toFixed(3)}% does not cover ${cfg.minTargetCostMultiple}× estimated round-trip costs (${cost.toFixed(3)}%)`);
  const reasons = side === "LONG"
    ? ["1m EMA fast above slow, close above VWAP, 5m trend up", `momentum +${mom.toFixed(1)} bps over ${cfg.momentumBars} candles, RSI ${rs.toFixed(1)}`, `book ${obi.toFixed(2)}, flow ${flow.imbalance.toFixed(2)}, microprice edge ${edgeBps.toFixed(2)} bps`]
    : ["1m EMA fast below slow, close below VWAP, 5m trend down", `momentum ${mom.toFixed(1)} bps over ${cfg.momentumBars} candles, RSI ${rs.toFixed(1)}`, `book ${obi.toFixed(2)}, flow ${flow.imbalance.toFixed(2)}, microprice edge ${edgeBps.toFixed(2)} bps`];
  const refs = { entryReference: r(entry, 8), stopReference: r(stop, 8), takeProfitReference: r(tp, 8), costs, features, confidence };
  return rejections.length ? base("NO_TRADE", reasons, rejections, refs) : base(side, reasons, [], refs);
}
