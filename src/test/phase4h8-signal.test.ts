// Phase 4H.8 — live scalping signal pipeline: deterministic synthetic markets plus the recorded public data.
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/indicators";
import { FeedEngine, LIVE_SYMBOLS, type SymbolHealth } from "@/lib/live-feed";
import { evaluateLiveSignal, PROPOSED_SIGNAL_CONFIG, snapshotFor, type SignalInput } from "@/lib/live-scalp-signal";
import { recorded, replay } from "./helpers/recorded-usdm";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % 300_000) + 2_000; // 2 s after a 5m (and 1m) close
const health = (over: Partial<SymbolHealth> = {}): SymbolHealth => ({ symbol: "BTCUSDT", ready: true, reasons: [], book: "SYNCED", streams: {} as never, candleGaps: { "1m": null, "5m": null }, tradeFlowComplete: true, latencyP50Ms: 100, counters: { resyncs: 0, gaps: 0, bookDuplicates: 0, tradeGaps: 0, tradeDuplicates: 0, missingCandles: 0 }, ...over });
function series(dir: 1 | -1, n: number, ms: number, end: number, step = 0.0008): Candle[] {
  const out: Candle[] = []; let p = 100;
  for (let i = 0; i < n; i++) { const o = p; p = p * (1 + dir * (i % 3 === 2 ? -1.5 * step : step)); /* RSI ≈ 57: inside the band */ out.push({ t: end - (n - i) * ms, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 100 }); }
  return out;
}
function market(dir: 1 | -1, o: { spread?: number; levelQty?: number; flow?: boolean; fundingAt?: number } = {}): SignalInput {
  const c1 = series(dir, 80, 60_000, NOW - 2_000), c5 = series(dir, 40, 300_000, NOW - 2_000, 0.003), last = c1.at(-1)!.c;
  const sp = o.spread ?? 0.0001, bid = last * (1 - sp / 2), ask = last * (1 + sp / 2), q = o.levelQty ?? 5_000;
  const heavy = (k: number) => q * (dir === 1 ? 3 : 1) * (1 + k / 10), light = (k: number) => q * (dir === 1 ? 1 : 3) * (1 + k / 10);
  const bids = Array.from({ length: 20 }, (_, k) => [bid * (1 - k * 0.0001), heavy(k)] as [number, number]), asks = Array.from({ length: 20 }, (_, k) => [ask * (1 + k * 0.0001), light(k)] as [number, number]);
  const trades = Array.from({ length: 40 }, (_, k) => ({ kind: "trade" as const, symbol: "BTCUSDT" as const, id: k + 1, price: last, qty: 1, t: NOW - 20_000 + k * 400, E: NOW - 20_000 + k * 400, buyerAggressor: (o.flow ?? true) ? dir === 1 : dir !== 1, receivedAt: NOW - 20_000 + k * 400 }));
  return { symbol: "BTCUSDT", now: NOW, candles1m: c1, candles5m: c5, top: { bid, bidQty: bids[0]![1], ask, askQty: asks[0]![1], source: "book", exchangeTs: NOW - 100, receivedAt: NOW - 50 }, depth: { bids, asks }, trades,
    mark: { kind: "mark", symbol: "BTCUSDT", markPrice: last, indexPrice: last, fundingRate: 0.0001, nextFundingTime: o.fundingAt ?? NOW + 3 * 3_600_000, E: NOW - 200, receivedAt: NOW - 150 }, health: health() };
}

describe("live signal: directions and required fields", () => {
  it("LONG with every required field; references from the executable side; no size or leverage", () => {
    const s = evaluateLiveSignal(market(1));
    expect(s.action).toBe("LONG");
    expect(s).toMatchObject({ strategyId: "futures-scalp-live", strategyVersion: "live-scalp-v1", featureVersion: "live-scalp-features-v1", validation: "UNVALIDATED", decidedAt: NOW, expiresAt: NOW + PROPOSED_SIGNAL_CONFIG.signalTtlMs });
    expect(s.entryReference).toBeCloseTo(market(1).top!.ask, 8);
    expect(s.stopReference!).toBeLessThan(s.entryReference!); expect(s.takeProfitReference!).toBeGreaterThan(s.entryReference!);
    expect(s.costs!.feePctRoundTrip).toBe(0.1); expect(s.costs!.spreadPct).toBeGreaterThan(0); expect(s.costs!.slippagePctRoundTrip.long).not.toBeNull();
    expect(Object.keys(s.features)).toEqual(expect.arrayContaining(["emaFast", "emaSlow", "vwap", "rsi", "atr", "momentumBps", "trend5m", "spreadBps", "bookImbalance10", "microprice", "flowImbalance", "volBurst", "fundingRate"]));
    expect(s.freshness).toMatchObject({ ready: true, bookSource: "book" });
    expect(s.reasons.length).toBeGreaterThan(0); expect(s.rejections).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/"(qty|quantity|leverage|notional|authorized)"/i);
  });
  it("SHORT mirrors it", () => {
    const s = evaluateLiveSignal(market(-1));
    expect(s.action).toBe("SHORT"); expect(s.entryReference).toBeCloseTo(market(-1).top!.bid, 8); expect(s.stopReference!).toBeGreaterThan(s.entryReference!);
  });
  it("confidence is an uncalibrated agreement share, never called a probability", () => {
    const s = evaluateLiveSignal(market(1));
    expect(s.confidence.calibration).toBe("UNCALIBRATED");
    expect(s.confidence.label).toMatch(/not a probability/);
    expect(s.confidence.score).toBe(s.confidence.agreeing / s.confidence.total);
  });
  it("deterministic: the same snapshot gives the same signal and id", () => {
    expect(evaluateLiveSignal(market(1))).toEqual(evaluateLiveSignal(market(1)));
    expect(evaluateLiveSignal(market(1)).id).toBe(`futures-scalp-live:live-scalp-v1:BTCUSDT:${market(1).candles1m.at(-1)!.t}`);
  });
  it("funding is costed only when the expected hold crosses the next funding time", () => {
    expect(evaluateLiveSignal(market(1)).costs!.fundingPct.long).toBe(0);
    const s = evaluateLiveSignal(market(1, { fundingAt: NOW + 60_000 }));
    expect(s.costs!.fundingPct).toEqual({ long: 0.01, short: -0.01 });
  });
});

