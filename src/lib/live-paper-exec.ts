// Phase 4H.8 — real-market PAPER execution for USD-M Futures scalping. Pure and deterministic; every input is a live
// public market event (synced order-book depth, aggregate trades, mark price). It never touches an exchange, credentials,
// the orders/positions tables, the demo wallet or any real account — its state is a separate, serialisable paper ledger.
//
// Fill model (all assumptions stated; nothing here is an exchange fill):
//  * MARKET (IOC): walks the visible opposite book, taking at most `participation` of each displayed level and only within
//    `maxSlippageBps` of the best price; the unfilled rest is cancelled. A stale or unsynced book rejects the order.
//  * LIMIT (post-only): rests behind the displayed quantity at its price (queue ahead). It fills only when trades print
//    THROUGH the price, or AT the price after the queue ahead has traded. A price merely touching is never a fill, and
//    candles are never used for fills at all.
//  * Stop-loss / take-profit trigger on the MARK price (like workingType MARK_PRICE) and exit as reduce-only market
//    orders walking the live book; with no usable book the exit stays pending (no invented price).
//  * Isolated margin, one-way, one position per symbol. Liquidation when the mark crosses the liquidation price
//    (entry·(1 − 1/L + mmr) long, entry·(1 + 1/L − mmr) short), closed at that price with the exchange-published
//    liquidation fee; the loss never exceeds the position margin.
//  * Funding: at each funding time a position held through it pays/receives qty × mark × the last streamed rate
//    (an estimate of the settled rate, labelled as such).
import { liquidationPrice } from "./central-risk";
import { floorStep } from "./central-risk";
import type { LiveSymbol, MarkEvent, TradeEvent } from "./live-feed";

export const PAPER_EXEC_VERSION = "live-paper-v1" as const;
export const PAPER_LABEL = "PAPER — simulated on live public market data; not an exchange fill and not real profit or loss" as const;

export interface SymbolFilters { symbol: LiveSymbol; tickSize: number; stepSize: number; minQty: number; maxQty: number; minNotional: number; maintMarginRate: number; liquidationFeeRate: number; source: string }
/** Exchange filters from the PUBLIC exchangeInfo entry (MARKET_LOT_SIZE for market orders). Null if any is missing. */
export function parseExchangeFilters(sym: unknown): SymbolFilters | null {
  const s = sym as { symbol?: string; filters?: { filterType: string; [k: string]: unknown }[]; maintMarginPercent?: string; liquidationFee?: string };
  if (!s || (s.symbol !== "BTCUSDT" && s.symbol !== "ETHUSDT") || !Array.isArray(s.filters)) return null;
  const f = (t: string) => s.filters!.find((x) => x.filterType === t);
  const n = (x: unknown) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : null; };
  const price = f("PRICE_FILTER"), lot = f("MARKET_LOT_SIZE") ?? f("LOT_SIZE"), mn = f("MIN_NOTIONAL");
  const out = { tickSize: n(price?.["tickSize"]), stepSize: n(lot?.["stepSize"]), minQty: n(lot?.["minQty"]), maxQty: n(lot?.["maxQty"]), minNotional: n(mn?.["notional"]), mmr: n(s.maintMarginPercent), liq: n(s.liquidationFee) };
  if (Object.values(out).some((v) => v === null)) return null;
  return { symbol: s.symbol, tickSize: out.tickSize!, stepSize: out.stepSize!, minQty: out.minQty!, maxQty: out.maxQty!, minNotional: out.minNotional!, maintMarginRate: out.mmr! / 100, liquidationFeeRate: out.liq!, source: "public exchangeInfo (maintMarginPercent is the symbol's generic rate, not the account's leverage bracket)" };
}

/** Simulation parameters — PROPOSED, not approved (owner decision OD-P1). Fee tier is not read from any account. */
export interface PaperSimConfig { takerFeePct: number; makerFeePct: number; participation: number; maxSlippageBps: number; maxOpenOrders: number; maxFills: number }
export const PROPOSED_PAPER_SIM: Readonly<PaperSimConfig> = Object.freeze({ takerFeePct: 0.05, makerFeePct: 0.02, participation: 0.5, maxSlippageBps: 10, maxOpenOrders: 4, maxFills: 1000 });

