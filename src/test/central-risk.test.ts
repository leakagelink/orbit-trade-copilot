// Central Risk Engine: one deterministic ACCEPT / REJECT / INSUFFICIENT_DATA authority for both AI engines.
import { describe, expect, it } from "vitest";
import { evaluateProposal, liquidationPrice, type RiskContext } from "@/lib/central-risk";

const NOW = Date.UTC(2026, 10, 12, 12);
const P = { proposalId: "prop-000001", engine: "scalp_intraday", strategyId: "intraday-v1", symbol: "BTCUSDT", market: "usdm_futures", environment: "testnet", side: "LONG", referencePrice: 99999, stopPrice: 99_000, takeProfitPrice: 101_500, createdAt: NOW - 1_000 } as const;
const ctx = (o: Partial<{ [K in keyof RiskContext]: Partial<NonNullable<RiskContext[K]>> }> = {}): RiskContext => ({
  now: NOW,
  account: { equity: 100, availableMargin: 50, openExposure: 0, openPositions: 0, dayNet: 0, halted: false, environmentHalted: false, ...o.account },
  limits: { maxExposure: 10, maxDailyLoss: 2, maxPositions: 1, maxLossPerTrade: 2, maxMarginPerTrade: 5, maxLeverage: 10, liquidationBufferPct: 0.5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.12, ...o.limits },
  strategy: { budget: 5, usedLoss: 0, ...o.strategy },
  market: { markPrice: 100_000, markTimestamp: NOW - 500, stepSize: 0.00001, minNotional: 5, maintenanceMarginRate: 0.004, ...o.market },
  orders: { sameProposalSeen: false, unresolvedOrders: 0, openPositionOnSymbol: false, ...o.orders },
});
const ids = (d: ReturnType<typeof evaluateProposal>, s: string) => d.checks.filter((c) => c.status === s).map((c) => c.id);

describe("Central Risk Engine", () => {
  it("ACCEPTs a valid proposal and sizes it itself, within every cap; never an execution authorization", () => {
    const d = evaluateProposal(P, ctx());
    expect(d.verdict).toBe("ACCEPT");
    expect(d.executionAuthorized).toBe(false);
    const z = d.sizing!;
    expect(z.notional).toBeLessThanOrEqual(10); // account exposure cap 10
    expect(z.margin).toBeLessThanOrEqual(5 + 1e-9);
    expect(z.leverage).toBeLessThanOrEqual(10);
    expect(z.riskAmount).toBeLessThanOrEqual(2);
    expect(z.entryEstimate).toBe(100_000); // the verified mark price, not the AI reference price 99,999
  });
  it("refuses any AI-supplied quantity, leverage or authorization field", () => {
    for (const extra of [{ quantity: 1 }, { leverage: 20 }, { notional: 500 }, { authorized: true }]) {
      const d = evaluateProposal({ ...P, ...extra }, ctx());
      expect(d.verdict).toBe("REJECT"); expect(d.checks[0]!.id).toBe("proposal_schema"); expect(d.sizing).toBeNull();
    }
  });
  it("requires a stop-loss on the correct side of the verified price", () => {
    expect(evaluateProposal({ ...P, stopPrice: null }, ctx()).verdict).toBe("REJECT");
    expect(ids(evaluateProposal({ ...P, stopPrice: 100_500 }, ctx()), "fail")).toContain("stop_loss");
    expect(ids(evaluateProposal({ ...P, side: "SHORT", stopPrice: 101_000, takeProfitPrice: 99_000 }, ctx()), "fail")).toEqual([]);
  });
  it("rejects stale market data and stale proposals; missing timestamps are INSUFFICIENT_DATA", () => {
    expect(ids(evaluateProposal(P, ctx({ market: { markTimestamp: NOW - 6_000 } })), "fail")).toEqual(["market_data"]);
    expect(ids(evaluateProposal({ ...P, createdAt: NOW - 120_000 }, ctx()), "fail")).toEqual(["proposal_fresh"]);
    expect(evaluateProposal(P, ctx({ market: { markTimestamp: null } })).verdict).toBe("INSUFFICIENT_DATA");
  });
  it("emergency stop (account or environment) rejects", () => {
    expect(ids(evaluateProposal(P, ctx({ account: { halted: true } })), "fail")).toEqual(["emergency_stop"]);
    expect(ids(evaluateProposal(P, ctx({ account: { environmentHalted: true } })), "fail")).toEqual(["emergency_stop"]);
  });
  it("duplicate proposals and unknown order outcomes reject", () => {
    expect(ids(evaluateProposal(P, ctx({ orders: { sameProposalSeen: true } })), "fail")).toEqual(["duplicate"]);
    expect(ids(evaluateProposal(P, ctx({ orders: { unresolvedOrders: 1 } })), "fail")).toEqual(["unknown_outcomes"]);
    expect(ids(evaluateProposal(P, ctx({ orders: { openPositionOnSymbol: true } })), "fail")).toEqual(["one_position_per_symbol"]);
  });
  it("daily loss, strategy budget, position count and exposure limits reject when used up", () => {
    expect(ids(evaluateProposal(P, ctx({ account: { dayNet: -2 } })), "fail")).toEqual(["daily_loss"]);
    expect(ids(evaluateProposal(P, ctx({ strategy: { usedLoss: 5 } })), "fail")).toEqual(["strategy_budget"]);
    expect(ids(evaluateProposal(P, ctx({ account: { openPositions: 1 } })), "fail")).toEqual(["position_count"]);
    expect(ids(evaluateProposal(P, ctx({ account: { openExposure: 10 } })), "fail")).toEqual(["exposure"]);
  });
  it("the smallest loss allowance sizes the trade", () => {
    const d = evaluateProposal(P, ctx({ limits: { maxExposure: 1_000_000, maxMarginPerTrade: 1_000_000 }, account: { availableMargin: 1_000_000, dayNet: -1.5 } }));
    expect(d.verdict).toBe("ACCEPT");
    expect(d.sizing!.binding).toBe("daily loss allowance");
    expect(d.sizing!.riskAmount).toBeLessThanOrEqual(0.5 + 1e-9);
  });
  it("a missing strategy budget or limit is INSUFFICIENT_DATA, never a guess", () => {
    expect(evaluateProposal(P, { ...ctx(), strategy: null }).verdict).toBe("INSUFFICIENT_DATA");
    expect(evaluateProposal(P, ctx({ limits: { maxLeverage: null } })).verdict).toBe("INSUFFICIENT_DATA");
    expect(evaluateProposal(P, { ...ctx(), account: null }).verdict).toBe("INSUFFICIENT_DATA");
    expect(evaluateProposal(P, ctx({ orders: { unresolvedOrders: null } })).verdict).toBe("INSUFFICIENT_DATA");
  });
  it("liquidation buffer: steps leverage down rather than up, and rejects when even 1× is too close", () => {
    expect(liquidationPrice("LONG", 100, 10, 0.004)).toBeCloseTo(90.4, 6);
    // Stop 9% below with 10× would sit next to liquidation (~9.6% below): leverage is stepped down.
    const d = evaluateProposal({ ...P, stopPrice: 91_000, takeProfitPrice: 110_000 }, ctx({ limits: { maxExposure: 1_000_000, maxLossPerTrade: 100, maxDailyLoss: 100, maxMarginPerTrade: 5, liquidationBufferPct: 2 }, strategy: { budget: 100 } }));
    expect(d.verdict).toBe("ACCEPT");
    expect(d.sizing!.leverage).toBe(8); // 10× and 9× leave the stop within 2% of liquidation
    expect((d.sizing!.liquidationPrice! < 91_000 - 0.02 * 100_000)).toBe(true);
    expect(d.sizing!.margin).toBeLessThanOrEqual(5 + 1e-9);
    const no = evaluateProposal({ ...P, stopPrice: 100, takeProfitPrice: 110_000 }, ctx({ limits: { liquidationBufferPct: 0.5 } }));
    expect(ids(no, "fail")).toContain("liquidation_buffer");
  });
  it("below the exchange minimum is rejected, not rounded up", () => {
    expect(ids(evaluateProposal(P, ctx({ market: { minNotional: 50 } })), "fail")).toEqual(["min_notional"]);
  });
  it("spot proposals use 1× with no liquidation check", () => {
    const d = evaluateProposal({ ...P, market: "spot" }, ctx());
    expect(d.verdict).toBe("ACCEPT"); expect(d.sizing!.leverage).toBe(1);
  });
  it("is deterministic", () => {
    expect(evaluateProposal(P, ctx())).toEqual(evaluateProposal(P, ctx()));
  });
});

