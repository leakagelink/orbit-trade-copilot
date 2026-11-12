// Phase 4B lower-frequency USD-M Futures research (1h / 4h). Pure and deterministic: no network, timers, credentials,
// orders or AI. A PRE-DECLARED grid is simulated causally (signal on a CLOSED bar, fill at the NEXT open; maker
// entries fill only on trade-through), costs and funding are charged explicitly, and selection uses the TRAIN period
// only; VALIDATION confirms; the LOCKED TEST is scored once for survivors. NO TRADE is a valid result. Nothing here
// sizes, levers, authorizes or places a trade — results are historical simulations under stated assumptions.
import { ema, type Candle } from "./indicators";
import { fillAt, type CostModel } from "./backtest-costs";

export const LOWFREQ_RESEARCH_VERSION = "lowfreq-research-v1" as const;
export const H = 3_600_000, D = 86_400_000;

export interface Funding { t: number; rate: number; mark: number | null }
export interface Costs { takerFeePct: number; makerFeePct: number; spreadPct: number; slippagePct: number }
export type Family = "ema_cross" | "donchian" | "reversion";
export interface Variant {
  id: string; tfH: 1 | 4; family: Family; p1: number; p2: number; // ema_cross: fast/slow · donchian: N/- · reversion: EMA/z×10
  atrStop: number; rr: number; maxHoldBars: number; vol: "any" | "mid"; funding: "off" | "on"; mode: "taker" | "maker";
}

/** The grid is fixed here, before any period is scored. 2 tf × 6 signals × 2 stops × 2 targets × 2 vol × 2 funding × 2 modes = 384. */
export function lowfreqGrid(): Variant[] {
  const out: Variant[] = [];
  const sigs: [Family, number, number][] = [["ema_cross", 20, 50], ["ema_cross", 50, 200], ["donchian", 20, 0], ["donchian", 55, 0], ["reversion", 50, 20], ["reversion", 50, 30]];
  for (const tfH of [1, 4] as const) for (const [family, p1, p2] of sigs) for (const atrStop of [2, 3]) for (const rr of [2, 4])
    for (const vol of ["any", "mid"] as const) for (const funding of ["off", "on"] as const) for (const mode of ["taker", "maker"] as const)
      out.push({ id: `${tfH}h-${family}-${p1}-${p2}-s${atrStop}-r${rr}-${vol}-f${funding}-${mode}`, tfH, family, p1, p2, atrStop, rr, maxHoldBars: tfH === 1 ? 72 : 48, vol, funding, mode });
  return out;
}
/** Longest holding period in the grid, in ms — the purge/embargo gap must exceed it. */
export const maxHoldMs = (g: Variant[]) => Math.max(...g.map((v) => v.maxHoldBars * v.tfH * H));

/** Aggregates contiguous 1h candles into UTC-aligned k-hour candles; incomplete buckets are dropped (never filled). */
export function aggregate(cs: Candle[], k: number): Candle[] {
  if (k === 1) return cs;
  const out: Candle[] = []; let i = 0;
  while (i < cs.length) {
    const t = Math.floor(cs[i]!.t / (k * H)) * k * H, a: Candle[] = [];
    while (i < cs.length && cs[i]!.t < t + k * H) a.push(cs[i++]!);
    if (a.length === k && a.every((c, j) => c.t === t + j * H)) out.push({ t, o: a[0]!.o, h: Math.max(...a.map((c) => c.h)), l: Math.min(...a.map((c) => c.l)), c: a[k - 1]!.c, v: a.reduce((s, c) => s + c.v, 0) });
  }
  return out;
}

