import { describe, expect, it } from "vitest";
import { createRunBudget, toolInputs, AUTOPILOT_LIMITS } from "@/lib/autopilot-guard";

describe("AI Autopilot is demo/paper only", () => {
  it("rejects a trade that tries to pick a real account", () => {
    const r = toolInputs.openPaperTrade.safeParse({ symbol: "BTC/USDT", side: "buy", amountUsd: 50, stopLoss: 1, takeProfit: null, connectionId: "00000000-0000-0000-0000-000000000000" });
    expect(r.success).toBe(false);
  });
  it("rejects arbitrage that asks for live mode", () => {
    const r = toolInputs.runPaperArbitrage.safeParse({ pair: "BTC/USDT", budget: 100, buyExchange: "binance", sellExchange: "okx", minimumNetPct: 0, mode: "live" });
    expect(r.success).toBe(false);
  });
  it("rejects a bot with a live trading account", () => {
    const r = toolInputs.startPaperBot.safeParse({ name: "x", strategyId: "00000000-0000-0000-0000-000000000000", exchange: "binance", pair: "BTC/USDT", timeframe: "1h", capital: 100, size: 10, exposure: 50, sl: 2, tp: 4, maxpos: 1, dll: 5, connectionId: "00000000-0000-0000-0000-000000000000" });
    expect(r.success).toBe(false);
  });
  it("requires a stop loss on every demo trade", () => {
    const r = toolInputs.openPaperTrade.safeParse({ symbol: "BTC/USDT", side: "buy", amountUsd: 50, stopLoss: null, takeProfit: null });
    expect(r.success).toBe(false);
  });
});

describe("AI Autopilot per-request limits", () => {
  it("allows at most 5 new entries per request", () => {
    expect(AUTOPILOT_LIMITS.entries).toBe(5);
    const b = createRunBudget();
    for (let i = 0; i < 5; i++) b.claim("entries");
    expect(() => b.claim("entries")).toThrow(/limit/);
  });
  it("allows at most 3 new bots per request", () => {
    const b = createRunBudget();
    for (let i = 0; i < 3; i++) b.claim("bots");
    expect(() => b.claim("bots")).toThrow(/limit/);
  });
});
