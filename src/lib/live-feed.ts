// Phase 4H.8 — Binance USD-M Futures live market-data core (BTCUSDT, ETHUSDT). Pure and deterministic: raw public
// WebSocket messages and REST bodies in, validated state and monitoring events out. No network, timers or credentials
// (the I/O lives in live-feed-client.ts). Nothing here is fabricated or substituted: a malformed, duplicate, out-of-order
// or gapped message is counted and refused, a gapped order book is cleared until a fresh snapshot resynchronises it, and
// every view states its source timestamps and age. Memory is bounded by explicit caps.
//
// Binance (2025+) splits USD-M streams by host path: trades, mark price and klines on /market, depth and book ticker on
// /public. The legacy combined path connects but stays silent for market streams — stale detection catches that.
import { createMonitor, type Monitor } from "./live-monitor";
import type { Candle } from "./indicators";

export const LIVE_FEED_VERSION = "live-feed-v1" as const;
export const LIVE_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type LiveSymbol = (typeof LIVE_SYMBOLS)[number];
export const isLiveSymbol = (s: unknown): s is LiveSymbol => typeof s === "string" && (LIVE_SYMBOLS as readonly string[]).includes(s);
export const FEED_HOSTS = Object.freeze({
  market: "wss://fstream.binance.com/market/stream", public: "wss://fstream.binance.com/public/stream", rest: "https://fapi.binance.com",
});
/** Exact public REST paths with their request weight (limit ≤ 1000 for depth, ≤ 499 for klines). Nothing signed. */
export const REST_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  "/fapi/v1/depth": 20, "/fapi/v1/aggTrades": 20, "/fapi/v1/klines": 2, "/fapi/v1/time": 1, "/fapi/v1/premiumIndex": 1, "/fapi/v1/exchangeInfo": 1,
});
const REST_PARAMS = new Set(["symbol", "limit", "interval", "startTime", "endTime"]);
export type SocketKind = "market" | "public";
export type StreamKind = "trade" | "depth" | "bbo" | "mark" | "kline1m" | "kline5m";
export const INTERVAL_MS = { "1m": 60_000, "5m": 300_000 } as const;
export type LiveInterval = keyof typeof INTERVAL_MS;

export function streamNames(kind: SocketKind, symbols: readonly LiveSymbol[]): string[] {
  return symbols.flatMap((s) => { const l = s.toLowerCase(); return kind === "market" ? [`${l}@aggTrade`, `${l}@markPrice@1s`, `${l}@kline_1m`, `${l}@kline_5m`] : [`${l}@depth@100ms`, `${l}@bookTicker`]; });
}
export function socketUrl(kind: SocketKind, symbols: readonly LiveSymbol[]): string {
  if (!symbols.length || !symbols.every(isLiveSymbol)) throw new Error("live feed: symbol not allowed");
  return `${FEED_HOSTS[kind]}?streams=${streamNames(kind, symbols).join("/")}`;
}
export function restUrl(path: string, params: Record<string, string | number>): string {
  if (!Object.prototype.hasOwnProperty.call(REST_WEIGHTS, path)) throw new Error(`live feed: REST path not allowed: ${path}`);
  for (const k of Object.keys(params)) if (!REST_PARAMS.has(k)) throw new Error(`live feed: REST parameter not allowed: ${k}`);
  if (params["symbol"] !== undefined && !isLiveSymbol(params["symbol"])) throw new Error("live feed: symbol not allowed");
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return `${FEED_HOSTS.rest}${path}${q.size ? `?${q}` : ""}`;
}

// ---------- parsing ----------
export interface TradeEvent { kind: "trade"; symbol: LiveSymbol; id: number; price: number; qty: number; t: number; E: number; buyerAggressor: boolean; receivedAt: number }
export interface DepthEvent { kind: "depth"; symbol: LiveSymbol; U: number; u: number; pu: number; E: number; T: number; bids: [number, number][]; asks: [number, number][]; receivedAt: number }
export interface BboEvent { kind: "bbo"; symbol: LiveSymbol; u: number; bid: number; bidQty: number; ask: number; askQty: number; T: number; E: number; receivedAt: number }
export interface KlineEvent { kind: "kline"; symbol: LiveSymbol; interval: LiveInterval; candle: Candle; closeTime: number; closed: boolean; trades: number; E: number; receivedAt: number }
export interface MarkEvent { kind: "mark"; symbol: LiveSymbol; markPrice: number; indexPrice: number; fundingRate: number; nextFundingTime: number; E: number; receivedAt: number }
export type FeedEvent = TradeEvent | DepthEvent | BboEvent | KlineEvent | MarkEvent;
export type ParseResult = { ok: true; event: FeedEvent } | { ok: false; reason: string; stream: string | null };