export type Side = "LONG" | "SHORT";
export interface PaperOrderRequest { proposalId: string; signalId: string; symbol: LiveSymbol; side: Side; type: "MARKET" | "LIMIT"; qty: number; leverage: number; limitPrice: number | null; stop: number; takeProfit: number | null; ttlMs: number; createdAt: number }
export type OrderStatus = "OPEN" | "FILLED" | "PARTIAL_CANCELLED" | "CANCELLED" | "EXPIRED" | "REJECTED";
export interface PaperOrder { id: string; proposalId: string; signalId: string; symbol: LiveSymbol; side: Side; type: "MARKET" | "LIMIT"; qty: number; filledQty: number; limitPrice: number | null; queueAhead: number; status: OrderStatus; reason: string | null; createdAt: number; expiresAt: number; leverage: number; stop: number; takeProfit: number | null }
export type FillReason = "ENTRY" | "STOP" | "TAKE_PROFIT" | "LIQUIDATION" | "MANUAL";
export interface PaperFill { id: string; orderId: string; positionId: string; symbol: LiveSymbol; action: "BUY" | "SELL"; qty: number; price: number; fee: number; liquidity: "TAKER" | "MAKER" | "LIQUIDATION"; slippage: number; realizedPnl: number; reason: FillReason; source: "book-walk" | "trade-through" | "trade-at-queue" | "liquidation-price"; at: number }
export interface PaperPosition { id: string; symbol: LiveSymbol; side: Side; qty: number; entryPrice: number; leverage: number; margin: number; stop: number; takeProfit: number | null; liquidationPrice: number; openedAt: number; proposalId: string; fundingPaid: number; feesPaid: number; exitPending: FillReason | null }
export interface Totals { fees: number; realized: number; funding: number; slippage: number; liquidationFees: number }
export interface PaperState {
  version: typeof PAPER_EXEC_VERSION; accountId: string; createdAt: number; startingEquity: number; wallet: number;
  totals: Totals; trimmed: Totals & { fills: number }; positions: Partial<Record<LiveSymbol, PaperPosition>>; orders: PaperOrder[]; fills: PaperFill[];
  proposals: string[]; processed: Partial<Record<LiveSymbol, { lastTradeId: number | null; lastMarkE: number | null; fundingTime: number | null; fundingRate: number | null }>>;
  day: { key: number; startEquity: number }; peakEquity: number; maxDrawdown: number; seq: number; duplicatesIgnored: number; restarts: number;
}
export interface MarketView { now: number; depth: { bids: [number, number][]; asks: [number, number][] } | null; filters: SymbolFilters | null }
export type PaperEvent = { type: "ORDER_REJECTED" | "ORDER_ACCEPTED" | "ORDER_FILLED" | "ORDER_PARTIAL" | "ORDER_CANCELLED" | "ORDER_EXPIRED" | "POSITION_OPENED" | "POSITION_CLOSED" | "EXIT_PENDING" | "FUNDING" | "LIQUIDATION" | "DUPLICATE_IGNORED"; symbol: LiveSymbol | null; detail: Record<string, string | number | null> };

const Z: Totals = { fees: 0, realized: 0, funding: 0, slippage: 0, liquidationFees: 0 };
const dayKey = (t: number) => Math.floor(t / 86_400_000);
const round = (x: number, d = 10) => Number(x.toFixed(d));

export function newPaperState(accountId: string, startingEquity: number, now: number): PaperState {
  if (!(startingEquity > 0) || !Number.isFinite(startingEquity)) throw new Error("paper: starting equity must be positive");
  return { version: PAPER_EXEC_VERSION, accountId, createdAt: now, startingEquity, wallet: startingEquity, totals: { ...Z }, trimmed: { ...Z, fills: 0 }, positions: {}, orders: [], fills: [], proposals: [], processed: {},
    day: { key: dayKey(now), startEquity: startingEquity }, peakEquity: startingEquity, maxDrawdown: 0, seq: 0, duplicatesIgnored: 0, restarts: 0 };
}
const pnl = (side: Side, entry: number, exit: number, qty: number) => (side === "LONG" ? exit - entry : entry - exit) * qty;
export function unrealized(s: PaperState, marks: Partial<Record<LiveSymbol, number>>): number {
  let u = 0; for (const p of Object.values(s.positions)) if (p) { const m = marks[p.symbol]; if (m) u += pnl(p.side, p.entryPrice, m, p.qty); }
  return u;
}
export const usedMargin = (s: PaperState) => Object.values(s.positions).reduce((a, p) => a + (p ? p.margin : 0), 0)
  + s.orders.filter((o) => o.status === "OPEN").reduce((a, o) => a + ((o.qty - o.filledQty) * (o.limitPrice ?? 0)) / o.leverage, 0);
