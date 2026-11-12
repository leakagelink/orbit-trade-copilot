// Payload builder for DRAFT migration 0046 (`futures_paper_commit_bar_v2`, not applied). Pure; browser-safe.
// It reads the pure Futures paper engine's output and adds what the reviewed successor ledger requires: a strategy id
// and the reserved risk on every entry fill, deterministic fill ids (a fill can never be recorded twice after a retry)
// and the marks the database uses to re-check daily loss and exposure at fill time. It changes no engine behaviour,
// and imports no order, exchange, credential, wallet, database or AI module (isolation test). Nothing calls it in the
// app: there is no Futures paper worker and nothing is scheduled.
import type { FPEvent, FPState } from "./futures-paper-engine";

export const FUTURES_PAPER_LEDGER_V2 = "futures-paper-ledger-v2 (draft 0046)" as const;

export class LedgerPayloadError extends Error {}

/**
 * @param prev   state before the candle (pending entries that fill in this candle live here)
 * @param next   state after the candle (all symbols of the account stepped for the same candle)
 * @param events the candle's events for every symbol, in sequence order
 * @param marks  latest mark price for every account symbol (required by the database for every open position)
 * @param roundTripCostPct cost assumption the Risk Engine sized with; reserved risk = qty × (stop distance + costs)
 */
export function futuresPaperCommitPayloadV2(prev: FPState, next: FPState, events: FPEvent[], marks: Record<string, number>, roundTripCostPct: number) {
  if (!(roundTripCostPct >= 0) || !Number.isFinite(roundTripCostPct)) throw new LedgerPayloadError("round-trip cost must be a finite, non-negative number");
  for (const [s, m] of Object.entries(marks)) if (!(m > 0) || !Number.isFinite(m)) throw new LedgerPayloadError(`mark for ${s} is not a positive number`);
  return {
    wallet: next.wallet, state: next, marks,
    events: events.map((e) => {
      const base = { seq: e.seq, t: e.t, symbol: e.symbol, kind: e.kind, side: e.side, qty: e.qty, price: e.price, fee: e.fee, pnl: e.pnl, wallet_delta: e.walletDelta, margin_delta: e.marginDelta, reason: e.reason, proposal_id: e.proposalId };
      if (e.kind === "entry_fill") {
        const src = prev.pending[e.symbol] ?? next.pending[e.symbol];
        if (!src || src.proposalId !== e.proposalId || e.price === null) throw new LedgerPayloadError(`entry fill ${e.seq} has no matching pending entry`);
        const risk = e.qty * src.stopDist + e.qty * e.price * (roundTripCostPct / 100);
        return { ...base, strategy_id: src.strategyId, fill_id: `${e.proposalId}:entry:${e.t}`, risk_amount: risk };
      }
      if (e.kind === "exit_fill" || e.kind === "liquidation") return { ...base, strategy_id: null, fill_id: `${e.proposalId}:close`, risk_amount: null };
      return { ...base, strategy_id: null, fill_id: null, risk_amount: null };
    }),
  };
}
