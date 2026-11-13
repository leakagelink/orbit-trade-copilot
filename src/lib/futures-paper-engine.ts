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
//  * Fill-time re-validation (Phase 4D): before ANY pending entry fill the engine re-checks, with the same definitions
//    as draft 0046's commit function, the account status/halt, pending validity, strategy/environment identity, the
//    eligible marks of every held symbol, daily loss, cumulative strategy budget (closed losses + reserved open risk +
//    this fill's risk), exposure, position count and free margin — on the ACTUAL fill quantity. A refused fill is never
//    executed: the unfilled remainder is cancelled with a reason code (an `entry_cancelled` event, which the ledger
//    contract permits), so the account cannot stall on a fill the database would refuse.
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
export interface FPPending { symbol: string; side: PerpSide; qtyTotal: number; qtyFilled: number; leverage: number; stopDist: number; targetDist: number | null; strategyId: string; proposalId: string; maxHoldBars: number; barsWaited: number; ttlBars: number; environment: "paper" }
export interface FPState {
  version: typeof FUTURES_PAPER_VERSION; wallet: number; seq: number; day: number; dayCash: number; halted: boolean;
  positions: Record<string, FPPosition>; pending: Record<string, FPPending>; strategyLoss: Record<string, number>; seen: string[];
  /** Last processed candle open time per symbol. A candle at or before it is refused (duplicate / out of order). */
  cursors?: Record<string, number>;
  /** Account-wide cursor (last committed candle open time), set only by `stepFuturesPaperCandle`. */
  accountCursor?: number;
}
export type FPEventKind = "funding" | "entry_fill" | "entry_cancelled" | "exit_fill" | "liquidation" | "order_accepted" | "order_rejected";
export interface FPEvent { seq: number; t: number; symbol: string; kind: FPEventKind; side: PerpSide | null; qty: number; price: number | null; fee: number; pnl: number; walletDelta: number; marginDelta: number; reason: string; proposalId: string | null }
export interface FPTrade { symbol: string; side: PerpSide; strategyId: string; proposalId: string; entryT: number; exitT: number; entry: number; exit: number; qty: number; leverage: number; pnl: number; fees: number; funding: number; net: number; reason: "stop" | "target" | "time" | "liquidation" }
/** Reason codes for a refused pending entry fill (bounded; no free text from outside the engine). */
export const FILL_REFUSAL_CODES = [
  "ACCOUNT_HALTED", "ACCOUNT_NOT_ACTIVE", "PENDING_INVALID", "ENVIRONMENT_MISMATCH", "STRATEGY_IDENTITY_MISMATCH",
  "MARK_MISSING", "MARK_STALE", "MARK_INVALID", "LIMIT_MISSING", "DAILY_LOSS_LIMIT", "STRATEGY_BUDGET_MISSING",
  "STRATEGY_USAGE_UNKNOWN", "STRATEGY_BUDGET_EXCEEDED", "EXPOSURE_LIMIT", "POSITION_LIMIT", "FREE_MARGIN",
] as const;
export type FPRefusalCode = (typeof FILL_REFUSAL_CODES)[number];
export interface FPRefusal { t: number; symbol: string; proposalId: string | null; strategyId: string | null; code: FPRefusalCode; source: "engine" | "ledger"; detail: string }
/**
 * Facts only the ledger (draft 0046 database view) knows, required for ledger-bound fill re-validation. Every value is
 * mandatory: a missing per-strategy usage or mark refuses the fill (never a default of zero).
 */
export interface FPFillContext {
  accountStatus: "active" | "paused" | "stopped";
  accountHalted: boolean;
  /** Closed-trade losses and reserved open risk of each strategy in the owner's OTHER paper accounts. */
  externalStrategy: Record<string, { closedLoss: number; reservedRisk: number }>;
  /** Latest eligible mark (price and its time) of every symbol the fill check needs — the marks the payload carries. */
  marks: Record<string, { price: number; t: number }>;
  maxMarkAgeMs: number;
  /** Proposals whose fill the ledger refused at commit (from `planCommitRefusal`): cancelled, never re-attempted. */
  refused?: Record<string, FPRefusalCode>;
}
export interface FPStepResult { state: FPState; events: FPEvent[]; trades: FPTrade[]; decisions: RiskDecision[]; refusals: FPRefusal[] }