export const equity = (s: PaperState, marks: Partial<Record<LiveSymbol, number>>) => s.wallet + unrealized(s, marks);
export const dayNet = (s: PaperState, marks: Partial<Record<LiveSymbol, number>>) => equity(s, marks) - s.day.startEquity;

function walk(levels: [number, number][], qty: number, best: number, side: "BUY" | "SELL", cfg: PaperSimConfig, banded: boolean) {
  let left = qty, got = 0, cost = 0;
  for (const [p, q] of levels) {
    if (left <= 1e-12) break;
    if (banded && Math.abs(p - best) / best * 10_000 > cfg.maxSlippageBps) break;
    const take = Math.min(left, q * (banded ? cfg.participation : 1));
    if (take <= 0) continue; got += take; cost += take * p; left -= take;
  }
  return got > 0 ? { qty: got, avg: cost / got, slippage: side === "BUY" ? cost - got * best : got * best - cost } : null;
}

export class PaperBook {
  readonly events: PaperEvent[] = [];
  constructor(public state: PaperState, readonly cfg: PaperSimConfig = PROPOSED_PAPER_SIM) {}
  private ev(type: PaperEvent["type"], symbol: LiveSymbol | null, detail: PaperEvent["detail"]) { const e = { type, symbol, detail }; this.events.push(e); if (this.events.length > 500) this.events.shift(); return e; }
  private proc(sym: LiveSymbol) { return (this.state.processed[sym] ??= { lastTradeId: null, lastMarkE: null, fundingTime: null, fundingRate: null }); }
  private addFill(f: Omit<PaperFill, "id">): PaperFill {
    const s = this.state, fill = { ...f, id: `${f.orderId}:${++s.seq}` };
    s.fills.push(fill);
    s.totals.fees = round(s.totals.fees + f.fee); s.totals.realized = round(s.totals.realized + f.realizedPnl); s.totals.slippage = round(s.totals.slippage + f.slippage);
    s.wallet = round(s.wallet - f.fee + f.realizedPnl);
    while (s.fills.length > this.cfg.maxFills) { const o = s.fills.shift()!; s.trimmed.fees += o.fee; s.trimmed.realized += o.realizedPnl; s.trimmed.slippage += o.slippage; s.trimmed.fills++; }
    return fill;
  }
  private reject(req: PaperOrderRequest, reason: string) {
    const o: PaperOrder = { id: `po_${req.proposalId}`, proposalId: req.proposalId, signalId: req.signalId, symbol: req.symbol, side: req.side, type: req.type, qty: req.qty, filledQty: 0, limitPrice: req.limitPrice, queueAhead: 0, status: "REJECTED", reason, createdAt: req.createdAt, expiresAt: req.createdAt, leverage: req.leverage, stop: req.stop, takeProfit: req.takeProfit };
    this.keepOrder(o); this.ev("ORDER_REJECTED", req.symbol, { proposalId: req.proposalId, reason }); return o;
  }
  private keepOrder(o: PaperOrder) { this.state.orders.push(o); const closed = this.state.orders.filter((x) => x.status !== "OPEN"); if (closed.length > 200) this.state.orders.splice(this.state.orders.indexOf(closed[0]!), 1); }

