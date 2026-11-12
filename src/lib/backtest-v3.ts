// Pure historical simulator v3 ("next-bar-v3"). Signals use completed prior bars and fill at the next open.
// Order of events inside each bar: (1) exits known at the open (prior-bar exit signal, gap through stop or target),
// (2) intrabar stop/target with stop-first when both are touched, (3) new entries at the open, whose own stop/target is
// then checked against the same bar (stop-first). No re-entry on a bar that closed a position.
// All P&L flows into cash, so final equity = starting capital + the sum of every trade's net result.
// v2 (`backtest.ts`) stays unchanged so stored v2 evidence still replays exactly.
import { computeAll, evalRules, type Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";
import { checkFundingCoverage, fillAt, fundingCashFlow, liquidityCap, validateCosts, type CostModel, type FundingRate } from "./backtest-costs";
import { performanceMetrics } from "./backtest-metrics";

export const SIMULATOR_V3 = "next-bar-v3" as const;
export interface SimOptions {
  capital: number; tfMs: number; costs: CostModel;
  direction?: "long" | "short"; market?: "spot" | "futures";
  funding?: FundingRate[]; fundingIntervalMs?: number;
  /** No entries before this bar time (indicator warm-up may use earlier bars). */ tradeFrom?: number;
}
export interface SimTrade {
  side: "long" | "short"; entryT: number; exitT: number; entry: number; exit: number; qty: number;
  pnl: number; fees: number; spread: number; slippage: number; funding: number; net: number;
  reason: "exit_signal" | "stop_loss" | "take_profit" | "end_of_test"; ambiguous: boolean; bars: number;
}
interface Pos { entryT: number; entry: number; qty: number; sl: number | null; tp: number | null; fee: number; spread: number; slippage: number; funding: number; notional: number }

export function runBacktestV3(cfg: StrategyConfig, cs: Candle[], o: SimOptions) {
  validateCosts(o.costs);
  if (!(o.capital > 0) || !(o.tfMs > 0)) throw new Error("Positive capital and timeframe required");
  const dir: 1 | -1 = o.direction === "short" ? -1 : 1;
  if (dir === -1 && o.market !== "futures") throw new Error("Short backtests require a Futures market");
  const fundingMs = o.fundingIntervalMs ?? 8 * 3_600_000;
  const first = cs[0], last = cs.at(-1);
  if (o.market === "futures" && first && last) { const why = checkFundingCoverage(o.funding, first.t, last.t + o.tfMs, fundingMs); if (why) throw new Error(why); }
  const funding = [...(o.funding ?? [])].sort((a, b) => a.t - b.t);
  const m = computeAll(cfg, cs);
  const { stop_loss_pct: sl, take_profit_pct: tp, position_size_pct: size, max_open_positions: maxPos } = cfg.risk;
  const entrySide = dir === 1 ? "buy" : "sell", exitSide = dir === 1 ? "sell" : "buy";
  let cash = o.capital;
  const open: Pos[] = [];
  const trades: SimTrade[] = [];
  const equity: { t: number; v: number }[] = first ? [{ t: first.t + o.tfMs, v: o.capital }] : [];
  let liquidityLimited = 0;

  const close = (p: Pos, ref: number, t: number, reason: SimTrade["reason"], ambiguous = false) => {
    const f = fillAt(exitSide, ref, p.qty, o.costs);
    const pnl = dir * (f.price - p.entry) * p.qty, fees = p.fee + f.fee;
    const net = pnl - fees + p.funding;
    cash += pnl - f.fee; // the entry fee and funding were already taken from cash
    trades.push({ side: dir === 1 ? "long" : "short", entryT: p.entryT, exitT: t, entry: p.entry, exit: f.price, qty: p.qty, pnl, fees, spread: p.spread + f.spreadCost, slippage: p.slippage + f.slippageCost, funding: p.funding, net, reason, ambiguous, bars: Math.round((t - p.entryT) / o.tfMs) });
  };
  const hits = (p: Pos, c: Candle) => ({
    stop: p.sl !== null && (dir === 1 ? c.l <= p.sl : c.h >= p.sl),
    target: p.tp !== null && (dir === 1 ? c.h >= p.tp : c.l <= p.tp),
  });

  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    let closedThisBar = false;
    const exitSig = evalRules(cfg.exit, m, i - 1);
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k]!;
      const gapStop = p.sl !== null && (dir === 1 ? c.o <= p.sl : c.o >= p.sl);
      const gapTarget = p.tp !== null && (dir === 1 ? c.o >= p.tp : c.o <= p.tp);
      const h = hits(p, c);
      // (1) known at the open, (2) intrabar with stop first.
      if (exitSig) close(p, c.o, c.t, "exit_signal");
      else if (gapStop) close(p, c.o, c.t, "stop_loss");
      else if (gapTarget) close(p, p.tp!, c.t, "take_profit"); // conservative: the target price, not the better open
      else if (h.stop) close(p, p.sl!, c.t, "stop_loss", h.target);
      else if (h.target) close(p, p.tp!, c.t, "take_profit");
      else continue;
      open.splice(k, 1); closedThisBar = true;
    }
    // (3) entries at the open, then the entry bar's own stop/target.
    if (!closedThisBar && open.length < maxPos && (o.tradeFrom === undefined || c.t >= o.tradeFrom) && evalRules(cfg.entry, m, i - 1)) {
      const reserved = open.reduce((a, p) => a + p.notional, 0);
      const budget = Math.min(cash - reserved, (o.capital * size) / 100);
      const probe = fillAt(entrySide, c.o, 1, o.costs);
      let qty = budget > 0 ? budget / (probe.price * (1 + o.costs.feePct / 100)) : 0;
      const capped = liquidityCap(qty, c.v, o.costs);
      if (capped < qty) { liquidityLimited++; qty = capped; }
      if (qty > 0) {
        const f = fillAt(entrySide, c.o, qty, o.costs);
        cash -= f.fee;
        const pos: Pos = { entryT: c.t, entry: f.price, qty, fee: f.fee, spread: f.spreadCost, slippage: f.slippageCost, funding: 0, notional: f.price * qty,
          sl: sl != null ? f.price * (1 - dir * sl / 100) : null, tp: tp != null ? f.price * (1 + dir * tp / 100) : null };
        const h = hits(pos, c);
        if (h.stop) close(pos, pos.sl!, c.t, "stop_loss", h.target);
        else if (h.target) close(pos, pos.tp!, c.t, "take_profit");
        else open.push(pos);
      }
    }
    // Funding for positions still open during this bar (charged when entryT ≤ funding time < exit bar).
    if (o.market === "futures") for (const r of funding) {
      if (r.t < c.t || r.t >= c.t + o.tfMs) continue;
      for (const p of open) { const flow = fundingCashFlow(dir, p.qty, c.o, r.rate); p.funding += flow; cash += flow; }
    }
    equity.push({ t: c.t + o.tfMs, v: cash + open.reduce((a, p) => a + dir * (c.c - p.entry) * p.qty, 0) });
  }
  // Terminal liquidation at the last close, with full costs, reflected in the final equity point.
  if (last && open.length) {
    for (const p of open.splice(0)) close(p, last.c, last.t, "end_of_test");
    const point = equity.at(-1);
    if (point) point.v = cash;
  }
  const netSum = trades.reduce((a, t) => a + t.net, 0);
  const reconciliation = { finalEquity: cash, expected: o.capital + netSum, difference: cash - (o.capital + netSum) };
  return { trades, equity, metrics: performanceMetrics(trades, equity, o.capital, o.tfMs), reconciliation, liquidityLimited };
}