export class FuturesPaperDataError extends Error {}

export const initialFuturesPaperState = (balance: number): FPState => ({ version: FUTURES_PAPER_VERSION, wallet: balance, seq: 0, day: -1, dayCash: 0, halted: false, positions: {}, pending: {}, strategyLoss: {}, seen: [], cursors: {} });

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

function validateFillContext(f: FPFillContext) {
  const obj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  if (!obj(f) || !["active", "paused", "stopped"].includes(f.accountStatus) || typeof f.accountHalted !== "boolean" || !obj(f.externalStrategy) || !obj(f.marks)
    || !fin(f.maxMarkAgeMs) || f.maxMarkAgeMs < 0 || (f.refused !== undefined && !obj(f.refused))) {
    throw new FuturesPaperDataError("fill context is malformed: account status, halt flag, strategy usage, marks and mark age are all required");
  }
  if (f.refused) for (const c of Object.values(f.refused)) if (!(FILL_REFUSAL_CODES as readonly string[]).includes(c)) throw new FuturesPaperDataError("fill context: unknown refusal code");
}

/** Structural validity of a pending entry before anything is computed from it. */
function pendingProblem(q: FPPending, sym: string): string | null {
  if (q.symbol !== sym) return "pending entry is filed under another symbol";
  if (q.side !== "LONG" && q.side !== "SHORT") return "pending side is invalid";
  if (typeof q.proposalId !== "string" || !q.proposalId || typeof q.strategyId !== "string" || !q.strategyId) return "pending entry has no proposal or strategy identity";
  if (![q.qtyTotal, q.qtyFilled, q.leverage, q.stopDist, q.barsWaited, q.ttlBars, q.maxHoldBars].every(fin)) return "pending numbers are not finite";
  if (!(q.qtyTotal > 0) || q.qtyFilled < 0 || q.qtyFilled >= q.qtyTotal || !(q.leverage >= 1) || !(q.stopDist > 0) || (q.targetDist !== null && !(fin(q.targetDist) && q.targetDist > 0))) return "pending quantities, leverage or protection are out of range";
  if (q.barsWaited > q.ttlBars) return "pending entry is past its time limit";
  return null;
}

/**
 * Fill-time re-validation for ONE pending entry slice of `q` units at `price` (fee `fee`, margin `add`). Uses the same
 * definitions as draft 0046 `futures_paper_commit_bar_v2`: daily loss = today's account cash (events of the same UTC day,
 * this candle included) + Σ negative unrealized at the marks; strategy budget = cumulative closed-trade losses per
 * proposal (wins not netted) + reserved open risk (qty × stop distance + qty × entry × round-trip cost) + this fill's
 * risk; exposure, position count and free margin are evaluated AFTER the fill on positions only. Returns null when every
 * check passes. Without a ledger context (offline replay) usage outside this state is not known and marks have no age.
 */
