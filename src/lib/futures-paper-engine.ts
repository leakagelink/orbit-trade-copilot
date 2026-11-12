// Futures PAPER simulation engine for Binance USD-M perpetuals (BTCUSDT, ETHUSDT). Pure and deterministic: one closed
// candle per symbol in → simulated fills, funding, liquidations and ledger events out. It never touches an exchange,
// credentials, real orders/positions, the demo wallet, or the Spot paper ledger (paper-engine.ts) — its records are a
// separate ledger. New entries are sized ONLY by the Central Risk Engine (environment "paper"); a proposal carries no
// quantity or leverage. Every price here is simulated from public candles; nothing is an execution price.
//
// Modelling assumptions (all stated, none verified against an account):
//  * One-way mode, isolated margin, one position per symbol. Margin = filled notional / leverage chosen by the Risk Engine.
//  * Entries are market orders filling at the NEXT candle's open (taker fee + half spread + slippage). With a volume
//    participation cap, an entry may fill partially; the remainder keeps filling at later opens until its time limit,
//    then the remainder is cancelled. Protection always covers the filled quantity.
//  * Stop-loss / take-profit behave like exchange STOP_MARKET / TAKE_PROFIT_MARKET (close-position, reduce-only):
//    triggered by MARK price (default) or last price, then filled as taker at the trigger price (or the candle open on a
//    gap) with spread + slippage. When stop and target are both touched in one candle, the stop is assumed first.
//  * Liquidation is mark-price based: margin + unrealized PnL at mark ≤ maintenance margin (first bracket, rate given
//    per symbol). A liquidated position loses its whole isolated margin (conservative; the exchange's clearance fee and
//    any insurance-fund remainder are not refunded). A stop beyond liquidation never saves the position.
//  * Funding at each funding timestamp inside a candle, at that candle's mark open: positive rate → longs pay. Funding
//    changes the wallet and the position's isolated margin (and so its liquidation price).
//  * Index price is used only as a data-sanity check: new entries are refused when |mark − index| / index exceeds the
//    configured basis limit or the index is missing. A candle without mark prices is invalid (the caller pauses).
//  * Daily loss = today's realized cash flows (fees, funding, PnL) + negative unrealized PnL at mark; it blocks new
//    entries (via the Risk Engine) but never force-closes positions — protective orders keep running.
import { evaluateProposal, type RiskDecision, type RiskLimits, type TradeProposal } from "./central-risk";

export const FUTURES_PAPER_VERSION = "futures-paper-v1" as const;
export const FUTURES_PAPER_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type FuturesPaperSymbol = (typeof FUTURES_PAPER_SYMBOLS)[number];
export type PerpSide = "LONG" | "SHORT";
const DAY = 86_400_000;
const EPS = 1e-9;

export interface SymbolSpec { stepSize: number; tickSize: number; minNotional: number; maintenanceMarginRate: number }
export interface FPCosts { takerFeePct: number; spreadPct: number; slippagePct: number; maxParticipationPct: number | null }
export interface FPConfig {
  startingBalance: number;
  triggerSource: "MARK" | "CONTRACT";
  maxBasisPct: number;
  entryTtlBars: number;
  costs: FPCosts;
  specs: Record<string, SymbolSpec>;
  limits: RiskLimits;
  strategyBudgets: Record<string, number>;
}
export interface OHLC { o: number; h: number; l: number; c: number }
export interface FPBar { symbol: string; t: number; tfMs: number; trade: OHLC & { v: number }; mark: OHLC | null; index: { c: number } | null; funding: { t: number; rate: number }[] }
export interface FPIntent { proposal: TradeProposal; maxHoldBars: number }

export interface FPPosition { symbol: string; side: PerpSide; qty: number; entryPrice: number; leverage: number; margin: number; stop: number; target: number | null; stopDist: number; targetDist: number | null; openedAt: number; bars: number; maxHoldBars: number; strategyId: string; proposalId: string; fees: number; funding: number }
export interface FPPending { symbol: string; side: PerpSide; qtyTotal: number; qtyFilled: number; leverage: number; stopDist: number; targetDist: number | null; strategyId: string; proposalId: string; maxHoldBars: number; barsWaited: number; ttlBars: number }
export interface FPState {
  version: typeof FUTURES_PAPER_VERSION; wallet: number; seq: number; day: number; dayCash: number; halted: boolean;
  positions: Record<string, FPPosition>; pending: Record<string, FPPending>; strategyLoss: Record<string, number>; seen: string[];
}
export type FPEventKind = "funding" | "entry_fill" | "entry_cancelled" | "exit_fill" | "liquidation" | "order_accepted" | "order_rejected";
export interface FPEvent { seq: number; t: number; symbol: string; kind: FPEventKind; side: PerpSide | null; qty: number; price: number | null; fee: number; pnl: number; walletDelta: number; marginDelta: number; reason: string; proposalId: string | null }
export interface FPTrade { symbol: string; side: PerpSide; strategyId: string; proposalId: string; entryT: number; exitT: number; entry: number; exit: number; qty: number; leverage: number; pnl: number; fees: number; funding: number; net: number; reason: "stop" | "target" | "time" | "liquidation" }
export interface FPStepResult { state: FPState; events: FPEvent[]; trades: FPTrade[]; decisions: RiskDecision[] }

