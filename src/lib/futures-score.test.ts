import { describe, it, expect } from "vitest";
import { futuresScore } from "./futures-score";
const t = (p: number, f: number, d: string) => ({ realized_pnl: p, fees: f, closed_at: d });
describe("futuresScore", () => {
  it("subtracts fees from gross PnL", () => { expect(futuresScore([t(0.0072, 0.00996, "2026-01-01")]).netPnl).toBeCloseTo(-0.00276, 5); });
  it("computes win rate, profit factor and drawdown", () => {
    const s = futuresScore([t(1, 0, "2026-01-01"), t(-0.5, 0, "2026-01-02"), t(-0.5, 0, "2026-01-03"), t(2, 0, "2026-01-04")]);
    expect(s.winRate).toBe(0.5); expect(s.profitFactor).toBe(3); expect(s.maxDrawdown).toBe(1);
  });
  it("flags fewer than 30 trades as not enough evidence", () => { expect(futuresScore([t(1, 0, "2026-01-01")]).enoughEvidence).toBe(false); });
});