const num = (x: unknown): number | null => { const n = typeof x === "string" ? (x.trim() === "" ? NaN : Number(x)) : typeof x === "number" ? x : NaN; return Number.isFinite(n) ? n : null; };
const pos = (x: unknown) => { const n = num(x); return n !== null && n > 0 ? n : null; };
const nonNeg = (x: unknown) => { const n = num(x); return n !== null && n >= 0 ? n : null; };
const int = (x: unknown) => { const n = num(x); return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null; };
function levels(x: unknown, max = 5000): [number, number][] | null {
  if (!Array.isArray(x) || x.length > max) return null;
  const out: [number, number][] = [];
  for (const l of x) { if (!Array.isArray(l) || l.length < 2) return null; const p = pos(l[0]), q = nonNeg(l[1]); if (p === null || q === null) return null; out.push([p, q]); }
  return out;
}

/** Validates one combined-stream message. The stream name must match the payload's type and symbol. */
export function parseMessage(raw: unknown, receivedAt: number): ParseResult {
  let m: unknown = raw;
  if (typeof raw === "string") { if (raw.length > 2_000_000) return { ok: false, reason: "message too large", stream: null }; try { m = JSON.parse(raw); } catch { return { ok: false, reason: "not JSON", stream: null }; } }
  if (!m || typeof m !== "object") return { ok: false, reason: "not an object", stream: null };
  const { stream, data } = m as { stream?: unknown; data?: Record<string, unknown> };
  if (typeof stream !== "string" || !data || typeof data !== "object") return { ok: false, reason: "not a combined-stream message", stream: null };
  const [lsym, type] = stream.split("@", 2) as [string, string | undefined];
  const symbol = lsym.toUpperCase();
  const bad = (reason: string): ParseResult => ({ ok: false, reason, stream });
  if (!isLiveSymbol(symbol) || data["s"] !== symbol) return bad("symbol not allowed or does not match the stream");
  const E = int(data["E"]);
  if (E === null) return bad("missing event time");
  if (type === "aggTrade" && data["e"] === "aggTrade") {
    const id = int(data["a"]), price = pos(data["p"]), qty = pos(data["q"]), t = int(data["T"]);
    if (id === null || price === null || qty === null || t === null || typeof data["m"] !== "boolean") return bad("malformed aggTrade");
    return { ok: true, event: { kind: "trade", symbol, id, price, qty, t, E, buyerAggressor: !data["m"], receivedAt } };
  }
  if (type === "depth" && stream.endsWith("@depth@100ms") && data["e"] === "depthUpdate") {
    const U = int(data["U"]), u = int(data["u"]), pu = int(data["pu"]), T = int(data["T"]), bids = levels(data["b"]), asks = levels(data["a"]);
    if (U === null || u === null || pu === null || T === null || !bids || !asks || u < U) return bad("malformed depthUpdate");
    return { ok: true, event: { kind: "depth", symbol, U, u, pu, E, T, bids, asks, receivedAt } };
  }
  if (type === "bookTicker" && data["e"] === "bookTicker") {
    const u = int(data["u"]), bid = pos(data["b"]), bidQty = nonNeg(data["B"]), ask = pos(data["a"]), askQty = nonNeg(data["A"]), T = int(data["T"]);
    if (u === null || bid === null || bidQty === null || ask === null || askQty === null || T === null) return bad("malformed bookTicker");
    if (bid >= ask) return bad("crossed bookTicker");
    return { ok: true, event: { kind: "bbo", symbol, u, bid, bidQty, ask, askQty, T, E, receivedAt } };
  }
  if ((type === "kline_1m" || type === "kline_5m") && data["e"] === "kline") {
    const k = data["k"] as Record<string, unknown> | undefined, interval = type === "kline_1m" ? "1m" : "5m";
    if (!k || k["i"] !== interval || k["s"] !== symbol) return bad("malformed kline");
    const t = int(k["t"]), T = int(k["T"]), o = pos(k["o"]), h = pos(k["h"]), l = pos(k["l"]), c = pos(k["c"]), v = nonNeg(k["v"]), n = int(k["n"]);
    if (t === null || T === null || o === null || h === null || l === null || c === null || v === null || n === null || typeof k["x"] !== "boolean") return bad("malformed kline");
    if (t % INTERVAL_MS[interval] !== 0 || T !== t + INTERVAL_MS[interval] - 1 || h < Math.max(o, c, l) || l > Math.min(o, c)) return bad("kline times or prices inconsistent");
    return { ok: true, event: { kind: "kline", symbol, interval, candle: { t, o, h, l, c, v }, closeTime: T, closed: k["x"], trades: n, E, receivedAt } };
  }
  if (type === "markPrice" && stream.endsWith("@markPrice@1s") && data["e"] === "markPriceUpdate") {
    const markPrice = pos(data["p"]), indexPrice = pos(data["i"]), fundingRate = num(data["r"]), nextFundingTime = int(data["T"]);
    if (markPrice === null || indexPrice === null || fundingRate === null || nextFundingTime === null || Math.abs(fundingRate) > 0.05) return bad("malformed markPriceUpdate");
    return { ok: true, event: { kind: "mark", symbol, markPrice, indexPrice, fundingRate, nextFundingTime, E, receivedAt } };
  }
  return bad("unknown stream type");
}

