import { describe, expect, it } from "vitest";
import { compareBooks, depthFill, executionAllowed, type Book } from "@/lib/arbitrage";

const books: Book[] = [
  { exchange: "binance", asks: [[100, 100]], bids: [[99, 100]], fetchedAt: 1000 },
  { exchange: "okx", asks: [[104, 100]], bids: [[103, 100]], fetchedAt: 1000 },
];
describe("arbitrage safeguards", () => {
  it("buys at the cheaper ask and sells at the higher bid", () => {
    const best = compareBooks(books, 1000, 10, 5, 1000)[0];
    expect(best?.buyExchange).toBe("binance"); expect(best?.sellExchange).toBe("okx");
    expect(best?.quantity).toBe(10); expect(best?.net).toBeCloseTo(26.955);
  });
  it("deducts both venue fees and slippage before approving a profit", () => {
    const best = compareBooks(books, 1000, 100, 100, 1000)[0];
    if (!best) throw new Error("Expected comparison");
    expect(best.net).toBeCloseTo(-10.6); expect(executionAllowed(best, 0)).toBe(false);
  });
  it("uses depth instead of assuming unlimited top-of-book liquidity", () => {
    expect(depthFill([[100, 1], [110, 2]], 2)).toBe(210);
    expect(depthFill([[100, 1]], 2)).toBeNull();
  });
  it("rejects stale quotes and same-venue routes", () => {
    expect(compareBooks(books, 1000, 10, 5, 17000)).toEqual([]);
    expect(compareBooks([books[0] as Book], 1000, 10, 5, 1000)).toEqual([]);
  });
});