function fillRefusal(s: FPState, cfg: FPConfig, bar: FPBar, pend: FPPending, q: number, price: number, fee: number, add: number, legacy: Record<string, number>, fill: FPFillContext | undefined): { code: FPRefusalCode; detail: string } | null {
  const no = (code: FPRefusalCode, detail: string) => ({ code, detail });
  const sym = bar.symbol, pos = s.positions[sym];
  if (pend.environment !== "paper") return no("ENVIRONMENT_MISMATCH", "pending entry is not a paper-environment entry");
  if (pos && (pos.side !== pend.side || pos.strategyId !== pend.strategyId || pos.proposalId !== pend.proposalId)) return no("STRATEGY_IDENTITY_MISMATCH", `fill does not match the open ${sym} position`);
  const mk: Record<string, number> = {};
  for (const x of [...new Set([...Object.keys(s.positions), sym])].sort()) {
    if (fill) {
      const m = fill.marks[x];
      if (!m) return no("MARK_MISSING", `no eligible mark for ${x}`);
      if (!fin(m.price) || !(m.price > 0) || !fin(m.t)) return no("MARK_INVALID", `mark for ${x} is not a positive timestamped number`);
      const age = bar.t - m.t;
      if (age < 0) return no("MARK_INVALID", `mark for ${x} is later than the fill time`);
      if (age > fill.maxMarkAgeMs) return no("MARK_STALE", `mark for ${x} is ${age} ms old (max ${fill.maxMarkAgeMs} ms)`);
      mk[x] = m.price;
    } else {
      const v = x === sym ? bar.mark!.o : legacy[x];
      if (!fin(v) || !(v > 0)) return no("MARK_MISSING", `no mark for ${x}`);
      mk[x] = v;
    }
  }
  const L = cfg.limits;
  if (!fin(L.maxDailyLoss) || !fin(L.maxExposure) || !fin(L.maxPositions) || !fin(L.roundTripCostPct) || L.roundTripCostPct < 0) return no("LIMIT_MISSING", "daily loss, exposure, position or cost limit is not configured");
  const positions = Object.values(s.positions);
  const unreal = positions.reduce((a, p) => a + Math.min(0, unrealizedAt(p, mk[p.symbol]!)), 0);
  const dayLeft = L.maxDailyLoss + Math.min(0, s.dayCash + unreal);
  if (!(dayLeft > 0)) return no("DAILY_LOSS_LIMIT", `daily loss ${(-(s.dayCash + unreal)).toFixed(6)} reached the limit ${L.maxDailyLoss}`);
  const budget = cfg.strategyBudgets[pend.strategyId];
  if (!fin(budget) || !(budget > 0)) return no("STRATEGY_BUDGET_MISSING", `no paper risk budget for strategy ${pend.strategyId}`);
  let extLoss = 0, extReserved = 0;
  if (fill) {
    const e = fill.externalStrategy[pend.strategyId];
    if (!e || !fin(e.closedLoss) || !fin(e.reservedRisk) || e.closedLoss < 0 || e.reservedRisk < 0) return no("STRATEGY_USAGE_UNKNOWN", `strategy ${pend.strategyId} usage in other paper accounts is unknown`);
    extLoss = e.closedLoss; extReserved = e.reservedRisk;
  }
  const rtc = L.roundTripCostPct / 100;
  const reserved = positions.filter((p) => p.strategyId === pend.strategyId).reduce((a, p) => a + p.qty * p.stopDist + p.qty * p.entryPrice * rtc, 0) + extReserved;
  const used = (s.strategyLoss[pend.strategyId] ?? 0) + extLoss, fillRisk = q * pend.stopDist + q * price * rtc;
  if (used + reserved + fillRisk > budget) return no("STRATEGY_BUDGET_EXCEEDED", `strategy ${pend.strategyId}: used ${used.toFixed(6)} + reserved ${reserved.toFixed(6)} + fill risk ${fillRisk.toFixed(6)} > budget ${budget}`);
  const exposure = positions.reduce((a, p) => a + p.qty * mk[p.symbol]!, 0) + q * mk[sym]!;
  if (exposure > L.maxExposure) return no("EXPOSURE_LIMIT", `exposure ${exposure.toFixed(6)} after the fill would exceed ${L.maxExposure}`);
  const count = positions.length + (pos ? 0 : 1);
  if (count > L.maxPositions) return no("POSITION_LIMIT", `${count} positions after the fill would exceed ${L.maxPositions}`);
  if (add + fee > s.wallet - usedMargin(s) + EPS) return no("FREE_MARGIN", `margin ${add.toFixed(6)} + fee ${fee.toFixed(6)} exceeds free margin ${(s.wallet - usedMargin(s)).toFixed(6)}`);
  return null;
}

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
export function stepFuturesPaper(prev: FPState, cfg: FPConfig, bar: FPBar, intents: FPIntent[], marks: Record<string, number> = {}, fill?: FPFillContext): FPStepResult {
  validateBar(bar);
  if (fill !== undefined) validateFillContext(fill);
  const last = prev.cursors?.[bar.symbol];
  if (last !== undefined && bar.t <= last) throw new FuturesPaperDataError(`${bar.symbol} ${bar.t}: duplicate or out-of-order candle (last processed ${last})`);
  const spec = cfg.specs[bar.symbol];
  if (!spec) throw new FuturesPaperDataError(`${bar.symbol}: no symbol specification`);
  const s: FPState = structuredClone(prev);
  // The ledger's halt flag is authoritative (the database refuses a state whose flag differs from the account's).
  if (fill) s.halted = fill.accountHalted;
  const events: FPEvent[] = [], trades: FPTrade[] = [], decisions: RiskDecision[] = [], refusals: FPRefusal[] = [];
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

  // Pending (partially filled) entries continue at this candle's open — only after fill-time re-validation.
  const pend = s.pending[sym];
  const refuse = (q: FPPending, code: FPRefusalCode, detail: string, source: FPRefusal["source"] = "engine") => {
    delete s.pending[sym];
    const left = fin(q.qtyTotal) && fin(q.qtyFilled) ? Math.max(0, q.qtyTotal - q.qtyFilled) : 0;
    const proposalId = typeof q.proposalId === "string" && q.proposalId ? q.proposalId : null;
    refusals.push({ t: bar.t, symbol: sym, proposalId, strategyId: typeof q.strategyId === "string" && q.strategyId ? q.strategyId : null, code, source, detail });
    emit({ t: bar.t, kind: "entry_cancelled", side: q.side === "LONG" || q.side === "SHORT" ? q.side : null, qty: left, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: `fill refused [${code}]: ${detail}; unfilled entry cancelled`, proposalId });
  };
  const bad = pend ? pendingProblem(pend, sym) : null;
  if (pend && s.halted) {
    // Emergency paper stop: no new exposure. The unfilled remainder is cancelled; exits below still run.
    refuse(pend, "ACCOUNT_HALTED", "emergency paper stop");
  } else if (pend && fill && fill.accountStatus !== "active") {
    refuse(pend, "ACCOUNT_NOT_ACTIVE", `paper account is ${fill.accountStatus}`);
  } else if (pend && bad) {
    refuse(pend, "PENDING_INVALID", bad);
  } else if (pend && fill?.refused?.[pend.proposalId]) {
    refuse(pend, fill.refused[pend.proposalId]!, "the ledger refused this fill at commit", "ledger");
  } else if (pend) {
    pend.barsWaited++;
    const left = pend.qtyTotal - pend.qtyFilled;
    const cap = cfg.costs.maxParticipationPct === null ? left : (bar.trade.v * cfg.costs.maxParticipationPct) / 100;
    const q = Math.floor(Math.min(left, cap) / spec.stepSize + EPS) * spec.stepSize; // ACTUAL fill quantity
    const action = pend.side === "LONG" ? "buy" : "sell";
    const fillPx = q > 0 ? takerFill(action, bar.trade.o, q, cfg.costs) : null;
    const add = fillPx ? (fillPx.price * q) / pend.leverage : 0;
    const no = fillPx ? fillRefusal(s, cfg, bar, pend, q, fillPx.price, fillPx.fee, add, marks, fill) : null;
    if (no) refuse(pend, no.code, no.detail);
    else if (fillPx) {
      if (!pos) {
        pos = { symbol: sym, side: pend.side, qty: 0, entryPrice: fillPx.price, leverage: pend.leverage, margin: 0, stop: 0, target: null, stopDist: pend.stopDist, targetDist: pend.targetDist, openedAt: bar.t, bars: 0, maxHoldBars: pend.maxHoldBars, strategyId: pend.strategyId, proposalId: pend.proposalId, fees: 0, funding: 0 };
        s.positions[sym] = pos;
      }
      pos.entryPrice = (pos.entryPrice * pos.qty + fillPx.price * q) / (pos.qty + q);
      pos.qty += q; pos.margin += add; pos.fees += fillPx.fee; pend.qtyFilled += q;
      // Exchange-style close-position protection is re-anchored to the average entry and covers the whole position.
      pos.stop = pos.entryPrice - dir(pos.side) * pos.stopDist;
      pos.target = pos.targetDist === null ? null : pos.entryPrice + dir(pos.side) * pos.targetDist;
      emit({ t: bar.t, kind: "entry_fill", side: pend.side, qty: q, price: fillPx.price, fee: fillPx.fee, pnl: 0, walletDelta: -fillPx.fee, marginDelta: add, reason: pend.qtyFilled + EPS < pend.qtyTotal ? "partial fill (volume cap)" : "filled", proposalId: pend.proposalId });
    }
    if (s.pending[sym]) {
      const rest = pend.qtyTotal - pend.qtyFilled;
      if (rest <= spec.stepSize / 2) delete s.pending[sym];
      else if (pend.barsWaited >= pend.ttlBars) {
        delete s.pending[sym];
        emit({ t: bar.t, kind: "entry_cancelled", side: pend.side, qty: rest, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: "unfilled remainder cancelled at its time limit", proposalId: pend.proposalId });
      }
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
    // The ledger refuses an accepted order on an inactive account; refuse it here so the candle still commits.
    if (fill && fill.accountStatus !== "active") { reject(`ACCOUNT_NOT_ACTIVE: paper account is ${fill.accountStatus}; entry refused`); continue; }
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
    s.pending[sym] = { symbol: sym, side: p.side, qtyTotal: d.sizing.qty, qtyFilled: 0, leverage: d.sizing.leverage, stopDist, targetDist, strategyId: p.strategyId, proposalId: p.proposalId, maxHoldBars: it.maxHoldBars, barsWaited: 0, ttlBars: cfg.entryTtlBars, environment: "paper" };
    emit({ t: closeT, kind: "order_accepted", side: p.side, qty: d.sizing.qty, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: `Risk Engine sized ${d.sizing.qty} at ${d.sizing.leverage}× (limited by ${d.sizing.binding}); fills from the next open`, proposalId: p.proposalId });
  }
  s.cursors = { ...(s.cursors ?? {}), [sym]: bar.t };
  return { state: s, events, trades, decisions, refusals };
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

// ---------------------------------------------------------------------------------------------------------------------
// Account-wide candle (Phase 4D). One candle for EVERY symbol of the account under one account-wide cursor, producing
// one result for one ledger commit. All inputs are validated before any symbol is stepped and the function is pure, so a
// failure leaves nothing half-applied: either the whole multi-symbol candle is returned or an error is thrown.
// ---------------------------------------------------------------------------------------------------------------------

/** Ledger facts for one candle. Marks are NOT supplied: they are the candle's own mark opens (eligible at fill time). */
export type FPCandleContext = Omit<FPFillContext, "marks" | "maxMarkAgeMs">;
export interface FPCandleResult extends FPStepResult {
  barT: number;
  /** The exact marks the fill checks used; a ledger payload must carry these (draft 0046 re-checks with them). */
  marks: Record<string, number>;
}

export function stepFuturesPaperCandle(prev: FPState, cfg: FPConfig, bars: FPBar[], intents: FPIntent[], ctx: FPCandleContext): FPCandleResult {
  if (!Array.isArray(bars) || bars.length === 0) throw new FuturesPaperDataError("account candle: at least one symbol candle is required");
  const t = bars[0]!.t, tf = bars[0]!.tfMs;
  if (!fin(t) || !fin(tf) || !(tf > 0) || t % tf !== 0) throw new FuturesPaperDataError("account candle: candle time is not aligned to its timeframe");
  const syms = bars.map((b) => b.symbol);
  if (new Set(syms).size !== syms.length) throw new FuturesPaperDataError("account candle: a symbol appears twice");
  for (const b of bars) {
    if (b.t !== t || b.tfMs !== tf) throw new FuturesPaperDataError(`account candle: ${b.symbol} is not the same candle (${b.t} vs ${t})`);
    if (!cfg.specs[b.symbol]) throw new FuturesPaperDataError(`${b.symbol}: no symbol specification`);
    validateBar(b);
  }
  if (prev.accountCursor !== undefined && t <= prev.accountCursor) throw new FuturesPaperDataError(`account candle ${t}: duplicate or out-of-order (account cursor ${prev.accountCursor})`);
  for (const held of [...Object.keys(prev.positions), ...Object.keys(prev.pending)]) {
    if (!syms.includes(held)) throw new FuturesPaperDataError(`account candle ${t}: no candle for held symbol ${held}; nothing is applied`);
  }
  for (const it of intents) if (!syms.includes(it.proposal.symbol.replace("/", ""))) throw new FuturesPaperDataError(`account candle ${t}: intent for ${it.proposal.symbol} has no candle`);
  const ordered = [...bars].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const marks: Record<string, number> = Object.fromEntries(ordered.map((b) => [b.symbol, b.mark!.o]));
  const fill: FPFillContext = { ...ctx, marks: Object.fromEntries(ordered.map((b) => [b.symbol, { price: b.mark!.o, t: b.t }])), maxMarkAgeMs: 0 };
  validateFillContext(fill);
  const closes: Record<string, number> = Object.fromEntries(ordered.map((b) => [b.symbol, b.mark!.c]));
  let s = prev; const out: FPCandleResult = { state: prev, events: [], trades: [], decisions: [], refusals: [], barT: t, marks };
  for (const b of ordered) {
    const r = stepFuturesPaper(s, cfg, b, intents.filter((i) => i.proposal.symbol.replace("/", "") === b.symbol), closes, fill);
    s = r.state; out.events.push(...r.events); out.trades.push(...r.trades); out.decisions.push(...r.decisions); out.refusals.push(...r.refusals);
  }
  out.state = { ...s, accountCursor: t };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger commit refusal → deterministic next step (Phase 4D). The database message is classified into a bounded code
// and is never stored. A refused fill is recomputed as a cancellation; the same refusal twice, or anything unclassified,
// halts for review instead of looping. A lost response is NOT a refusal: resend the identical payload (idempotent).
// ---------------------------------------------------------------------------------------------------------------------
export type CommitRefusalPlan =
  | { action: "recompute"; refused: Record<string, FPRefusalCode>; code: FPRefusalCode }
  | { action: "reload_account"; code: "SEQUENCE_MOVED" | "ACCOUNT_STATE_CHANGED" | "CANDLE_ALREADY_COMMITTED" }
  | { action: "wait"; code: "CANDLE_NOT_CLOSED" }
  | { action: "halt_for_review"; code: "REFUSAL_REPEATED" | "UNCLASSIFIED_REFUSAL" };

const FILL_REFUSALS: [RegExp, FPRefusalCode][] = [
  [/daily loss limit reached: entry fill refused/, "DAILY_LOSS_LIMIT"],
  [/no paper risk budget for strategy (\S+): entry fill refused/, "STRATEGY_BUDGET_MISSING"],
  [/strategy (\S+) budget \S+ would be exceeded at fill/, "STRATEGY_BUDGET_EXCEEDED"],
  [/exposure \S+ would exceed \S+ at fill/, "EXPOSURE_LIMIT"],
  [/position limit \S+ exceeded at fill/, "POSITION_LIMIT"],
  [/free margin would be negative at fill/, "FREE_MARGIN"],
  [/entry fill does not match the open/, "STRATEGY_IDENTITY_MISMATCH"],
];

/**
 * @param prev    the state the refused attempt started from (its pending entries carry the strategy ids)
 * @param attempt the refused candle result
 * @param message the database error message (classified only; never persisted)
 * @param alreadyRefused refusals already applied to this candle
 */
export function planCommitRefusal(prev: FPState, attempt: Pick<FPStepResult, "events">, message: string, alreadyRefused: Record<string, FPRefusalCode> = {}): CommitRefusalPlan {
  const m = String(message ?? "").slice(0, 500);
  if (/already committed with a different payload/.test(m)) return { action: "reload_account", code: "CANDLE_ALREADY_COMMITTED" };
  if (/sequence moved|is not after the cursor/.test(m)) return { action: "reload_account", code: "SEQUENCE_MOVED" };
  if (/entries are refused while the account is not active or is halted|account is stopped/.test(m)) return { action: "reload_account", code: "ACCOUNT_STATE_CHANGED" };
  if (/has not closed yet/.test(m)) return { action: "wait", code: "CANDLE_NOT_CLOSED" };
  for (const [re, code] of FILL_REFUSALS) {
    const hit = re.exec(m);
    if (!hit) continue;
    const strategy = code === "STRATEGY_BUDGET_MISSING" || code === "STRATEGY_BUDGET_EXCEEDED" ? hit[1] ?? null : null;
    const targets = attempt.events.filter((e) => e.kind === "entry_fill" && e.proposalId && !(e.proposalId in alreadyRefused)
      && (strategy === null || prev.pending[e.symbol]?.strategyId === strategy)).map((e) => e.proposalId!);
    if (targets.length === 0) return { action: "halt_for_review", code: "REFUSAL_REPEATED" };
    return { action: "recompute", refused: { ...alreadyRefused, ...Object.fromEntries(targets.map((p) => [p, code])) }, code };
  }
  return { action: "halt_for_review", code: "UNCLASSIFIED_REFUSAL" };
}