// ---------- state ----------
export interface FeedThresholds {
  staleMs: Record<StreamKind, number>; maxClockOffsetMs: number; maxStreamLatencyMs: number;
  bookLevels: number; bufferMax: number; tradesMax: number; tradeWindowMs: number; candlesMax: number;
}
/** Engineering defaults (not risk policy). Stale = no message for that long; trades can be quiet, so their limit is longer. */
export const DEFAULT_THRESHOLDS: FeedThresholds = Object.freeze({
  staleMs: { trade: 15_000, depth: 3_000, bbo: 3_000, mark: 3_000, kline1m: 5_000, kline5m: 5_000 },
  maxClockOffsetMs: 1_000, maxStreamLatencyMs: 2_000, bookLevels: 1_000, bufferMax: 1_000, tradesMax: 5_000, tradeWindowMs: 120_000, candlesMax: 500,
}) as FeedThresholds;

export type BookStatus = "UNSYNCED" | "AWAITING_SNAPSHOT" | "SYNCING" | "SYNCED";
interface Book {
  status: BookStatus; lastUpdateId: number | null; prevU: number | null; bids: Map<number, number>; asks: Map<number, number>;
  buffer: DepthEvent[]; overflowed: boolean; syncedAt: number | null; lastE: number | null; resyncs: number; gaps: number; duplicates: number; corr: string | null;
}
interface Series { closed: Candle[]; open: Candle | null; missing: number; pendingFrom: number | null; lastReceivedAt: number | null }
interface SymbolState {
  book: Book; bbo: BboEvent | null; mark: MarkEvent | null;
  trades: TradeEvent[]; lastTradeId: number | null; tradeGaps: number; tradeDuplicates: number; lastTradeGapAt: number | null;
  candles: Record<LiveInterval, Series>; last: Record<StreamKind, { receivedAt: number | null; exchangeTs: number | null }>;
  latencies: number[]; stale: Record<StreamKind, boolean>;
}
const STREAMS: StreamKind[] = ["trade", "depth", "bbo", "mark", "kline1m", "kline5m"];
const emptyBook = (): Book => ({ status: "UNSYNCED", lastUpdateId: null, prevU: null, bids: new Map(), asks: new Map(), buffer: [], overflowed: false, syncedAt: null, lastE: null, resyncs: 0, gaps: 0, duplicates: 0, corr: null });
const emptySeries = (): Series => ({ closed: [], open: null, missing: 0, pendingFrom: null, lastReceivedAt: null });

