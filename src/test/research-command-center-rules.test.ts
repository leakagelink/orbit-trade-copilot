// Phase 1 rules: spending limits, cost labels, read-only risk evaluation and source statuses.
import { describe, expect, it } from "vitest";
import { costStatus, createBudgetMeter, DEFAULT_RESEARCH_BUDGET, ResearchBudgetStop } from "@/lib/research-budget";
import { evaluateResearchRisk, RISK_EVALUATION_NOTICE } from "@/lib/research-risk-evaluation";
import { riskPreview } from "@/lib/research-risk-preview";
import { dataQuality } from "@/lib/research-data-quality";
import { portfolioDecision } from "@/lib/research-decisions";
import type { AgentRecord } from "@/lib/research-transparency";

const prior = { userDayTokens: 0, userMonthTokens: 0, platformMonthTokens: 0, platformMonthUsd: null };

describe("research spending limits", () => {
  it("refuses a call that would pass the daily per-user limit", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, { ...prior, userDayTokens: 599_000 });
    expect(() => m.reserve(5_000)).toThrow(ResearchBudgetStop);
    expect(m.state().stoppedBy).toBe("user_day_tokens");
  });
  it("after any stop, every later call is refused too", () => {
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxCallsPerRun: 1 }, prior);
    m.reserve(1_000);
    expect(() => m.reserve(1_000)).toThrow(/Call limit/);
    expect(() => m.reserve(1)).toThrow(ResearchBudgetStop);
    expect(m.state().calls).toBe(1);
  });
  it("stops once the run passes its time limit", () => {
    let t = 0;
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxRunSeconds: 60 }, prior, { startedAt: 0, now: () => t });
    t = 61_000;
    expect(() => m.reserve(1_000)).toThrow(/Time limit/);
  });
  it("a refused format correction fails only that agent, not the run", () => {
    const m = createBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxRepairsPerRun: 0 }, prior);
    expect(() => m.reserve(1_000, "repair")).toThrow(/Format correction not attempted/);
    expect(m.state().stoppedBy).toBeNull();
    expect(() => m.reserve(1_000)).not.toThrow();
  });
  it("cancellation stops all further calls", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, prior);
    expect(() => m.halt("cancelled", "Cancelled by you")).toThrow(ResearchBudgetStop);
    expect(() => m.reserve(1_000)).toThrow(/Cancelled by you/);
  });
  it("a failed call counts its full reservation as spent", () => {
    const m = createBudgetMeter(DEFAULT_RESEARCH_BUDGET, prior);
    m.settleFailed(m.reserve(7_000));
    expect(m.state().runTokens).toBe(7_000);
  });
});

describe("cost labels", () => {
  it("no provider price means unknown cost, never an estimate", () => {
    const c = costStatus([null, null]);
    expect(c.status).toBe("UNKNOWN_COST");
    expect(c.amountUsd).toBeNull();
  });
  it("a partly reported set stays unknown but keeps the reported part", () => {
    const c = costStatus([0.5, null]);
    expect(c.status).toBe("UNKNOWN_COST");
    expect(c.reportedPartUsd).toBe(0.5);
  });
  it("fully reported costs are actual", () => {
    expect(costStatus([0.25, 0.75])).toMatchObject({ status: "ACTUAL_PROVIDER_COST", amountUsd: 1 });
  });
});

const now = Date.parse("2026-11-12T10:00:00Z");
const candles = Array.from({ length: 30 }, (_, i) => ({ t: now - (30 - i) * 86_400_000, o: 100, h: 102, l: 98, c: 100, v: 1 }));
const asOf = new Date(candles.at(-1)!.t).toISOString();
const preview = riskPreview({ referencePrice: 100, asOf, candles, limits: { maxOpenExposure: 1000, maxDailyLoss: 50, maxTotalPositions: 3, halted: false }, account: { openExposure: 0, openPositions: 0, dailyNet: 0 } });
const proposal = (o: Record<string, unknown> = {}) => ({ advisoryOnly: true, executionAllowed: false, status: "scenario", direction: "long", referenceClose: 100, asOf, hypotheticalEntry: 100, stopLoss: 96, takeProfit: 108, rewardRisk: 2, positionSize: null, confidence: null, reasons: [], limitations: [], ...o });
const evaluate = (p: unknown, pv = preview, block: string | null = null) => evaluateResearchRisk({ symbol: "BTC-USD", proposal: p, preview: pv, riskEngineBlock: block, accountExposure: 0, evaluatedAt: new Date(now).toISOString() });