export interface Features { atr: (number | null)[]; atrPctile: (number | null)[]; emaA: (number | null)[]; emaB: (number | null)[]; hi: (number | null)[]; lo: (number | null)[]; fundingAtClose: (number | null)[] }
/** Causal features: every value at i uses bars ≤ i and funding with t ≤ close of bar i. */
export function features(cs: Candle[], tfMs: number, v: Pick<Variant, "family" | "p1" | "p2">, funding: Funding[]): Features {
  const n = cs.length, atr: (number | null)[] = new Array(n).fill(null);
  // Wilder ATR(14): seeded with the mean true range of bars 1..14, then smoothed.
  let a = 0;
  for (let i = 1; i < n; i++) {
    const c = cs[i]!, p = cs[i - 1]!, tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    if (i < 14) a += tr; else if (i === 14) { a = (a + tr) / 14; atr[i] = a; } else { a = (a * 13 + tr) / 14; atr[i] = a; }
  }
  // ATR as % of price, percentile over the trailing 90 days (bars ≤ i only).
  const win = Math.max(20, Math.round((90 * D) / tfMs)), rel = atr.map((x, i) => (x === null ? null : x / cs[i]!.c));
  const atrPctile = rel.map((x, i) => {
    if (x === null || i < win) return null;
    let below = 0, cnt = 0; for (let j = i - win; j < i; j++) { const y = rel[j]; if (y != null) { cnt++; if (y < x) below++; } }
    return cnt ? below / cnt : null;
  });
  const closes = cs.map((c) => c.c);
  const emaA = v.family === "donchian" ? closes.map(() => null) : ema(closes, v.p1);
  const emaB = v.family === "ema_cross" ? ema(closes, v.p2) : closes.map(() => null);
  const N = v.family === "donchian" ? v.p1 : 0;
  const hi = cs.map((_, i) => (N && i >= N ? Math.max(...cs.slice(i - N, i).map((c) => c.h)) : null));
  const lo = cs.map((_, i) => (N && i >= N ? Math.min(...cs.slice(i - N, i).map((c) => c.l)) : null));
  const fs = [...funding].sort((x, y) => x.t - y.t); let k = -1;
  const fundingAtClose = cs.map((c) => { while (k + 1 < fs.length && fs[k + 1]!.t <= c.t + tfMs) k++; return k >= 0 ? fs[k]!.rate : null; });
  return { atr, atrPctile, emaA, emaB, hi, lo, fundingAtClose };
}

/** Direction decided at the CLOSE of bar i (0 = none). Uses only features[i] and bar i (and i−1 for crosses). */
export function signalAt(cs: Candle[], f: Features, v: Variant, i: number): -1 | 0 | 1 {
  const c = cs[i]!.c, atr = f.atr[i];
  if (atr == null || !(atr > 0)) return 0;
  let d: -1 | 0 | 1 = 0;
  if (v.family === "ema_cross") {
    const a = f.emaA[i], b = f.emaB[i], a0 = f.emaA[i - 1], b0 = f.emaB[i - 1];
    if (a == null || b == null || a0 == null || b0 == null) return 0;
    d = a > b && a0 <= b0 ? 1 : a < b && a0 >= b0 ? -1 : 0;
  } else if (v.family === "donchian") {
    const hi = f.hi[i], lo = f.lo[i]; if (hi == null || lo == null) return 0;
    d = c > hi ? 1 : c < lo ? -1 : 0;
  } else {
    const m = f.emaA[i]; if (m == null) return 0;
    const z = (c - m) / atr, k = v.p2 / 10;
    d = z <= -k ? 1 : z >= k ? -1 : 0;
  }
  if (d === 0) return 0;
  if (v.vol === "mid") { const p = f.atrPctile[i]; if (p == null || p < 0.2 || p > 0.8) return 0; }
  if (v.funding === "on") { const r = f.fundingAtClose[i]; if (r == null) return 0; if ((d === 1 && r > 0.0003) || (d === -1 && r < -0.0003)) return 0; }
  return d;
}

export interface LFTrade {
  side: 1 | -1; signalT: number; entryT: number; exitT: number; entryRef: number; exitRef: number; reason: "stop" | "target" | "time" | "end";
  qty: number; gross: number; fees: number; spread: number; slippage: number; funding: number; net: number; holdBars: number; markout4Bps: number | null;
}
export interface SimResult { trades: LFTrade[]; signals: number; makerMissed: number }

const cm = (feePct: number, spreadPct: number, slippagePct: number): CostModel => ({ feePct, spreadPct, slippagePct, maxParticipationPct: null });

/**
 * One position at a time, fixed `notional` per trade, one-bar cooldown after an exit.
 *  taker: entry at the next open (taker fee + half spread + slippage).
 *  maker: post-only limit at the signal close for ONE bar; it fills only if the next bar trades THROUGH the limit,
 *         maker fee, no spread/slippage; if that bar also reaches the stop the stop is assumed hit (adverse selection).
 *  Stop-first when stop and target are both inside a bar; a gap through the stop fills at the open. Stops, targets and
 *  time exits are taker. Funding: each event with entryT < t < exitT is charged at its mark price (positive → longs pay).
 */