export class FuturesPaperDataError extends Error {}

export const initialFuturesPaperState = (balance: number): FPState => ({ version: FUTURES_PAPER_VERSION, wallet: balance, seq: 0, day: -1, dayCash: 0, halted: false, positions: {}, pending: {}, strategyLoss: {}, seen: [] });

const dir = (s: PerpSide) => (s === "LONG" ? 1 : -1);
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Taker fill: buy above, sell below the reference by half the spread plus slippage. */
export function takerFill(action: "buy" | "sell", ref: number, qty: number, c: FPCosts) {
  const adj = c.spreadPct / 200 + c.slippagePct / 100, price = ref * (1 + (action === "buy" ? adj : -adj));
  return { price, fee: price * qty * (c.takerFeePct / 100) };
}
/** Isolated liquidation price from the position's actual margin (maintenance amount of the first bracket is 0). */
export function isolatedLiquidationPrice(side: PerpSide, entry: number, qty: number, margin: number, mmr: number) {
  if (!(qty > 0)) return null;
  const p = side === "LONG" ? (qty * entry - margin) / (qty * (1 - mmr)) : (qty * entry + margin) / (qty * (1 + mmr));
  return p > 0 ? p : 0;
}
export const unrealizedAt = (p: FPPosition, mark: number) => dir(p.side) * (mark - p.entryPrice) * p.qty;
const usedMargin = (s: FPState) => Object.values(s.positions).reduce((a, p) => a + p.margin, 0);
const reservedMargin = (s: FPState, marks: Record<string, number>) => Object.values(s.pending).reduce((a, q) => a + ((q.qtyTotal - q.qtyFilled) * (marks[q.symbol] ?? 0)) / q.leverage, 0);

function validateBar(b: FPBar) {
  const ok = (x: OHLC | null) => !!x && [x.o, x.h, x.l, x.c].every((v) => fin(v) && v > 0) && x.h >= Math.max(x.o, x.c) - EPS && x.l <= Math.min(x.o, x.c) + EPS;
  if (!ok(b.trade) || !fin(b.trade.v) || b.trade.v < 0) throw new FuturesPaperDataError(`${b.symbol} ${b.t}: invalid trade candle`);
  if (!ok(b.mark)) throw new FuturesPaperDataError(`${b.symbol} ${b.t}: mark price candle missing or invalid`);
  if (b.funding.some((f) => !fin(f.t) || !fin(f.rate) || f.t < b.t || f.t >= b.t + b.tfMs || Math.abs(f.rate) > 0.05)) throw new FuturesPaperDataError(`${b.symbol} ${b.t}: funding event outside the candle or invalid`);
}

/**
 * Advances ONE symbol by ONE closed candle. Order inside the candle: day rollover → funding (positions held before the
 * open) → pending entry fills at the open → liquidation / stop / target / time stop → new intents evaluated at the
 * close by the Central Risk Engine (fills start next candle). `marks` gives the latest mark of every symbol for
 * account-wide margin and exposure.
 */
