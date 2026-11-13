// Phase 4G workstream E — candle provenance records (pure). Source, symbol/timeframe, open/close times, closed-candle
// confirmation, sequence/gap detection (inherited), payload hash and stale/future fetch refusal. Prices are never
// marked independently verified.
import { describe, expect, it } from "vitest";
import { buildCandleProvenance, canonicalJson, sha256Hex } from "@/lib/futures-paper-market-provenance";
import { rawBundle } from "./helpers/fp-v3-harness";

const M = 60_000, T = 1_794_000_000_000 - (1_794_000_000_000 % M), NOW = T + M + 3_000;
const b = (sym: string, over: Partial<ReturnType<typeof rawBundle>> = {}) => ({ ...rawBundle(sym, T, M, { trade: [100, 101, 99, 100.5] }, T + M + 500), ...over });
const req = { symbols: ["BTCUSDT", "ETHUSDT"], timeframe: "1m" as const, barT: T, now: NOW };

describe("provenance records", () => {
  it("one record per symbol with exact source, timeframe, open/close times, fetch time and a SHA-256 of the raw payload; never 'verified'", async () => {
    const r = await buildCandleProvenance([b("ETHUSDT"), b("BTCUSDT")], req);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.records.map((x) => x.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const x of r.records) {
      expect(x).toMatchObject({ source: "binance-public-usdm", timeframe: "1m", open_t: T, close_t: T + M - 1, fetched_at: T + M + 500, independently_verified: false });
      expect(x.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(r.records[0]!.raw_sha256).toBe(await sha256Hex(canonicalJson(b("BTCUSDT"))));
  });
  it("the payload hash ignores key order but changes with any value", async () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    const h = async (x: unknown) => sha256Hex(canonicalJson(x));
    const base = b("BTCUSDT"), moved = { ...base, trade: [[...(base.trade[0] as unknown[]).slice(0, 4), "100.50000001", ...(base.trade[0] as unknown[]).slice(5)]] };
    expect(await h(base)).not.toBe(await h(moved));
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
  it.each([
    ["stale fetch (older than the window)", [b("BTCUSDT", { fetchedAt: NOW - 200_000 }), b("ETHUSDT")], { now: NOW }, "CANDLE_NOT_CLOSED"],
    ["stale fetch after the close", [b("BTCUSDT"), b("ETHUSDT")], { now: T + M + 500 + 130_000 }, "PROVENANCE_FETCH_STALE"],
    ["future fetch", [b("BTCUSDT", { fetchedAt: NOW + 60_000 }), b("ETHUSDT")], {}, "FETCH_TIME_INVALID"],
    ["candle not closed at fetch", [b("BTCUSDT", { fetchedAt: T + M - 10 }), b("ETHUSDT")], {}, "CANDLE_NOT_CLOSED"],
    ["wrong source", [b("BTCUSDT", { source: "paid-feed" }), b("ETHUSDT")], {}, "SOURCE_MISMATCH"],
    ["wrong timeframe", [b("BTCUSDT", { timeframe: "5m" }), b("ETHUSDT")], {}, "TIMEFRAME_MISMATCH"],
    ["missing symbol", [b("BTCUSDT")], {}, "SYMBOL_SET_MISMATCH"],
    ["gap (no candle at the requested time)", [b("BTCUSDT", { trade: [[T + M, "1", "1", "1", "1", "1", T + 2 * M - 1]] }), b("ETHUSDT")], { now: T + 3 * M }, "CANDLE_MISSING"],
    ["malformed row", [b("BTCUSDT", { trade: [["x"]] }), b("ETHUSDT")], {}, "CANDLE_MALFORMED"],
  ])("%s → refused", async (_why, bundles, over, code) => {
    const r = await buildCandleProvenance(bundles as never, { ...req, ...over });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe(code);
  });
});
