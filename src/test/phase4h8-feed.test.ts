// Phase 4H.8 — market-data core on RECORDED public Binance USD-M data (BTCUSDT, ETHUSDT) plus targeted fault injection.
import { describe, expect, it } from "vitest";
import { FeedEngine, LIVE_SYMBOLS, parseMessage, restUrl, RestGovernor, socketUrl, streamNames } from "@/lib/live-feed";
import { recorded, replay } from "./helpers/recorded-usdm";

const depthMsg = (sym: string, U: number, u: number, pu: number, bids: [string, string][] = [], asks: [string, string][] = [], E = 1_000) =>
  JSON.stringify({ stream: `${sym.toLowerCase()}@depth@100ms`, data: { e: "depthUpdate", E, T: E, s: sym, U, u, pu, b: bids, a: asks } });
const trade = (sym: string, a: number, p = "100", r = 0) => JSON.stringify({ stream: `${sym.toLowerCase()}@aggTrade`, data: { e: "aggTrade", E: 1000 + r, a, s: sym, p, q: "1", T: 1000 + r, m: false } });
const kline = (sym: string, t: number, x: boolean, iv = "1m") => JSON.stringify({ stream: `${sym.toLowerCase()}@kline_${iv}`, data: { e: "kline", E: t + 1, s: sym, k: { t, T: t + (iv === "1m" ? 60_000 : 300_000) - 1, s: sym, i: iv, o: "10", h: "11", l: "9", c: "10.5", v: "3", n: 5, x } } });
const snap = { lastUpdateId: 100, bids: [["99", "2"], ["98", "1"]], asks: [["101", "2"], ["102", "1"]] };

describe("recorded real data", () => {
  it("every recorded message parses; nothing is refused", () => {
    const f = recorded(); let bad = 0;
    for (const m of f.messages) if (!parseMessage(JSON.stringify(m.d), m.r).ok) bad++;
    expect(f.messages.length).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });
  it("both books synchronise from the recorded snapshots and stay gap-free; the local best bid/ask equals Binance's book ticker", () => {
    const { engine, last } = replay(), f = recorded();
    for (const s of LIVE_SYMBOLS) {
      const h = engine.health(s, last);
      expect(h.book).toBe("SYNCED");
      expect(h.counters).toMatchObject({ resyncs: 0, gaps: 0, tradeGaps: 0 });
      const top = engine.top(s, last)!, bt = f.messages.filter((m) => m.d.stream === `${s.toLowerCase()}@bookTicker`).at(-1)!.d.data;
      expect(top.source).toBe("book");
      // book ticker is thinned in the fixture; the final local book is within one tick of the last recorded ticker
      expect(Math.abs(top.bid - Number(bt["b"]))).toBeLessThanOrEqual(Number(bt["b"]) * 0.0005);
      expect(top.bid).toBeLessThan(top.ask);
    }
  });
  it("aggregate-trade ids in the recording are contiguous (no false gaps) and trade flow is complete", () => {
    const { engine, last } = replay();
    for (const s of LIVE_SYMBOLS) { const h = engine.health(s, last); expect(h.counters.tradeGaps).toBe(0); expect(h.tradeFlowComplete).toBe(true); expect(engine.trades(s).length).toBeGreaterThan(10); }
  });
  it("a removed depth message in the recording is detected as a sequence gap and the book is cleared until a new snapshot", () => {
    let dropped = false;
    const { engine, last } = replay(undefined, { mutate: (m) => { if (!dropped && m.d.stream === "btcusdt@depth@100ms" && m.r > recorded().snapshots.BTCUSDT.r + 3000) { dropped = true; return null; } return m.d; } });
    const h = engine.health("BTCUSDT", last);
    expect(dropped).toBe(true);
    expect(h.counters.gaps).toBe(1);
    expect(h.book).toBe("AWAITING_SNAPSHOT");
    expect(engine.depth("BTCUSDT", last)).toBeNull();
    expect(engine.monitor.events.some((e) => e.type === "SEQUENCE_GAP" && e.symbol === "BTCUSDT")).toBe(true);
    expect(engine.health("ETHUSDT", last).book).toBe("SYNCED");
  });
  it("a replayed (duplicated) depth message is ignored, not applied twice", () => {
    let dup = 0;
    const f = recorded(), e = new FeedEngine(LIVE_SYMBOLS);
    replay(e, { until: f.snapshots.BTCUSDT.r + 4000 });
    const m = f.messages.filter((x) => x.d.stream === "btcusdt@depth@100ms" && x.r <= f.snapshots.BTCUSDT.r + 4000).at(-1)!;
    const before = e.depth("BTCUSDT", m.r);
    e.ingest(JSON.stringify(m.d), m.r); dup = e.health("BTCUSDT", m.r).counters.bookDuplicates;
    expect(dup).toBe(1);
    expect(e.depth("BTCUSDT", m.r)).toEqual(before);
  });
  it("REST klines from the recording merge as closed candles only, sorted, de-duplicated", () => {
    const f = recorded(), e = new FeedEngine(["BTCUSDT"]);
    const n = e.mergeKlines("BTCUSDT", "1m", f.rest.BTCUSDT.klines1m, f.messages.at(-1)!.r);
    const cs = e.candles("BTCUSDT", "1m");
    expect(n).toBe(cs.length);
    expect(cs.length).toBeGreaterThanOrEqual(198);
    expect(cs.every((c, i) => i === 0 || c.t === cs[i - 1]!.t + 60_000)).toBe(true);
    expect(cs.at(-1)!.t + 60_000).toBeLessThanOrEqual(f.messages.at(-1)!.r); // the still-open candle was excluded
    expect(e.mergeKlines("BTCUSDT", "1m", f.rest.BTCUSDT.klines1m, f.messages.at(-1)!.r)).toBe(0);
  });
});

