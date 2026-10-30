import { describe, expect, it } from "vitest";
import { canOpen } from "@/lib/plans";
import { walletClose, walletOpen } from "@/lib/wallet-math";
import { MARKETS, quoteUsdSource } from "@/lib/markets";

describe("plan access", () => {
  it("free plan can open only manual trading, wallet and account pages", () => {
    for (const p of ["/trade", "/wallet", "/exchanges", "/risk", "/settings", "/plans"]) expect(canOpen(p, false)).toBe(true);
  });
  it("free plan cannot open AI, strategies, bots, backtests, analytics or dashboard", () => {
    for (const p of ["/assistant", "/strategies", "/strategies/abc", "/bots", "/backtests", "/analytics", "/dashboard"]) expect(canOpen(p, false)).toBe(false);
  });
  it("paid plan opens everything", () => {
    expect(canOpen("/bots", true)).toBe(true);
    expect(canOpen("/assistant", true)).toBe(true);
  });
  it("arbitrage is available to Pro users and blocked for Free users", () => {
    expect(canOpen("/arbitrage", false)).toBe(false);
    expect(canOpen("/arbitrage", true)).toBe(true);
  });
});

describe("demo wallet trade math", () => {
  it("opening debits the amount plus a 0.1% fee", () => {
    const o = walletOpen(1000, 100, "buy", 1);
    expect(o.debit).toBeCloseTo(1001, 6);
    expect(o.qty * o.fill).toBeCloseTo(1000, 6);
  });
  it("closing a flat trade returns the margin minus the exit fee", () => {
    const c = walletClose({ side: "buy", entry: 100, qty: 10, margin: 1000 }, 100 / (1 - 0.0005), 1);
    expect(c.pnl).toBeCloseTo(0, 6);
    expect(c.credit).toBeCloseTo(999, 2);
  });
  it("a short gains when the price falls, converted to USD", () => {
    const c = walletClose({ side: "sell", entry: 150, qty: 1000, margin: 1000 }, 140, 1 / 140);
    expect(c.pnl).toBeGreaterThan(0);
  });
  it("the wallet never gets back a negative amount", () => {
    const c = walletClose({ side: "sell", entry: 100, qty: 10, margin: 1000 }, 500, 1);
    expect(c.credit).toBe(0);
  });
});

describe("markets", () => {
  it("every forex and commodity market has a Yahoo Finance ticker", () => {
    for (const m of MARKETS.filter((x) => x.category !== "crypto")) expect(m.yahoo).toBeTruthy();
  });
  it("USD conversion: USD quote = 1, USD base = 1/price, crosses look up the quote currency", () => {
    expect(quoteUsdSource("EUR/USD", 1.1)).toBe(1);
    expect(quoteUsdSource("USD/JPY", 150)).toBeCloseTo(1 / 150, 10);
    expect(quoteUsdSource("EUR/GBP", 0.85)).toBe("GBPUSD=X");
  });
});