describe("research risk evaluation", () => {
  it("is never executable, whatever the outcome", () => {
    for (const e of [evaluate(proposal()), evaluate(null), evaluate(proposal({ stopLoss: 120 })), evaluate(proposal(), preview, "Halted")]) {
      expect(e.status).toBe("NOT_EXECUTABLE");
      expect(e.executionAuthorized).toBe(false);
      expect(e.notice).toBe(RISK_EVALUATION_NOTICE);
    }
  });
  it("returns insufficient data, with no size, when there is no directional proposal", () => {
    const e = evaluate(proposal({ status: "withheld", direction: "none", hypotheticalEntry: null, stopLoss: null, takeProfit: null, rewardRisk: null, reasons: ["No consensus"] }));
    expect(e.decision).toBe("INSUFFICIENT_DATA");
    expect(e.estimatedPositionSize).toBeNull();
  });
  it("rejects a long scenario whose stop is above the entry", () => {
    const e = evaluate(proposal({ stopLoss: 105 }));
    expect(e.decision).toBe("REJECTED");
    expect(e.estimatedPositionSize).toBeNull();
  });
  it("rejects an entry that does not match the Risk Engine's own price", () => {
    expect(evaluate(proposal({ hypotheticalEntry: 120, stopLoss: 110, takeProfit: 140 })).decision).toBe("REJECTED");
  });
  it("a Risk Engine block rejects the preview", () => {
    const e = evaluate(proposal(), preview, "Trading halted");
    expect(e.decision).toBe("REJECTED");
    expect(e.rejectionReasons.join(" ")).toMatch(/Trading halted/);
  });
  it("quantities or leverage supplied with a proposal are ignored", () => {
    const e = evaluate({ ...proposal(), quantity: 50, leverage: 100, notional: 1_000_000 });
    expect(e.decision).toBe("PREVIEW_ONLY");
    expect(e.estimatedPositionSize).toBe(preview.quantity);
    expect(e.estimatedPositionSize).not.toBe(50);
    expect(e.notes.join(" ")).toMatch(/fixed at 1x/);
  });
  it("a proposal carrying its own position size is not accepted at all", () => {
    const e = evaluate(proposal({ positionSize: 50 }));
    expect(e.decision).toBe("INSUFFICIENT_DATA");
    expect(e.estimatedPositionSize).toBeNull();
  });
  it("a proposal claiming execution is allowed is not accepted and authorizes nothing", () => {
    const e = evaluate(proposal({ executionAllowed: true }));
    expect(e.decision).toBe("INSUFFICIENT_DATA");
    expect(e.executionAuthorized).toBe(false);
  });
  it("rejects a short scenario whose stop is below the entry", () => {
    expect(evaluate(proposal({ direction: "short", stopLoss: 96, takeProfit: 92 })).decision).toBe("REJECTED");
  });
  it("missing Risk Engine inputs mean insufficient data, not a guessed size", () => {
    const noLimits = riskPreview({ referencePrice: 100, asOf, candles, limits: null, account: { openExposure: 0, openPositions: 0, dailyNet: 0 } });
    const e = evaluate(proposal(), noLimits);
    expect(e.decision).toBe("INSUFFICIENT_DATA");
    expect(e.estimatedPositionSize).toBeNull();
    expect(e.missingInputs.length).toBeGreaterThan(0);
  });
  it("sizes from the Risk Engine, not from the proposal", () => {
    const e = evaluate(proposal());
    expect(e.decision).toBe("PREVIEW_ONLY");
    expect(e.estimatedPositionSize).toBe(preview.quantity);
  });
});

const agent = (a: string, outlook: string, status = "completed"): AgentRecord => ({ agent: a, status, report: { summary: "s", outlook, observations: [], risks: [], limitations: [] } }) as unknown as AgentRecord;
describe("source statuses", () => {
  const base = { now, agents: [], fundamentals: null, news: null, sentiment: null };
  it("crypto company statements are not applicable and sentiment is unavailable", () => {
    const q = dataQuality({ ...base, symbol: "BTC-USD", market: { asOf, fetchedAt: null, candles: 100 } });
    expect(q.sources.find((s) => s.key === "fundamentals")?.status).toBe("NOT_APPLICABLE");
    expect(q.sources.find((s) => s.key === "sentiment")?.status).toBe("UNAVAILABLE");
    expect(q.sources.find((s) => s.key === "news_history")?.status).toBe("UNAVAILABLE");
  });
  it("old market data is stale and missing market data is unavailable", () => {
    expect(dataQuality({ ...base, symbol: "BTC-USD", market: { asOf: new Date(now - 5 * 86_400_000).toISOString(), fetchedAt: null, candles: 100 } }).sources[0]!.status).toBe("STALE");
    expect(dataQuality({ ...base, symbol: "BTC-USD", market: null }).sources[0]!.status).toBe("UNAVAILABLE");
  });
  it("opposite agent directions are shown as conflicting", () => {
    const q = dataQuality({ ...base, symbol: "BTC-USD", market: { asOf, fetchedAt: null, candles: 100 }, agents: [agent("bull", "bullish"), agent("bear", "bearish"), agent("market", "bullish"), agent("manager", "bearish")] });
    expect(["CONFLICTING", "AVAILABLE"]).toContain(q.sources.find((s) => s.key === "agents")?.status);
    expect(q.dimensions.modelUncertainty.status).toBe("NOT_ASSESSED");
    expect(q.dimensions).not.toHaveProperty("confidence");
  });
});

describe("portfolio decision", () => {
  it("a bullish portfolio view without a scenario is not a buy proposal", () => {
    expect(portfolioDecision(agent("portfolio", "bullish"), { status: "withheld", direction: "none" })).not.toBe("BUY_PROPOSAL");
  });
  it("a failed portfolio manager means insufficient evidence", () => {
    expect(portfolioDecision(agent("portfolio", "bullish", "failed"), null)).toBe("INSUFFICIENT_EVIDENCE");
  });
});