  /** One order per proposal, ever. Sizing (qty, leverage) must come from the Central Risk Engine decision. */
  submit(req: PaperOrderRequest, mv: MarketView): PaperOrder {
    const s = this.state;
    if (s.proposals.includes(req.proposalId)) { s.duplicatesIgnored++; this.ev("DUPLICATE_IGNORED", req.symbol, { proposalId: req.proposalId }); return s.orders.find((o) => o.proposalId === req.proposalId) ?? this.reject(req, "DUPLICATE_PROPOSAL"); }
    s.proposals.push(req.proposalId); if (s.proposals.length > 1000) s.proposals.shift();
    const f = mv.filters;
    if (!f || f.symbol !== req.symbol) return this.reject(req, "NO_EXCHANGE_FILTERS");
    if (!mv.depth || !mv.depth.bids.length || !mv.depth.asks.length) return this.reject(req, "NO_EXECUTABLE_BOOK");
    if (s.positions[req.symbol] || s.orders.some((o) => o.status === "OPEN" && o.symbol === req.symbol)) return this.reject(req, "POSITION_OR_ORDER_ALREADY_OPEN");
    if (s.orders.filter((o) => o.status === "OPEN").length >= this.cfg.maxOpenOrders) return this.reject(req, "TOO_MANY_OPEN_ORDERS");
    if (!(req.leverage >= 1) || !Number.isFinite(req.leverage)) return this.reject(req, "INVALID_LEVERAGE");
    const qty = floorStep(req.qty, f.stepSize);
    if (!(qty >= f.minQty) || qty > f.maxQty) return this.reject(req, `QTY_OUTSIDE_LOT_SIZE (${qty} vs ${f.minQty}–${f.maxQty})`);
    const bestBid = mv.depth.bids[0]![0], bestAsk = mv.depth.asks[0]![0], ref = req.side === "LONG" ? bestAsk : bestBid;
    if (qty * ref < f.minNotional) return this.reject(req, `BELOW_MIN_NOTIONAL (${(qty * ref).toFixed(2)} < ${f.minNotional} USDT)`);
    if (req.side === "LONG" ? !(req.stop < ref) : !(req.stop > ref)) return this.reject(req, "STOP_ON_WRONG_SIDE");
    if (req.takeProfit !== null && (req.side === "LONG" ? !(req.takeProfit > ref) : !(req.takeProfit < ref))) return this.reject(req, "TARGET_ON_WRONG_SIDE");
    const avail = s.wallet - usedMargin(s), need = (qty * ref) / req.leverage + qty * ref * (this.cfg.takerFeePct / 100);
    if (need > avail + 1e-9) return this.reject(req, `INSUFFICIENT_MARGIN (${need.toFixed(2)} > ${avail.toFixed(2)})`);
    const base: PaperOrder = { id: `po_${req.proposalId}`, proposalId: req.proposalId, signalId: req.signalId, symbol: req.symbol, side: req.side, type: req.type, qty, filledQty: 0, limitPrice: req.limitPrice, queueAhead: 0, status: "OPEN", reason: null, createdAt: req.createdAt, expiresAt: req.createdAt + req.ttlMs, leverage: req.leverage, stop: req.stop, takeProfit: req.takeProfit };
    if (req.type === "LIMIT") {
      const p = req.limitPrice;
      if (p === null || !(p > 0)) return this.reject(req, "LIMIT_PRICE_REQUIRED");
      if (req.side === "LONG" ? p >= bestAsk : p <= bestBid) return this.reject(req, "POST_ONLY_WOULD_CROSS");
      const lv = (req.side === "LONG" ? mv.depth.bids : mv.depth.asks).find(([x]) => Math.abs(x - p) < f.tickSize / 2);
      base.queueAhead = lv ? lv[1] : 0;
      this.keepOrder(base); this.ev("ORDER_ACCEPTED", req.symbol, { orderId: base.id, type: "LIMIT", price: p, qty, queueAhead: base.queueAhead });
      return base;
    }
    const w = walk(req.side === "LONG" ? mv.depth.asks : mv.depth.bids, qty, ref, req.side === "LONG" ? "BUY" : "SELL", this.cfg, true);
    if (!w) return this.reject(req, "NO_LIQUIDITY_WITHIN_SLIPPAGE_BAND");
    const fq = floorStep(w.qty, f.stepSize);
    if (fq < f.minQty) return this.reject(req, "NO_LIQUIDITY_WITHIN_SLIPPAGE_BAND");
    base.filledQty = fq; base.status = fq + 1e-12 >= qty ? "FILLED" : "PARTIAL_CANCELLED"; base.reason = base.status === "PARTIAL_CANCELLED" ? `IOC remainder ${round(qty - fq, 8)} cancelled: visible liquidity within ${this.cfg.maxSlippageBps} bps` : null;
    this.keepOrder(base);
    this.openOrAdd(base, fq, w.avg, "TAKER", w.slippage * (fq / w.qty), "book-walk", mv.now, f);
    this.ev(base.status === "FILLED" ? "ORDER_FILLED" : "ORDER_PARTIAL", req.symbol, { orderId: base.id, qty: fq, avg: round(w.avg, 8), slippage: round(w.slippage, 8) });
    return base;
  }
  private openOrAdd(o: PaperOrder, qty: number, price: number, liq: "TAKER" | "MAKER", slippage: number, source: PaperFill["source"], at: number, f: SymbolFilters) {
    const s = this.state, fee = qty * price * ((liq === "TAKER" ? this.cfg.takerFeePct : this.cfg.makerFeePct) / 100);
    let p = s.positions[o.symbol];
    if (!p) {
      p = { id: `pos_${o.proposalId}`, symbol: o.symbol, side: o.side, qty: 0, entryPrice: price, leverage: o.leverage, margin: 0, stop: o.stop, takeProfit: o.takeProfit, liquidationPrice: 0, openedAt: at, proposalId: o.proposalId, fundingPaid: 0, feesPaid: 0, exitPending: null };
      s.positions[o.symbol] = p; this.ev("POSITION_OPENED", o.symbol, { positionId: p.id, side: p.side });
    }
    p.entryPrice = (p.entryPrice * p.qty + price * qty) / (p.qty + qty); p.qty = round(p.qty + qty, 12);
    p.margin = round((p.qty * p.entryPrice) / p.leverage); p.feesPaid = round(p.feesPaid + fee);
    p.liquidationPrice = liquidationPrice(p.side, p.entryPrice, p.leverage, f.maintMarginRate);
    this.addFill({ orderId: o.id, positionId: p.id, symbol: o.symbol, action: o.side === "LONG" ? "BUY" : "SELL", qty, price, fee, liquidity: liq, slippage, realizedPnl: 0, reason: "ENTRY", source, at });
  }

