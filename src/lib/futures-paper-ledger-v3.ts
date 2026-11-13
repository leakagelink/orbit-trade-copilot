// Payload builder for DRAFT migration 0049 (`futures_paper_commit_bar_v3`, not applied; replaces draft 0046). Pure;
// browser-safe. It reads the pure Futures paper engine's output and adds only FACTS the database needs to recompute
// risk itself: the public candle of every account symbol, and for each accepted order its proposal stop price,
// creation time, leverage and strategy. It never sends a risk figure or a fill id — the database derives both and
// refuses a payload that carries either. It changes no engine behaviour and imports no order, exchange, credential,
// wallet, database or AI module (isolation test). Nothing calls it in the app: no worker exists, nothing is scheduled.
import type { FPBar, FPEvent, FPIntent, FPState } from "./futures-paper-engine";

export const FUTURES_PAPER_LEDGER_V3 = "futures-paper-ledger-v3 (draft 0049)" as const;

export class LedgerPayloadV3Error extends Error {}

/**
 * @param prev    state before the candle (pending entries that fill in this candle live here)
 * @param next    state after the candle (all symbols of the account stepped for the same candle)
 * @param events  the candle's events for every symbol, in sequence order
 * @param bars    the candle of every account symbol (stored by the database; every recomputation reads it)
 * @param intents the proposals evaluated in this candle (stop price and creation time of accepted orders)
 */
export function futuresPaperCommitPayloadV3(prev: FPState, next: FPState, events: FPEvent[], bars: FPBar[], intents: FPIntent[]) {
  const candles: Record<string, unknown> = {};
  for (const b of bars) {
    if (candles[b.symbol]) throw new LedgerPayloadV3Error(`candle for ${b.symbol} appears twice`);
    if (!b.mark) throw new LedgerPayloadV3Error(`candle for ${b.symbol} has no mark prices`);
    candles[b.symbol] = {
      trade: { o: b.trade.o, h: b.trade.h, l: b.trade.l, c: b.trade.c, v: b.trade.v },
      mark: { o: b.mark.o, h: b.mark.h, l: b.mark.l, c: b.mark.c },
      index_c: b.index ? b.index.c : null,
      funding: b.funding.map((f) => ({ t: f.t, rate: f.rate })),
    };
  }
  return {
    wallet: next.wallet, state: next, candles,
    events: events.map((e) => {
      const base = { seq: e.seq, t: e.t, symbol: e.symbol, kind: e.kind, side: e.side, qty: e.qty, price: e.price, fee: e.fee, pnl: e.pnl, wallet_delta: e.walletDelta, margin_delta: e.marginDelta, reason: e.reason, proposal_id: e.proposalId };
      if (e.kind === "order_accepted") {
        const pend = next.pending[e.symbol];
        const it = intents.find((i) => i.proposal.proposalId === e.proposalId);
        if (!pend || pend.proposalId !== e.proposalId || !it || it.proposal.stopPrice === null) throw new LedgerPayloadV3Error(`accepted order ${e.seq} has no matching pending entry or proposal`);
        return { ...base, strategy_id: pend.strategyId, stop_price: it.proposal.stopPrice, leverage: pend.leverage, proposal_created_t: it.proposal.createdAt };
      }
      if (e.kind === "entry_fill") {
        const src = prev.pending[e.symbol] ?? next.pending[e.symbol];
        if (!src || src.proposalId !== e.proposalId) throw new LedgerPayloadV3Error(`entry fill ${e.seq} has no matching pending entry`);
        return { ...base, strategy_id: src.strategyId };
      }
      return { ...base, strategy_id: null };
    }),
  };
}
