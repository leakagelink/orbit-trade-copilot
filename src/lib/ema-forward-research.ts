// Phase 4C — EMA forward evaluation (offline research only). Pure and deterministic: no network, timers, credentials,
// database, orders or AI. It evaluates ONE pre-declared candidate — the Phase 4B "4h EMA 50/200 always-in" benchmark,
// exactly as `emaAlwaysIn` in lowfreq-research.ts implements it — on data that the Phase 4B selection never scored:
//   * HISTORY_UNSEEN: Binance USD-M history BEFORE the Phase 4B window (minus a 14-day embargo);
//   * FORWARD: closed candles AFTER the Phase 4B window end (2026-11-12T00:00Z).
// The Phase 4B window itself is reported only as CONTAMINATED context (the candidate was noticed there).
// The specification, data windows, metrics and decision rule are frozen below BEFORE any new data is scored; the
// spec hash is recorded in docs/phase-4c/ema-forward-spec.json and checked by a test. Nothing here sizes, levers,
// authorizes, routes or places a trade, and nothing connects to the Futures paper engine.
// lowfreq-research.ts is left byte-for-byte (Phase 4B provenance); `emaAlwaysInTrades` reproduces `emaAlwaysIn`
// exactly (equivalence test) and additionally returns the trades and a marked-to-market equity path.
import { ema, type Candle } from "./indicators";
import { fillAt, type CostModel } from "./backtest-costs";
import { D, H, stats, type Costs, type Funding, type LFTrade, type Stats } from "./lowfreq-research";
import { evidenceHash } from "./evidence-hash";

export const EMA_FORWARD_VERSION = "ema-forward-v1" as const;
const PHASE4B_START = Date.UTC(2023, 10, 13), PHASE4B_END = Date.UTC(2026, 10, 12);

/** Frozen candidate specification and experiment design. Changing ANY value is a new experiment (new version). */
export const EMA_FORWARD_SPEC = Object.freeze({
  version: EMA_FORWARD_VERSION,
  candidate: {
    id: "4h-ema-50-200-always-in",
    origin: "Phase 4B benchmark emaAlwaysIn(c4, funding, from, to, COSTS, 50, 200, 1000, 4h); noticed on the Phase 4B locked test, so the Phase 4B window cannot count as evidence",
    timeframe: "4h (UTC-aligned aggregation of 1h candles; incomplete buckets dropped, never filled)",
    emaFast: 50, emaSlow: 200, emaSeed: "SMA of the first N closes of the fetched series (indicators.ema)",
    longShort: "both: LONG when EMA50 > EMA200 at the previous 4h close, otherwise SHORT (always in the market once both EMAs exist)",
    entry: "at the open of the first bar of the segment, and at the next 4h open after the previous close changes direction",
    exit: "reverse at the next 4h open on a direction change; the open position is closed at the segment's last close",
    positionSizing: "fixed 1000 USDT notional per position (no compounding, no leverage modelled; quantity = 1000 / entry price)",
    stopLoss: "none", takeProfit: "none", maxHoldingPeriod: "none (always-in)",
    fees: "taker 0.05 % per side (Binance USD-M regular tier list fee; NOT verified against an account)",
    spreadSlippage: "spread 0.01 % (half per side) + slippage 0.01 % per side — assumptions, no historical bid/ask data",
    funding: "actual historical funding rates charged for events strictly inside (entry, exit); at the funding mark price, or the entry price when the exchange supplies no mark",
    dataSource: "Binance USD-M public GET /fapi/v1/klines (1h) and /fapi/v1/fundingRate; credential-free",
  },
  costs: { takerFeePct: 0.05, makerFeePct: 0.02, spreadPct: 0.01, slippagePct: 0.01 } as Costs,
  stressCostMultiplier: 2,
  notional: 1000,
  symbols: ["BTCUSDT", "ETHUSDT"] as const,
  windows: {
    historyRequestStart: Date.UTC(2019, 8, 1),
    historyWarmupDays: 60,
    embargoDays: 14,
    historyUnseenEnd: PHASE4B_START - 14 * D,
    contaminatedFrom: PHASE4B_START, contaminatedTo: PHASE4B_END,
    forwardFrom: PHASE4B_END,
    splitFractions: [0.6, 0.2, 0.2],
    walkForwardWindowDays: 90,
  },
  sensitivity: { note: "reported on HISTORY_UNSEEN only; never used to change the candidate", pairs4h: [[20, 100], [30, 150], [40, 200], [50, 150], [50, 250], [60, 200], [100, 200]] as [number, number][], include1h50_200: true },
  baselines: ["cash (0)", "buy-and-hold (taker costs both sides + funding)", "existing Phase 4B 1h EMA 50/200 always-in benchmark"],
  metrics: ["trades", "grossExpectancy", "netExpectancy", "totalNetReturnPct", "profitFactor", "maxDrawdownRealized", "maxDrawdownMarked", "winRate", "avgWin", "avgLoss", "exposurePct", "avgHoldHours", "fees", "spread", "slippage", "funding", "tStat", "dailySharpe"],
  rule: {
    R1: "HISTORY_UNSEEN full: >= 30 trades, net expectancy > 0 and t-stat >= 2",
    R2: "HISTORY_UNSEEN train, validation and test each: net > 0 (beats cash); validation and test each >= 8 trades",
    R3: "Walk-forward: >= 60 % of 90-day windows with at least one trade are net positive",
    R4: "HISTORY_UNSEEN full profit factor >= 1.2",
    R5: "At 2x costs, HISTORY_UNSEEN full net expectancy > 0",
    R6: "FORWARD: >= 30 closed trades with net expectancy > 0 (required for anything beyond historical evidence)",
    verdict: "any of R1-R5 fails -> NO TRADE; R1-R5 pass but R6 fails -> INSUFFICIENT EVIDENCE; all pass -> CANDIDATE FOR FORWARD-PAPER REVIEW. Every outcome stays RESEARCH_ONLY; none authorizes paper or live trading.",
    thresholds: { minTradesFull: 30, minTStat: 2, minTradesValTest: 8, minPositiveWindowShare: 0.6, minProfitFactor: 1.2, minForwardTrades: 30 },
  },
});
export type EmaSpec = typeof EMA_FORWARD_SPEC;
export const emaSpecHash = () => evidenceHash(EMA_FORWARD_SPEC);