  /** Aggregate trades drive resting limit orders. Each trade id is applied once (restart-safe). */
  onTrade(t: TradeEvent, filters: SymbolFilters | null) {
    const pr = this.proc(t.symbol);
    if (pr.lastTradeId !== null && t.id <= pr.lastTradeId) { this.state.duplicatesIgnored++; return; }
    pr.lastTradeId = t.id;
    if (!filters) return;
    for (const o of this.state.orders) {
      if (o.status !== "OPEN" || o.symbol !== t.symbol || o.limitPrice === null) continue;
      const p = o.limitPrice, buy = o.side === "LONG", left = o.qty - o.filledQty;
      let fill = 0, source: PaperFill["source"] = "trade-through";
      if (buy ? t.price < p : t.price > p) fill = Math.min(left, t.qty);
      else if (t.price === p && (buy ? !t.buyerAggressor : t.buyerAggressor)) { // sellers hitting our bid level (or buyers lifting our ask)
        const afterQueue = t.qty - o.queueAhead; o.queueAhead = Math.max(0, o.queueAhead - t.qty);
        if (afterQueue > 0) { fill = Math.min(left, afterQueue); source = "trade-at-queue"; }
      }
      fill = floorStep(fill, filters.stepSize);
      if (fill <= 0) continue;
      o.filledQty = round(o.filledQty + fill, 12);
      this.openOrAdd(o, fill, p, "MAKER", 0, source, t.receivedAt, filters);
      if (o.filledQty + 1e-12 >= o.qty) { o.status = "FILLED"; this.ev("ORDER_FILLED", o.symbol, { orderId: o.id, qty: o.filledQty, price: p }); }
      else this.ev("ORDER_PARTIAL", o.symbol, { orderId: o.id, filled: o.filledQty, of: o.qty, price: p });
    }
  }
  /** Expiry of resting orders and daily roll-over. */
  onTick(now: number, marks: Partial<Record<LiveSymbol, number>>) {
    for (const o of this.state.orders) if (o.status === "OPEN" && now >= o.expiresAt) { o.status = o.filledQty > 0 ? "PARTIAL_CANCELLED" : "EXPIRED"; o.reason = o.filledQty > 0 ? "time limit: remainder cancelled" : "time limit"; this.ev(o.filledQty > 0 ? "ORDER_CANCELLED" : "ORDER_EXPIRED", o.symbol, { orderId: o.id, filled: o.filledQty }); }
    const eq = equity(this.state, marks), s = this.state;
    if (dayKey(now) !== s.day.key) s.day = { key: dayKey(now), startEquity: eq };
    if (eq > s.peakEquity) s.peakEquity = eq;
    s.maxDrawdown = Math.max(s.maxDrawdown, s.peakEquity > 0 ? (s.peakEquity - eq) / s.peakEquity : 0);
  }
  /** Mark price: funding, liquidation, then mark-triggered stop / take-profit. Each mark event (by time) is applied once. */
  onMark(m: MarkEvent, mv: MarketView) {
    const pr = this.proc(m.symbol), s = this.state;
    if (pr.lastMarkE !== null && m.E <= pr.lastMarkE) { s.duplicatesIgnored++; return; }
    pr.lastMarkE = m.E;
    const p = s.positions[m.symbol];
    if (p && pr.fundingTime !== null && m.E >= pr.fundingTime && p.openedAt < pr.fundingTime && pr.fundingRate !== null) {
      const pay = p.qty * m.markPrice * pr.fundingRate * (p.side === "LONG" ? 1 : -1);
      p.fundingPaid = round(p.fundingPaid + pay); s.totals.funding = round(s.totals.funding - pay); s.wallet = round(s.wallet - pay);
      this.ev("FUNDING", m.symbol, { positionId: p.id, paid: round(pay, 8), rate: pr.fundingRate, rateSource: "last streamed estimate before the funding time" });
    }
    pr.fundingTime = m.nextFundingTime; pr.fundingRate = m.fundingRate;
    if (!p) return;
    const f = mv.filters;
    if (p.side === "LONG" ? m.markPrice <= p.liquidationPrice : m.markPrice >= p.liquidationPrice) { this.liquidate(p, m, f); return; }
    if (!p.exitPending) {
      if (p.side === "LONG" ? m.markPrice <= p.stop : m.markPrice >= p.stop) p.exitPending = "STOP";
      else if (p.takeProfit !== null && (p.side === "LONG" ? m.markPrice >= p.takeProfit : m.markPrice <= p.takeProfit)) p.exitPending = "TAKE_PROFIT";
    }
    if (p.exitPending) this.tryExit(p, mv);
  }
  /** Retries a pending exit against the current book (call on book updates too). */
  tryExit(p: PaperPosition, mv: MarketView) {
    const reason = p.exitPending; if (!reason) return;
    if (!mv.depth || !mv.filters) { this.ev("EXIT_PENDING", p.symbol, { positionId: p.id, reason, why: "no fresh synced book — exit not priced" }); return; }
    const sell = p.side === "LONG", lv = sell ? mv.depth.bids : mv.depth.asks;
    if (!lv.length) return;
    const w = walk(lv, p.qty, lv[0]![0], sell ? "SELL" : "BUY", this.cfg, false);
    if (!w) return;
    const q = Math.min(p.qty, floorStep(w.qty, mv.filters.stepSize) || w.qty);
    this.closeQty(p, q, w.avg, reason, "TAKER", w.slippage * (q / w.qty), "book-walk", mv.now);
  }
  closeManually(sym: LiveSymbol, mv: MarketView) { const p = this.state.positions[sym]; if (p) { p.exitPending = "MANUAL"; this.tryExit(p, mv); } }
  private closeQty(p: PaperPosition, q: number, price: number, reason: FillReason, liq: PaperFill["liquidity"], slippage: number, source: PaperFill["source"], at: number) {
    const s = this.state, fee = liq === "LIQUIDATION" ? 0 : q * price * (this.cfg.takerFeePct / 100), realized = pnl(p.side, p.entryPrice, price, q);
    this.addFill({ orderId: `exit_${p.id}`, positionId: p.id, symbol: p.symbol, action: p.side === "LONG" ? "SELL" : "BUY", qty: q, price, fee, liquidity: liq, slippage, realizedPnl: realized, reason, source, at });
    p.qty = round(p.qty - q, 12); p.feesPaid = round(p.feesPaid + fee);
    if (p.qty <= 1e-12) { delete s.positions[p.symbol]; this.ev("POSITION_CLOSED", p.symbol, { positionId: p.id, reason, price: round(price, 8) }); }
    else { p.margin = round((p.qty * p.entryPrice) / p.leverage); this.ev("EXIT_PENDING", p.symbol, { positionId: p.id, reason, remaining: p.qty, why: "visible depth smaller than the position" }); }
  }
  private liquidate(p: PaperPosition, m: MarkEvent, f: SymbolFilters | null) {
    const s = this.state, price = p.liquidationPrice, raw = pnl(p.side, p.entryPrice, price, p.qty), feeRate = f?.liquidationFeeRate ?? 0;
    const liqFee = Math.max(0, Math.min(p.qty * price * feeRate, p.margin + raw)); // the loss never exceeds the isolated margin
    const realized = Math.max(-p.margin, raw) - liqFee;
    s.totals.liquidationFees = round(s.totals.liquidationFees + liqFee);
    this.addFill({ orderId: `liq_${p.id}`, positionId: p.id, symbol: p.symbol, action: p.side === "LONG" ? "SELL" : "BUY", qty: p.qty, price, fee: 0, liquidity: "LIQUIDATION", slippage: 0, realizedPnl: realized, reason: "LIQUIDATION", source: "liquidation-price", at: m.receivedAt });
    delete s.positions[p.symbol];
    this.ev("LIQUIDATION", p.symbol, { positionId: p.id, mark: m.markPrice, liquidationPrice: round(price, 8), loss: round(realized, 8) });
  }
}