describe("parser refuses instead of substituting", () => {
  const cases: [string, unknown][] = [
    ["not JSON", "{"], ["wrong symbol", JSON.stringify({ stream: "solusdt@aggTrade", data: { e: "aggTrade", E: 1, s: "SOLUSDT", a: 1, p: "1", q: "1", T: 1, m: true } })],
    ["stream/payload symbol mismatch", JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: 1, s: "ETHUSDT", a: 1, p: "1", q: "1", T: 1, m: true } })],
    ["zero price trade", JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: 1, s: "BTCUSDT", a: 1, p: "0", q: "1", T: 1, m: true } })],
    ["NaN depth level", JSON.stringify({ stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", E: 1, T: 1, s: "BTCUSDT", U: 1, u: 2, pu: 0, b: [["x", "1"]], a: [] } })],
    ["crossed book ticker", JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", u: 1, s: "BTCUSDT", b: "101", B: "1", a: "100", A: "1", T: 1, E: 1 } })],
    ["kline with high below close", JSON.stringify({ stream: "btcusdt@kline_1m", data: { e: "kline", E: 1, s: "BTCUSDT", k: { t: 60_000, T: 119_999, s: "BTCUSDT", i: "1m", o: "10", h: "10", l: "9", c: "11", v: "1", n: 1, x: true } } })],
    ["funding rate out of range", JSON.stringify({ stream: "btcusdt@markPrice@1s", data: { e: "markPriceUpdate", E: 1, s: "BTCUSDT", p: "1", i: "1", r: "0.9", T: 1 } })],
    ["no event time", JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", s: "BTCUSDT", a: 1, p: "1", q: "1", T: 1, m: true } })],
  ];
  for (const [name, raw] of cases) it(name, () => {
    const e = new FeedEngine(["BTCUSDT"]);
    expect(e.ingest(raw, 1)).toBeNull();
    expect(e.counts.malformed).toBe(1);
    expect(e.monitor.counts["MALFORMED_MESSAGE"]).toBe(1);
  });
});

describe("order-book procedure", () => {
  const synced = () => { const e = new FeedEngine(["BTCUSDT"]); e.ingest(depthMsg("BTCUSDT", 95, 105, 94, [["99", "3"]]), 10); expect(e.applySnapshot("BTCUSDT", snap, 11)).toBe(true); return e; };
  it("buffers diffs, applies the snapshot, and is SYNCED only after a diff bridging lastUpdateId", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    expect(e.needsSnapshot("BTCUSDT")).toBe(true);
    e.ingest(depthMsg("BTCUSDT", 80, 90, 79), 5); // older than the snapshot: dropped
    e.applySnapshot("BTCUSDT", snap, 6);
    expect(e.health("BTCUSDT", 6).book).toBe("SYNCING");
    e.ingest(depthMsg("BTCUSDT", 95, 105, 90, [["99", "5"]]), 7);
    expect(e.health("BTCUSDT", 7).book).toBe("SYNCED");
    expect(e.depth("BTCUSDT", 7)!.bids[0]).toEqual([99, 5]);
  });
  it("a snapshot older than the buffered stream forces another snapshot", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    e.ingest(depthMsg("BTCUSDT", 150, 160, 149), 5);
    e.applySnapshot("BTCUSDT", snap, 6);
    expect(e.health("BTCUSDT", 6).book).toBe("AWAITING_SNAPSHOT");
    expect(e.monitor.events.some((x) => x.type === "BOOK_RESYNC" && x.detail["reason"] === "SNAPSHOT_TOO_OLD")).toBe(true);
  });
  it("pu ≠ previous u is a gap; a zero quantity removes a level; a crossed result resyncs", () => {
    const e = synced();
    e.ingest(depthMsg("BTCUSDT", 106, 110, 105, [["99", "0"]]), 12);
    expect(e.depth("BTCUSDT", 12)!.bids[0]).toEqual([98, 1]);
    e.ingest(depthMsg("BTCUSDT", 115, 120, 111), 13);
    expect(e.health("BTCUSDT", 13).counters.gaps).toBe(1);
    const c = synced();
    c.ingest(depthMsg("BTCUSDT", 106, 110, 105, [["105", "1"]]), 12);
    expect(c.health("BTCUSDT", 12).book).toBe("AWAITING_SNAPSHOT");
    expect(c.monitor.events.some((x) => x.detail["reason"] === "CROSSED_BOOK")).toBe(true);
  });
  it("a disconnect invalidates the book: no depth is served until resynced", () => {
    const e = synced();
    e.invalidateBooks("SOCKET_CLOSED");
    expect(e.depth("BTCUSDT", 12)).toBeNull();
    expect(e.needsSnapshot("BTCUSDT")).toBe(true);
  });
  it("buffer and book sizes are bounded", () => {
    const e = new FeedEngine(["BTCUSDT"], { thresholds: { bufferMax: 50, bookLevels: 100 } });
    for (let i = 0; i < 500; i++) e.ingest(depthMsg("BTCUSDT", i * 2 + 1, i * 2 + 2, i * 2), i);
    expect(e.bookSizes("BTCUSDT").buffer).toBe(50);
    expect(e.monitor.counts["BUFFER_OVERFLOW"]).toBe(1);
    const big = { lastUpdateId: 2000, bids: Array.from({ length: 1000 }, (_, i) => [String(1000 - i), "1"]), asks: Array.from({ length: 1000 }, (_, i) => [String(2000 + i), "1"]) };
    const b = new FeedEngine(["BTCUSDT"], { thresholds: { bookLevels: 100 } });
    b.ingest(depthMsg("BTCUSDT", 1990, 2001, 1989), 1); b.applySnapshot("BTCUSDT", big, 2);
    expect(b.bookSizes("BTCUSDT").bids).toBeLessThanOrEqual(100);
  });
});

