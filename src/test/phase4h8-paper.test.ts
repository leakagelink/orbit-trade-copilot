// Phase 4H.8 — real-market PAPER execution: fills, rejections, costs, protection, liquidation, dedupe, recovery.
import { describe, expect, it } from "vitest";
import { newPaperState, PaperBook, parseExchangeFilters, reconcilePaper, restorePaper, serializePaper, equity, type MarketView, type PaperOrderRequest, type SymbolFilters } from "@/lib/live-paper-exec";
import type { MarkEvent, TradeEvent } from "@/lib/live-feed";
import { recorded } from "./helpers/recorded-usdm";

const F = (sym: "BTCUSDT" | "ETHUSDT"): SymbolFilters => parseExchangeFilters(recorded().exchangeInfo.symbols.find((s) => (s as { symbol: string }).symbol === sym))!;
const depth = (bid = 1900, ask = 1900.1, qtys = [1, 2, 3, 4, 5]) => ({ bids: qtys.map((q, i) => [Number((bid - i * 0.1).toFixed(2)), q] as [number, number]), asks: qtys.map((q, i) => [Number((ask + i * 0.1).toFixed(2)), q] as [number, number]) });
const mv = (now = 1_000, d: MarketView["depth"] = depth()): MarketView => ({ now, depth: d, filters: F("ETHUSDT") });
const req = (o: Partial<PaperOrderRequest> = {}): PaperOrderRequest => ({ proposalId: "prop-0001", signalId: "sig", symbol: "ETHUSDT", side: "LONG", type: "MARKET", qty: 0.5, leverage: 5, limitPrice: null, stop: 1890, takeProfit: 1920, ttlMs: 60_000, createdAt: 1_000, ...o });
const mark = (p: number, E: number, o: Partial<MarkEvent> = {}): MarkEvent => ({ kind: "mark", symbol: "ETHUSDT", markPrice: p, indexPrice: p, fundingRate: 0.0001, nextFundingTime: 10_000_000, E, receivedAt: E, ...o });
const tr = (id: number, price: number, qty: number, buyerAggressor: boolean, t = 2_000 + id): TradeEvent => ({ kind: "trade", symbol: "ETHUSDT", id, price, qty, t, E: t, buyerAggressor, receivedAt: t });
const book = () => new PaperBook(newPaperState("t", 10_000, 1_000));

describe("public exchange filters", () => {
  it("parse from the recorded exchangeInfo (real values)", () => {
    expect(F("BTCUSDT")).toMatchObject({ symbol: "BTCUSDT", minNotional: 50, stepSize: 0.001, tickSize: 0.1, maintMarginRate: 0.025, liquidationFeeRate: 0.0125 });
    expect(F("ETHUSDT").minNotional).toBe(20);
    expect(parseExchangeFilters({ symbol: "BTCUSDT", filters: [] })).toBeNull();
  });
});

describe("market orders walk the visible book", () => {
  it("fills across levels at the size-weighted price, taker fee and slippage recorded", () => {
    const b = book(), o = b.submit(req({ qty: 2 }), mv()); // 50 % of 1 + 50 % of 2 + 50 % of 3 = 0.5 + 1 + 1.5
    expect(o.status).toBe("FILLED");
    const f = b.state.fills[0]!, avg = (0.5 * 1900.1 + 1 * 1900.2 + 0.5 * 1900.3) / 2;
    expect(f.price).toBeCloseTo(avg, 8); expect(f.liquidity).toBe("TAKER"); expect(f.source).toBe("book-walk");
    expect(f.fee).toBeCloseTo(2 * avg * 0.0005, 8); expect(f.slippage).toBeCloseTo(2 * (avg - 1900.1), 8);
    expect(b.state.positions.ETHUSDT).toMatchObject({ side: "LONG", qty: 2, leverage: 5 });
  });
  it("partial fill when visible liquidity within the band is short; the IOC remainder is cancelled", () => {
    const b = book(), o = b.submit(req({ qty: 9 }), mv());
    expect(o.status).toBe("PARTIAL_CANCELLED"); expect(o.filledQty).toBe(7.5); expect(o.reason).toMatch(/remainder/);
    expect(b.state.positions.ETHUSDT!.qty).toBe(7.5);
  });
  it("rejections: no book, below minimum notional, lot size, margin, wrong-side stop, duplicate proposal, already open", () => {
    expect(book().submit(req(), { ...mv(), depth: null }).reason).toBe("NO_EXECUTABLE_BOOK");
    expect(book().submit(req({ qty: 0.005 }), mv()).reason).toMatch(/BELOW_MIN_NOTIONAL|LOT_SIZE/);
    expect(book().submit(req({ qty: 0.0001 }), mv()).reason).toMatch(/QTY_OUTSIDE_LOT_SIZE/);
    expect(book().submit(req({ qty: 6, leverage: 1 }), mv(1_000, depth(1900, 1900.1, [100, 100, 100]))).reason).toMatch(/INSUFFICIENT_MARGIN/);
    expect(book().submit(req({ stop: 1950 }), mv()).reason).toBe("STOP_ON_WRONG_SIDE");
    const b = book(); b.submit(req(), mv());
    const again = b.submit(req(), mv()); expect(again.status).toBe("FILLED"); expect(b.state.fills.length).toBe(1); expect(b.state.duplicatesIgnored).toBe(1);
    expect(b.submit(req({ proposalId: "prop-0002" }), mv()).reason).toBe("POSITION_OR_ORDER_ALREADY_OPEN");
    expect(book().submit(req(), { ...mv(), filters: null }).reason).toBe("NO_EXCHANGE_FILTERS");
  });
  it("BTCUSDT's real 50 USDT minimum rejects an order sized to the owner's 10 USDT Testnet exposure", () => {
    const b = new PaperBook(newPaperState("t", 10_000, 1)), q = 10 / 67_000;
    const o = b.submit({ ...req({ symbol: "BTCUSDT", qty: q, stop: 66_000, takeProfit: 68_000 }) }, { now: 1, depth: { bids: [[67_000, 5]], asks: [[67_000.1, 5]] }, filters: F("BTCUSDT") });
    expect(o.status).toBe("REJECTED"); expect(o.reason).toMatch(/LOT_SIZE|MIN_NOTIONAL/);
  });
});

