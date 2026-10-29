// Portfolio metrics computed strictly from stored trading records.
export interface TradeRow {
  realized_pnl: number | string;
  fees: number | string;
  closed_at: string | null;
}
export interface PositionRow {
  unrealized_pnl: number | string;
  is_open: boolean;
}
export interface SnapshotRow {
  total_value: number | string;
  available_capital: number | string;
  captured_at: string;
}

const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

export function computeMetrics(
  trades: TradeRow[],
  positions: PositionRow[],
  snapshots: SnapshotRow[],
  now: Date = new Date(),
) {
  const closed = trades.filter((t) => t.closed_at);
  const net = (t: TradeRow) => n(t.realized_pnl) - n(t.fees);
  const since = (ms: number) =>
    closed.filter((t) => now.getTime() - new Date(t.closed_at!).getTime() <= ms).reduce((s, t) => s + net(t), 0);
  const DAY = 86_400_000;
  const wins = closed.filter((t) => net(t) > 0).length;
  const sorted = [...snapshots].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of sorted) {
    const v = n(s.total_value);
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  const latest = sorted.at(-1);
  return {
    portfolioValue: latest ? n(latest.total_value) : null,
    availableCapital: latest ? n(latest.available_capital) : null,
    realizedPnl: closed.reduce((s, t) => s + net(t), 0),
    unrealizedPnl: positions.filter((p) => p.is_open).reduce((s, p) => s + n(p.unrealized_pnl), 0),
    dailyPnl: since(DAY),
    weeklyPnl: since(7 * DAY),
    monthlyPnl: since(30 * DAY),
    closedTrades: closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    maxDrawdownPct: sorted.length > 1 ? maxDd * 100 : null,
    equityCurve: sorted.map((s) => ({ t: s.captured_at, value: n(s.total_value) })),
  };
}

export function fmtMoney(v: number | null, ccy = "USDT") {
  if (v == null) return "—";
  return `${v < 0 ? "-" : ""}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
}
