// Phase 4C risk-data contract validators: every missing, stale, mis-scoped or substituted input is INSUFFICIENT_DATA.
import { describe, expect, it } from "vitest";
import { bracketFor, TESTNET_PUBLIC_HOST, usedLossFrom, validateAvailableMargin, validateBrackets, validateLossAttribution, validateStrategyBudget, validateTestnetMarket } from "@/lib/risk-data-contracts";

const now = Date.UTC(2026, 10, 12, 18), U = "00000000-0000-4000-8000-00000000000a";
const budget = { userId: U, strategyId: "s1", environment: "production", maxLossUsdt: 50, updatedAt: now - 86_400_000, observedAt: now - 100, source: "strategy_risk_budgets" };
const attr = { strategyId: "s1", strategyVersion: 3, environment: "production", realizedNetLossUsdt: 12, openRiskReservedUsdt: 4, coverage: "COMPLETE", unattributedTradeCount: 0, asOf: now - 1000 };
const br = { symbol: "BTCUSDT", environment: "production", source: "binance:/fapi/v1/leverageBracket", fetchedAt: now - 60_000, exchangeTime: now - 60_000,
  brackets: [{ notionalFloorUsdt: 0, notionalCapUsdt: 50_000, maintMarginRatio: 0.004, maintAmountUsdt: 0, initialLeverage: 125 }, { notionalFloorUsdt: 50_000, notionalCapUsdt: 250_000, maintMarginRatio: 0.005, maintAmountUsdt: 50, initialLeverage: 100 }] };
const margin = { environment: "production", connectionRef: "conn-1", source: "binance:/fapi/v3/account", availableBalanceUsdt: 120, fetchedAt: now - 1000, exchangeTime: now - 1200 };
const tmk = { symbol: "BTCUSDT", environment: "testnet", source: `${TESTNET_PUBLIC_HOST}/fapi/v1/premiumIndex`, markPrice: 100_000, markTime: now - 500, stepSize: 0.001, minNotionalUsdt: 100, fetchedAt: now - 400 };
const E = { now, environment: "production" as const };

describe("strategy budget contract", () => {
  it("accepts an in-scope row", () => { expect(validateStrategyBudget(budget, { ...E, userId: U, strategyId: "s1" }).status).toBe("VALID"); });
  it.each([
    ["missing", null], ["another owner", { ...budget, userId: "x" }], ["another strategy", { ...budget, strategyId: "s2" }], ["testnet row for production", { ...budget, environment: "testnet" }],
    ["zero budget", { ...budget, maxLossUsdt: 0 }], ["NaN", { ...budget, maxLossUsdt: Number.NaN }], ["string number", { ...budget, maxLossUsdt: "50" }], ["future update", { ...budget, updatedAt: now + 10_000 }], ["stale read", { ...budget, observedAt: now - 60_000 }],
  ])("%s → INSUFFICIENT_DATA", (_n, x) => { expect(validateStrategyBudget(x, { ...E, userId: U, strategyId: "s1" }).status).toBe("INSUFFICIENT_DATA"); });
});

describe("loss attribution contract", () => {
  it("accepts COMPLETE coverage and reports used loss = realized + reserved", () => { const r = validateLossAttribution(attr, { ...E, strategyId: "s1" }); expect(r.status).toBe("VALID"); expect(usedLossFrom(r)).toBe(16); });
  it.each([["PARTIAL", { ...attr, coverage: "PARTIAL" }], ["NONE", { ...attr, coverage: "NONE" }], ["legacy unattributed trade", { ...attr, unattributedTradeCount: 1 }], ["stale", { ...attr, asOf: now - 6000 }], ["negative loss", { ...attr, realizedNetLossUsdt: -1 }], ["version 0", { ...attr, strategyVersion: 0 }], ["wrong env", { ...attr, environment: "testnet" }]])
    ("%s → INSUFFICIENT_DATA and no used loss", (_n, x) => { const r = validateLossAttribution(x, { ...E, strategyId: "s1" }); expect(r.status).toBe("INSUFFICIENT_DATA"); expect(usedLossFrom(r)).toBeNull(); });
});

describe("maintenance-margin brackets contract", () => {
  it("accepts contiguous brackets and finds the covering one", () => { const r = validateBrackets(br, { ...E, symbol: "BTCUSDT" }); expect(r.status).toBe("VALID"); expect(bracketFor(r, 60_000)?.maintMarginRatio).toBe(0.005); });
  it("never extrapolates beyond the last bracket", () => { expect(bracketFor(validateBrackets(br, { ...E, symbol: "BTCUSDT" }), 300_000)).toBeNull(); });
  it.each([["gap between brackets", { ...br, brackets: [br.brackets[0], { ...br.brackets[1], notionalFloorUsdt: 60_000 }] }], ["ratio ≥ 1", { ...br, brackets: [{ ...br.brackets[0], maintMarginRatio: 1 }] }], ["no brackets (leverage alone)", { ...br, brackets: [] }],
    ["stale", { ...br, fetchedAt: now - 3_700_000 }], ["other symbol", { ...br, symbol: "ETHUSDT" }], ["not starting at 0", { ...br, brackets: [{ ...br.brackets[0], notionalFloorUsdt: 10 }] }]])
    ("%s → INSUFFICIENT_DATA", (_n, x) => { const r = validateBrackets(x, { ...E, symbol: "BTCUSDT" }); expect(r.status).toBe("INSUFFICIENT_DATA"); expect(bracketFor(r, 1000)).toBeNull(); });
  it("paper environment never uses exchange brackets", () => { expect(validateBrackets({ ...br, environment: "paper" }, { now, environment: "paper", symbol: "BTCUSDT" }).status).toBe("INSUFFICIENT_DATA"); });
});

describe("available margin contract", () => {
  it("accepts a fresh Futures account snapshot", () => { expect(validateAvailableMargin(margin, { ...E, connectionRef: "conn-1" }).status).toBe("VALID"); });
  it.each([["wallet balance substituted", { ...margin, walletBalance: 500 }], ["Spot account source", { ...margin, source: "binance:/api/v3/account" }], ["stale (> 5 s)", { ...margin, fetchedAt: now - 6000 }], ["another connection", { ...margin, connectionRef: "conn-2" }],
    ["Testnet snapshot for Live", { ...margin, environment: "testnet" }], ["negative", { ...margin, availableBalanceUsdt: -1 }], ["missing exchange time", { ...margin, exchangeTime: undefined }]])
    ("%s → INSUFFICIENT_DATA", (_n, x) => { expect(validateAvailableMargin(x, { ...E, connectionRef: "conn-1" }).status).toBe("INSUFFICIENT_DATA"); });
});

describe("Testnet market contract", () => {
  it("accepts Testnet-host data", () => { expect(validateTestnetMarket(tmk, { now, symbol: "BTCUSDT" }).status).toBe("VALID"); });
  it.each([["production host price", { ...tmk, source: "https://fapi.binance.com/fapi/v1/premiumIndex" }], ["labelled production", { ...tmk, environment: "production" }], ["stale mark", { ...tmk, markTime: now - 6000 }], ["zero step", { ...tmk, stepSize: 0 }], ["missing", null]])
    ("%s → INSUFFICIENT_DATA", (_n, x) => { expect(validateTestnetMarket(x, { now, symbol: "BTCUSDT" }).status).toBe("INSUFFICIENT_DATA"); });
});

it("valid snapshots are frozen copies", () => { const r = validateStrategyBudget(budget, { ...E, userId: U, strategyId: "s1" }); expect(Object.isFrozen(r.value)).toBe(true); expect(r.value).not.toBe(budget); });