export interface TopOfBook { bid: number; bidQty: number; ask: number; askQty: number; source: "book" | "bookTicker"; exchangeTs: number; receivedAt: number }
export interface StreamHealth { status: "LIVE" | "STALE" | "NO_DATA"; ageMs: number | null; exchangeTs: number | null; receivedAt: number | null }
export interface SymbolHealth {
  symbol: LiveSymbol; ready: boolean; reasons: string[]; book: BookStatus; streams: Record<StreamKind, StreamHealth>;
  candleGaps: Record<LiveInterval, number | null>; tradeFlowComplete: boolean; latencyP50Ms: number | null; counters: { resyncs: number; gaps: number; bookDuplicates: number; tradeGaps: number; tradeDuplicates: number; missingCandles: number };
}

export class FeedEngine {
  readonly monitor: Monitor; readonly th: FeedThresholds;
  private s: Record<LiveSymbol, SymbolState>;
  clock: { offsetMs: number | null; rttMs: number | null; measuredAt: number | null; drift: boolean } = { offsetMs: null, rttMs: null, measuredAt: null, drift: false };
  counts = { messages: 0, malformed: 0, accepted: 0 };
  constructor(readonly symbols: readonly LiveSymbol[] = LIVE_SYMBOLS, o: { monitor?: Monitor; thresholds?: Partial<FeedThresholds> } = {}) {
    if (!symbols.length || !symbols.every(isLiveSymbol)) throw new Error("live feed: symbol not allowed");
    this.monitor = o.monitor ?? createMonitor(); this.th = { ...DEFAULT_THRESHOLDS, ...o.thresholds };
    this.s = Object.fromEntries(symbols.map((sym) => [sym, {
      book: emptyBook(), bbo: null, mark: null, trades: [], lastTradeId: null, tradeGaps: 0, tradeDuplicates: 0, lastTradeGapAt: null,
      candles: { "1m": emptySeries(), "5m": emptySeries() }, last: Object.fromEntries(STREAMS.map((k) => [k, { receivedAt: null, exchangeTs: null }])) as SymbolState["last"],
      latencies: [], stale: Object.fromEntries(STREAMS.map((k) => [k, false])) as SymbolState["stale"],
    }])) as unknown as Record<LiveSymbol, SymbolState>;
  }
  private st(sym: LiveSymbol) { const x = this.s[sym]; if (!x) throw new Error("live feed: unknown symbol"); return x; }

  /** One raw message in. Returns the accepted event, or null when it was refused (and counted). */
  ingest(raw: unknown, receivedAt: number): FeedEvent | null {
    this.counts.messages++;
    const r = parseMessage(raw, receivedAt);
    if (!r.ok) { this.counts.malformed++; this.monitor.emit("MALFORMED_MESSAGE", "warn", null, { reason: r.reason, stream: r.stream }); return null; }
    const e = r.event;
    if (!this.symbols.includes(e.symbol)) { this.counts.malformed++; return null; }
    const x = this.st(e.symbol);
    const kind: StreamKind = e.kind === "kline" ? (e.interval === "1m" ? "kline1m" : "kline5m") : e.kind;
    const ok = e.kind === "trade" ? this.onTrade(x, e) : e.kind === "depth" ? this.onDepth(x, e) : e.kind === "bbo" ? this.onBbo(x, e) : e.kind === "mark" ? this.onMark(x, e) : this.onKline(x, e);
    x.last[kind] = { receivedAt, exchangeTs: e.E };
    x.latencies.push(receivedAt - e.E); if (x.latencies.length > 200) x.latencies.shift();
    if (x.stale[kind]) { x.stale[kind] = false; this.monitor.emit("FEED_RECOVERED", "info", e.symbol, { stream: kind }); }
    if (ok) this.counts.accepted++;
    return ok ? e : null;
  }

