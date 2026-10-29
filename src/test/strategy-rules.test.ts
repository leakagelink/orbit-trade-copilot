import { describe, expect, it } from "vitest";
import { emptyStrategyConfig, validateStrategy } from "@/lib/strategy";
import { computeMetrics } from "@/lib/metrics";

const valid = () => {
  const c = emptyStrategyConfig();
  c.indicators = [{ id: "rsi_1", type: "RSI", params: { period: 14 } }];
  c.entry.conditions = [{ left: "rsi_1", operator: "<", right: "30" }];
  return c;
};

describe("strategy validation", () => {
  it("accepts a complete strategy", () => expect(validateStrategy(valid())).toEqual([]));
  it("requires a stop loss", () => {
    const c = valid(); c.risk.stop_loss_pct = null;
    expect(validateStrategy(c).some((i) => i.path === "risk.stop_loss_pct")).toBe(true);
  });
  it("requires an entry condition", () => {
    const c = valid(); c.entry.conditions = [];
    expect(validateStrategy(c).some((i) => i.path === "entry")).toBe(true);
  });
  it("rejects conditions referencing unknown indicators", () => {
    const c = valid(); c.entry.conditions = [{ left: "ema_9", operator: ">", right: "price" }];
    expect(validateStrategy(c).length).toBeGreaterThan(0);
  });
  it("rejects total exposure above 100%", () => {
    const c = valid(); c.risk.position_size_pct = 40; c.risk.max_open_positions = 3;
    expect(validateStrategy(c).some((i) => i.path === "risk")).toBe(true);
  });
});

describe("metrics", () => {
  it("computes net pnl, win rate and drawdown from records", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const m = computeMetrics(
      [
        { realized_pnl: 100, fees: 1, closed_at: "2026-10-28T12:00:00Z" },
        { realized_pnl: -50, fees: 1, closed_at: "2026-10-10T00:00:00Z" },
      ],
      [{ unrealized_pnl: 5, is_open: true }, { unrealized_pnl: 99, is_open: false }],
      [
        { total_value: 1000, available_capital: 1000, captured_at: "2026-10-01" },
        { total_value: 800, available_capital: 800, captured_at: "2026-10-02" },
        { total_value: 900, available_capital: 900, captured_at: "2026-10-03" },
      ],
      now,
    );
    expect(m.realizedPnl).toBe(48);
    expect(m.dailyPnl).toBe(99);
    expect(m.monthlyPnl).toBe(48);
    expect(m.unrealizedPnl).toBe(5);
    expect(m.winRate).toBe(50);
    expect(m.maxDrawdownPct).toBeCloseTo(20);
  });
});
