// Pure demo-wallet trade math (shared by server code and tests). All money is USD.
export const WALLET_FEE = 0.001; // 0.1% per side
export const WALLET_SLIP = 0.0005; // 0.05% simulated slippage

export function walletOpen(amountUsd: number, price: number, side: "buy" | "sell", quoteUsd: number) {
  const fill = price * (side === "buy" ? 1 + WALLET_SLIP : 1 - WALLET_SLIP);
  const qty = amountUsd / (fill * quoteUsd);
  const fee = amountUsd * WALLET_FEE;
  return { fill, qty, fee, debit: amountUsd + fee };
}

/** Closing a wallet position: returns gross PnL (USD), total fees, and what goes back to the wallet (never negative). */
export function walletClose(p: { side: "buy" | "sell"; entry: number; qty: number; margin: number }, price: number, quoteUsd: number) {
  const sign = p.side === "buy" ? 1 : -1;
  const exit = price * (p.side === "buy" ? 1 - WALLET_SLIP : 1 + WALLET_SLIP);
  const pnl = sign * (exit - p.entry) * p.qty * quoteUsd;
  const exitFee = p.qty * exit * quoteUsd * WALLET_FEE;
  const credit = Math.max(0, p.margin + pnl - exitFee);
  return { exit, pnl, fees: p.margin * WALLET_FEE + exitFee, credit };
}

/** Unrealized PnL in USD at the current price (before exit fees). */
export const walletUnrealized = (side: "buy" | "sell", entry: number, qty: number, price: number, quoteUsd: number) =>
  (side === "buy" ? 1 : -1) * (price - entry) * qty * quoteUsd;