describe("limit orders: a touch is not a fill", () => {
  const placed = () => { const b = book(); const o = b.submit(req({ type: "LIMIT", limitPrice: 1900, qty: 1 }), mv()); return { b, o }; };
  it("post-only: a crossing limit is rejected; queue ahead is the displayed quantity at the price", () => {
    expect(book().submit(req({ type: "LIMIT", limitPrice: 1900.1 }), mv()).reason).toBe("POST_ONLY_WOULD_CROSS");
    const { o } = placed(); expect(o.status).toBe("OPEN"); expect(o.queueAhead).toBe(1);
  });
  it("trades AT the price only consume the queue ahead first; buyer-initiated prints never fill a resting buy", () => {
    const { b, o } = placed(), f = F("ETHUSDT");
    b.onTrade(tr(1, 1900, 0.6, false), f); expect(o.filledQty).toBe(0); expect(o.queueAhead).toBeCloseTo(0.4, 10);
    b.onTrade(tr(2, 1900, 5, true), f); expect(o.filledQty).toBe(0);
    b.onTrade(tr(3, 1900, 0.7, false), f); expect(o.filledQty).toBeCloseTo(0.3, 10); expect(b.state.fills.at(-1)!.source).toBe("trade-at-queue");
  });
  it("a trade THROUGH the price fills (maker fee) and completes the order", () => {
    const { b, o } = placed();
    b.onTrade(tr(1, 1899.9, 2, false), F("ETHUSDT"));
    expect(o.status).toBe("FILLED"); expect(b.state.fills[0]!).toMatchObject({ liquidity: "MAKER", source: "trade-through", price: 1900 });
    expect(b.state.fills[0]!.fee).toBeCloseTo(1900 * 0.0002, 8);
  });
  it("expiry cancels the remainder; a partially filled order keeps its filled position", () => {
    const { b, o } = placed();
    b.onTrade(tr(1, 1899.9, 0.4, false), F("ETHUSDT")); b.onTick(61_001, {});
    expect(o.status).toBe("PARTIAL_CANCELLED"); expect(b.state.positions.ETHUSDT!.qty).toBeCloseTo(0.4, 10);
    const { b: b2, o: o2 } = placed(); b2.onTick(61_001, {}); expect(o2.status).toBe("EXPIRED"); expect(b2.state.positions.ETHUSDT).toBeUndefined();
  });
  it("duplicate trade ids are applied once", () => {
    const { b, o } = placed(); const t = tr(1, 1899.9, 0.3, false);
    b.onTrade(t, F("ETHUSDT")); b.onTrade(t, F("ETHUSDT")); expect(o.filledQty).toBeCloseTo(0.3, 10); expect(b.state.duplicatesIgnored).toBe(1);
  });
});

