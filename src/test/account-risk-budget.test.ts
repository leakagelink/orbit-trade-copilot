// Account-level risk budget with Research and Scalping sub-budgets (owner decision, 13 Nov 2026). One test per rule;
// budget numbers are test inputs, not approved policy.
import { describe, expect, it } from "vitest";
import { checkAdditionalRisk, openAndPendingExposure, riskEngineStrategyBudget, validateBudgetConfig, type AccountRiskBudget, type StrategyRiskBudget, type StrategyUsage } from "@/lib/account-risk-budget";

const ACC: AccountRiskBudget = { maxLoss: 100, research: 40, scalping: 60 };
const STRATS: StrategyRiskBudget[] = [{ strategyId: "r1", engine: "research", maxLoss: 40 }, { strategyId: "s1", engine: "scalping", maxLoss: 30 }, { strategyId: "s2", engine: "scalping", maxLoss: 30 }];
const zero: StrategyUsage = { closedLoss: 0, openRisk: 0, pendingRisk: 0 };
const U = (o: Partial<Record<string, Partial<StrategyUsage>>> = {}) => Object.fromEntries(STRATS.map((s) => [s.strategyId, { ...zero, ...o[s.strategyId] }]));

describe("static nesting: strategy budgets can never add up past the central account budget", () => {
  it("accepts 40 research + 60 scalping inside a 100 account budget", () => { expect(validateBudgetConfig(ACC, STRATS)).toEqual([]); });
  it("refuses sub-budgets above the account budget", () => { expect(validateBudgetConfig({ maxLoss: 100, research: 50, scalping: 60 }, STRATS).join()).toMatch(/exceed the account budget 100/); });
  it("refuses scalping strategy budgets totalling more than the scalping sub-budget", () => {
    expect(validateBudgetConfig(ACC, [...STRATS, { strategyId: "s3", engine: "scalping", maxLoss: 1 }]).join()).toMatch(/scalping strategy budgets total 61 above the scalping sub-budget 60/);
  });
  it("refuses a strategy without a valid sub-budget and duplicate strategy budgets", () => {
    expect(validateBudgetConfig(ACC, [{ strategyId: "x", engine: "other" as never, maxLoss: 1 }]).join()).toMatch(/no valid sub-budget/);
    expect(validateBudgetConfig(ACC, [STRATS[1]!, STRATS[1]!]).join()).toMatch(/more than one budget/);
  });
});

describe("shared check: strategy, sub-budget and account levels; open and pending risk both count", () => {
  it("open + pending + closed losses are all usage: s1 with 10 closed, 8 open and 7 pending has 5 left", () => {
    const c = checkAdditionalRisk(ACC, STRATS, U({ s1: { closedLoss: 10, openRisk: 8, pendingRisk: 7 } }), "s1", 5);
    expect(c.ok).toBe(true); expect(c.room).toBeCloseTo(5, 9);
    expect(checkAdditionalRisk(ACC, STRATS, U({ s1: { closedLoss: 10, openRisk: 8, pendingRisk: 7 } }), "s1", 5.01).code).toBe("STRATEGY_BUDGET");
  });
  it("another scalping strategy's usage counts against the shared scalping sub-budget (e.g. after its budget was lowered)", () => {
    // s2's budget was lowered to 25 after it had 22 closed losses and 8 pending: s2 alone is over, s1 still has room 5.
    const strats: StrategyRiskBudget[] = [{ strategyId: "s1", engine: "scalping", maxLoss: 25 }, { strategyId: "s2", engine: "scalping", maxLoss: 25 }];
    const u = { s1: { ...zero, openRisk: 20 }, s2: { ...zero, closedLoss: 22, pendingRisk: 8 } };
    const c = checkAdditionalRisk({ maxLoss: 100, research: 40, scalping: 50 }, strats, u, "s1", 1);
    expect(c.code).toBe("SUB_BUDGET"); expect(c.usage!.subBudget).toBe(50);
  });
  it("research usage does not consume the scalping sub-budget, but both consume the account budget", () => {
    const u = U({ r1: { closedLoss: 39 }, s1: { openRisk: 29 }, s2: { pendingRisk: 29 } });
    expect(checkAdditionalRisk(ACC, STRATS, u, "s2", 1).ok).toBe(true); // scalping 59/60, account 98/100
    expect(checkAdditionalRisk(ACC, STRATS, u, "s2", 1.5).ok).toBe(false);
  });
  it("fails closed: unknown strategy, missing usage of any budgeted strategy, negative risk, invalid configuration", () => {
    expect(checkAdditionalRisk(ACC, STRATS, U(), "nope", 1).code).toBe("STRATEGY_UNKNOWN");
    const missing = U(); delete missing["r1"];
    expect(checkAdditionalRisk(ACC, STRATS, missing, "s1", 1).code).toBe("USAGE_UNKNOWN");
    expect(checkAdditionalRisk(ACC, STRATS, U({ r1: { closedLoss: Number.NaN } }), "s1", 1).code).toBe("USAGE_UNKNOWN");
    expect(checkAdditionalRisk(ACC, STRATS, U(), "s1", -1).code).toBe("RISK_INVALID");
    expect(checkAdditionalRisk({ maxLoss: 50, research: 40, scalping: 60 }, STRATS, U(), "s1", 1).code).toBe("CONFIG_INVALID");
  });
  it("the Risk Engine input carries the tightest room as budget − usedLoss", () => {
    const b = riskEngineStrategyBudget(ACC, STRATS, U({ s1: { openRisk: 10 }, s2: { pendingRisk: 25 } }), "s1")!;
    expect(b.usedLoss).toBe(10); expect(b.budget - b.usedLoss).toBeCloseTo(20, 9); // strategy room 20 < scalping room 25
    expect(riskEngineStrategyBudget(ACC, STRATS, U(), "nope")).toBeNull();
  });
});

describe("open and pending exposure", () => {
  it("counts pending remainders at the current mark and fails closed on a missing mark", () => {
    const x = openAndPendingExposure([{ symbol: "BTCUSDT", qty: 2, margin: 40 }], [{ symbol: "ETHUSDT", remainingQty: 3, leverage: 5 }], { BTCUSDT: 100, ETHUSDT: 50 })!;
    expect(x.exposure).toBe(350); expect(x.positionCount).toBe(2); expect(x.marginUsedAndReserved).toBe(70);
    expect(openAndPendingExposure([], [{ symbol: "ETHUSDT", remainingQty: 3, leverage: 5 }], { BTCUSDT: 100 })).toBeNull();
  });
});
