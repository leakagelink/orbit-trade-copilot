import { z } from "zod";
import { type researchSnapshot } from "./research";
import type { AgentResult } from "./research-pipeline";

export const researchProposal = z.object({
  advisoryOnly: z.literal(true), executionAllowed: z.literal(false),
  status: z.enum(["scenario", "withheld"]), direction: z.enum(["long", "short", "none"]),
  referenceClose: z.number().positive().nullable(), asOf: z.string().nullable(),
  hypotheticalEntry: z.number().positive().nullable(), stopLoss: z.number().positive().nullable(),
  takeProfit: z.number().positive().nullable(), rewardRisk: z.number().positive().nullable(),
  positionSize: z.null(), confidence: z.null(), reasons: z.array(z.string()), limitations: z.array(z.string()),
});
export type ResearchProposal = z.infer<typeof researchProposal>;

/** Historical scenarios only: model text never supplies prices, sizing or execution authority. */
export function buildResearchProposal(snapshot: ReturnType<typeof researchSnapshot>, results: AgentResult[], now = Date.now()): ResearchProposal {
  const required = ["market", "manager", "trader", "risk_aggressive", "risk_conservative", "risk_neutral", "portfolio"];
  const reasons: string[] = [];
  for (const agent of required) {
    const result = results.find(r => r.agent === agent);
    if (!result || result.status !== "completed" || result.report.outlook === "insufficient_data") reasons.push(`${agent}: completed evidence-backed assessment required.`);
  }
  const portfolio = results.find(r => r.agent === "portfolio");
  const trader = results.find(r => r.agent === "trader");
  const conservative = results.find(r => r.agent === "risk_conservative");
  const outlook = portfolio?.report.outlook;
  if (outlook !== "bullish" && outlook !== "bearish") reasons.push("No directional portfolio consensus.");
  if (trader?.report.outlook !== outlook || conservative?.report.outlook !== outlook) reasons.push("Trader, conservative risk and portfolio assessments do not agree.");
  const timestamp = Date.parse(snapshot.asOf);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > 7 * 86400000) reasons.push("Historical market evidence is stale or invalid.");
  const candles = snapshot.candles.slice(-15);
  const ranges = candles.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - (candles[i]?.c ?? c.c)), Math.abs(c.l - (candles[i]?.c ?? c.c))));
  const atr = ranges.reduce((a,b) => a+b,0) / ranges.length;
  if (ranges.length !== 14 || !Number.isFinite(atr) || atr <= 0 || !Number.isFinite(snapshot.close) || snapshot.close <= 2 * atr) reasons.push("Valid 14-day volatility and positive price levels are required.");
  const base = {
    advisoryOnly: true as const, executionAllowed: false as const,
    referenceClose: Number.isFinite(snapshot.close) && snapshot.close > 0 ? snapshot.close : null,
    asOf: Number.isFinite(timestamp) ? snapshot.asOf : null, positionSize: null, confidence: null,
    reasons, limitations: ["Historical daily closing-price scenario, not a live entry quote.", "Levels use a 14-day average true range: stop at 1 ATR, target at 2 ATR. Fees and slippage are not included.", "Position sizing and calibrated confidence are unavailable; account exposure and execution eligibility were not assessed.", "Missing source limitations remain applicable. No orders are created."],
  };
  if (reasons.length) return researchProposal.parse({ ...base, status: "withheld", direction: "none", hypotheticalEntry: null, stopLoss: null, takeProfit: null, rewardRisk: null });
  const sign = outlook === "bullish" ? 1 : -1;
  return researchProposal.parse({ ...base, status: "scenario", direction: sign === 1 ? "long" : "short", hypotheticalEntry: snapshot.close, stopLoss: snapshot.close - sign*atr, takeProfit: snapshot.close + sign*2*atr, rewardRisk: 2 });
}