// Pure forward-only outcome of stored Research AI proposals. Makes no AI calls and creates no orders.
// Only daily bars that open after the proposal was recorded are used; a proposal whose evidence is dated after its
// own decision time is excluded as a leak. Results are descriptive, never evidence of AI profitability.
import type { Candle } from "./indicators";
import { observePaperResearch } from "./research-paper";
import { researchProposal } from "./research-proposal";

export const CONTAMINATION_NOTICE = "Possibly contaminated: AI models are trained on historical market text, so an AI opinion about any past period may reflect hindsight. These outcomes are not clean out-of-sample evidence and do not show that the AI is profitable.";
export const OUTCOME_COSTS = { feePct: 0.1, slippagePct: 0.05 };
export const MIN_OUTCOMES_FOR_SUMMARY = 30;

export interface StoredDecision { proposalId: string; runId: string; symbol: string; decidedAt: number; proposal: unknown }

export function researchOutcome(d: StoredDecision, candles: Candle[], now: number) {
  const parsed = researchProposal.safeParse(d.proposal);
  const base = { proposalId: d.proposalId, runId: d.runId, symbol: d.symbol, decidedAt: d.decidedAt };
  if (!parsed.success) return { ...base, status: "invalid" as const, direction: null, note: "Stored proposal does not match the proposal format" };
  const p = parsed.data;
  if (p.status !== "scenario" || p.direction === "none") return { ...base, status: "no_scenario" as const, direction: null, note: "No directional scenario (no trade or insufficient evidence)" };
  const asOf = p.asOf ? Date.parse(p.asOf) : NaN;
  if (!Number.isFinite(asOf) || asOf > d.decidedAt) return { ...base, status: "excluded" as const, direction: p.direction, note: "Evidence time is missing or later than the decision time" };
  const r = observePaperResearch({ proposal: p, confirmedAt: d.decidedAt, quantity: 1, ...OUTCOME_COSTS }, candles, now);
  return { ...base, status: r.status, direction: p.direction, entry: r.entry, exit: r.exit, reason: r.reason, bars: r.bars,
    netPct: r.entry && r.netPnl !== null ? (r.netPnl / r.entry) * 100 : null, note: r.status === "waiting" ? r.reason : null };
}

export function summarizeOutcomes(rows: ReturnType<typeof researchOutcome>[]) {
  const closed = rows.filter((r) => r.status === "closed" && "netPct" in r && r.netPct !== null) as (ReturnType<typeof researchOutcome> & { netPct: number })[];
  return {
    stored: rows.length, directional: rows.filter((r) => r.direction !== null).length, closed: closed.length,
    open: rows.filter((r) => r.status === "open").length,
    // Below the sample floor no average is shown at all, to avoid implying a track record.
    averageNetPct: closed.length >= MIN_OUTCOMES_FOR_SUMMARY ? closed.reduce((a, r) => a + r.netPct, 0) / closed.length : null,
    note: closed.length < MIN_OUTCOMES_FOR_SUMMARY ? `Only ${closed.length} closed outcome${closed.length === 1 ? "" : "s"}; at least ${MIN_OUTCOMES_FOR_SUMMARY} are needed before any average is shown.` : "Descriptive only; possibly contaminated.",
  };
}