export function stepFuturesPaper(prev: FPState, cfg: FPConfig, bar: FPBar, intents: FPIntent[], marks: Record<string, number> = {}): FPStepResult {
  validateBar(bar);
  const spec = cfg.specs[bar.symbol];
  if (!spec) throw new FuturesPaperDataError(`${bar.symbol}: no symbol specification`);
  const s: FPState = structuredClone(prev);
  const events: FPEvent[] = [], trades: FPTrade[] = [], decisions: RiskDecision[] = [];
  const mark = bar.mark!, sym = bar.symbol, closeT = bar.t + bar.tfMs;
  const emit = (e: Omit<FPEvent, "seq" | "symbol">) => {
    const ev = { seq: ++s.seq, symbol: sym, ...e }; events.push(ev);
    s.wallet += ev.walletDelta; s.dayCash += ev.walletDelta; return ev;
  };
  const day = Math.floor(bar.t / DAY);
  if (day !== s.day) { s.day = day; s.dayCash = 0; }

  // Funding for a position held before this candle opened.
  let pos: FPPosition | undefined = s.positions[sym];
  for (const f of [...bar.funding].sort((a, b) => a.t - b.t)) {
    if (!pos || pos.openedAt >= f.t) continue;
    const cash = -dir(pos.side) * pos.qty * mark.o * f.rate;
    pos.funding += cash; pos.margin += cash;
    emit({ t: f.t, kind: "funding", side: pos.side, qty: pos.qty, price: mark.o, fee: 0, pnl: 0, walletDelta: cash, marginDelta: cash, reason: `funding rate ${f.rate}`, proposalId: pos.proposalId });
  }

  // Pending (partially filled) entries continue at this candle's open.
  const pend = s.pending[sym];
  if (pend) {
    pend.barsWaited++;
    const left = pend.qtyTotal - pend.qtyFilled;
    const cap = cfg.costs.maxParticipationPct === null ? left : (bar.trade.v * cfg.costs.maxParticipationPct) / 100;
    let q = Math.floor(Math.min(left, cap) / spec.stepSize + EPS) * spec.stepSize;
    const action = pend.side === "LONG" ? "buy" : "sell";
    let fill = takerFill(action, bar.trade.o, q, cfg.costs);
    const free = s.wallet - usedMargin(s);
    if (q > 0 && (fill.price * q) / pend.leverage + fill.fee > free + EPS) q = 0; // not enough simulated margin: no fill
    if (q > 0) {
      fill = takerFill(action, bar.trade.o, q, cfg.costs);
      const add = (fill.price * q) / pend.leverage;
      if (!pos) {
        pos = { symbol: sym, side: pend.side, qty: 0, entryPrice: fill.price, leverage: pend.leverage, margin: 0, stop: 0, target: null, stopDist: pend.stopDist, targetDist: pend.targetDist, openedAt: bar.t, bars: 0, maxHoldBars: pend.maxHoldBars, strategyId: pend.strategyId, proposalId: pend.proposalId, fees: 0, funding: 0 };
        s.positions[sym] = pos;
      }
      pos.entryPrice = (pos.entryPrice * pos.qty + fill.price * q) / (pos.qty + q);
      pos.qty += q; pos.margin += add; pos.fees += fill.fee; pend.qtyFilled += q;
      // Exchange-style close-position protection is re-anchored to the average entry and covers the whole position.
      pos.stop = pos.entryPrice - dir(pos.side) * pos.stopDist;
      pos.target = pos.targetDist === null ? null : pos.entryPrice + dir(pos.side) * pos.targetDist;
      emit({ t: bar.t, kind: "entry_fill", side: pend.side, qty: q, price: fill.price, fee: fill.fee, pnl: 0, walletDelta: -fill.fee, marginDelta: add, reason: pend.qtyFilled + EPS < pend.qtyTotal ? "partial fill (volume cap)" : "filled", proposalId: pend.proposalId });
    }
    const rest = pend.qtyTotal - pend.qtyFilled;
    if (rest <= spec.stepSize / 2) delete s.pending[sym];
    else if (pend.barsWaited >= pend.ttlBars) {
      delete s.pending[sym];
      emit({ t: bar.t, kind: "entry_cancelled", side: pend.side, qty: rest, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: "unfilled remainder cancelled at its time limit", proposalId: pend.proposalId });
    }
  }

  // Liquidation and protective orders, then the time stop.
  if (pos) {
    pos.bars++;
    const L = pos.side === "LONG", trig = cfg.triggerSource === "MARK" ? mark : bar.trade;
    const liq = isolatedLiquidationPrice(pos.side, pos.entryPrice, pos.qty, pos.margin, spec.maintenanceMarginRate)!;
    const close = (reason: FPTrade["reason"], ref: number, t: number) => {
      const p = pos!; const f = takerFill(L ? "sell" : "buy", ref, p.qty, cfg.costs);
      const pnl = dir(p.side) * (f.price - p.entryPrice) * p.qty;
      emit({ t, kind: "exit_fill", side: p.side, qty: p.qty, price: f.price, fee: f.fee, pnl, walletDelta: pnl - f.fee, marginDelta: -p.margin, reason, proposalId: p.proposalId });
      finish(p, reason, f.price, t, pnl, p.fees + f.fee);
    };
    const finish = (p: FPPosition, reason: FPTrade["reason"], exit: number, t: number, pnl: number, fees: number) => {
      const net = pnl - fees + p.funding;
      trades.push({ symbol: sym, side: p.side, strategyId: p.strategyId, proposalId: p.proposalId, entryT: p.openedAt, exitT: t, entry: p.entryPrice, exit, qty: p.qty, leverage: p.leverage, pnl, fees, funding: p.funding, net, reason });
      if (net < 0) s.strategyLoss[p.strategyId] = (s.strategyLoss[p.strategyId] ?? 0) - net;
      delete s.positions[sym];
      if (s.pending[sym]) { const q = s.pending[sym]!; delete s.pending[sym]; emit({ t, kind: "entry_cancelled", side: q.side, qty: q.qtyTotal - q.qtyFilled, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: "position closed: remainder cancelled", proposalId: q.proposalId }); }
      pos = undefined;
    };
    const liquidate = (t: number) => {
      const p = pos!; const lost = p.margin;
      emit({ t, kind: "liquidation", side: p.side, qty: p.qty, price: liq, fee: 0, pnl: -lost, walletDelta: -lost, marginDelta: -lost, reason: `mark reached estimated liquidation ${liq.toFixed(4)}; isolated margin lost`, proposalId: p.proposalId });
      // PnL = −(isolated margin incl. funding); net = PnL − entry fees + funding = −(initial margin) − entry fees.
      finish(p, "liquidation", liq, t, -lost, p.fees);
    };
    const liqAtOpen = L ? mark.o <= liq : mark.o >= liq;
    const stopAtOpen = L ? trig.o <= pos.stop : trig.o >= pos.stop;
    const tgtAtOpen = pos.target !== null && (L ? trig.o >= pos.target : trig.o <= pos.target);
    const stopIn = L ? trig.l <= pos.stop : trig.h >= pos.stop;
    const liqIn = L ? mark.l <= liq : mark.h >= liq;
    const tgtIn = pos.target !== null && (L ? trig.h >= pos.target : trig.l <= pos.target);
    const stopBeforeLiq = L ? pos.stop > liq : pos.stop < liq;
    if (liqAtOpen) liquidate(bar.t);
    else if (stopAtOpen) close("stop", bar.trade.o, bar.t);
    else if (tgtAtOpen) close("target", bar.trade.o, bar.t);
    else if (stopIn && stopBeforeLiq) close("stop", pos.stop, bar.t);
    else if (liqIn) liquidate(bar.t);
    else if (tgtIn) close("target", pos.target!, bar.t);
    else if (pos.bars >= pos.maxHoldBars) close("time", bar.trade.c, closeT);
  }

  // New intents, evaluated at the candle close by the Central Risk Engine.
  const allMarks = { ...marks, [sym]: mark.c };
  for (const it of intents) {
    const p = it.proposal;
    const reject = (reason: string) => emit({ t: closeT, kind: "order_rejected", side: p.side ?? null, qty: 0, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason, proposalId: typeof p.proposalId === "string" ? p.proposalId : null });
    if (p.environment !== "paper" || p.market !== "usdm_futures" || p.symbol.replace("/", "") !== sym) { reject("Futures paper accepts only paper USD-M proposals for this symbol"); continue; }
    if (!bar.index || !(bar.index.c > 0)) { reject("Index price unavailable: entry refused"); continue; }
    const basis = (Math.abs(mark.c - bar.index.c) / bar.index.c) * 100;
    if (basis > cfg.maxBasisPct) { reject(`Mark/index basis ${basis.toFixed(3)}% exceeds ${cfg.maxBasisPct}%: entry refused`); continue; }
    const positions = Object.values(s.positions), pendings = Object.values(s.pending);
    const unreal = positions.reduce((a, q) => a + unrealizedAt(q, allMarks[q.symbol] ?? q.entryPrice), 0);
    const negUnreal = positions.reduce((a, q) => a + Math.min(0, unrealizedAt(q, allMarks[q.symbol] ?? q.entryPrice)), 0);
    const exposure = positions.reduce((a, q) => a + q.qty * (allMarks[q.symbol] ?? q.entryPrice), 0) + pendings.reduce((a, q) => a + (q.qtyTotal - q.qtyFilled) * (allMarks[q.symbol] ?? 0), 0);
    const d = evaluateProposal(p, {
      now: closeT,
      account: { equity: s.wallet + unreal, availableMargin: s.wallet - usedMargin(s) - reservedMargin(s, allMarks), openExposure: exposure, openPositions: positions.length + pendings.filter((q) => !s.positions[q.symbol]).length, dayNet: s.dayCash + negUnreal, halted: s.halted, environmentHalted: s.halted },
      limits: cfg.limits,
      strategy: { budget: cfg.strategyBudgets[p.strategyId] ?? null, usedLoss: s.strategyLoss[p.strategyId] ?? 0 },
      market: { markPrice: mark.c, markTimestamp: closeT, stepSize: spec.stepSize, minNotional: spec.minNotional, maintenanceMarginRate: spec.maintenanceMarginRate },
      orders: { sameProposalSeen: s.seen.includes(p.proposalId), unresolvedOrders: 0, openPositionOnSymbol: !!s.positions[sym] || !!s.pending[sym] },
    });
    decisions.push(d);
    if (typeof p.proposalId === "string") s.seen.push(p.proposalId);
    if (d.verdict !== "ACCEPT" || !d.sizing) { reject(`${d.verdict}: ${d.checks.filter((c) => c.status === "fail" || c.status === "missing").map((c) => c.detail).join("; ")}`); continue; }
    const stopDist = Math.abs(mark.c - p.stopPrice!), targetDist = p.takeProfitPrice === null ? null : Math.abs(p.takeProfitPrice - mark.c);
    s.pending[sym] = { symbol: sym, side: p.side, qtyTotal: d.sizing.qty, qtyFilled: 0, leverage: d.sizing.leverage, stopDist, targetDist, strategyId: p.strategyId, proposalId: p.proposalId, maxHoldBars: it.maxHoldBars, barsWaited: 0, ttlBars: cfg.entryTtlBars };
    emit({ t: closeT, kind: "order_accepted", side: p.side, qty: d.sizing.qty, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: `Risk Engine sized ${d.sizing.qty} at ${d.sizing.leverage}× (limited by ${d.sizing.binding}); fills from the next open`, proposalId: p.proposalId });
  }
  return { state: s, events, trades, decisions };
}