describe("trades, candles, marks, staleness, clock and rate limits", () => {
  it("duplicate trade ids are ignored; a skipped id range is reported and marks trade flow incomplete", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    e.ingest(trade("BTCUSDT", 10), 1000); e.ingest(trade("BTCUSDT", 10), 1001); e.ingest(trade("BTCUSDT", 14), 1002);
    const h = e.health("BTCUSDT", 1003);
    expect(h.counters.tradeDuplicates).toBe(1); expect(h.counters.tradeGaps).toBe(1); expect(h.tradeFlowComplete).toBe(false);
    expect(e.monitor.events.find((x) => x.type === "TRADE_ID_GAP")!.detail["missing"]).toBe(3);
    expect(e.health("BTCUSDT", 1002 + 120_001).tradeFlowComplete).toBe(true);
  });
  it("a missing closed candle is detected and cleared only by a REST backfill", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    e.ingest(kline("BTCUSDT", 60_000, true), 1); e.ingest(kline("BTCUSDT", 180_000, true), 2);
    expect(e.health("BTCUSDT", 3).candleGaps["1m"]).toBe(120_000);
    expect(e.monitor.events.find((x) => x.type === "MISSING_CANDLE")!.detail["count"]).toBe(1);
    e.mergeKlines("BTCUSDT", "1m", [[120_000, "10", "11", "9", "10", "1", 179_999]], 500_000);
    expect(e.health("BTCUSDT", 3).candleGaps["1m"]).toBeNull();
    expect(e.candles("BTCUSDT", "1m").map((c) => c.t)).toEqual([60_000, 120_000, 180_000]);
  });
  it("stale streams are flagged once per transition and recover on the next message", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    e.ingest(trade("BTCUSDT", 1), 1_000);
    e.checkStale(20_000); e.checkStale(21_000);
    expect(e.monitor.counts["STALE_DATA"]).toBe(1);
    expect(e.health("BTCUSDT", 20_000).streams.trade.status).toBe("STALE");
    e.ingest(trade("BTCUSDT", 2), 21_500);
    expect(e.monitor.counts["FEED_RECOVERED"]).toBe(1);
    expect(e.health("BTCUSDT", 21_600).streams.trade.status).toBe("LIVE");
  });
  it("a stream that never sends (the silent legacy path) keeps the symbol not ready", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    const h = e.health("BTCUSDT", 10_000);
    expect(h.ready).toBe(false);
    expect(h.reasons).toEqual(expect.arrayContaining(["mark has no data", "kline1m has no data", "trade has no data"]));
  });
  it("clock drift beyond the limit is reported from the server-time midpoint", () => {
    const e = new FeedEngine(["BTCUSDT"]);
    e.setServerTime({ serverTime: 10_100 }, 10_000, 10_200); expect(e.clock).toMatchObject({ offsetMs: 0, drift: false });
    e.setServerTime({ serverTime: 15_000 }, 10_000, 10_200); expect(e.clock.drift).toBe(true);
    expect(e.health("BTCUSDT", 1).reasons.some((r) => r.startsWith("clock offset"))).toBe(true);
  });
  it("rate governor: local weight budget, 429 Retry-After and 418 ban back-off", () => {
    const g = new RestGovernor(2400, 0.25);
    let ok = 0; for (let i = 0; i < 40; i++) if (g.canSend("/fapi/v1/depth", 1_000).ok) ok++;
    expect(ok).toBe(30); // 600 weight budget / 20
    g.onResponse(429, "2390", "7", 2_000);
    expect(g.canSend("/fapi/v1/time", 30_000)).toMatchObject({ ok: false, reason: "rate-limit back-off" });
    g.onResponse(418, null, null, 70_000);
    expect(g.backoffUntil).toBe(370_000);
    expect(g.canSend("/fapi/v1/order", 1e9).ok).toBe(false);
  });
  it("only allowlisted public hosts, paths, parameters and symbols can be addressed", () => {
    expect(socketUrl("market", ["BTCUSDT"])).toBe("wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@kline_1m/btcusdt@kline_5m");
    expect(socketUrl("public", ["ETHUSDT"])).toBe("wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms/ethusdt@bookTicker");
    expect(streamNames("public", ["BTCUSDT"])).toHaveLength(2);
    expect(() => socketUrl("market", ["SOLUSDT" as never])).toThrow();
    expect(() => restUrl("/fapi/v1/order", { symbol: "BTCUSDT" })).toThrow(/not allowed/);
    expect(() => restUrl("/fapi/v1/depth", { symbol: "BTCUSDT", signature: "x" })).toThrow(/parameter/);
    expect(() => restUrl("/fapi/v1/depth", { symbol: "DOGEUSDT" })).toThrow(/symbol/);
    expect(restUrl("/fapi/v1/depth", { symbol: "BTCUSDT", limit: 1000 })).toBe("https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000");
  });
});
