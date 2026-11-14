// Phase 4H.8 — Central Risk Engine integration for live scalping (PAPER environment). Pure. A LiveSignal becomes a
// strict TradeProposal (no quantity, leverage or authorization fields exist on it), the risk context is built from the
// paper ledger, public exchange filters and the live mark price, and evaluateProposal (central-risk.ts, unchanged)
// decides ACCEPT / REJECT / INSUFFICIENT_DATA and sizes. Only that sizing ever reaches a paper order. Limits are never
// invented: every limit the owner has not entered is null, which the engine reports as INSUFFICIENT_DATA.
import { evaluateProposal, type RiskContext, type RiskDecision, type TradeProposal } from "./central-risk";
import { TESTNET_FUTURES_LIMITS } from "./futures-testnet-limits";
import { dayNet, equity, usedMargin, type PaperState, type SymbolFilters } from "./live-paper-exec";
import type { LiveSymbol, MarkEvent } from "./live-feed";
import type { LiveSignal } from "./live-scalp-signal";

export interface PaperRiskConfig {
  maxExposure: number | null; maxDailyLoss: number | null; maxPositions: number | null; maxLossPerTrade: number | null; maxMarginPerTrade: number | null;
  maxLeverage: number | null; liquidationBufferPct: number | null; maxDataAgeMs: number | null; maxProposalAgeMs: number | null; roundTripCostPct: number | null; strategyBudget: number | null;
}
export const EMPTY_PAPER_RISK: Readonly<PaperRiskConfig> = Object.freeze({ maxExposure: null, maxDailyLoss: null, maxPositions: null, maxLossPerTrade: null, maxMarginPerTrade: null, maxLeverage: null, liquidationBufferPct: null, maxDataAgeMs: null, maxProposalAgeMs: null, roundTripCostPct: null, strategyBudget: null });
/** Values the owner PROPOSED for paper (13 Nov 2026) — NOT APPROVED; shown separately and applied only by an explicit choice. */
export const OWNER_PROPOSED_PAPER_VALUES = Object.freeze({ liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 });
/** The owner's fixed Testnet limits, offered as a paper preset (same values; never written anywhere). */
export const TESTNET_PRESET: Readonly<Partial<PaperRiskConfig>> = Object.freeze({
  maxMarginPerTrade: TESTNET_FUTURES_LIMITS.maxMargin, maxLossPerTrade: TESTNET_FUTURES_LIMITS.maxLossReserve, maxDailyLoss: TESTNET_FUTURES_LIMITS.maxDailyLoss,
  maxExposure: TESTNET_FUTURES_LIMITS.maxExposure, maxPositions: TESTNET_FUTURES_LIMITS.maxOpenPositions, maxLeverage: TESTNET_FUTURES_LIMITS.maxLeverage,
});

/** LONG/SHORT signals only. The proposal id is the signal id: one evaluation authority per signal. */
export function signalToProposal(sig: LiveSignal): TradeProposal | null {
  if (sig.action !== "LONG" && sig.action !== "SHORT") return null;
  return { proposalId: sig.id, engine: "scalp_intraday", strategyId: `${sig.strategyId}@${sig.strategyVersion}`, symbol: sig.symbol, market: "usdm_futures", environment: "paper",
    side: sig.action, referencePrice: sig.entryReference, stopPrice: sig.stopReference, takeProfitPrice: sig.takeProfitReference, createdAt: sig.decidedAt };
}
export interface PaperRiskInputs {
  now: number; state: PaperState; limits: PaperRiskConfig; filters: SymbolFilters | null; mark: MarkEvent | null; marks: Partial<Record<LiveSymbol, number>>;
  killSwitch: boolean | null; strategyUsedLoss: number | null; evaluated: ReadonlySet<string>;
}
export function buildPaperRiskContext(symbol: LiveSymbol, proposalId: string, i: PaperRiskInputs): RiskContext {
  const s = i.state, open = Object.values(s.positions).filter(Boolean);
  const exposure = open.reduce((a, p) => a + p!.qty * (i.marks[p!.symbol] ?? p!.entryPrice), 0);
  return {
    now: i.now,
    account: { equity: equity(s, i.marks), availableMargin: s.wallet - usedMargin(s), openExposure: exposure, openPositions: open.length, dayNet: dayNet(s, i.marks), halted: i.killSwitch, environmentHalted: i.killSwitch },
    limits: { maxExposure: i.limits.maxExposure, maxDailyLoss: i.limits.maxDailyLoss, maxPositions: i.limits.maxPositions, maxLossPerTrade: i.limits.maxLossPerTrade, maxMarginPerTrade: i.limits.maxMarginPerTrade,
      maxLeverage: i.limits.maxLeverage, liquidationBufferPct: i.limits.liquidationBufferPct, maxDataAgeMs: i.limits.maxDataAgeMs, maxProposalAgeMs: i.limits.maxProposalAgeMs, roundTripCostPct: i.limits.roundTripCostPct },
    strategy: { budget: i.limits.strategyBudget, usedLoss: i.strategyUsedLoss },
    // Mark timestamp = LOCAL receive time, so the age check uses one clock (exchange time is shown separately).
    market: { markPrice: i.mark?.markPrice ?? null, markTimestamp: i.mark?.receivedAt ?? null, stepSize: i.filters?.stepSize ?? null, minNotional: i.filters?.minNotional ?? null, maintenanceMarginRate: i.filters?.maintMarginRate ?? null },
    orders: { sameProposalSeen: i.evaluated.has(proposalId) || s.proposals.includes(proposalId), unresolvedOrders: 0, openPositionOnSymbol: Boolean(s.positions[symbol]) || s.orders.some((o) => o.status === "OPEN" && o.symbol === symbol) },
  };
}
export interface SignalRiskResult { proposal: TradeProposal | null; decision: RiskDecision | null; skipped: string | null }
/** Signal → proposal → Central Risk decision. Expired signals are not evaluated. AI output can never enter here. */
export function evaluateSignalRisk(sig: LiveSignal, i: PaperRiskInputs): SignalRiskResult {
  const proposal = signalToProposal(sig);
  if (!proposal) return { proposal: null, decision: null, skipped: `${sig.action}: nothing to evaluate` };
  if (i.now > sig.expiresAt) return { proposal, decision: null, skipped: "signal expired before evaluation" };
  return { proposal, decision: evaluateProposal(proposal, buildPaperRiskContext(sig.symbol, proposal.proposalId, i)), skipped: null };
}
/** Realised paper loss attributed to this strategy today (positive number), from the paper fills. */
export function strategyLossToday(s: PaperState, now: number): number {
  const day = Math.floor(now / 86_400_000), net = s.fills.filter((f) => Math.floor(f.at / 86_400_000) === day).reduce((a, f) => a + f.realizedPnl - f.fee, 0);
  return Math.max(0, -net);
}
