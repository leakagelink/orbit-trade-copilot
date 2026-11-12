import { describe, expect, it } from "vitest";
import { createBudgetMeter, DEFAULT_RESEARCH_BUDGET, projectCallTokens, reportedCostUsd, ResearchBudgetStop } from "@/lib/research-budget";
import { atr14, riskPreview } from "@/lib/research-risk-preview";
import { agentDisagreement, allAgents, bullBearArguments, decisionOutcome, leakageWarnings, unavailableSources } from "@/lib/research-transparency";
import { RESEARCH_AGENTS } from "@/lib/research-pipeline";

const rep = (outlook: string, extra: Partial<{ observations: string[]; risks: string[]; limitations: string[] }> = {}) => ({ summary: `${outlook} view`, outlook, observations: extra.observations ?? [], risks: extra.risks ?? [], limitations: extra.limitations ?? [] });
const candles = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 102, l: 98, c: 100 }));

describe("research spending limits", () => {
  const prior = { userMonthTokens: 0, platformMonthTokens: 0, platformMonthUsd: null };
  it("stops a call that would exceed the per-run token limit", () => {
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, perRunTokens: 20_000 }, prior);
    m.settle(m.reserve(15_000), 15_000, null);
    expect(() => m.reserve(6_000)).toThrow(ResearchBudgetStop);
    expect(m.state().stoppedBy).toBe("per_run_tokens");
    expect(m.state().stopReason).toMatch(/No further AI calls/);
  });
  it("counts parallel reservations together", () => {
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, perRunTokens: 20_000 }, prior);
    m.reserve(9_000); m.reserve(9_000);
    expect(() => m.reserve(9_000)).toThrow(/per-run limit/);
  });
  it("stops when the user's monthly limit would be exceeded", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, { ...prior, userMonthTokens: 2_999_000 });
    expect(() => m.reserve(5_000)).toThrow(/monthly research limit/);
  });
  it("stops when the platform's monthly limit would be exceeded", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, { ...prior, platformMonthTokens: 19_999_000 });
    expect(() => m.reserve(5_000)).toThrow(/platform/);
  });
  it("a failed call counts its whole reservation as spent", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, prior);
    m.settleFailed(m.reserve(8_000));
    expect(m.state().runTokens).toBe(8_000);
  });
  it("USD limits apply only to provider-reported cost and never derive a price", () => {
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, perRunUsd: 1 }, prior);
    m.settle(m.reserve(5_000), 5_000, null);
    expect(m.state().runUsd).toBeNull();
    expect(() => m.reserve(5_000)).not.toThrow();
    m.settle(m.reserve(5_000), 5_000, 1.5);
    expect(() => m.reserve(5_000)).toThrow(/provider-reported cost/);
  });
  it("reads only a reported cost field", () => {
    expect(reportedCostUsd({ input_tokens: 100, output_tokens: 10 })).toBeNull();
    expect(reportedCostUsd({ cost_usd: 0.02 })).toBe(0.02);
  });
  it("projects input at 3 characters per token plus the full output allowance", () => {
    expect(projectCallTokens(3000)).toBe(1000 + 4000);
  });
});