export function simulate(cs: Candle[], f: Features, v: Variant, funding: Funding[], costs: Costs, notional = 1000, tfMs = v.tfH * H, sig: (i: number) => -1 | 0 | 1 = (i) => signalAt(cs, f, v, i)): SimResult {
  const trades: LFTrade[] = []; let signals = 0, makerMissed = 0, i = 1;
  const fs = [...funding].sort((a, b) => a.t - b.t);
  const taker = cm(costs.takerFeePct, costs.spreadPct, costs.slippagePct), maker = cm(costs.makerFeePct, 0, 0);
  while (i < cs.length - 1) {
    const d = sig(i);
    if (d === 0) { i++; continue; }
    signals++;
    const atr = f.atr[i]!, sigBar = cs[i]!, nb = cs[i + 1]!, side = d;
    if (nb.t !== sigBar.t + tfMs) { i++; continue; } // data gap: never fill across it
    let entryRef: number, entryModel: CostModel;
    if (v.mode === "taker") { entryRef = nb.o; entryModel = taker; }
    else {
      const lim = sigBar.c, through = side === 1 ? nb.l < lim : nb.h > lim;
      if (!through) { makerMissed++; i += 2; continue; }
      entryRef = side === 1 ? Math.min(lim, nb.o) : Math.max(lim, nb.o); entryModel = maker; // a gap fills at the better open
    }
    const qty = notional / entryRef;
    const ent = fillAt(side === 1 ? "buy" : "sell", entryRef, qty, entryModel);
    const stopDist = v.atrStop * atr, stop = entryRef - side * stopDist, target = entryRef + side * stopDist * v.rr;
    let j = i + 1, exitRef = 0, reason: LFTrade["reason"] = "end", exitT = 0;
    for (; j < cs.length; j++) {
      const b = cs[j]!;
      if (j > i + 1 && b.t !== cs[j - 1]!.t + tfMs) { exitRef = cs[j - 1]!.c; exitT = cs[j - 1]!.t + tfMs; reason = "end"; j--; break; } // gap: close at the last known close
      const first = j === i + 1;
      const gapStop = !first && (side === 1 ? b.o <= stop : b.o >= stop), gapTgt = !first && (side === 1 ? b.o >= target : b.o <= target);
      const stopIn = side === 1 ? b.l <= stop : b.h >= stop, tgtIn = side === 1 ? b.h >= target : b.l <= target;
      if (gapStop) { exitRef = b.o; reason = "stop"; exitT = b.t; break; }
      if (gapTgt) { exitRef = b.o; reason = "target"; exitT = b.t; break; }
      if (stopIn) { exitRef = stop; reason = "stop"; exitT = b.t + tfMs / 2; break; }   // stop-first, also on the maker fill bar
      if (tgtIn && !(first && v.mode === "maker")) { exitRef = target; reason = "target"; exitT = b.t + tfMs / 2; break; }
      if (j - i >= v.maxHoldBars) { exitRef = b.c; reason = "time"; exitT = b.t + tfMs; break; }
    }
    if (j >= cs.length) { j = cs.length - 1; exitRef = cs[j]!.c; exitT = cs[j]!.t + tfMs; reason = "end"; }
    const ex = fillAt(side === 1 ? "sell" : "buy", exitRef, qty, taker);
    const entryT = nb.t;
    let fund = 0; for (const e of fs) { if (e.t <= entryT) continue; if (e.t >= exitT) break; fund += -side * qty * (e.mark ?? entryRef) * e.rate; }
    const gross = side * (exitRef - entryRef) * qty;
    const spread = ent.spreadCost + ex.spreadCost, slippage = ent.slippageCost + ex.slippageCost, fees = ent.fee + ex.fee;
    const mk = cs[i + 1 + 4]; const markout4Bps = mk ? (side * (mk.c - entryRef) / entryRef) * 1e4 : null;
    trades.push({ side, signalT: sigBar.t, entryT, exitT, entryRef, exitRef, reason, qty, gross, fees, spread, slippage, funding: fund, net: gross - fees - spread - slippage + fund, holdBars: j - i, markout4Bps });
    i = j + 2; // one-bar cooldown after the exit bar
  }
  return { trades, signals, makerMissed };
}

