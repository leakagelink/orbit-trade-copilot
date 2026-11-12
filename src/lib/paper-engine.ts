// Forward paper trading engine (Phase 3). Pure and deterministic: each call processes exactly ONE newly closed candle
// for one paper strategy, using only candles that had closed by then. The same inputs always give the same output, so
// an interrupted tick is simply recomputed. Every fill is simulated — this module cannot reach any exchange, order,
// credential or wallet code (enforced by an import-graph test).
//
// Order of events inside a candle (documented assumption):
//   1. Emergency paper stop: pending entries are cancelled (conservative); an open position gets a market exit at this
//      candle's open when the stop was switched on before the candle opened, otherwise at the open after the first candle
//      that closed after the stop — a catch-up never exits at a time before the stop existed.
//   2. Working orders fill against the candle: market orders at the open (plus half-spread and slippage), limit orders
//      only when price trades THROUGH the limit (touching is not enough). Each fill takes at most the configured share
//      of the candle's volume; the rest keeps working (partial fills).
//   3. Stop-loss / take-profit inside the candle. If both could have traded, the stop wins (conservative). A gap through
//      the stop fills at the worse opening price. Take-profit is a limit: it needs a trade above the target.
//   4. At the close: exit and entry rules are evaluated on closed candles only; new orders work from the next candle.
//   5. Mark to market at the close.
import { computeAll, evalRules, type Candle } from "./indicators";
import type { StrategyConfig } from "./strategy";
import { fillAt, type CostModel } from "./backtest-costs";
import { floorQty, sizePaperEntry, PAPER_MIN_NOTIONAL, type PaperAccountContext, type PaperRiskPolicy } from "./paper-risk";

export const PAPER_ENGINE_VERSION = "forward-paper-v1";
export const PAPER_MIN_HISTORY = 60;
export const SIMULATED_FILL_LABEL = "Simulated paper fill — not an exchange fill";
const EPS = 1e-9;

export type OrderKind = "market" | "limit" | "stop" | "take_profit";
export interface PaperOrder {
  key: string; intent: "entry" | "exit"; kind: OrderKind; side: "buy" | "sell"; qty: number; filled: number; filledNotional: number;
  limitPrice: number | null; maxNotional: number | null; createdBarT: number; expiresBarT: number | null; reason: string;
}
export interface PaperPosition {
  key: string; qty: number; openedBarT: number; buyQty: number; buyNotional: number; sellQty: number; sellNotional: number;
  fees: number; spread: number; slippage: number; stop: number; target: number | null;
}
export interface PaperState { v: 1; cash: number; position: PaperPosition | null; orders: PaperOrder[]; seq: number; dayUtc: string | null; dayNet: number; closedTrades: number }
export interface PaperEvent {
  order_key: string; seq: number; event: "created" | "filled" | "partially_filled" | "cancelled" | "expired" | "rejected";
  intent: "entry" | "exit"; kind: OrderKind; side: "buy" | "sell"; qty: number; price: number | null;
  fee: number; spread_cost: number; slippage_cost: number; cash_delta: number; reason: string;
}
export interface PaperTrade {
  position_key: string; opened_bar_t: number; closed_bar_t: number; qty: number; avg_entry: number; avg_exit: number;
  gross_pnl: number; fees: number; spread_cost: number; slippage_cost: number; net_pnl: number; close_reason: string;
}
export type PaperSignal = "none" | "enter_long" | "exit" | "rejected" | "halted";
export interface PaperBarRecord {
  bar_t: number; candle: { o: number; h: number; l: number; c: number; v: number }; signal: PaperSignal;
  decision: Record<string, unknown>; cash: number; equity: number; position_qty: number; unrealized: number;
  open_exposure: number; open_positions: 0 | 1; day_utc: string; day_net: number;
}
export interface PaperStepInput {
  strategyKey: string; state: PaperState; history: Candle[]; tfMs: number; cfg: StrategyConfig; costs: CostModel; policy: PaperRiskPolicy;
  entriesAllowed: boolean; haltedAt: number | null; account: PaperAccountContext;
}
export interface PaperStepResult { state: PaperState; events: PaperEvent[]; trades: PaperTrade[]; record: PaperBarRecord }

export class PaperDataError extends Error {}

