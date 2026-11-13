// Phase 4F workstream E — provenance of the public candles the paper worker may simulate. Pure; no network.
// These checks establish source identity, format, sequence and timing. They do NOT authenticate prices.
import { describe, expect, it } from "vitest";
import { selectClosedCandles, parseKlines, FUTURES_PAPER_DATA_SOURCE, MARKET_DATA_CODES, type RawSymbolBundle } from "@/lib/futures-paper-market-data";

const M = 60_000, T = Math.floor(1_794_000_000_000 / M) * M, NOW = T + 2 * M; // candle T closed at T + M − 1
const row = (t: number, o = 100, h = 101, l = 99, c = 100.5, v = 10, tf = M) => [t, String(o), String(h), String(l), String(c), String(v), t + tf - 1, "x"];
const bundle = (symbol: string, over: Partial<RawSymbolBundle> = {}): RawSymbolBundle => ({ source: FUTURES_PAPER_DATA_SOURCE, symbol, timeframe: "1m", fetchedAt: NOW, trade: [row(T - M), row(T)], mark: [row(T - M), row(T)], index: [row(T)], funding: [], ...over });
const req = { symbols: ["BTCUSDT", "ETHUSDT"], timeframe: "1m" as const, barT: T, now: NOW, closeGraceMs: 2_000, maxFutureSkewMs: 5_000 };
const run = (b: RawSymbolBundle[], r = req) => selectClosedCandles(b, r);
const code = (b: RawSymbolBundle[], r = req) => { const x = run(b, r); return x.ok ? "OK" : x.code; };