  private onTrade(x: SymbolState, e: TradeEvent): boolean {
    if (x.lastTradeId !== null && e.id <= x.lastTradeId) { x.tradeDuplicates++; this.monitor.emit("DUPLICATE_EVENT", "info", e.symbol, { stream: "aggTrade", id: e.id }); return false; }
    if (x.lastTradeId !== null && e.id > x.lastTradeId + 1) { x.tradeGaps++; x.lastTradeGapAt = e.receivedAt; this.monitor.emit("TRADE_ID_GAP", "warn", e.symbol, { from: x.lastTradeId + 1, to: e.id - 1, missing: e.id - x.lastTradeId - 1 }); }
    x.lastTradeId = e.id; x.trades.push(e);
    const cut = e.receivedAt - this.th.tradeWindowMs; let drop = 0;
    while (drop < x.trades.length && (x.trades[drop]!.receivedAt < cut || x.trades.length - drop > this.th.tradesMax)) drop++;
    if (drop) x.trades.splice(0, drop);
    return true;
  }
  private onBbo(x: SymbolState, e: BboEvent): boolean {
    if (x.bbo && e.u <= x.bbo.u) { this.monitor.emit("DUPLICATE_EVENT", "info", e.symbol, { stream: "bookTicker", u: e.u }); return false; }
    x.bbo = e; return true;
  }
  private onMark(x: SymbolState, e: MarkEvent): boolean {
    if (x.mark && e.E <= x.mark.E) { this.monitor.emit("DUPLICATE_EVENT", "info", e.symbol, { stream: "markPrice", E: e.E }); return false; }
    x.mark = e; return true;
  }
  private onKline(x: SymbolState, e: KlineEvent): boolean {
    const s = x.candles[e.interval], ms = INTERVAL_MS[e.interval], last = s.closed.at(-1);
    s.lastReceivedAt = e.receivedAt;
    if (!e.closed) {
      if (last && e.candle.t > last.t + ms && s.pendingFrom === null) this.markMissing(e.symbol, e.interval, last.t + ms, e.candle.t - ms);
      s.open = e.candle; return true;
    }
    if (last && e.candle.t <= last.t) { this.monitor.emit("DUPLICATE_EVENT", "info", e.symbol, { stream: `kline_${e.interval}`, t: e.candle.t }); return false; }
    if (last && e.candle.t > last.t + ms && s.pendingFrom === null) this.markMissing(e.symbol, e.interval, last.t + ms, e.candle.t - ms);
    s.closed.push(e.candle); if (s.closed.length > this.th.candlesMax) s.closed.splice(0, s.closed.length - this.th.candlesMax);
    if (s.open && s.open.t === e.candle.t) s.open = null;
    return true;
  }
  private markMissing(sym: LiveSymbol, iv: LiveInterval, from: number, to: number) {
    const s = this.st(sym).candles[iv], n = Math.round((to - from) / INTERVAL_MS[iv]) + 1;
    s.missing += n; s.pendingFrom = from;
    this.monitor.emit("MISSING_CANDLE", "warn", sym, { interval: iv, from, to, count: n });
  }

