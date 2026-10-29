// Pure backtester: long-only, same rules/risk semantics as the paper engine.
import { computeAll, evalRules, type Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";

export interface BtOptions { capital: number; feePct: number; slippagePct: number; tfMs: number }
export interface BtTrade { entryT: number; exitT: number; entry: number; exit: number; qty: number; pnl: number; fees: number; reason: string }

export function runBacktest(cfg: StrategyConfig, cs: Candle[], o: BtOptions) {
  const m = computeAll(cfg, cs);
  const fee = o.feePct / 100, slip = o.slippagePct / 100;
  const { stop_loss_pct: sl, take_profit_pct: tp, position_size_pct: size, max_open_positions: maxPos } = cfg.risk;
  let cash = o.capital;
  const open: { entryT: number; entry: number; qty: number; sl: number | null; tp: number | null; fee: number }[] = [];
  const trades: BtTrade[] = [];
  const equity: { t: number; v: number }[] = [];

  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    const exitSig = evalRules(cfg.exit, m, i);
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k]!;
      let px: number | null = null, reason = "";
      if (p.sl != null && c.l <= p.sl) { px = p.sl; reason = "stop_loss"; } // conservative: stop wins ties
      else if (p.tp != null && c.h >= p.tp) { px = p.tp; reason = "take_profit"; }
      else if (exitSig) { px = c.c; reason = "exit_signal"; }
      if (px == null) continue;
      const fill = px * (1 - slip);
      const exitFee = fill * p.qty * fee;
      cash += fill * p.qty - exitFee;
      trades.push({ entryT: p.entryT, exitT: c.t, entry: p.entry, exit: fill, qty: p.qty, pnl: (fill - p.entry) * p.qty, fees: p.fee + exitFee, reason });
      open.splice(k, 1);
    }
    if (open.length < maxPos && evalRules(cfg.entry, m, i)) {
      const fill = c.c * (1 + slip);
      const budget = Math.min(cash, (o.capital * size) / 100);
      const qty = budget / (fill * (1 + fee));
      if (qty > 0 && budget > 0) {
        const f = fill * qty * fee;
        cash -= fill * qty + f;
        open.push({ entryT: c.t, entry: fill, qty, fee: f, sl: sl != null ? fill * (1 - sl / 100) : null, tp: tp != null ? fill * (1 + tp / 100) : null });
      }
    }
    equity.push({ t: c.t, v: cash + open.reduce((a, p) => a + p.qty * c.c, 0) });
  }
  const last = cs[cs.length - 1];
  for (const p of open) { // mark-to-market close at the end
    const fill = last!.c * (1 - slip), f = fill * p.qty * fee;
    cash += fill * p.qty - f;
    trades.push({ entryT: p.entryT, exitT: last!.t, entry: p.entry, exit: fill, qty: p.qty, pnl: (fill - p.entry) * p.qty, fees: p.fee + f, reason: "end_of_test" });
  }
  return { trades, equity, stats: tradeStats(trades, equity, o.capital, o.tfMs) };
}

export function tradeStats(trades: { pnl: number; fees: number }[], equity: { v: number }[], capital: number, tfMs: number) {
  const net = trades.map((t) => t.pnl - t.fees);
  const wins = net.filter((x) => x > 0), losses = net.filter((x) => x <= 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  let peak = -Infinity, dd = 0;
  for (const e of equity) { peak = Math.max(peak, e.v); if (peak > 0) dd = Math.max(dd, (peak - e.v) / peak); }
  const rets = equity.slice(1).map((e, i) => (equity[i]!.v > 0 ? e.v / equity[i]!.v - 1 : 0));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  const perYear = (365 * 86_400_000) / tfMs;
  const netProfit = net.reduce((a, b) => a + b, 0);
  return {
    total_trades: trades.length,
    net_profit: netProfit,
    total_return_pct: (netProfit / capital) * 100,
    win_rate_pct: trades.length ? (wins.length / trades.length) * 100 : null,
    profit_factor: gl > 0 ? gw / gl : wins.length ? null : null,
    avg_win: wins.length ? gw / wins.length : null,
    avg_loss: losses.length ? -gl / losses.length : null,
    max_drawdown_pct: dd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : null,
  };
}