describe("closed-candle selection with provenance", () => {
  it("valid closed candles for every symbol → bars + provenance (source, symbol, timeframe, open/close time, fetch time)", () => {
    const x = run([bundle("ETHUSDT"), bundle("BTCUSDT", { funding: [{ fundingTime: T, fundingRate: "0.0001" }, { fundingTime: T + M, fundingRate: "0.0002" }] })]);
    expect(x.ok).toBe(true); if (!x.ok) return;
    expect(x.bars.map((b) => b.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(x.bars[0]).toMatchObject({ t: T, tfMs: M, trade: { o: 100, h: 101, l: 99, c: 100.5, v: 10 }, mark: { o: 100, c: 100.5 }, index: { c: 100.5 }, funding: [{ t: T, rate: 0.0001 }] });
    expect(x.provenance[0]).toMatchObject({ source: "binance-public-usdm", symbol: "BTCUSDT", timeframe: "1m", openTime: T, closeTime: T + M - 1, fetchedAt: NOW, closedAtFetch: true, fundingEvents: 1 });
    expect(x.provenance[0]!.verification).toMatch(/NOT independently verified/);
  });
  it("source, symbol and timeframe identity", () => {
    expect(code([bundle("BTCUSDT", { source: "some-other-feed" }), bundle("ETHUSDT")])).toBe("SOURCE_MISMATCH");
    expect(code([bundle("BTCUSDT"), bundle("SOLUSDT")])).toBe("SYMBOL_SET_MISMATCH");
    expect(code([bundle("BTCUSDT")])).toBe("SYMBOL_SET_MISMATCH");
    expect(code([bundle("BTCUSDT", { timeframe: "5m" }), bundle("ETHUSDT")])).toBe("TIMEFRAME_MISMATCH");
    expect(code([bundle("BTCUSDT"), bundle("ETHUSDT")], { ...req, barT: T + 1 })).toBe("TIMEFRAME_MISMATCH");
  });
  it("open/close timestamps: misaligned open, wrong close time", () => {
    expect(code([bundle("BTCUSDT", { trade: [row(T + 1)] }), bundle("ETHUSDT")])).toBe("CANDLE_MISALIGNED");
    const r = row(T); r[6] = T + M; // close time must be open + timeframe − 1
    expect(code([bundle("BTCUSDT", { trade: [r] }), bundle("ETHUSDT")])).toBe("CLOSE_TIME_MISMATCH");
  });
  it("closed-candle requirement: not closed at fetch, or not closed yet now (grace)", () => {
    expect(code([bundle("BTCUSDT", { fetchedAt: T + 30_000 }), bundle("ETHUSDT")])).toBe("CANDLE_NOT_CLOSED");
    expect(code([bundle("BTCUSDT", { fetchedAt: T + M + 500 }), bundle("ETHUSDT", { fetchedAt: T + M + 500 })], { ...req, now: T + M + 500 })).toBe("CANDLE_NOT_CLOSED");
  });
  it("duplicates and sequence: identical duplicates are dropped, conflicting ones and out-of-order rows refuse", () => {
    const x = run([bundle("BTCUSDT", { trade: [row(T - M), row(T), row(T)] }), bundle("ETHUSDT")]);
    expect(x.ok && x.provenance[0]!.dedupedRows).toBe(1);
    expect(code([bundle("BTCUSDT", { trade: [row(T), row(T, 100, 101, 99, 100.6)] }), bundle("ETHUSDT")])).toBe("CANDLE_DUPLICATE_CONFLICT");
    expect(code([bundle("BTCUSDT", { trade: [row(T), row(T - M)] }), bundle("ETHUSDT")])).toBe("CANDLE_OUT_OF_SEQUENCE");
    expect(code([bundle("BTCUSDT", { funding: [{ fundingTime: T, fundingRate: "0.0001" }, { fundingTime: T, fundingRate: "0.0003" }] }), bundle("ETHUSDT")])).toBe("FUNDING_INVALID");
  });
  it("stale and future timestamps", () => {
    expect(code([bundle("BTCUSDT", { trade: [row(T - 2 * M), row(T - M)] }), bundle("ETHUSDT")])).toBe("CANDLE_STALE_FEED"); // feed behind
    expect(code([bundle("BTCUSDT", { trade: [row(T), row(T + 10 * M)] }), bundle("ETHUSDT")])).toBe("CANDLE_FUTURE");
    expect(code([bundle("BTCUSDT", { fetchedAt: NOW + 60_000 }), bundle("ETHUSDT")])).toBe("FETCH_TIME_INVALID");
  });
  it("gaps and missing series: a hole at the requested candle, no mark; a missing index is allowed (entries are then refused)", () => {
    expect(code([bundle("BTCUSDT", { trade: [row(T - M), row(T + M)] }), bundle("ETHUSDT")], { ...req, now: T + 3 * M })).toBe("CANDLE_MISSING");
    expect(code([bundle("BTCUSDT", { mark: [row(T - M)] }), bundle("ETHUSDT")])).toBe("MARK_MISSING");
    const x = run([bundle("BTCUSDT", { index: [] }), bundle("ETHUSDT")]);
    expect(x.ok && x.bars[0]!.index).toBeNull(); expect(x.ok && x.provenance[0]!.series.index).toBe(false);
  });
  it("malformed rows: wrong shape, non-numeric, non-positive, inconsistent OHLC, bad funding", () => {
    for (const bad of [[[T, "100"]], [[T, "abc", "101", "99", "100", "1", T + M - 1]], [[T, "0", "101", "99", "100", "1", T + M - 1]], [[T, "100", "99", "98", "100", "1", T + M - 1]], [[T, "100", "101", "99", "100", "-1", T + M - 1]]]) {
      expect(code([bundle("BTCUSDT", { trade: bad }), bundle("ETHUSDT")])).toBe("CANDLE_MALFORMED");
    }
    expect(code([bundle("BTCUSDT", { funding: [{ fundingTime: T, fundingRate: "0.9" }] }), bundle("ETHUSDT")])).toBe("FUNDING_INVALID");
    expect(code([bundle("BTCUSDT", { funding: [{ fundingTime: "x", fundingRate: "0.0001" }] }), bundle("ETHUSDT")])).toBe("FUNDING_INVALID");
    expect(parseKlines("nope" as never, M, "t").ok).toBe(false);
  });
  it("every code is bounded and listed", () => { expect(new Set(MARKET_DATA_CODES).size).toBe(MARKET_DATA_CODES.length); });
});