  // ----- order book (Binance USD-M local book procedure) -----
  private resync(x: SymbolState, sym: LiveSymbol, reason: string, keep?: DepthEvent) {
    const b = x.book, corr = b.corr ?? `corr_${sym}_${Date.now().toString(36)}_${b.resyncs + 1}`;
    x.book = { ...emptyBook(), status: "AWAITING_SNAPSHOT", buffer: keep ? [keep] : [], resyncs: b.resyncs + 1, gaps: b.gaps + (reason === "SEQUENCE_GAP" ? 1 : 0), duplicates: b.duplicates, corr };
    this.monitor.emit(reason === "SEQUENCE_GAP" ? "SEQUENCE_GAP" : "BOOK_RESYNC", "warn", sym, { reason, lastU: b.prevU, lastUpdateId: b.lastUpdateId }, corr);
  }
  private onDepth(x: SymbolState, e: DepthEvent): boolean {
    const b = x.book;
    if (b.status === "UNSYNCED" || b.status === "AWAITING_SNAPSHOT") {
      b.status = "AWAITING_SNAPSHOT"; b.buffer.push(e);
      if (b.buffer.length > this.th.bufferMax) { b.buffer.shift(); if (!b.overflowed) { b.overflowed = true; this.monitor.emit("BUFFER_OVERFLOW", "warn", e.symbol, { kept: this.th.bufferMax }, b.corr ?? undefined); } }
      return true;
    }
    return this.process(x, e);
  }
  private process(x: SymbolState, e: DepthEvent): boolean {
    const b = x.book;
    if (b.lastUpdateId === null) return false;
    if (b.prevU === null) { // first event after the snapshot
      if (e.u < b.lastUpdateId) return false; // older than the snapshot: dropped by the procedure
      if (e.U > b.lastUpdateId) { this.resync(x, e.symbol, "SNAPSHOT_TOO_OLD", e); return false; }
    } else {
      if (e.u <= b.prevU) { b.duplicates++; this.monitor.emit("DUPLICATE_EVENT", "info", e.symbol, { stream: "depth", u: e.u }); return false; }
      if (e.pu !== b.prevU) { this.resync(x, e.symbol, "SEQUENCE_GAP", e); return false; }
    }
    for (const [p, q] of e.bids) { if (q === 0) b.bids.delete(p); else b.bids.set(p, q); }
    for (const [p, q] of e.asks) { if (q === 0) b.asks.delete(p); else b.asks.set(p, q); }
    b.prevU = e.u; b.lastE = e.E;
    this.trim(b);
    const bb = best(b.bids, "bid"), ba = best(b.asks, "ask");
    if (bb !== null && ba !== null && bb >= ba) { this.resync(x, e.symbol, "CROSSED_BOOK"); return false; }
    if (b.status === "SYNCING") { b.status = "SYNCED"; b.syncedAt = e.receivedAt; this.monitor.emit("BOOK_SYNCED", "info", e.symbol, { lastUpdateId: b.lastUpdateId, u: e.u, resyncs: b.resyncs }, b.corr ?? undefined); b.corr = null; }
    return true;
  }
  private trim(b: Book) {
    const lim = this.th.bookLevels;
    for (const [side, m] of [["bid", b.bids], ["ask", b.asks]] as const) {
      if (m.size <= lim * 1.2) continue;
      const keys = [...m.keys()].sort((p, q) => (side === "bid" ? q - p : p - q));
      for (const k of keys.slice(lim)) m.delete(k);
    }
  }
  needsSnapshot(sym: LiveSymbol): boolean { return this.st(sym).book.status === "AWAITING_SNAPSHOT" || this.st(sym).book.status === "UNSYNCED"; }
  /** REST /fapi/v1/depth body. Applies buffered diffs per the procedure; the book is SYNCED only after a diff bridges it. */
  applySnapshot(sym: LiveSymbol, body: unknown, receivedAt: number): boolean {
    const x = this.st(sym), b = x.book, o = body as { lastUpdateId?: unknown; bids?: unknown; asks?: unknown };
    const id = int(o?.lastUpdateId), bids = levels(o?.bids, 5000), asks = levels(o?.asks, 5000);
    if (id === null || !bids || !asks || !bids.length || !asks.length) { this.monitor.emit("MALFORMED_MESSAGE", "warn", sym, { reason: "malformed depth snapshot" }); return false; }
    if (b.status === "SYNCED" || b.status === "SYNCING") return false;
    const buffered = b.buffer;
    x.book = { ...emptyBook(), status: "SYNCING", lastUpdateId: id, bids: new Map(bids.filter(([, q]) => q > 0)), asks: new Map(asks.filter(([, q]) => q > 0)), resyncs: b.resyncs, gaps: b.gaps, duplicates: b.duplicates, corr: b.corr };
    void receivedAt;
    this.trim(x.book);
    for (const e of buffered) { if (x.book.status === "AWAITING_SNAPSHOT") { x.book.buffer.push(e); continue; } this.process(x, e); }
    return true;
  }