export interface Stats { trades: number; grossExp: number; netExp: number; netExpPct: number; net: number; fees: number; spread: number; slippage: number; funding: number; winRate: number | null; profitFactor: number | null; maxDrawdown: number; dailySharpe: number | null; tStat: number | null }
/** Per-trade and daily statistics for trades whose ENTRY is in [from, to). Daily Sharpe uses every calendar day (zero days included). */
export function stats(all: LFTrade[], from: number, to: number, notional = 1000): Stats {
  const t = all.filter((x) => x.entryT >= from && x.entryT < to), n = t.length;
  const sum = (k: keyof LFTrade) => t.reduce((a, x) => a + (x[k] as number), 0);
  const net = sum("net"), mean = n ? net / n : 0;
  const sd = n > 1 ? Math.sqrt(t.reduce((a, x) => a + (x.net - mean) ** 2, 0) / (n - 1)) : 0;
  const wins = t.filter((x) => x.net > 0), lossSum = -t.filter((x) => x.net < 0).reduce((a, x) => a + x.net, 0);
  let eq = 0, peak = 0, dd = 0; for (const x of [...t].sort((a, b) => a.exitT - b.exitT)) { eq += x.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { trades: n, grossExp: n ? sum("gross") / n : 0, netExp: mean, netExpPct: n ? (mean / notional) * 100 : 0, net, fees: sum("fees"), spread: sum("spread"), slippage: sum("slippage"), funding: sum("funding"),
    winRate: n ? wins.length / n : null, profitFactor: lossSum > 0 ? wins.reduce((a, x) => a + x.net, 0) / lossSum : null, maxDrawdown: dd, dailySharpe: dailySharpe(t, from, to), tStat: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null };
}
export function dailySharpe(t: { exitT: number; net: number }[], from: number, to: number): number | null {
  const days = Math.max(0, Math.floor((to - from) / D)); if (days < 2) return null;
  const pnl = new Array(days).fill(0);
  for (const x of t) { const k = Math.floor((x.exitT - from) / D); if (k >= 0 && k < days) pnl[k] += x.net; }
  const m = pnl.reduce((a, b) => a + b, 0) / days, sd = Math.sqrt(pnl.reduce((a, b) => a + (b - m) ** 2, 0) / (days - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : null;
}

export interface Period { name: "train" | "validation" | "test"; from: number; to: number }
/** Chronological train/validation/test (fractions of whole days) separated by `gapMs` purge+embargo gaps. */
export function splitPeriods(from: number, to: number, gapMs: number, fr = [0.6, 0.2, 0.2]): Period[] {
  const usable = to - from - 2 * gapMs, dd = (x: number) => Math.floor(x / D) * D;
  if (usable <= 0) throw new Error("Not enough data for the split");
  const a = dd(from + usable * fr[0]!), b0 = a + gapMs, b = dd(b0 + usable * fr[1]!), c0 = b + gapMs;
  return [{ name: "train", from, to: a }, { name: "validation", from: b0, to: b }, { name: "test", from: c0, to }];
}

export const RULE = Object.freeze({ trainMinTrades: 30, trainMinT: 2, topK: 5, valMinTrades: 15, testMinTrades: 15 });
export interface Selection { trainPass: string[]; checked: string[]; validationPass: string[] }
/** Selection reads TRAIN statistics only, then VALIDATION for the fixed top-K. It never receives test statistics. */
export function selectCandidates(train: Map<string, Stats>, validation: Map<string, Stats>): Selection {
  const pass = [...train].filter(([, s]) => s.trades >= RULE.trainMinTrades && s.netExp > 0 && (s.tStat ?? 0) >= RULE.trainMinT)
    .sort((a, b) => (b[1].tStat ?? 0) - (a[1].tStat ?? 0) || a[0].localeCompare(b[0])).map(([id]) => id);
  const checked = pass.slice(0, RULE.topK);
  return { trainPass: pass, checked, validationPass: checked.filter((id) => { const s = validation.get(id); return !!s && s.trades >= RULE.valMinTrades && s.netExp > 0; }) };
}

/** Rolling walk-forward inside [from, to): select on `selDays` by the TRAIN rule (scaled trade floor), embargo, test on `testDays`. */
export function walkForward(byId: Map<string, LFTrade[]>, from: number, to: number, gapMs: number, selDays = 180, testDays = 60) {
  const folds: { selFrom: number; testFrom: number; testTo: number; chosen: string | null; oos: Stats | null }[] = [];
  for (let s = from; s + selDays * D + gapMs + testDays * D <= to; s += testDays * D) {
    const selTo = s + selDays * D, tf = selTo + gapMs, tt = tf + testDays * D;
    let best: [string, Stats] | null = null;
    for (const [id, tr] of byId) { const st = stats(tr, s, selTo); if (st.trades >= 20 && st.netExp > 0 && (st.tStat ?? 0) >= RULE.trainMinT && (!best || (st.tStat ?? 0) > (best[1].tStat ?? 0))) best = [id, st]; }
    folds.push({ selFrom: s, testFrom: tf, testTo: tt, chosen: best?.[0] ?? null, oos: best ? stats(byId.get(best[0])!, tf, tt) : null });
  }
  const traded = folds.filter((f) => f.oos && f.oos.trades > 0);
  return { folds, foldsTraded: traded.length, positiveFolds: traded.filter((f) => f.oos!.net > 0).length, pooledOosNet: traded.reduce((a, f) => a + f.oos!.net, 0), pooledOosTrades: traded.reduce((a, f) => a + f.oos!.trades, 0) };
}

/** Variants that differ from `v` in exactly one grid dimension. */
export function neighbours(v: Variant, grid: Variant[]): Variant[] {
  const keys = ["tfH", "atrStop", "rr", "vol", "funding", "mode"] as const; // maxHoldBars is derived from tfH
  const sig = (x: Variant) => `${x.family}-${x.p1}-${x.p2}`;
  return grid.filter((x) => x.id !== v.id && keys.filter((k) => x[k] !== v[k]).length + (sig(x) !== sig(v) ? 1 : 0) === 1);
}

/** Buy-and-hold with taker costs both sides and funding (long pays positive). */
export function buyAndHold(cs: Candle[], funding: Funding[], from: number, to: number, costs: Costs, notional = 1000) {
  const seg = cs.filter((c) => c.t >= from && c.t < to); if (seg.length < 2) return null;
  const tk = cm(costs.takerFeePct, costs.spreadPct, costs.slippagePct), qty = notional / seg[0]!.o;
  const a = fillAt("buy", seg[0]!.o, qty, tk), b = fillAt("sell", seg.at(-1)!.c, qty, tk);
  const fund = funding.filter((f) => f.t > seg[0]!.t && f.t < seg.at(-1)!.t + H).reduce((s, f) => s - qty * (f.mark ?? seg[0]!.o) * f.rate, 0);
  let peak = -Infinity, dd = 0; for (const c of seg) { const v = (c.c - seg[0]!.o) * qty; peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  return { net: (b.price - a.price) * qty - a.fee - b.fee + fund, gross: (seg.at(-1)!.c - seg[0]!.o) * qty, funding: fund, maxDrawdownMtm: dd };
}
/** Always-in EMA trend baseline: long when EMA(fast) > EMA(slow) at a close, short otherwise; flips at the next open. */
export function emaAlwaysIn(cs: Candle[], funding: Funding[], from: number, to: number, costs: Costs, fast = 50, slow = 200, notional = 1000, tfMs = H) {
  const A = ema(cs.map((c) => c.c), fast), B = ema(cs.map((c) => c.c), slow), tk = cm(costs.takerFeePct, costs.spreadPct, costs.slippagePct);
  const ff = [...funding].sort((a, b) => a.t - b.t), trades: LFTrade[] = [];
  let side: 0 | 1 | -1 = 0, entryRef = 0, entryT = 0, qty = 0;
  const close = (ref: number, t: number) => {
    const s1 = side as 1 | -1, en = fillAt(s1 === 1 ? "buy" : "sell", entryRef, qty, tk), ex = fillAt(s1 === 1 ? "sell" : "buy", ref, qty, tk);
    let fund = 0; for (const e of ff) { if (e.t <= entryT) continue; if (e.t >= t) break; fund += -s1 * qty * (e.mark ?? entryRef) * e.rate; }
    const gross = s1 * (ref - entryRef) * qty, spread = en.spreadCost + ex.spreadCost, slippage = en.slippageCost + ex.slippageCost, fees = en.fee + ex.fee;
    trades.push({ side: s1, signalT: entryT, entryT, exitT: t, entryRef, exitRef: ref, reason: "time", qty, gross, fees, spread, slippage, funding: fund, net: gross - fees - spread - slippage + fund, holdBars: 0, markout4Bps: null });
    side = 0;
  };
  const seg = cs.map((c, i) => [c, i] as const).filter(([c]) => c.t >= from && c.t < to);
  for (const [c, i] of seg) {
    const a = A[i - 1], b = B[i - 1]; if (i < 1 || a == null || b == null) continue; // decided at the previous close
    const want: 1 | -1 = a > b ? 1 : -1;
    if (want !== side) { if (side) close(c.o, c.t); side = want; entryRef = c.o; entryT = c.t; qty = notional / c.o; }
  }
  const last = seg.at(-1)?.[0]; if (side && last) close(last.c, last.t + tfMs);
  return stats(trades, from, to, notional);
}

/** Leakage guard: recomputing features + signals on a series truncated after bar i must give the same signal at i. */
export function leakageCheck(cs: Candle[], tfMs: number, v: Variant, funding: Funding[], samples: number[], sig = signalAt): { ok: boolean; firstBad: number | null } {
  const full = features(cs, tfMs, v, funding);
  for (const i of samples) {
    const cut = cs.slice(0, i + 1), fc = features(cut, tfMs, v, funding.filter((f) => f.t <= cs[i]!.t + tfMs));
    if (sig(cut, fc, v, i) !== sig(cs, full, v, i)) return { ok: false, firstBad: i };
  }
  return { ok: true, firstBad: null };
}
