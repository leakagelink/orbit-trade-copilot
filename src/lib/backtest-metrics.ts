// Pure net-of-cost performance metrics shared by the v3 simulator, benchmarks and chronological folds.
export interface MetricTrade { entryT: number; exitT: number; pnl: number; fees: number; spread: number; slippage: number; funding: number; net: number }

export function performanceMetrics(trades: MetricTrade[], equity: { t: number; v: number }[], capital: number, tfMs: number) {
  const net = trades.map((t) => t.net);
  const wins = net.filter((x) => x > 0), losses = net.filter((x) => x < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  const netProfit = net.reduce((a, b) => a + b, 0);
  let peak = capital, dd = 0;
  for (const e of equity) { peak = Math.max(peak, e.v); if (peak > 0) dd = Math.max(dd, (peak - e.v) / peak); }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) { const a = equity[i - 1]!.v, b = equity[i]!.v; if (a > 0) rets.push(b / a - 1); }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  // Sample standard deviation; zero risk-free rate; annualised for markets that trade every day (crypto).
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const periodsPerYear = (365 * 86_400_000) / tfMs;
  const sum = (k: keyof MetricTrade) => trades.reduce((a, t) => a + t[k], 0);
  const finalEquity = equity.at(-1)?.v ?? capital;
  return {
    trades: trades.length,
    netProfit, netReturnPct: capital > 0 ? (netProfit / capital) * 100 : null,
    finalEquity,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    profitFactorNote: grossLoss > 0 ? null : trades.length ? "No losing trades: profit factor is undefined" : "No trades",
    expectancy: trades.length ? netProfit / trades.length : null,
    avgWin: wins.length ? grossWin / wins.length : null, avgLoss: losses.length ? -grossLoss / losses.length : null,
    maxDrawdownPct: dd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null,
    avgHoldingMs: trades.length ? trades.reduce((a, t) => a + (t.exitT - t.entryT), 0) / trades.length : null,
    totalFees: sum("fees"), totalSpread: sum("spread"), totalSlippage: sum("slippage"), totalFunding: sum("funding"),
    grossProfit: sum("pnl"),
  };
}
export type PerformanceMetrics = ReturnType<typeof performanceMetrics>;
