// Engine B ultrafast market intelligence: exact feature math and fail-closed NO_TRADE guards (constructed inputs).
import { describe, expect, it } from "vitest";
import { bookImbalance, freshness, liquidityChange, markoutBps, microprice, momentumBps, spreadBps, tradeFlow, ultrafastSignal, volatilityBurst, type BookTop, type Trade, type UltrafastConfig } from "@/lib/scalp-microstructure";

const top = (o: Partial<BookTop> = {}): BookTop => ({ t: 1_000, receivedAt: 1_020, bid: 100, bidQty: 30, ask: 100.02, askQty: 10, ...o });
const CFG: UltrafastConfig = { minBookImbalance: 0.3, minFlowImbalance: 0.3, flowWindowMs: 5_000, minMicropriceEdgeBps: 0.2, maxSpreadBps: 3, maxDataAgeMs: 500, maxLatencyMs: 300, maxVolBurst: 5, roundTripCostBps: 12, minExpectedMoveMultiple: 1.5, expectedMoveBps: 20 };
const buys: Trade[] = [{ t: 500, price: 100.01, qty: 3, buyerAggressor: true }, { t: 800, price: 100.02, qty: 1, buyerAggressor: false }];

describe("microstructure features", () => {
  it("spread, microprice and imbalance", () => {
    expect(spreadBps(top())).toBeCloseTo((0.02 / 100.01) * 10_000, 9);
    expect(microprice(top())).toBeCloseTo((100.02 * 30 + 100 * 10) / 40, 9); // leans toward the thin ask
    expect(bookImbalance(top())).toBeCloseTo(0.5, 9);
    expect(bookImbalance(top(), { t: 1, bids: [{ price: 100, qty: 1 }], asks: [{ price: 100.02, qty: 3 }] })).toBeCloseTo(-0.5, 9);
  });
  it("aggressive trade flow uses only trades inside the window and not after now", () => {
    const f = tradeFlow([...buys, { t: 2_000, price: 1, qty: 100, buyerAggressor: false }], 1_000, 5_000);
    expect(f).toEqual({ buyVolume: 3, sellVolume: 1, trades: 2, imbalance: 0.5 });
  });
  it("liquidity change, momentum, volatility burst, freshness and latency", () => {
    expect(liquidityChange({ t: 0, bids: [{ price: 10, qty: 1 }], asks: [{ price: 11, qty: 1 }] }, { t: 1, bids: [{ price: 10, qty: 2 }], asks: [{ price: 11, qty: 0.5 }] })).toEqual({ bidPct: 100, askPct: -50 });
    expect(momentumBps([top({ t: 0, bid: 100, ask: 100 }), top({ t: 1_000, bid: 101, ask: 101 })], 1_000, 1_000)).toBeCloseTo(100, 9);
    expect(volatilityBurst([], 0, 1, 2)).toBeNull();
    expect(freshness(top(), 1_100)).toEqual({ ageMs: 80, latencyMs: 20 });
  });
  it("markout measures adverse selection from later prices only", () => {
    const px = (t: number) => (t < 10 ? 100 : 99.9);
    expect(markoutBps([{ t: 0, side: 1 }], px, 10).meanBps).toBeCloseTo(-10, 9); // long entries picked off by 10 bps
  });
});

describe("ultrafast signal fails closed", () => {
  it("LONG only when book, flow and microprice agree", () => {
    expect(ultrafastSignal(1_100, top(), null, buys, CFG).action).toBe("LONG");
  });
  it("stale book, bad latency, wide spread, missing book → NO_TRADE", () => {
    expect(ultrafastSignal(2_000, top(), null, buys, CFG).reasons[0]).toMatch(/stale/);
    expect(ultrafastSignal(1_600, top({ t: 1_000, receivedAt: 1_500 }), null, buys, CFG).reasons[0]).toMatch(/latency/);
    expect(ultrafastSignal(1_100, top({ ask: 100.1 }), null, buys, CFG).reasons[0]).toMatch(/Spread/);
    expect(ultrafastSignal(1_100, null, null, buys, CFG).action).toBe("NO_TRADE");
  });
  it("NO_TRADE when the measured expected move does not cover costs", () => {
    expect(ultrafastSignal(1_100, top(), null, buys, { ...CFG, expectedMoveBps: 15 }).reasons[0]).toMatch(/does not cover/);
  });
});
