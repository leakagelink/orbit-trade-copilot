// Pure forward paper performance summary, per strategy. Uses only the paper ledger — never backtest results.
import { performanceMetrics } from "./backtest-metrics";

export const PAPER_EVALUATION_THRESHOLD = 100; // settled observations before any evaluation; NOT statistical significance

export interface PaperTradeRow { closed_bar_t: number; opened_bar_t: number; gross_pnl: number; fees: number; spread_cost: number; slippage_cost: number; net_pnl: number }
export interface PaperBarRow { bar_t: number; equity: number; unrealized: number }

const isoWeek = (t: number) => {
  const d = new Date(t); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
};

/** Change in closing equity per period; the first period is measured from the starting capital. */
export function periodPnl(bars: PaperBarRow[], capital: number, by: "day" | "week") {
  const sorted = [...bars].sort((a, b) => a.bar_t - b.bar_t);
  const last = new Map<string, number>();
  for (const b of sorted) last.set(by === "day" ? new Date(b.bar_t).toISOString().slice(0, 10) : isoWeek(b.bar_t), Number(b.equity));
  let prev = capital;
  return [...last].map(([period, equity]) => { const pnl = equity - prev; prev = equity; return { period, equity, pnl }; });
}

export function paperSummary(trades: PaperTradeRow[], bars: PaperBarRow[], capital: number, tfMs: number) {
  const sortedBars = [...bars].sort((a, b) => a.bar_t - b.bar_t);
  const m = performanceMetrics(
    trades.map((t) => ({ entryT: Number(t.opened_bar_t), exitT: Number(t.closed_bar_t), pnl: Number(t.gross_pnl), fees: Number(t.fees), spread: Number(t.spread_cost), slippage: Number(t.slippage_cost), funding: 0, net: Number(t.net_pnl) })),
    sortedBars.map((b) => ({ t: Number(b.bar_t), v: Number(b.equity) })), capital, tfMs);
  const latest = sortedBars.at(-1);
  const settled = trades.length;
  return {
    ...m,
    realizedNet: m.netProfit,
    unrealized: latest ? Number(latest.unrealized) : 0,
    equity: latest ? Number(latest.equity) : capital,
    settled,
    thresholdReached: settled >= PAPER_EVALUATION_THRESHOLD,
    verdict: settled >= PAPER_EVALUATION_THRESHOLD
      ? `${settled} settled paper trades: enough for an initial evaluation, not proof of statistical significance or future profit.`
      : `${settled} of ${PAPER_EVALUATION_THRESHOLD} settled paper trades: too few to judge profitability.`,
  };
}
