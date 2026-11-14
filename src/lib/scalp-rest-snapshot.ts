// Live-first milestone A/C — server-side signal snapshot. Pure: turns credential-free Binance USD-M REST payloads
// (klines, depth snapshot, recent aggTrades, premiumIndex) fetched by the server into the same SignalInput the browser
// feed produces, so an order path never trusts a browser-computed signal. Missing or malformed data → not ready.
import type { Candle } from "./indicators";
import { FeedEngine, type LiveSymbol, type MarkEvent, type StreamHealth, type StreamKind, type SymbolHealth, type TradeEvent } from "./live-feed";
import type { SignalInput } from "./live-scalp-signal";

export const REST_SNAPSHOT_VERSION = "rest-snapshot-v1" as const;
export interface RestPayloads {
  klines1m: unknown; klines5m: unknown; depth: unknown; aggTrades: unknown; premium: unknown;
  /** when the responses were received (server clock, ms) */ receivedAt: number;
}
export interface RestSnapshotLimits { maxDepthAgeMs: number; maxMarkAgeMs: number; minTrades: number }
export const REST_SNAPSHOT_LIMITS: Readonly<RestSnapshotLimits> = Object.freeze({ maxDepthAgeMs: 3_000, maxMarkAgeMs: 5_000, minTrades: 20 });

const num = (x: unknown) => { const n = typeof x === "string" && x.trim() !== "" ? Number(x) : typeof x === "number" ? x : NaN; return Number.isFinite(n) ? n : null; };
const int = (x: unknown) => { const n = num(x); return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null; };
function levels(x: unknown): [number, number][] | null {
  if (!Array.isArray(x) || x.length === 0 || x.length > 1000) return null;
  const out: [number, number][] = [];
  for (const l of x) { if (!Array.isArray(l)) return null; const p = num(l[0]), q = num(l[1]); if (p === null || q === null || p <= 0 || q < 0) return null; out.push([p, q]); }
  return out;
}
const stream = (receivedAt: number | null, exchangeTs: number | null, now: number, maxAge: number): StreamHealth =>
  receivedAt === null ? { status: "NO_DATA", ageMs: null, exchangeTs, receivedAt } : { status: now - receivedAt > maxAge ? "STALE" : "LIVE", ageMs: now - receivedAt, exchangeTs, receivedAt };

/** Builds a SignalInput from REST payloads. `now` is the server clock at evaluation time. */
export function snapshotFromRest(symbol: LiveSymbol, p: RestPayloads, now: number, L: RestSnapshotLimits = REST_SNAPSHOT_LIMITS): SignalInput {
  const reasons: string[] = [];
  // Closed candles only (same merge and validation as the browser feed).
  const e = new FeedEngine([symbol]);
  e.mergeKlines(symbol, "1m", p.klines1m, now); e.mergeKlines(symbol, "5m", p.klines5m, now);
  const candles1m: Candle[] = [...e.candles(symbol, "1m")], candles5m: Candle[] = [...e.candles(symbol, "5m")];
  if (!candles1m.length) reasons.push("no closed 1m candles from REST");
  if (!candles5m.length) reasons.push("no closed 5m candles from REST");

  // Depth snapshot: a single exchange-consistent book at `T`.
  const d = p.depth as { lastUpdateId?: unknown; E?: unknown; T?: unknown; bids?: unknown; asks?: unknown } | null;
  const bids = levels(d?.bids), asks = levels(d?.asks), depthT = int(d?.T) ?? int(d?.E);
  let depth: SignalInput["depth"] = null, top: SignalInput["top"] = null;
  if (!bids || !asks || int(d?.lastUpdateId) === null || depthT === null) reasons.push("depth snapshot missing or malformed");
  else if (bids[0]![0] >= asks[0]![0]) reasons.push("depth snapshot is crossed");
  else {
    depth = { bids: [...bids].sort((a, b) => b[0] - a[0]), asks: [...asks].sort((a, b) => a[0] - b[0]) };
    top = { bid: depth.bids[0]![0], bidQty: depth.bids[0]![1], ask: depth.asks[0]![0], askQty: depth.asks[0]![1], source: "book", exchangeTs: depthT, receivedAt: p.receivedAt };
    if (now - p.receivedAt > L.maxDepthAgeMs) reasons.push(`depth snapshot stale (${now - p.receivedAt} ms)`);
  }

  // Recent aggTrades: ids must be consecutive (a gap means the flow window is incomplete).
  const trades: TradeEvent[] = []; let gap = false;
  if (!Array.isArray(p.aggTrades)) reasons.push("recent trades missing");
  else {
    for (const r of p.aggTrades as Record<string, unknown>[]) {
      const id = int(r?.["a"]), price = num(r?.["p"]), qty = num(r?.["q"]), t = int(r?.["T"]);
      if (id === null || price === null || price <= 0 || qty === null || qty <= 0 || t === null || typeof r["m"] !== "boolean") { reasons.push("malformed recent trade"); break; }
      trades.push({ kind: "trade", symbol, id, price, qty, t, E: t, buyerAggressor: !r["m"], receivedAt: t });
    }
    trades.sort((a, b) => a.id - b.id);
    for (let i = 1; i < trades.length; i++) if (trades[i]!.id !== trades[i - 1]!.id + 1) { gap = true; break; }
    if (trades.length < L.minTrades) reasons.push(`too few recent trades (${trades.length})`);
  }

  // Mark price with exchange timestamp.
  const pr = p.premium as Record<string, unknown> | null, markPrice = num(pr?.["markPrice"]), indexPrice = num(pr?.["indexPrice"]), fr = num(pr?.["lastFundingRate"]), nft = int(pr?.["nextFundingTime"]), mt = int(pr?.["time"]);
  let mark: MarkEvent | null = null;
  if (markPrice === null || markPrice <= 0 || indexPrice === null || fr === null || nft === null || mt === null) reasons.push("mark price missing or malformed");
  else { mark = { kind: "mark", symbol, markPrice, indexPrice, fundingRate: fr, nextFundingTime: nft, E: mt, receivedAt: p.receivedAt }; if (now - mt > L.maxMarkAgeMs) reasons.push(`mark price stale (${now - mt} ms)`); }

  const lastTrade = trades.at(-1) ?? null, c1 = candles1m.at(-1), c5 = candles5m.at(-1);
  const streams: Record<StreamKind, StreamHealth> = {
    trade: stream(lastTrade?.t ?? null, lastTrade?.t ?? null, now, 60_000), depth: stream(depth ? p.receivedAt : null, depthT, now, L.maxDepthAgeMs),
    bbo: stream(top ? p.receivedAt : null, depthT, now, L.maxDepthAgeMs), mark: stream(mark ? p.receivedAt : null, mt, now, L.maxMarkAgeMs),
    kline1m: stream(c1 ? p.receivedAt : null, c1?.t ?? null, now, 75_000), kline5m: stream(c5 ? p.receivedAt : null, c5?.t ?? null, now, 360_000),
  };
  const health: SymbolHealth = {
    symbol, ready: reasons.length === 0, reasons, book: depth ? "SYNCED" : "UNSYNCED", streams, candleGaps: { "1m": null, "5m": null },
    tradeFlowComplete: !gap, latencyP50Ms: null, counters: { resyncs: 0, gaps: 0, bookDuplicates: 0, tradeGaps: gap ? 1 : 0, tradeDuplicates: 0, missingCandles: 0 },
  };
  return { symbol, now, candles1m, candles5m, top, depth, trades, mark, health };
}