import { fromIntraday, fromResearch } from "@/lib/central-risk-proposals";
describe("both engines submit to the same authority", () => {
  const meta = { proposalId: "run-0000001", strategyId: "research", symbol: "BTCUSDT", market: "usdm_futures" as const, createdAt: NOW - 1_000 };
  const research = { advisoryOnly: true as const, executionAllowed: false as const, status: "scenario" as const, direction: "long" as const, referenceClose: 99_000, asOf: null, hypotheticalEntry: 99_000, stopLoss: 99_000, takeProfit: 102_000, rewardRisk: 2, positionSize: null, confidence: null, reasons: [], limitations: [] };
  it("a research scenario becomes a paper-only proposal and is sized by the Risk Engine", () => {
    const a = fromResearch(research, meta);
    expect(a.proposal!.environment).toBe("paper");
    expect(Object.keys(a.proposal!)).not.toContain("quantity");
    const d = evaluateProposal(a.proposal, ctx());
    expect(d.verdict).toBe("ACCEPT"); expect(d.executionAuthorized).toBe(false);
  });
  it("withheld research and NO_TRADE signals never reach the Risk Engine", () => {
    expect(fromResearch({ ...research, status: "withheld", direction: "none", reasons: ["No consensus"] }, meta)).toEqual({ proposal: null, noTrade: "No consensus" });
    expect(fromIntraday({ t: 0, action: "NO_TRADE", setup: null, reasons: ["Volatility too low"], stop: null, target: null, features: null as never }, { ...meta, environment: "testnet" }).noTrade).toBe("Volatility too low");
  });
  it("a scalping LONG is evaluated by exactly the same checks", () => {
    const a = fromIntraday({ t: 0, action: "LONG", setup: "breakout", reasons: [], stop: 99_000, target: 101_500, features: { close: 100_010 } as never }, { ...meta, strategyId: "intraday-v1", environment: "testnet" });
    expect(evaluateProposal(a.proposal, ctx()).checks.map((c) => c.id)).toEqual(evaluateProposal(P, ctx()).checks.map((c) => c.id));
  });
});
