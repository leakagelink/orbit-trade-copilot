// Research-only risk evaluation. Pure and browser-safe.
// Wraps the Risk Engine preview (sizing from saved account limits and market data only) around a research proposal.
// It never authorizes anything: status is always NOT_EXECUTABLE and executionAuthorized is always false.
import { researchProposal } from "./research-proposal";
import { RESEARCH_SYMBOLS } from "./research";
import type { RiskPreview } from "./research-risk-preview";

export const RISK_EVALUATION_NOTICE = "Research-only risk evaluation. No trade has been authorized or executed.";
export type RiskDecision = "PREVIEW_ONLY" | "INSUFFICIENT_DATA" | "REJECTED";
export interface RiskEvaluation {
  decision: RiskDecision; status: "NOT_EXECUTABLE"; executionAuthorized: false; basis: "risk_engine";
  symbol: string; marketType: "crypto" | "equity" | "unknown"; proposedDirection: "LONG" | "SHORT" | "NONE";
  reference: { entry: number | null; stopLoss: number | null; takeProfit: number | null; asOf: string | null; label: string };
  estimatedPositionSize: number | null; estimatedPositionValue: number | null; estimatedRiskAmount: number | null;
  availableRiskBudget: { exposure: number | null; dailyLoss: number | null; positions: number | null };
  accountExposure: number | null; strategyExposure: null; strategyNote: string;
  rejectionReasons: string[]; missingInputs: string[]; notes: string[]; notice: string; evaluatedAt: string;
}

const REF_LABEL = "Research reference levels from the last completed daily close and a 14-day average true range. Not verified execution prices.";
/** Allowed gap between the proposal's reference entry and the Risk Engine's own reference price. */
const ENTRY_TOLERANCE = 0.005;

export function evaluateResearchRisk(i: { symbol: string; proposal: unknown; preview: RiskPreview | null; riskEngineBlock: string | null; accountExposure: number | null; evaluatedAt: string }): RiskEvaluation {
  const supported = (RESEARCH_SYMBOLS as readonly string[]).includes(i.symbol);
  const parsed = researchProposal.safeParse(i.proposal);
  const p = parsed.success ? parsed.data : null;
  const dir = p?.status === "scenario" ? (p.direction === "long" ? "LONG" : p.direction === "short" ? "SHORT" : "NONE") : "NONE";
  const pv = i.preview;
  const base: RiskEvaluation = {
    decision: "INSUFFICIENT_DATA", status: "NOT_EXECUTABLE", executionAuthorized: false, basis: "risk_engine",
    symbol: i.symbol, marketType: !supported ? "unknown" : i.symbol.endsWith("-USD") ? "crypto" : "equity", proposedDirection: dir,
    reference: { entry: p?.hypotheticalEntry ?? null, stopLoss: p?.stopLoss ?? null, takeProfit: p?.takeProfit ?? null, asOf: p?.asOf ?? null, label: REF_LABEL },
    estimatedPositionSize: null, estimatedPositionValue: null, estimatedRiskAmount: null,
    availableRiskBudget: pv?.remaining ?? { exposure: null, dailyLoss: null, positions: null },
    accountExposure: i.accountExposure, strategyExposure: null,
    strategyNote: "Not applicable: this research is not linked to a trading strategy or bot, so there is no strategy budget or exposure.",
    rejectionReasons: [], missingInputs: [], notes: ["Leverage is fixed at 1x for this estimate. Fees, slippage and spread are not included."], notice: RISK_EVALUATION_NOTICE, evaluatedAt: i.evaluatedAt,
  };
  if (!supported) return { ...base, decision: "REJECTED", rejectionReasons: ["Unsupported research symbol"] };
  if (!p) return { ...base, missingInputs: ["A valid research proposal"] };
  if (p.status !== "scenario" || dir === "NONE") return { ...base, missingInputs: p.reasons.length ? p.reasons.map((r) => `Proposal withheld: ${r}`) : ["No directional research proposal"] };
  if (dir === "SHORT") base.notes.push("Short scenario: this 1x estimate does not assess borrowing, margin or futures requirements.");

  // Independent validation of the untrusted reference levels.
  const { hypotheticalEntry: e, stopLoss: s, takeProfit: t } = p;
  const invalid: string[] = [];
  if (e === null || s === null || t === null) invalid.push("Reference entry, stop-loss and take-profit are all required");
  else {
    if (dir === "LONG" && !(s < e && e < t)) invalid.push("For a long scenario the stop must be below and the target above the entry");
    if (dir === "SHORT" && !(t < e && e < s)) invalid.push("For a short scenario the stop must be above and the target below the entry");
    if (pv?.referencePrice != null && Math.abs(e - pv.referencePrice) / pv.referencePrice > ENTRY_TOLERANCE) invalid.push("Reference entry does not match the Risk Engine's own reference price");
  }
  if (invalid.length) return { ...base, decision: "REJECTED", rejectionReasons: invalid.map((r) => `Reference levels failed validation: ${r}`) };

  if (!pv) return { ...base, missingInputs: ["Risk Engine preview unavailable"] };
  if (pv.status === "blocked") return { ...base, decision: "REJECTED", rejectionReasons: [pv.blockReason ?? "Blocked by account risk limits"] };
  if (pv.status !== "estimate" || pv.quantity === null) return { ...base, missingInputs: pv.unavailable.length ? pv.unavailable : ["Risk Engine inputs unavailable"] };
  if (i.riskEngineBlock) return { ...base, decision: "REJECTED", rejectionReasons: [`Risk Engine: ${i.riskEngineBlock}`] };
  return { ...base, decision: "PREVIEW_ONLY", estimatedPositionSize: pv.quantity, estimatedPositionValue: pv.positionValue, estimatedRiskAmount: pv.maxLossAtStop };
}