describe("mark-price protection, funding and liquidation", () => {
  const open = () => { const b = book(); b.submit(req({ qty: 1 }), mv()); return b; };
  it("stop triggers on the MARK price and exits by walking the bid side", () => {
    const b = open(); b.onMark(mark(1891, 2_000), mv(2_000)); expect(b.state.positions.ETHUSDT).toBeDefined();
    b.onMark(mark(1889.9, 3_000), mv(3_000, depth(1889, 1889.1)));
    expect(b.state.positions.ETHUSDT).toBeUndefined();
    const exit = b.state.fills.at(-1)!; expect(exit).toMatchObject({ reason: "STOP", action: "SELL", price: 1889 });
    expect(exit.realizedPnl).toBeCloseTo(1889 - b.state.fills[0]!.price, 6);
  });
  it("take-profit triggers on the mark", () => { const b = open(); b.onMark(mark(1920.5, 2_000), mv(2_000, depth(1920, 1920.1))); expect(b.state.fills.at(-1)!.reason).toBe("TAKE_PROFIT"); });
  it("with no usable book the exit stays pending — no invented price — and completes on the next book", () => {
    const b = open(); b.onMark(mark(1889, 2_000), { ...mv(2_000), depth: null });
    expect(b.state.positions.ETHUSDT!.exitPending).toBe("STOP"); expect(b.events.some((e) => e.type === "EXIT_PENDING")).toBe(true);
    b.tryExit(b.state.positions.ETHUSDT!, mv(2_100, depth(1888, 1888.1))); expect(b.state.positions.ETHUSDT).toBeUndefined();
  });
  it("funding is charged once, after the funding time, on a position opened before it", () => {
    const b = open(); const w0 = b.state.wallet;
    b.onMark(mark(1900, 5_000, { nextFundingTime: 8_000, fundingRate: 0.0002 }), mv(5_000));
    b.onMark(mark(1900, 8_001, { nextFundingTime: 8_000 + 28_800_000 }), mv(8_001));
    b.onMark(mark(1900, 8_002, { nextFundingTime: 8_000 + 28_800_000 }), mv(8_002));
    expect(b.state.totals.funding).toBeCloseTo(-1 * 1900 * 0.0002, 10); expect(b.state.wallet).toBeCloseTo(w0 - 0.38, 8);
    expect(b.events.filter((e) => e.type === "FUNDING").length).toBe(1);
  });
  it("liquidation at the liquidation price; the loss never exceeds the isolated margin", () => {
    const b = book(); b.submit(req({ qty: 1, leverage: 20, stop: 1800 }), mv());
    const p = b.state.positions.ETHUSDT!, margin = p.margin;
    b.onMark(mark(p.liquidationPrice - 1, 2_000), mv(2_000));
    expect(b.state.positions.ETHUSDT).toBeUndefined();
    const f = b.state.fills.at(-1)!; expect(f.reason).toBe("LIQUIDATION"); expect(f.realizedPnl).toBeGreaterThanOrEqual(-margin - 1e-9);
    expect(reconcilePaper(b.state).ok).toBe(true);
  });
  it("duplicate mark events are ignored", () => { const b = open(); b.onMark(mark(1900, 2_000), mv()); b.onMark(mark(1880, 2_000), mv()); expect(b.state.positions.ETHUSDT).toBeDefined(); expect(b.state.duplicatesIgnored).toBe(1); });
});

describe("restart recovery and reconciliation", () => {
  it("serialise → restore keeps the ledger and its de-duplication cursors; replayed events after restart are ignored", () => {
    const b = book(); b.submit(req({ type: "LIMIT", limitPrice: 1900, qty: 1 }), mv()); b.onTrade(tr(5, 1899.9, 0.4, false), F("ETHUSDT"));
    const r = restorePaper(serializePaper(b.state)); expect(r.ok).toBe(true);
    const b2 = new PaperBook((r as { ok: true; state: typeof b.state }).state);
    expect(b2.state.restarts).toBe(1);
    b2.onTrade(tr(5, 1899.9, 0.4, false), F("ETHUSDT")); expect(b2.state.positions.ETHUSDT!.qty).toBeCloseTo(0.4, 10);
    expect(b2.submit(req({ type: "LIMIT", limitPrice: 1900, qty: 1 }), mv()).filledQty).toBeCloseTo(0.4, 10); // same proposal: not re-placed
    expect(equity(b2.state, { ETHUSDT: 1900 })).toBeCloseTo(equity(b.state, { ETHUSDT: 1900 }), 10);
  });
  it("a corrupted or truncated save is refused (fresh ledger, never a guessed one)", () => {
    const s = serializePaper(book().state);
    expect(s).toContain('\\"wallet\\":10000');
    expect(restorePaper(s.replace('\\"wallet\\":10000', '\\"wallet\\":99999'))).toEqual({ ok: false, reason: "checksum mismatch" });
    expect(restorePaper(s.slice(0, 40)).ok).toBe(false); expect(restorePaper(null).ok).toBe(false);
  });
  it("reconciliation passes on a consistent ledger and names each tampered identity", () => {
    const b = book(); b.submit(req({ qty: 1 }), mv()); b.onMark(mark(1889, 2_000), mv(2_000, depth(1889, 1889.1)));
    expect(reconcilePaper(b.state)).toMatchObject({ ok: true, mismatches: [] });
    const t = JSON.parse(JSON.stringify(b.state)); t.wallet += 5; t.totals.fees -= 1;
    const r = reconcilePaper(t); expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(expect.arrayContaining(["fees in fills do not equal the fee total", "wallet ≠ starting equity + realized − fees + funding"]));
    const q = book(); q.submit(req({ qty: 1 }), mv()); q.state.positions.ETHUSDT!.qty = 2;
    expect(reconcilePaper(q.state).mismatches.join()).toMatch(/position quantity/);
  });
});