describe("independent risk preview", () => {
  const limits = { maxOpenExposure: 10, maxDailyLoss: 2, maxTotalPositions: null, halted: false };
  const account = { openExposure: 0, openPositions: 0, dailyNet: 0 };
  it("sizes from account limits and market data only", () => {
    const p = riskPreview({ referencePrice: 100, asOf: "2026-11-11T00:00:00Z", candles, limits, account });
    expect(atr14(candles)).toBe(4);
    expect(p.status).toBe("estimate");
    expect(p.quantity).toBeCloseTo(0.1); // min(10/100 exposure, 2/4 loss)
    expect(p.positionValue).toBeCloseTo(10);
    expect(p.maxLossAtStop).toBeCloseTo(0.4);
    expect(p.bindingLimit).toBe("exposure");
    expect(p.leverage).toBe("1x (spot research estimate)");
  });
  it("uses the daily loss limit when it binds", () => {
    const p = riskPreview({ referencePrice: 100, asOf: null, candles, limits: { ...limits, maxOpenExposure: 1000 }, account });
    expect(p.quantity).toBeCloseTo(0.5);
    expect(p.bindingLimit).toBe("daily_loss");
  });
  it("is blocked by the emergency stop", () => {
    expect(riskPreview({ referencePrice: 100, asOf: null, candles, limits: { ...limits, halted: true }, account }).blockReason).toMatch(/emergency stop/);
  });
  it("is unavailable, not guessed, without saved limits", () => {
    const p = riskPreview({ referencePrice: 100, asOf: null, candles, limits: null, account });
    expect(p.status).toBe("unavailable");
    expect(p.quantity).toBeNull();
    expect(p.unavailable.join(" ")).toMatch(/risk settings unavailable/);
  });
  it("is unavailable when a limit is not set", () => {
    expect(riskPreview({ referencePrice: 100, asOf: null, candles, limits: { ...limits, maxDailyLoss: null }, account }).status).toBe("unavailable");
  });
  it("accounts for today's losses", () => {
    const p = riskPreview({ referencePrice: 100, asOf: null, candles, limits: { ...limits, maxOpenExposure: 1000 }, account: { ...account, dailyNet: -1 } });
    expect(p.remaining.dailyLoss).toBe(1);
    expect(p.quantity).toBeCloseTo(0.25);
  });
});

describe("research transparency", () => {
  const rows = [
    { agent: "market", status: "completed", report: rep("bullish") },
    { agent: "fundamentals", status: "unavailable", report: rep("insufficient_data", { limitations: ["No financial statements"] }) },
    { agent: "news", status: "completed", report: rep("bearish") },
    { agent: "sentiment", status: "unavailable", report: rep("insufficient_data", { limitations: ["Social data not connected"] }) },
    { agent: "bull", status: "completed", report: rep("bullish", { observations: ["Trend up"], risks: ["Overbought"] }) },
    { agent: "bear", status: "completed", report: rep("bearish", { observations: ["Weak news"] }) },
    { agent: "manager", status: "completed", report: rep("bullish") },
    { agent: "trader", status: "completed", report: rep("bullish") },
    { agent: "risk_aggressive", status: "completed", report: rep("bullish") },
    { agent: "risk_conservative", status: "completed", report: rep("neutral") },
    { agent: "risk_neutral", status: "completed", report: rep("bullish") },
    { agent: "portfolio", status: "completed", report: rep("neutral") },
  ];
  it("always lists 12 agents and marks missing ones not_run", () => {
    const a = allAgents(rows.slice(0, 3));
    expect(a.map((x) => x.agent)).toEqual([...RESEARCH_AGENTS]);
    expect(a.filter((x) => x.status === "not_run")).toHaveLength(9);
  });
  it("separates bull and bear arguments", () => {
    const b = bullBearArguments(allAgents(rows));
    expect(b.bull.available && b.bull.arguments).toEqual(["Trend up"]);
    expect(b.bull.available && b.bull.counterpoints).toEqual(["Overbought"]);
    expect(b.bear.available && b.bear.arguments).toEqual(["Weak news"]);
  });
  it("reports opposite directions and specific disagreements", () => {
    const d = agentDisagreement(allAgents(rows));
    expect(d.level).toBe("high");
    expect(d.conflicts.join(" ")).toMatch(/Research Manager .* Portfolio Manager/);
    expect(d.conflicts.join(" ")).toMatch(/risk analysts do not agree/);
  });
  it("lists unavailable sources with their stored reason, never a value", () => {
    const u = unavailableSources(allAgents(rows));
    expect(u.map((x) => x.source)).toEqual(["Financial statements", "Social sentiment"]);
    expect(u[1]?.reason).toBe("Social data not connected");
  });
  it("is complete when only analysts lacked a source", () => {
    expect(decisionOutcome(allAgents(rows), false)).toBe("complete");
  });
  it("is partial when a decision agent did not finish", () => {
    const r = rows.map((x) => x.agent === "trader" ? { ...x, status: "failed" } : x);
    expect(decisionOutcome(allAgents(r), false)).toBe("partial");
  });
  it("records a budget stop", () => { expect(decisionOutcome(allAgents(rows), true)).toBe("stopped_by_budget"); });
  it("always warns about hindsight", () => {
    expect(leakageWarnings("2026-11-10T00:00:00Z", "m", Date.parse("2026-11-11T00:00:00Z"))[0]).toMatch(/hindsight/);
  });
});
