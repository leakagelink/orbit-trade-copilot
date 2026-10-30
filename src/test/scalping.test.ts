import { describe, expect, it } from "vitest";
import { canOpen } from "@/lib/plans";
import { WALLET_ROUND_TRIP_PCT, scalpBracket, scalpExit, scalpStats, scalpTemplates, validateScalp } from "@/lib/scalping";
import { validateStrategy } from "@/lib/strategy";

describe("scalping access", () => {
  it("is Pro-only", () => {
    expect(canOpen("/scalping", false)).toBe(false);
    expect(canOpen("/scalping", true)).toBe(true);
  });
});

describe("scalp settings", () => {
  it("demo-wallet round trip costs 0.3% (0.1% fee + 0.05% slippage, both sides)", () => {
    expect(WALLET_ROUND_TRIP_PCT).toBeCloseTo(0.3, 9);
  });
  it("rejects a demo-wallet target that cannot beat fees", () => {
    expect(validateScalp({ tpPct: 0.3, slPct: 0.2, holdMin: 5 }, true)).toMatch(/above 0.30%/);
    expect(validateScalp({ tpPct: 0.3, slPct: 0.2, holdMin: 5 }, false)).toBeNull();
  });
  it("limits stop/target to 0.05–5% and the time limit to 1–240 minutes", () => {
    expect(validateScalp({ tpPct: 6, slPct: 0.2, holdMin: 5 }, false)).not.toBeNull();
    expect(validateScalp({ tpPct: 0.5, slPct: 0.01, holdMin: 5 }, false)).not.toBeNull();
    expect(validateScalp({ tpPct: 0.5, slPct: 0.2, holdMin: 241 }, false)).not.toBeNull();
    expect(validateScalp({ tpPct: 0.5, slPct: 0.2, holdMin: null }, true)).toBeNull();
  });
});

describe("scalp brackets and exits", () => {
  it("places long stop below and target above the price", () => {
    const b = scalpBracket("buy", 100, 0.5, 0.25);
    expect(b.tp).toBeCloseTo(100.5, 9);
    expect(b.sl).toBeCloseTo(99.75, 9);
  });
  it("places short stop above and target below the price", () => {
    const b = scalpBracket("sell", 100, 0.5, 0.25);
    expect(b.tp).toBeCloseTo(99.5, 9);
    expect(b.sl).toBeCloseTo(100.25, 9);
  });
  it("closes on stop, target or time limit", () => {
    const p = { side: "buy" as const, stop_loss: 99.75, take_profit: 100.5, max_hold_until: "2026-01-01T00:05:00Z" };
    const t0 = Date.parse("2026-01-01T00:01:00Z");
    expect(scalpExit(p, 99.7, t0)).toBe("stop_loss");
    expect(scalpExit(p, 100.6, t0)).toBe("take_profit");
    expect(scalpExit(p, 100, t0)).toBeNull();
    expect(scalpExit(p, 100, Date.parse("2026-01-01T00:05:00Z"))).toBe("time_stop");
  });
  it("short scalps stop out when price rises", () => {
    expect(scalpExit({ side: "sell", stop_loss: 100.25, take_profit: 99.5, max_hold_until: null }, 100.3, 0)).toBe("stop_loss");
  });
});

describe("scalp stats and templates", () => {
  it("counts wins net of fees", () => {
    const s = scalpStats([{ realized_pnl: 1, fees: 0.5 }, { realized_pnl: 0.2, fees: 0.3 }, { realized_pnl: -1, fees: 0.2 }]);
    expect(s.count).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.net).toBeCloseTo(-0.8, 9);
  });
  it("every scalping template is a valid strategy", () => {
    for (const t of scalpTemplates("ETH/USDT")) expect(validateStrategy(t.config)).toEqual([]);
  });
});