export function initialPaperState(startingCapital: number): PaperState {
  return { v: 1, cash: startingCapital, position: null, orders: [], seq: 0, dayUtc: null, dayNet: 0, closedTrades: 0 };
}
/** First candle a paper strategy may act on: the first one that opens at or after it was started. */
export function initialCursor(startedAt: number, tfMs: number) { return Math.ceil(startedAt / tfMs) * tfMs - tfMs; }
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function checkCandle(c: Candle | undefined, tfMs: number): asserts c is Candle {
  if (!c) throw new PaperDataError("No candle to process");
  const ok = [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 && c.v >= 0
    && c.h >= Math.max(c.o, c.c, c.l) && c.l <= Math.min(c.o, c.c, c.h) && c.t % tfMs === 0;
  if (!ok) throw new PaperDataError(`Invalid candle at ${Number.isFinite(c.t) ? new Date(c.t).toISOString() : "unknown time"}`);
}

export function stepPaperBar(i: PaperStepInput): PaperStepResult {
  const bar = i.history.at(-1);
  checkCandle(bar, i.tfMs);
  for (let k = 1; k < i.history.length; k++) if (i.history[k]!.t - i.history[k - 1]!.t !== i.tfMs) throw new PaperDataError("Candle history has a gap or is out of order");
  const s: PaperState = structuredClone(i.state);
  const c = i.costs;
  const events: PaperEvent[] = [];
  const trades: PaperTrade[] = [];
  const notes: string[] = [];
  let seq = 0;
  const day = utcDay(bar.t);
  if (s.dayUtc !== day) { s.dayUtc = day; s.dayNet = 0; }
  const halted = i.haltedAt !== null;
  const volumeCap = c.maxParticipationPct === null ? Infinity : bar.v * (c.maxParticipationPct / 100);
  let volumeUsed = 0;
  const capQty = (q: number) => floorQty(Math.min(q, Math.max(0, volumeCap - volumeUsed)));

  const emit = (o: PaperOrder, event: PaperEvent["event"], f?: { qty: number; price: number; fee: number; spread: number; slip: number; cash: number }, reason = o.reason) =>
    events.push({ order_key: o.key, seq: seq++, event, intent: o.intent, kind: o.kind, side: o.side, qty: f?.qty ?? (event === "created" ? o.qty : o.qty - o.filled), price: f?.price ?? o.limitPrice, fee: f?.fee ?? 0, spread_cost: f?.spread ?? 0, slippage_cost: f?.slip ?? 0, cash_delta: f?.cash ?? 0, reason });
  const newOrder = (o: Omit<PaperOrder, "key" | "filled" | "filledNotional" | "createdBarT">) => {
    const order: PaperOrder = { ...o, key: `${i.strategyKey}:${bar.t}:${s.seq++}`, filled: 0, filledNotional: 0, createdBarT: bar.t };
    emit(order, "created");
    return order;
  };
  const drop = (o: PaperOrder) => { s.orders = s.orders.filter((x) => x.key !== o.key); };
  const exitPending = () => s.orders.some((o) => o.intent === "exit");

  /** Applies one simulated fill to cash, the position and (when flat) settles the round trip. */
  const fill = (o: PaperOrder, qty: number, ref: number, asLimit: boolean) => {
    const f = asLimit ? { price: ref, fee: ref * qty * (c.feePct / 100), spreadCost: 0, slippageCost: 0 } : fillAt(o.side, ref, qty, c);
    const notional = f.price * qty;
    const cash = o.side === "buy" ? -(notional + f.fee) : notional - f.fee;
    s.cash += cash; volumeUsed += qty; o.filled += qty; o.filledNotional += notional;
    if (o.side === "buy") {
      const p = s.position ?? { key: `${i.strategyKey}:pos:${bar.t}`, qty: 0, openedBarT: bar.t, buyQty: 0, buyNotional: 0, sellQty: 0, sellNotional: 0, fees: 0, spread: 0, slippage: 0, stop: 0, target: null };
      p.qty += qty; p.buyQty += qty; p.buyNotional += notional; p.fees += f.fee; p.spread += f.spreadCost; p.slippage += f.slippageCost;
      const avg = p.buyNotional / p.buyQty;
      p.stop = avg * (1 - i.policy.stopLossPct / 100);
      p.target = i.policy.takeProfitPct === null ? null : avg * (1 + i.policy.takeProfitPct / 100);
      s.position = p;
    } else {
      const p = s.position!;
      p.qty -= qty; p.sellQty += qty; p.sellNotional += notional; p.fees += f.fee; p.spread += f.spreadCost; p.slippage += f.slippageCost;
      if (p.qty <= EPS) {
        const gross = p.sellNotional - p.buyNotional;
        const net = gross - p.fees;
        trades.push({ position_key: p.key, opened_bar_t: p.openedBarT, closed_bar_t: bar.t, qty: p.buyQty, avg_entry: p.buyNotional / p.buyQty, avg_exit: p.sellNotional / p.sellQty, gross_pnl: gross, fees: p.fees, spread_cost: p.spread, slippage_cost: p.slippage, net_pnl: net, close_reason: o.reason });
        s.dayNet += net; s.closedTrades += 1; s.position = null;
      }
    }
    // An entry whose approved notional or the cash is used up is complete (price drift since the signal is not a partial fill).
    if (o.intent === "entry" && ((o.maxNotional !== null && o.maxNotional - o.filledNotional < PAPER_MIN_NOTIONAL) || s.cash < PAPER_MIN_NOTIONAL)) o.qty = o.filled;
    emit(o, o.filled >= o.qty - EPS ? "filled" : "partially_filled", { qty, price: f.price, fee: f.fee, spread: f.spreadCost, slip: f.slippageCost, cash });
  };

  // 1. Emergency paper stop and paused strategies: no entry may fill from here on.
  if (halted || !i.entriesAllowed) {
    for (const o of s.orders.filter((x) => x.intent === "entry")) { emit(o, "cancelled", undefined, halted ? "Emergency paper stop" : "Paper strategy paused or plan inactive"); drop(o); }
  }
  if (halted && s.position && !exitPending() && bar.t >= i.haltedAt!) {
    s.orders.push(newOrder({ intent: "exit", kind: "market", side: "sell", qty: s.position.qty, limitPrice: null, maxNotional: null, expiresBarT: null, reason: "emergency_stop" }));
  }

  // 2. Working orders against this candle, oldest first.
  for (const o of [...s.orders]) {
    if (o.intent === "exit" && !s.position) { emit(o, "cancelled", undefined, "Position already closed"); drop(o); continue; }
    let ref: number | null = null;
    const limit = o.kind === "limit" && o.limitPrice !== null;
    if (!limit) ref = bar.o;
    else if (o.side === "buy" ? bar.l < o.limitPrice! : bar.h > o.limitPrice!) ref = o.side === "buy" ? Math.min(bar.o, o.limitPrice!) : Math.max(bar.o, o.limitPrice!);
    if (ref !== null) {
      let q = o.qty - o.filled;
      if (o.intent === "entry") {
        const est = limit ? ref : fillAt("buy", ref, 1, c).price;
        const perUnitCash = est * (1 + c.feePct / 100);
        q = Math.min(q, s.cash / perUnitCash, o.maxNotional === null ? Infinity : (o.maxNotional - o.filledNotional) / est);
      } else q = Math.min(q, s.position!.qty);
      q = capQty(q);
      if (q > EPS) fill(o, q, ref, limit);
      else if (volumeCap - volumeUsed <= EPS) notes.push(`${o.intent} order ${o.key}: no candle volume available within the participation cap`);
    }
    if (o.filled >= o.qty - EPS || (o.intent === "exit" && !s.position)) drop(o);
    else if (o.expiresBarT !== null && bar.t >= o.expiresBarT) { emit(o, "expired", undefined, o.filled > 0 ? "Partly filled; remainder expired" : "Not filled before expiry"); drop(o); }
  }

  // 3. Protective stop-loss / take-profit inside the candle.
  const p = s.position;
  if (p && !exitPending()) {
    const heldAtOpen = p.openedBarT < bar.t;
    let ref: number | null = null, kind: OrderKind = "stop", reason = "stop_loss", asLimit = false;
    if (heldAtOpen && bar.o <= p.stop) { ref = bar.o; reason = "stop_loss_gap"; }
    else if (bar.l <= p.stop) ref = p.stop;
    else if (p.target !== null && heldAtOpen && bar.o > p.target) { ref = bar.o; kind = "take_profit"; reason = "take_profit"; asLimit = true; }
    else if (p.target !== null && bar.h > p.target) { ref = p.target; kind = "take_profit"; reason = "take_profit"; asLimit = true; }
    if (ref !== null) {
      const o = newOrder({ intent: "exit", kind, side: "sell", qty: p.qty, limitPrice: asLimit ? ref : null, maxNotional: null, expiresBarT: null, reason });
      const q = capQty(p.qty);
      if (q > EPS) fill(o, q, ref, asLimit);
      if (s.position) {
        // Not enough candle volume: the rest leaves at market from the next candle's open.
        emit(o, "cancelled", undefined, "Remainder moved to a market exit (volume cap)");
        s.orders.push(newOrder({ intent: "exit", kind: "market", side: "sell", qty: s.position.qty, limitPrice: null, maxNotional: null, expiresBarT: null, reason: `${reason}_remainder` }));
      }
    }
  }

  // 4. Mark to market at the close (before exit costs).
  const pos = s.position;
  const unrealized = pos ? pos.qty * bar.c + pos.sellNotional - pos.buyNotional - pos.fees : 0;
  const equity = s.cash + (pos ? pos.qty * bar.c : 0);

  // 5. Close-of-candle decisions on closed candles only.
  let signal: PaperSignal = "none";
  const decision: Record<string, unknown> = { engine: PAPER_ENGINE_VERSION, decidedAt: bar.t + i.tfMs, candlesUsed: i.history.length, firstCandle: i.history[0]!.t };
  if (i.history.length < PAPER_MIN_HISTORY) decision["note"] = `Warming up: ${i.history.length}/${PAPER_MIN_HISTORY} closed candles`;
  else {
    const series = computeAll(i.cfg, i.history);
    const idx = i.history.length - 1;
    decision["indicators"] = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v[idx] ?? null]));
    if (s.position) {
      if (halted && !exitPending() && bar.t + i.tfMs >= i.haltedAt!) { s.orders.push(newOrder({ intent: "exit", kind: "market", side: "sell", qty: s.position.qty, limitPrice: null, maxNotional: null, expiresBarT: null, reason: "emergency_stop" })); signal = "halted"; }
      else if (!exitPending() && evalRules(i.cfg.exit, series, idx)) { s.orders.push(newOrder({ intent: "exit", kind: "market", side: "sell", qty: s.position.qty, limitPrice: null, maxNotional: null, expiresBarT: null, reason: "exit_signal" })); signal = "exit"; }
    } else if (!s.orders.some((o) => o.intent === "entry") && evalRules(i.cfg.entry, series, idx)) {
      if (halted) { signal = "halted"; decision["reason"] = "Entry signal ignored: emergency paper stop is on"; }
      else if (!i.entriesAllowed) { signal = "rejected"; decision["reason"] = "Entry signal ignored: paper strategy paused or plan inactive"; }
      else {
        const limit = i.policy.entryOrder === "limit";
        const limitPrice = limit ? bar.c * (1 - i.policy.limitOffsetPct / 100) : null;
        const estPrice = limit ? limitPrice! : fillAt("buy", bar.c, 1, c).price;
        const sizing = sizePaperEntry({ estPrice, equity, cash: s.cash, dayNet: s.dayNet + Math.min(0, unrealized), costs: c, policy: i.policy, account: i.account });
        decision["risk"] = sizing;
        if (!sizing.ok) { signal = "rejected"; decision["reason"] = sizing.reason; }
        else {
          signal = "enter_long";
          s.orders.push(newOrder({ intent: "entry", kind: limit ? "limit" : "market", side: "buy", qty: sizing.qty, limitPrice, maxNotional: sizing.notional, expiresBarT: bar.t + i.policy.orderTtlBars * i.tfMs, reason: "entry_signal" }));
        }
      }
    }
  }
  if (notes.length) decision["notes"] = notes;
  const fp = s.position;
  return {
    state: s, events, trades,
    record: {
      bar_t: bar.t, candle: { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }, signal, decision,
      cash: s.cash, equity, position_qty: fp?.qty ?? 0, unrealized,
      open_exposure: fp ? fp.qty * (fp.buyNotional / fp.buyQty) : 0, open_positions: fp ? 1 : 0, day_utc: day, day_net: s.dayNet,
    },
  };
}

/** Ledger identity: cash = start + settled net + open-position cash flows. Returns the absolute error. */
export function reconcilePaper(startingCapital: number, state: PaperState, trades: Pick<PaperTrade, "net_pnl">[]) {
  const p = state.position;
  const open = p ? p.sellNotional - p.buyNotional - p.fees : 0;
  return Math.abs(startingCapital + trades.reduce((a, t) => a + t.net_pnl, 0) + open - state.cash);
}