const cm = (c: Costs): CostModel => ({ feePct: c.takerFeePct, spreadPct: c.spreadPct, slippagePct: c.slippagePct, maxParticipationPct: null });
export const scaleCosts = (c: Costs, k: number): Costs => ({ takerFeePct: c.takerFeePct * k, makerFeePct: c.makerFeePct * k, spreadPct: c.spreadPct * k, slippagePct: c.slippagePct * k });

/**
 * Same rules, same arithmetic and the same order of operations as lowfreq-research `emaAlwaysIn`; returns the trades
 * plus an equity path marked at every bar close (realized net + open position at the close, open costs excluded).
 */
export function emaAlwaysInTrades(cs: Candle[], funding: Funding[], from: number, to: number, costs: Costs, fast = 50, slow = 200, notional = 1000, tfMs = H) {
  const A = ema(cs.map((c) => c.c), fast), B = ema(cs.map((c) => c.c), slow), tk = cm(costs);
  const ff = [...funding].sort((a, b) => a.t - b.t), trades: LFTrade[] = [], marks: { t: number; equity: number }[] = [];
  let side: 0 | 1 | -1 = 0, entryRef = 0, entryT = 0, qty = 0, realized = 0;
  const close = (ref: number, t: number) => {
    const s1 = side as 1 | -1, en = fillAt(s1 === 1 ? "buy" : "sell", entryRef, qty, tk), ex = fillAt(s1 === 1 ? "sell" : "buy", ref, qty, tk);
    let fund = 0; for (const e of ff) { if (e.t <= entryT) continue; if (e.t >= t) break; fund += -s1 * qty * (e.mark ?? entryRef) * e.rate; }
    const gross = s1 * (ref - entryRef) * qty, spread = en.spreadCost + ex.spreadCost, slippage = en.slippageCost + ex.slippageCost, fees = en.fee + ex.fee;
    const net = gross - fees - spread - slippage + fund;
    trades.push({ side: s1, signalT: entryT, entryT, exitT: t, entryRef, exitRef: ref, reason: "time", qty, gross, fees, spread, slippage, funding: fund, net, holdBars: 0, markout4Bps: null });
    realized += net; side = 0;
  };
  const seg = cs.map((c, i) => [c, i] as const).filter(([c]) => c.t >= from && c.t < to);
  for (const [c, i] of seg) {
    const a = A[i - 1], b = B[i - 1];
    if (!(i < 1 || a == null || b == null)) {
      const want: 1 | -1 = a > b ? 1 : -1;
      if (want !== side) { if (side) close(c.o, c.t); side = want; entryRef = c.o; entryT = c.t; qty = notional / c.o; }
    }
    marks.push({ t: c.t + tfMs, equity: realized + (side ? side * (c.c - entryRef) * qty : 0) });
  }
  const last = seg.at(-1)?.[0]; if (side && last) close(last.c, last.t + tfMs);
  if (marks.length) marks[marks.length - 1] = { t: marks[marks.length - 1]!.t, equity: realized };
  return { trades, marks };
}

