// Advisory decision labels derived from stored agent outputs. Pure and browser-safe.
import type { AgentRecord } from "./research-transparency";
import type { ResearchAgent } from "./research-pipeline";

export type ManagerConclusion = "BULLISH" | "BEARISH" | "NEUTRAL" | "INSUFFICIENT_EVIDENCE";
export type PortfolioDecision = "BUY_PROPOSAL" | "SELL_PROPOSAL" | "HOLD" | "NO_TRADE" | "INSUFFICIENT_EVIDENCE";
export const DECISION_LABELS: Record<ManagerConclusion | PortfolioDecision, string> = {
  BULLISH: "Bullish", BEARISH: "Bearish", NEUTRAL: "Neutral", INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  BUY_PROPOSAL: "Buy proposal", SELL_PROPOSAL: "Sell proposal", HOLD: "Hold", NO_TRADE: "No trade",
};

export function managerConclusion(a: AgentRecord | undefined): ManagerConclusion {
  if (!a || a.status !== "completed") return "INSUFFICIENT_EVIDENCE";
  return a.report.outlook === "bullish" ? "BULLISH" : a.report.outlook === "bearish" ? "BEARISH" : a.report.outlook === "neutral" ? "NEUTRAL" : "INSUFFICIENT_EVIDENCE";
}

/**
 * Portfolio Manager decision. A directional view becomes a buy/sell proposal only when the independently built
 * research scenario agrees; otherwise it is "No trade". Neutral is "Hold". All values are advisory research.
 */
export function portfolioDecision(a: AgentRecord | undefined, proposal: { status?: string; direction?: string } | null | undefined): PortfolioDecision {
  if (!a || a.status !== "completed" || a.report.outlook === "insufficient_data") return "INSUFFICIENT_EVIDENCE";
  if (a.report.outlook === "neutral") return "HOLD";
  const want = a.report.outlook === "bullish" ? "long" : "short";
  if (proposal?.status === "scenario" && proposal.direction === want) return want === "long" ? "BUY_PROPOSAL" : "SELL_PROPOSAL";
  return "NO_TRADE";
}

export const AGENT_ROLES: Record<ResearchAgent, string> = {
  market: "Price trend, momentum and volatility from daily candles",
  fundamentals: "Company revenue and earnings, where they apply",
  news: "Recent headline metadata",
  sentiment: "Social sentiment (not connected)",
  bull: "Strongest evidence-backed case for upside",
  bear: "Strongest evidence-backed case for downside",
  manager: "Weighs the bull and bear cases and states what is unresolved",
  trader: "Tests the manager's thesis against the original evidence",
  risk_aggressive: "Growth-oriented risk review",
  risk_conservative: "Downside-focused risk review",
  risk_neutral: "Balanced risk review",
  portfolio: "Final advisory research decision",
};
/** Inputs each agent receives (for the audit envelope). */
export const AGENT_INPUTS: Record<ResearchAgent, string[]> = {
  market: ["Yahoo Finance daily candles"], fundamentals: ["Yahoo Finance annual statements"], news: ["Yahoo Finance headline metadata"], sentiment: [],
  bull: ["Analyst reports from this run"], bear: ["Analyst reports from this run"], manager: ["Analyst reports", "Bull and Bear reports"],
  trader: ["Market snapshot", "Research reports"], risk_aggressive: ["Market snapshot", "Research reports", "Trader assessment"],
  risk_conservative: ["Market snapshot", "Research reports", "Trader assessment"], risk_neutral: ["Market snapshot", "Research reports", "Trader assessment"],
  portfolio: ["Market snapshot", "Research reports", "Trader assessment", "Three risk reviews"],
};