  // ----- REST merges and clock -----
  /** REST klines rows; only candles closed before `now` are merged. Clears the pending gap when contiguous again. */
  mergeKlines(sym: LiveSymbol, iv: LiveInterval, rows: unknown, now: number): number {
    if (!Array.isArray(rows)) return 0;
    const s = this.st(sym).candles[iv], ms = INTERVAL_MS[iv], byT = new Map(s.closed.map((c) => [c.t, c]));
    let added = 0;
    for (const r of rows.slice(0, 1500)) {
      if (!Array.isArray(r)) continue;
      const t = int(r[0]), o = pos(r[1]), h = pos(r[2]), l = pos(r[3]), c = pos(r[4]), v = nonNeg(r[5]), T = int(r[6]);
      if (t === null || o === null || h === null || l === null || c === null || v === null || T === null || T !== t + ms - 1 || T >= now || h < Math.max(o, c, l) || l > Math.min(o, c)) continue;
      if (!byT.has(t)) { byT.set(t, { t, o, h, l, c, v }); added++; }
    }
    s.closed = [...byT.values()].sort((a, b) => a.t - b.t).slice(-this.th.candlesMax);
    const gap = s.closed.findIndex((c, i) => i > 0 && c.t !== s.closed[i - 1]!.t + ms);
    if (gap === -1 && s.pendingFrom !== null) { this.monitor.emit("CANDLE_BACKFILLED", "info", sym, { interval: iv, added }); s.pendingFrom = null; }
    return added;
  }
  setServerTime(serverTime: unknown, sentAt: number, receivedAt: number) {
    const t = int((serverTime as { serverTime?: unknown })?.serverTime);
    if (t === null || receivedAt < sentAt) return;
    const offset = t - (sentAt + receivedAt) / 2, drift = Math.abs(offset) > this.th.maxClockOffsetMs;
    this.clock = { offsetMs: Math.round(offset), rttMs: receivedAt - sentAt, measuredAt: receivedAt, drift };
    if (drift) this.monitor.emit("CLOCK_DRIFT", "warn", null, { offsetMs: Math.round(offset), rttMs: receivedAt - sentAt, maxMs: this.th.maxClockOffsetMs });
  }
  /** Emits STALE_DATA once per transition; call about once per second. */
  checkStale(now: number) {
    for (const sym of this.symbols) {
      const x = this.st(sym);
      for (const k of STREAMS) {
        const r = x.last[k].receivedAt, stale = r === null ? false : now - r > this.th.staleMs[k];
        if (stale && !x.stale[k]) { x.stale[k] = true; this.monitor.emit("STALE_DATA", "warn", sym, { stream: k, ageMs: now - r!, limitMs: this.th.staleMs[k] }); }
      }
    }
  }
  /** Marks every book unsynced (socket closed): no stale book is ever served after a disconnect. */
  invalidateBooks(reason: string) { for (const sym of this.symbols) { const x = this.st(sym); if (x.book.status !== "UNSYNCED") this.resync(x, sym, reason); x.book.status = "UNSYNCED"; } }
  /** Forgets trade continuity after a reconnect: ids skipped while disconnected are a known gap, not new duplicates. */
  markReconnected(kind: SocketKind, at: number) {
    for (const sym of this.symbols) { const x = this.st(sym); if (kind === "market" && x.lastTradeId !== null) x.lastTradeGapAt = at; }
  }

