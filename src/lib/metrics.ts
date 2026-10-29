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

export interface AnalyticsTrade { realized_pnl: number | string; fees: number | string; closed_at: string | null; bot_id: string | null; strategy_id: string | null; trading_pair: string }

/** Per-group performance (by bot, strategy or pair) from closed trades; PnL is net of fees. */
export function groupStats(trades: AnalyticsTrade[], key: (t: AnalyticsTrade) => string | null) {
  const groups = new Map<string, number[]>();
  for (const t of trades) {
    if (!t.closed_at) continue;
    const k = key(t) ?? "—";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(n(t.realized_pnl) - n(t.fees));
  }
  return [...groups.entries()].map(([k, xs]) => {
    const wins = xs.filter((x) => x > 0), losses = xs.filter((x) => x <= 0);
    const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
    return {
      key: k, trades: xs.length, net: gw - gl,
      winRate: (wins.length / xs.length) * 100,
      profitFactor: gl > 0 ? gw / gl : null,
      avgWin: wins.length ? gw / wins.length : null,
      avgLoss: losses.length ? -gl / losses.length : null,
      best: Math.max(...xs), worst: Math.min(...xs),
    };
  }).sort((a, b) => b.net - a.net);
}

/** Net PnL per calendar month (UTC), oldest first. */
export function monthlyPnl(trades: AnalyticsTrade[]) {
  const m = new Map<string, number>();
  for (const t of trades) if (t.closed_at) { const k = t.closed_at.slice(0, 7); m.set(k, (m.get(k) ?? 0) + n(t.realized_pnl) - n(t.fees)); }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, pnl]) => ({ month, pnl }));
}
