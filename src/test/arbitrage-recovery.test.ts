import { describe, expect, it } from "vitest";
import { recoveryDecision, type OrderEvidence } from "@/lib/arbitrage-recovery";
const buy: OrderEvidence = { orderId: "b", state: "filled", qty: 10, avgPrice: 100, quoteValue: 1000, feeQuote: 1 };
const sell: OrderEvidence = { orderId: "s", state: "filled", qty: 10, avgPrice: 103, quoteValue: 1030, feeQuote: 1.03 };
describe("arbitrage recovery", () => {
  it("keeps unknown exchange outcomes locked", () => { expect(recoveryDecision(buy, null).status).toBe("needs_review"); });
  it("keeps unmatched inventory locked", () => { expect(recoveryDecision(buy, { ...sell, qty: 9.99 }).status).toBe("needs_review"); });
  it("keeps open orders locked even with equal fills", () => { expect(recoveryDecision(buy, { ...sell, state: "open" }).status).toBe("needs_review"); });
  it("keeps terminal partial orders locked", () => { expect(recoveryDecision(buy, { ...sell, state: "cancelled" }).status).toBe("needs_review"); });
  it("unlocks only two exchange-confirmed zero-fill cancellations", () => { expect(recoveryDecision({ ...buy, state: "cancelled", qty: 0 }, { ...sell, state: "cancelled", qty: 0 }).status).toBe("blocked"); });
  it("uses actual quote flows and deducts quote fees exactly once", () => { expect(recoveryDecision(buy, sell).realizedNet).toBeCloseTo(27.97); });
  it("does not fabricate net profit when fee valuation is unknown", () => { expect(recoveryDecision({ ...buy, feeQuote: null }, sell).realizedNet).toBeNull(); });
});