/**
 * Position reconciliation: rebuilds wallet, per-symbol quantity and isolated margin from the event ledger alone and
 * compares them with the state. Any mismatch (or negative free margin) is returned; an empty list means consistent.
 */
export function reconcileFuturesPaper(state: FPState, events: FPEvent[], startingBalance: number): string[] {
  const out: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const wallet = events.reduce((a, e) => a + e.walletDelta, startingBalance);
  if (!near(wallet, state.wallet)) out.push(`wallet ${state.wallet} ≠ ledger ${wallet}`);
  const qty: Record<string, number> = {}, margin: Record<string, number> = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === "entry_fill") qty[e.symbol] = (qty[e.symbol] ?? 0) + e.qty;
    if (e.kind === "exit_fill" || e.kind === "liquidation") qty[e.symbol] = 0;
    margin[e.symbol] = (margin[e.symbol] ?? 0) + e.marginDelta;
    if (e.kind === "exit_fill" || e.kind === "liquidation") margin[e.symbol] = 0;
  }
  for (const sym of new Set([...Object.keys(qty), ...Object.keys(state.positions)])) {
    const p = state.positions[sym];
    if (!near(qty[sym] ?? 0, p?.qty ?? 0)) out.push(`${sym} quantity ${p?.qty ?? 0} ≠ ledger ${qty[sym] ?? 0}`);
    if (!near(margin[sym] ?? 0, p?.margin ?? 0)) out.push(`${sym} margin ${p?.margin ?? 0} ≠ ledger ${margin[sym] ?? 0}`);
    if (p && !(p.margin > 0)) out.push(`${sym} isolated margin is not positive`);
  }
  const seqs = events.map((e) => e.seq);
  if (seqs.some((q, i) => q !== (i === 0 ? 1 : seqs[i - 1]! + 1))) out.push("ledger sequence has a gap");
  if (state.wallet - usedMargin(state) < -1e-6) out.push("free margin is negative");
  return out;
}

/** Payload for the draft 0045 `futures_paper_commit_bar` (one closed candle, all its events, the resulting state). */
export function futuresPaperCommitPayload(state: FPState, events: FPEvent[]) {
  return {
    wallet: state.wallet, state,
    events: events.map((e) => ({ seq: e.seq, t: e.t, symbol: e.symbol, kind: e.kind, side: e.side, qty: e.qty, price: e.price, fee: e.fee, pnl: e.pnl, wallet_delta: e.walletDelta, margin_delta: e.marginDelta, reason: e.reason, proposal_id: e.proposalId })),
  };
}