// ---------- restart recovery and reconciliation ----------
function fnv1a(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
/** Serialised paper state with an integrity checksum (detects truncation/corruption — not a security signature). */
export function serializePaper(s: PaperState): string { const body = JSON.stringify(s); return JSON.stringify({ v: PAPER_EXEC_VERSION, sum: fnv1a(body), body }); }
export function restorePaper(text: string | null): { ok: true; state: PaperState } | { ok: false; reason: string } {
  if (!text) return { ok: false, reason: "no saved state" };
  try {
    const o = JSON.parse(text) as { v?: string; sum?: string; body?: string };
    if (o.v !== PAPER_EXEC_VERSION || typeof o.body !== "string") return { ok: false, reason: "unknown version" };
    if (fnv1a(o.body) !== o.sum) return { ok: false, reason: "checksum mismatch" };
    const st = JSON.parse(o.body) as PaperState; st.restarts = (st.restarts ?? 0) + 1;
    return { ok: true, state: st };
  } catch { return { ok: false, reason: "unreadable" }; }
}
export interface ReconcileReport { ok: boolean; mismatches: string[]; checked: number }
/** Accounting identities over the ledger: wallet, totals vs fills, position quantities vs their fills, margins. */
export function reconcilePaper(s: PaperState): ReconcileReport {
  const mm: string[] = [], eq = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const sum = (k: "fee" | "realizedPnl" | "slippage") => s.fills.reduce((a, f) => a + f[k], 0);
  if (!eq(sum("fee") + s.trimmed.fees, s.totals.fees)) mm.push("fees in fills do not equal the fee total");
  if (!eq(sum("realizedPnl") + s.trimmed.realized, s.totals.realized)) mm.push("realized P&L in fills does not equal the realized total");
  if (!eq(s.startingEquity + s.totals.realized - s.totals.fees + s.totals.funding, s.wallet)) mm.push("wallet ≠ starting equity + realized − fees + funding");
  for (const p of Object.values(s.positions)) {
    if (!p) continue;
    const fills = s.fills.filter((f) => f.positionId === p.id), opened = fills.filter((f) => f.reason === "ENTRY").reduce((a, f) => a + f.qty, 0), closed = fills.filter((f) => f.reason !== "ENTRY").reduce((a, f) => a + f.qty, 0);
    if (s.trimmed.fills === 0 && !eq(opened - closed, p.qty)) mm.push(`${p.symbol}: position quantity ${p.qty} ≠ fills ${opened - closed}`);
    if (!(p.margin > 0) || !(p.qty > 0)) mm.push(`${p.symbol}: non-positive margin or quantity`);
  }
  for (const o of s.orders) if (o.filledQty > o.qty + 1e-9) mm.push(`${o.id}: filled more than ordered`);
  if (s.wallet < 0) mm.push("negative paper wallet");
  return { ok: mm.length === 0, mismatches: mm, checked: 4 + Object.keys(s.positions).length + s.orders.length };
}
