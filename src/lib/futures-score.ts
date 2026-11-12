import { tradeNet, type AccountedTrade } from './trade-accounting';
/** Descriptive closed-trade metrics, never independent trading qualification. */
export interface ScoredTrade extends AccountedTrade { closed_at: string | null }
export const netPnl = tradeNet;
export function futuresScore(trades: ScoredTrade[]) {
  const closed = trades.filter((t) => t.closed_at && Number.isFinite(Date.parse(t.closed_at))).sort((a, b) => Date.parse(a.closed_at ?? '') - Date.parse(b.closed_at ?? ''));
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
    accountingComplete: nets.every(Number.isFinite),
    /** Legacy descriptive sample-count badge; never authorizes trading. */
    enoughEvidence: count >= 30,
  };
}
