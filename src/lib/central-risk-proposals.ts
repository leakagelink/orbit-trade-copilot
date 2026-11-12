// Adapters from each engine's output to the ONE Central Risk Engine proposal format. Pure. Only direction, reference
// price, stop and target cross over; nothing an engine or a model says can become a quantity, leverage or authorization.
import type { TradeProposal } from "./central-risk";
import type { ResearchProposal } from "./research-proposal";
import type { IntradaySignal } from "./scalp-intraday";
import type { UltrafastSignal } from "./scalp-microstructure";

type Meta = { proposalId: string; strategyId: string; symbol: string; market: TradeProposal["market"]; environment: TradeProposal["environment"]; createdAt: number };
export type Adapted = { proposal: TradeProposal; noTrade: null } | { proposal: null; noTrade: string };

/** Engine A. Research stays non-executable, so its proposals are only ever evaluated for the paper environment. */
export function fromResearch(p: ResearchProposal, m: Omit<Meta, "environment">): Adapted {
  if (p.status !== "scenario" || p.direction === "none") return { proposal: null, noTrade: p.reasons[0] ?? "Research withheld a direction" };
  return { proposal: { ...m, environment: "paper", engine: "research", side: p.direction === "long" ? "LONG" : "SHORT", referencePrice: p.referenceClose, stopPrice: p.stopLoss, takeProfitPrice: p.takeProfit }, noTrade: null };
}
/** Engine B, 1–5 minute strategy. */
export function fromIntraday(s: IntradaySignal, m: Meta): Adapted {
  if (s.action === "NO_TRADE") return { proposal: null, noTrade: s.reasons[0] ?? "NO_TRADE" };
  return { proposal: { ...m, engine: "scalp_intraday", side: s.action, referencePrice: s.features?.close ?? null, stopPrice: s.stop, takeProfitPrice: s.target }, noTrade: null };
}
/** Engine B, seconds-level strategy: stop/target come from the deterministic bracket the caller derives, never from a model. */
export function fromUltrafast(s: UltrafastSignal, m: Meta, bracket: { stopPrice: number; takeProfitPrice: number | null; referencePrice: number }): Adapted {
  if (s.action === "NO_TRADE") return { proposal: null, noTrade: s.reasons[0] ?? "NO_TRADE" };
  return { proposal: { ...m, engine: "scalp_ultrafast", side: s.action, ...bracket }, noTrade: null };
}
