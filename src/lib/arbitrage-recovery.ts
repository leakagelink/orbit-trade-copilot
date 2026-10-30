/** Read-only reconciliation decisions. Missing evidence never authorizes another order. */
export interface OrderEvidence {
  orderId: string;
  state: "filled" | "cancelled" | "open";
  qty: number;
  avgPrice: number;
  quoteValue: number;
  feeQuote: number | null;
}

export function recoveryDecision(buy: OrderEvidence | null, sell: OrderEvidence | null) {
  const valid = (o: OrderEvidence) => [o.qty, o.avgPrice, o.quoteValue].every(Number.isFinite) && o.qty >= 0 && o.quoteValue >= 0 && (o.qty === 0 || o.avgPrice > 0) && (o.feeQuote == null || Number.isFinite(o.feeQuote));
  if ((buy && !valid(buy)) || (sell && !valid(sell))) return { status: "needs_review", realizedNet: null, message: "Invalid exchange evidence. New executions remain locked. No orders were sent during verification." } as const;
  if (!buy || !sell) return { status: "needs_review", realizedNet: null, message: "An order could not be verified. New executions remain locked; inspect both exchanges. No orders were sent." } as const;
  if (buy.state === "cancelled" && sell.state === "cancelled" && buy.qty === 0 && sell.qty === 0) {
    return { status: "blocked", realizedNet: null, message: "Both exchanges confirm terminal orders with zero fills. No orders were sent during reconciliation." } as const;
  }
  const tolerance = Math.max(buy.qty, sell.qty) * 1e-8;
  if (buy.state !== "filled" || sell.state !== "filled" || buy.qty <= 0 || sell.qty <= 0 || Math.abs(buy.qty - sell.qty) > tolerance) {
    return { status: "needs_review", realizedNet: null, message: "Open, partial or unequal fills remain. New executions stay locked; manage unmatched inventory on the exchanges. No orders were sent." } as const;
  }
  const knownFees = buy.feeQuote != null && sell.feeQuote != null;
  const realizedNet = knownFees ? sell.quoteValue - buy.quoteValue - (buy.feeQuote ?? 0) - (sell.feeQuote ?? 0) : null;
  return { status: "completed", realizedNet, message: knownFees ? "Both terminal fills verified against the exchanges. No new orders were sent." : "Both terminal fills verified. Net unavailable because a fee currency could not be valued. No new orders were sent." } as const;
}