  // ----- views -----
  health(sym: LiveSymbol, now: number): SymbolHealth {
    const x = this.st(sym), reasons: string[] = [];
    const streams = Object.fromEntries(STREAMS.map((k) => {
      const l = x.last[k], age = l.receivedAt === null ? null : now - l.receivedAt;
      return [k, { status: age === null ? "NO_DATA" : age > this.th.staleMs[k] ? "STALE" : "LIVE", ageMs: age, exchangeTs: l.exchangeTs, receivedAt: l.receivedAt }];
    })) as Record<StreamKind, StreamHealth>;
    for (const k of ["depth", "mark", "kline1m", "kline5m", "trade"] as StreamKind[]) if (streams[k].status !== "LIVE") reasons.push(`${k} ${streams[k].status === "NO_DATA" ? "has no data" : `stale (${streams[k].ageMs} ms)`}`);
    if (x.book.status !== "SYNCED") reasons.push(`order book ${x.book.status.toLowerCase().replace("_", " ")}`);
    const gaps = { "1m": x.candles["1m"].pendingFrom, "5m": x.candles["5m"].pendingFrom };
    if (gaps["1m"] !== null || gaps["5m"] !== null) reasons.push("candle gap awaiting backfill");
    const tradeFlowComplete = x.lastTradeGapAt === null || now - x.lastTradeGapAt > this.th.tradeWindowMs;
    if (this.clock.drift) reasons.push(`clock offset ${this.clock.offsetMs} ms`);
    const lat = [...x.latencies].sort((a, b) => a - b), p50 = lat.length ? lat[Math.floor(lat.length / 2)]! : null;
    if (p50 !== null && p50 > this.th.maxStreamLatencyMs) reasons.push(`stream latency ${p50} ms`);
    return { symbol: sym, ready: reasons.length === 0, reasons, book: x.book.status, streams, candleGaps: gaps, tradeFlowComplete, latencyP50Ms: p50,
      counters: { resyncs: x.book.resyncs, gaps: x.book.gaps, bookDuplicates: x.book.duplicates, tradeGaps: x.tradeGaps, tradeDuplicates: x.tradeDuplicates, missingCandles: x.candles["1m"].missing + x.candles["5m"].missing } };
  }
  /** Best bid/ask from the synced local book (preferred) or the book ticker; null when neither is usable. */
  top(sym: LiveSymbol, now: number): TopOfBook | null {
    const x = this.st(sym), b = x.book;
    if (b.status === "SYNCED" && b.lastE !== null && x.last.depth.receivedAt !== null && now - x.last.depth.receivedAt <= this.th.staleMs.depth) {
      const bid = best(b.bids, "bid"), ask = best(b.asks, "ask");
      if (bid !== null && ask !== null) return { bid, bidQty: b.bids.get(bid)!, ask, askQty: b.asks.get(ask)!, source: "book", exchangeTs: b.lastE, receivedAt: x.last.depth.receivedAt };
    }
    const t = x.bbo;
    if (t && now - t.receivedAt <= this.th.staleMs.bbo) return { bid: t.bid, bidQty: t.bidQty, ask: t.ask, askQty: t.askQty, source: "bookTicker", exchangeTs: t.E, receivedAt: t.receivedAt };
    return null;
  }
  /** Top `n` levels of a SYNCED, fresh book (null otherwise): the only depth paper fills may walk. */
  depth(sym: LiveSymbol, now: number, n = 50): { bids: [number, number][]; asks: [number, number][]; exchangeTs: number; receivedAt: number } | null {
    const x = this.st(sym), b = x.book, r = x.last.depth.receivedAt;
    if (b.status !== "SYNCED" || b.lastE === null || r === null || now - r > this.th.staleMs.depth) return null;
    const side = (m: Map<number, number>, d: 1 | -1) => [...m.entries()].sort((p, q) => d * (p[0] - q[0])).slice(0, n);
    return { bids: side(b.bids, -1), asks: side(b.asks, 1), exchangeTs: b.lastE, receivedAt: r };
  }
  trades(sym: LiveSymbol): readonly TradeEvent[] { return this.st(sym).trades; }
  candles(sym: LiveSymbol, iv: LiveInterval): readonly Candle[] { return this.st(sym).candles[iv].closed; }
  openCandle(sym: LiveSymbol, iv: LiveInterval): Candle | null { return this.st(sym).candles[iv].open; }
  mark(sym: LiveSymbol): MarkEvent | null { return this.st(sym).mark; }
  bookSizes(sym: LiveSymbol) { const b = this.st(sym).book; return { bids: b.bids.size, asks: b.asks.size, buffer: b.buffer.length, trades: this.st(sym).trades.length, candles1m: this.st(sym).candles["1m"].closed.length }; }
}
function best(m: Map<number, number>, side: "bid" | "ask"): number | null {
  let r: number | null = null;
  for (const p of m.keys()) if (r === null || (side === "bid" ? p > r : p < r)) r = p;
  return r;
}

// ---------- REST rate governor ----------
/** Keeps public REST use far below Binance's per-IP weight limit and honours 429/418 back-off. */
export class RestGovernor {
  private usedWeight = 0; private minute = -1; backoffUntil = 0; limited = 0;
  constructor(readonly limitPerMinute = 2400, readonly fraction = 0.25) {}
  canSend(path: string, now: number): { ok: true } | { ok: false; reason: string; retryAt: number } {
    const w = REST_WEIGHTS[path]; if (w === undefined) return { ok: false, reason: "path not allowed", retryAt: Infinity };
    if (now < this.backoffUntil) return { ok: false, reason: "rate-limit back-off", retryAt: this.backoffUntil };
    const m = Math.floor(now / 60_000); if (m !== this.minute) { this.minute = m; this.usedWeight = 0; }
    if (this.usedWeight + w > this.limitPerMinute * this.fraction) return { ok: false, reason: "local weight budget used", retryAt: (m + 1) * 60_000 };
    this.usedWeight += w; return { ok: true };
  }
  onResponse(status: number, usedWeightHeader: string | null, retryAfterHeader: string | null, now: number) {
    const used = usedWeightHeader === null ? null : Number(usedWeightHeader);
    if (used !== null && Number.isFinite(used) && used > this.usedWeight) this.usedWeight = used;
    if (status === 429 || status === 418) {
      const ra = Number(retryAfterHeader); this.limited++;
      this.backoffUntil = now + Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, status === 418 ? 300_000 : 60_000);
    }
  }
}