describe("INSUFFICIENT_DATA instead of guessing", () => {
  const cases: [string, (m: SignalInput) => SignalInput, RegExp][] = [
    ["feed not ready", (m) => ({ ...m, health: health({ ready: false, reasons: ["depth stale (4000 ms)"] }) }), /depth stale/],
    ["no synced depth", (m) => ({ ...m, depth: null }), /order book/],
    ["no best bid/ask", (m) => ({ ...m, top: null }), /best bid\/ask/],
    ["no mark price", (m) => ({ ...m, mark: null }), /mark price/],
    ["too little 1m history", (m) => ({ ...m, candles1m: m.candles1m.slice(-10) }), /closed 1m candles/],
    ["too little 5m history", (m) => ({ ...m, candles5m: m.candles5m.slice(-5) }), /closed 5m candles/],
    ["a gap in the 1m history", (m) => ({ ...m, candles1m: [...m.candles1m.slice(0, 40), ...m.candles1m.slice(41)] }), /gap/],
    ["latest candle too old", (m) => ({ ...m, now: m.now + 120_000 }), /old/],
    ["trade-id gap inside the flow window", (m) => ({ ...m, health: health({ tradeFlowComplete: false }) }), /trade-id gap/],
  ];
  for (const [name, f, re] of cases) it(name, () => { const s = evaluateLiveSignal(f(market(1))); expect(s.action).toBe("INSUFFICIENT_DATA"); expect(s.rejections.join(" ")).toMatch(re); expect(s.entryReference).toBeNull(); });
});

describe("NO_TRADE with reasons", () => {
  it("estimated costs larger than the target allowance", () => { const s = evaluateLiveSignal(market(1), { ...PROPOSED_SIGNAL_CONFIG, takerFeePct: 0.5 }); expect(s.action).toBe("NO_TRADE"); expect(s.rejections.join()).toMatch(/does not cover/); });
  it("spread too wide", () => { const s = evaluateLiveSignal(market(1, { spread: 0.001 })); expect(s.action).toBe("NO_TRADE"); expect(s.rejections.join()).toMatch(/spread/); });
  it("thin book", () => { const s = evaluateLiveSignal(market(1, { levelQty: 10 })); expect(s.action).toBe("NO_TRADE"); expect(s.rejections.join()).toMatch(/thin book/); });
  it("trend without order-flow confirmation", () => { const s = evaluateLiveSignal({ ...market(1, { flow: false }), depth: { ...market(-1).depth! }, top: { ...market(1).top!, bidQty: 1, askQty: 100 } }); expect(s.action).toBe("NO_TRADE"); expect(s.rejections.join()).toMatch(/not aligned/); });
});

describe("recorded public data", () => {
  it("real BTCUSDT/ETHUSDT snapshots produce a well-formed signal (any action) with real features and freshness", () => {
    const f = recorded(), { engine, last } = replay();
    for (const s of LIVE_SYMBOLS) { engine.mergeKlines(s, "1m", f.rest[s].klines1m, last + 120_000); engine.mergeKlines(s, "5m", f.rest[s].klines5m, last + 600_000); }
    const now = Math.min(last, ...LIVE_SYMBOLS.map((s) => engine.candles(s, "1m").at(-1)!.t + 60_000 + 30_000));
    for (const s of LIVE_SYMBOLS) {
      const sig = evaluateLiveSignal(snapshotFor(engine, s, now));
      expect(["LONG", "SHORT", "NO_TRADE", "INSUFFICIENT_DATA"]).toContain(sig.action);
      expect(sig.symbol).toBe(s);
      if (sig.action === "INSUFFICIENT_DATA") expect(sig.rejections.length).toBeGreaterThan(0);
      else { expect(sig.features["markPrice"]).toBe(engine.mark(s)!.markPrice); expect(sig.costs).not.toBeNull(); }
      expect(evaluateLiveSignal(snapshotFor(engine, s, now))).toEqual(sig);
    }
  });
  it("a fresh engine with no data is INSUFFICIENT_DATA for both symbols", () => {
    const e = new FeedEngine(LIVE_SYMBOLS);
    for (const s of LIVE_SYMBOLS) expect(evaluateLiveSignal(snapshotFor(e, s, Date.now())).action).toBe("INSUFFICIENT_DATA");
  });
});
