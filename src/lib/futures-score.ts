/** Pure Futures trade scoring. Net PnL = gross realized - fees + funding (fees stored separately). */
export interface ScoredTrade { realized_pnl: number | null; fees: number | null; funding_pnl?: number | null; closed_at: string | null }
export function netPnl(t: ScoredTrade) { return Number(t.realized_pnl ?? 0) - Number(t.fees ?? 0) + Number(t.funding_pnl ?? 0); }
export function futuresScore(trades: ScoredTrade[]) {
  const closed = trades.filter((t) => t.closed_at).sort((a, b) => Date.parse(a.closed_at!) - Date.parse(b.closed_at!));
  const nets = closed.map(netPnl);
  const wins = nets.filter((n) => n > 0), losses = nets.filter((n) => n <= 0);
  const grossWin = wins.reduce((s, n) => s + n, 0), grossLoss = -losses.reduce((s, n) => s + n, 0);
  let eq = 0, peak = 0, maxDd = 0;
  for (const n of nets) { eq += n; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
  const count = nets.length;
  return {
    count, wins: wins.length, losses: losses.length,
    winRate: count ? wins.length / count : null,
    netPnl: eq, fees: closed.reduce((s, t) => s + Number(t.fees ?? 0), 0),
    avgPnl: count ? eq / count : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdown: maxDd,
    /** Descriptive only; below 30 trades there is not enough evidence. Never authorizes trading. */
    enoughEvidence: count >= 30,
  };
}