export interface EmaMetrics extends Stats { totalNetReturnPct: number; avgWin: number | null; avgLoss: number | null; exposurePct: number; avgHoldHours: number | null; maxDrawdownMarked: number }
export function emaMetrics(r: { trades: LFTrade[]; marks: { t: number; equity: number }[] }, from: number, to: number, notional = 1000): EmaMetrics {
  const s = stats(r.trades, from, to, notional);
  const t = r.trades.filter((x) => x.entryT >= from && x.entryT < to);
  const wins = t.filter((x) => x.net > 0), losses = t.filter((x) => x.net < 0);
  const held = t.reduce((a, x) => a + Math.max(0, Math.min(x.exitT, to) - x.entryT), 0);
  let peak = 0, dd = 0; for (const m of r.marks) { peak = Math.max(peak, m.equity); dd = Math.max(dd, peak - m.equity); }
  return { ...s, totalNetReturnPct: (s.net / notional) * 100, avgWin: wins.length ? wins.reduce((a, x) => a + x.net, 0) / wins.length : null, avgLoss: losses.length ? losses.reduce((a, x) => a + x.net, 0) / losses.length : null,
    exposurePct: to > from ? (held / (to - from)) * 100 : 0, avgHoldHours: t.length ? held / t.length / H : null, maxDrawdownMarked: dd };
}

export interface Window { name: string; from: number; to: number }
/** Non-overlapping windows of `days` inside [from, to); a trailing partial window is dropped. */
export function rollingWindows(from: number, to: number, days: number): Window[] {
  const out: Window[] = []; for (let s = from, k = 1; s + days * D <= to; s += days * D, k++) out.push({ name: `wf${k}`, from: s, to: s + days * D });
  return out;
}

export interface SymbolEvidence {
  full: EmaMetrics | null; train: EmaMetrics | null; validation: EmaMetrics | null; test: EmaMetrics | null;
  windows: { traded: number; positive: number }; stressFull: EmaMetrics | null; forward: EmaMetrics | null;
}
export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type EmaVerdict = "NO TRADE" | "INSUFFICIENT EVIDENCE" | "CANDIDATE FOR FORWARD-PAPER REVIEW";
/** Applies the frozen rule. Missing evidence fails its rule (never passes by default). Always RESEARCH_ONLY. */
export function emaVerdict(e: SymbolEvidence): { verdict: EmaVerdict; status: "RESEARCH_ONLY"; rules: Record<RuleId, { pass: boolean; detail: string }> } {
  const T = EMA_FORWARD_SPEC.rule.thresholds, f = e.full;
  const r = (pass: boolean, detail: string) => ({ pass, detail });
  const rules: Record<RuleId, { pass: boolean; detail: string }> = {
    R1: f ? r(f.trades >= T.minTradesFull && f.netExp > 0 && (f.tStat ?? -Infinity) >= T.minTStat, `${f.trades} trades, net exp ${f.netExp.toFixed(2)}, t ${f.tStat === null ? "n/a" : f.tStat.toFixed(2)}`) : r(false, "no history evidence"),
    R2: e.train && e.validation && e.test ? r(e.train.net > 0 && e.validation.net > 0 && e.test.net > 0 && e.validation.trades >= T.minTradesValTest && e.test.trades >= T.minTradesValTest,
      `net train ${e.train.net.toFixed(2)} / validation ${e.validation.net.toFixed(2)} (${e.validation.trades}) / test ${e.test.net.toFixed(2)} (${e.test.trades})`) : r(false, "a split period is missing"),
    R3: e.windows.traded > 0 ? r(e.windows.positive / e.windows.traded >= T.minPositiveWindowShare, `${e.windows.positive}/${e.windows.traded} traded windows positive`) : r(false, "no traded walk-forward window"),
    R4: f ? r((f.profitFactor ?? 0) >= T.minProfitFactor, `profit factor ${f.profitFactor === null ? "n/a" : f.profitFactor.toFixed(2)}`) : r(false, "no history evidence"),
    R5: e.stressFull ? r(e.stressFull.netExp > 0, `net exp at 2x costs ${e.stressFull.netExp.toFixed(2)}`) : r(false, "no stress evidence"),
    R6: e.forward ? r(e.forward.trades >= T.minForwardTrades && e.forward.netExp > 0, `${e.forward.trades} forward trades (need ${T.minForwardTrades})`) : r(false, "no forward candles yet"),
  };
  const hist = (["R1", "R2", "R3", "R4", "R5"] as const).every((k) => rules[k].pass);
  return { verdict: !hist ? "NO TRADE" : rules.R6.pass ? "CANDIDATE FOR FORWARD-PAPER REVIEW" : "INSUFFICIENT EVIDENCE", status: "RESEARCH_ONLY", rules };
}

/** Canonical hash of a candle series (t,o,h,l,c,v) so a re-run can prove it scored identical data. */
export const candleHash = (cs: Candle[]) => evidenceHash(cs.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]));
