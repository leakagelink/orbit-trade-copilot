// Phase 3 forward paper engine: deterministic simulated execution, risk sizing and accounting. Pure; no network.
import { describe, expect, it } from "vitest";
import { initialCursor, initialPaperState, PaperDataError, reconcilePaper, stepPaperBar, type PaperEvent, type PaperState, type PaperStepInput, type PaperTrade } from "@/lib/paper-engine";
import { paperRiskPolicySchema, sizePaperEntry, type PaperAccountContext, type PaperRiskPolicy } from "@/lib/paper-risk";
import type { Candle } from "@/lib/indicators";
import type { StrategyConfig } from "@/lib/strategy";
import type { CostModel } from "@/lib/backtest-costs";

const TF = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const flat = (n: number, px = 100, v = 1000): Candle[] => Array.from({ length: n }, (_, k) => ({ t: T0 + k * TF, o: px, h: px, l: px, c: px, v }));
const bar = (k: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ t: T0 + k * TF, o, h, l, c, v });
const cfg = (entry = "0", exitAbove = "1000000"): StrategyConfig => ({
  pairs: ["BTC/USDT"], timeframe: "1h", indicators: [],
  entry: { logic: "all", conditions: [{ left: "price", operator: ">", right: entry }] },
  exit: { logic: "any", conditions: [{ left: "price", operator: ">", right: exitAbove }] },
  risk: { stop_loss_pct: 2, take_profit_pct: 4, trailing_stop_pct: null, position_size_pct: 50, capital_allocation: 1000, max_open_positions: 1, daily_loss_limit_pct: 5 },
});
const COSTS: CostModel = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: null };
const POLICY: PaperRiskPolicy = { riskPerTradePct: 1, positionSizePct: 50, maxPositionNotional: 300, stopLossPct: 2, takeProfitPct: 4, dailyLossLimit: 20, strategyBudget: 1000, entryOrder: "market", limitOffsetPct: 0, orderTtlBars: 3 };
const ACCOUNT: PaperAccountContext = { maxExposure: 1000, maxDailyLoss: 50, maxOpenPositions: 3, maxPositionNotional: 500, otherExposure: 0, otherOpenPositions: 0, otherDayNet: 0 };

/** Feeds candles one at a time (each step sees only closed candles up to that point). */
function run(candles: Candle[], opts: Partial<PaperStepInput> & { from?: number; state?: PaperState } = {}) {
  const { from, state: initial, ...o } = opts;
  let state = initial ?? initialPaperState(1000);
  const events: PaperEvent[] = [], trades: PaperTrade[] = [], records = [];
  for (let k = from ?? 59; k < candles.length; k++) {
    const r = stepPaperBar({ strategyKey: "S", history: candles.slice(0, k + 1), tfMs: TF, cfg: cfg(), costs: COSTS, policy: POLICY, entriesAllowed: true, haltedAt: null, account: ACCOUNT, ...o, state } as PaperStepInput);
    state = r.state; events.push(...r.events); trades.push(...r.trades); records.push(r.record);
  }
  return { state, events, trades, records };
}

describe("forward-only signals and market fills", () => {
  it("a signal at a candle's close fills at the NEXT candle's open plus half-spread and slippage, with the fee", () => {
    const cs = [...flat(60), bar(60, 101, 101, 101, 101)];
    const r = run(cs);
    const fill = r.events.find((e) => e.event === "filled")!;
    expect(fill.price).toBeCloseTo(101 * (1 + 0.0001 + 0.0005), 10);
    expect(fill.fee).toBeCloseTo(fill.price! * fill.qty * 0.001, 10);
    expect(fill.cash_delta).toBeCloseTo(-(fill.price! * fill.qty + fill.fee), 10);
    expect(r.records[0]!.signal).toBe("enter_long");
    expect(r.records[0]!.position_qty).toBe(0); // nothing fills on the signal candle itself
  });
  it("no decision before 60 closed candles (warm-up)", () => {
    const r = run(flat(40), { from: 0 });
    expect(r.events).toHaveLength(0);
    expect(r.records.at(-1)!.decision["note"]).toMatch(/Warming up/);
  });
  it("a repeated entry signal never creates a second order or position (duplicate prevention)", () => {
    const r = run(flat(70));
    expect(r.events.filter((e) => e.event === "created" && e.intent === "entry")).toHaveLength(1);
    expect(r.state.position?.buyQty).toBeGreaterThan(0);
  });
  it("is deterministic and survives a restart from serialized state", () => {
    const cs = [...flat(60), bar(60, 100, 100, 97, 99), bar(61, 99, 106, 99, 105), ...flat(10, 105).map((c, k) => ({ ...c, t: T0 + (62 + k) * TF }))];
    const whole = run(cs);
    const again = run(cs);
    expect(again).toEqual(whole);
    const first = run(cs.slice(0, 62));
    const resumed = run(cs, { from: 62, state: JSON.parse(JSON.stringify(first.state)) });
    expect([...first.events, ...resumed.events]).toEqual(whole.events);
    expect(resumed.state).toEqual(whole.state);
  });
  it("refuses a history with a gap or an invalid candle instead of filling across it", () => {
    const cs = flat(61); cs.splice(30, 1);
    expect(() => stepPaperBar({ strategyKey: "S", state: initialPaperState(1000), history: cs, tfMs: TF, cfg: cfg(), costs: COSTS, policy: POLICY, entriesAllowed: true, haltedAt: null, account: ACCOUNT })).toThrow(PaperDataError);
    const bad = [...flat(60), { ...bar(60, 100, 99, 101, 100) }];
    expect(() => stepPaperBar({ strategyKey: "S", state: initialPaperState(1000), history: bad, tfMs: TF, cfg: cfg(), costs: COSTS, policy: POLICY, entriesAllowed: true, haltedAt: null, account: ACCOUNT })).toThrow(PaperDataError);
  });
  it("the first candle a strategy acts on opens at or after it was started", () => {
    expect(initialCursor(T0 + 10 * TF + 1, TF)).toBe(T0 + 10 * TF); // first processed candle opens at T0+11h
    expect(initialCursor(T0 + 10 * TF, TF)).toBe(T0 + 9 * TF);
  });
});

describe("partial fills and limit orders", () => {
  it("caps each fill at the candle-volume share and keeps working the rest", () => {
    const cs = [...flat(60), bar(60, 100, 100, 100, 100, 10), bar(61, 100, 100, 100, 100, 10), bar(62, 100, 100, 100, 100, 10)];
    const r = run(cs, { costs: { ...COSTS, maxParticipationPct: 10 } });
    const fills = r.events.filter((e) => e.intent === "entry" && e.event !== "created");
    expect(fills.map((e) => e.event)).toEqual(["partially_filled", "partially_filled", "filled"]);
    expect(fills[0]!.qty).toBe(1); expect(fills[1]!.qty).toBe(1);
    expect(r.state.position!.buyQty).toBeCloseTo(fills.reduce((a, e) => a + e.qty, 0), 8);
  });
  it("an unfilled remainder expires after the order lifetime", () => {
    const cs = [...flat(60), ...[60, 61, 62].map((k) => bar(k, 100, 100, 100, 100, 5))];
    const r = run(cs, { costs: { ...COSTS, maxParticipationPct: 10 }, policy: { ...POLICY, orderTtlBars: 3 } });
    expect(r.events.filter((e) => e.event === "partially_filled")).toHaveLength(3);
    expect(r.events.some((e) => e.event === "expired" && e.reason.includes("Partly filled"))).toBe(true);
  });
  it("a buy limit needs a trade BELOW the limit (touching is not enough) and pays no spread or slippage", () => {
    const policy = { ...POLICY, entryOrder: "limit" as const, limitOffsetPct: 1 };
    const touch = run([...flat(60), bar(60, 100, 100, 99, 100)], { policy });
    expect(touch.events.some((e) => e.event === "filled")).toBe(false);
    const through = run([...flat(60), bar(60, 100, 100, 98.5, 100)], { policy });
    const f = through.events.find((e) => e.event === "filled")!;
    expect(f.price).toBe(99); expect(f.spread_cost).toBe(0); expect(f.slippage_cost).toBe(0);
    const gap = run([...flat(60), bar(60, 98, 98, 97, 98)], { policy });
    expect(gap.events.find((e) => e.event === "filled")!.price).toBe(98); // opened below the limit: filled at the better open
  });
});

describe("stop-loss and take-profit", () => {
  const entered = () => run([...flat(60), bar(60, 100, 100, 100, 100)]); // long from 100.06
  const entry = () => entered().state.position!.buyNotional / entered().state.position!.buyQty;
  it("a stop inside the candle fills at the stop less half-spread and slippage", () => {
    const st = entered().state; const stop = st.position!.stop;
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 100, 97, 99)], { from: 61, state: st });
    const f = r.events.find((e) => e.event === "filled")!;
    expect(f.kind).toBe("stop"); expect(f.price).toBeCloseTo(stop * (1 - 0.0001 - 0.0005), 10);
    expect(r.trades[0]!.close_reason).toBe("stop_loss");
    expect(stop).toBeCloseTo(entry() * 0.98, 10);
  });
  it("a gap through the stop fills at the worse opening price", () => {
    const st = entered().state;
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 90, 95, 89, 94)], { from: 61, state: st });
    expect(r.events.find((e) => e.event === "filled")!.price).toBeCloseTo(90 * (1 - 0.0006), 10);
    expect(r.trades[0]!.close_reason).toBe("stop_loss_gap");
  });
  it("when stop and target are both inside one candle, the stop wins", () => {
    const st = entered().state;
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 110, 90, 100)], { from: 61, state: st });
    expect(r.trades[0]!.close_reason).toBe("stop_loss");
  });
  it("take-profit needs a trade above the target and fills exactly at it", () => {
    const st = entered().state; const target = st.position!.target!;
    const touch = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, target, 100, 100)], { from: 61, state: st });
    expect(touch.trades).toHaveLength(0);
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, target + 1, 100, 104)], { from: 61, state: st });
    const f = r.events.find((e) => e.event === "filled")!;
    expect(f.kind).toBe("take_profit"); expect(f.price).toBe(target); expect(f.slippage_cost).toBe(0);
  });
  it("an exit rule exits at the next candle's open", () => {
    const st = entered().state;
    const cs = [...flat(60), bar(60, 100, 100, 100, 100), bar(61, 101, 101.5, 100.5, 101), bar(62, 100.5, 100.5, 100.5, 100.5)];
    const r = run(cs, { from: 61, state: st, cfg: cfg("0", "100.9") });
    expect(r.records[0]!.signal).toBe("exit");
    expect(r.events.find((e) => e.event === "filled")!.price).toBeCloseTo(100.5 * (1 - 0.0006), 10);
  });
});

describe("fees and reconciliation", () => {
  it("net = gross − both fees, and cash reconciles to start + settled net", () => {
    const cs = [...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 100, 97, 99), ...flat(5, 99).map((c, k) => ({ ...c, t: T0 + (62 + k) * TF }))];
    const r = run(cs);
    const t = r.trades[0]!;
    const fills = r.events.filter((e) => e.event === "filled" || e.event === "partially_filled");
    expect(t.fees).toBeCloseTo(fills.slice(0, 2).reduce((a, e) => a + e.fee, 0), 10);
    expect(t.net_pnl).toBeCloseTo(t.gross_pnl - t.fees, 10);
    expect(t.gross_pnl).toBeCloseTo(t.qty * (t.avg_exit - t.avg_entry), 8);
    expect(reconcilePaper(1000, r.state, r.trades)).toBeLessThan(1e-9);
  });
  it("cash never goes negative and fills never exceed the approved notional", () => {
    const r = run([...flat(60), bar(60, 150, 150, 150, 150)]);
    const f = r.events.find((e) => e.event === "filled")!;
    expect(f.price! * f.qty).toBeLessThanOrEqual(300 + 1e-9);
    expect(r.state.cash).toBeGreaterThanOrEqual(0);
  });
});

describe("paper Risk Engine", () => {
  const base = { estPrice: 100, equity: 1000, cash: 1000, dayNet: 0, costs: COSTS, policy: POLICY, account: ACCOUNT };
  it("sizes from the tightest cap and reports it", () => {
    const s = sizePaperEntry(base);
    expect(s.ok && s.binding).toBe("max position size");
    expect(s.ok && s.qty).toBe(3);
    const risk = sizePaperEntry({ ...base, policy: { ...POLICY, riskPerTradePct: 0.5, maxPositionNotional: 10_000 }, account: { ...ACCOUNT, maxPositionNotional: 10_000 } });
    expect(risk.ok && risk.binding).toBe("risk per trade");
    expect(risk.ok && risk.riskAmount).toBeCloseTo(5, 1); // 0.5% of 1000 at risk if the stop is hit, costs included
  });
  it("rejects when account exposure is used up", () => {
    const s = sizePaperEntry({ ...base, account: { ...ACCOUNT, otherExposure: 999.5 } });
    expect(s.ok).toBe(false); expect(!s.ok && s.reason).toMatch(/limited by account exposure/);
  });
  it("rejects when the account already holds its maximum open positions", () => {
    expect(sizePaperEntry({ ...base, account: { ...ACCOUNT, otherOpenPositions: 3 } })).toMatchObject({ ok: false, reason: "Account maximum open paper positions reached" });
  });
  it("strategy and account daily loss stops block new entries", () => {
    expect(sizePaperEntry({ ...base, dayNet: -20 })).toMatchObject({ ok: false });
    expect(sizePaperEntry({ ...base, dayNet: -10, account: { ...ACCOUNT, otherDayNet: -40 } })).toMatchObject({ ok: false });
  });
  it("a stop-loss is mandatory and the policy has no AI quantity or leverage field", () => {
    expect(paperRiskPolicySchema.safeParse({ ...POLICY, stopLossPct: 0 }).success).toBe(false);
    expect(paperRiskPolicySchema.safeParse({ ...POLICY, quantity: 5 }).success).toBe(false);
    expect(paperRiskPolicySchema.safeParse({ ...POLICY, leverage: 10 }).success).toBe(false);
  });
  it("a risk rejection is recorded on the candle and places no order", () => {
    const r = run([...flat(60), bar(60, 100, 100, 100, 100)], { account: { ...ACCOUNT, otherOpenPositions: 3 } });
    expect(r.records[0]!.signal).toBe("rejected");
    expect(r.events).toHaveLength(0);
  });
  it("the daily loss stop holds for the rest of the UTC day and lifts the next day", () => {
    // Loss of ~-6.6 on day 1 with a 5 limit: no re-entry the same day; entry again after midnight UTC.
    const policy = { ...POLICY, dailyLossLimit: 5 };
    const start = Date.UTC(2026, 0, 3, 0) - 62 * TF; // candle 61 is at 23:00 on 2 Jan
    const mk = (k: number, o: number, h: number, l: number, c: number): Candle => ({ t: start + k * TF, o, h, l, c, v: 1000 });
    const cs = [...Array.from({ length: 60 }, (_, k) => mk(k, 100, 100, 100, 100)), mk(60, 100, 100, 100, 100), mk(61, 100, 100, 97, 99), mk(62, 99, 99, 99, 99), mk(63, 99, 99, 99, 99)];
    const r = run(cs, { policy });
    expect(r.trades).toHaveLength(1);
    expect(r.records[2]!.signal).toBe("rejected"); // 23:00 candle: stopped out, same UTC day
    expect(r.records[2]!.decision["reason"]).toMatch(/daily loss stop/);
    expect(r.records[3]!.signal).toBe("enter_long"); // 00:00 UTC candle: new day
  });
});

describe("account limits re-checked at fill", () => {
  // Entry sized at candle 60's close (300 notional), filled at candle 61's open — after another strategy changed the account.
  const at = (account: PaperAccountContext) => {
    const cs = [...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 100, 100, 100)];
    const step = (k: number, state: PaperState, acc: PaperAccountContext) => stepPaperBar({ strategyKey: "S", history: cs.slice(0, k + 1), tfMs: TF, cfg: cfg(), costs: COSTS, policy: POLICY, entriesAllowed: true, haltedAt: null, account: acc, state });
    const first = step(60, initialPaperState(1000), ACCOUNT);
    expect(first.record.signal).toBe("enter_long");
    return step(61, first.state, account);
  };
  it("shrinks the entry to the exposure room left and completes it (no order keeps working for more)", () => {
    const r = at({ ...ACCOUNT, otherExposure: 800 });
    const f = r.events.find((e) => e.event === "filled")!;
    expect(f.qty * f.price).toBeLessThanOrEqual(200 + 1e-6);
    expect(f.qty * f.price).toBeGreaterThan(199);
    expect(r.record.open_exposure + 800).toBeLessThanOrEqual(1000 + 1e-6);
    expect(r.state.orders).toHaveLength(0);
  });
  it("cancels the entry when the account is at its open-position or daily-loss limit", () => {
    for (const acc of [{ ...ACCOUNT, otherOpenPositions: 3 }, { ...ACCOUNT, otherDayNet: -50 }]) {
      const r = at(acc);
      expect(r.events.map((e) => e.event)).toEqual(["cancelled"]);
      expect(r.events[0]!.reason).toMatch(/Account limits re-checked at fill/);
      expect(r.state.position).toBeNull();
      expect(r.state.cash).toBe(1000);
    }
  });
});

describe("emergency paper stop", () => {
  it("cancels working entries, exits at the first open after the stop and accepts no new entry", () => {
    const st = run([...flat(60), bar(60, 100, 100, 100, 100)]).state;
    const haltedAt = T0 + 61 * TF - 1;
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 100, 100, 100), bar(62, 100, 100, 100, 100)], { from: 61, state: st, haltedAt });
    expect(r.trades[0]!.close_reason).toBe("emergency_stop");
    expect(r.trades[0]!.closed_bar_t).toBe(T0 + 61 * TF);
    expect(r.records[1]!.signal).toBe("halted");
    expect(r.events.filter((e) => e.intent === "entry")).toHaveLength(0);
    const pending = run([...flat(60)], { haltedAt: null });
    const cancel = run([...flat(60), bar(60, 100, 100, 100, 100)], { from: 60, state: pending.state, haltedAt: T0 });
    expect(cancel.events.find((e) => e.event === "cancelled")?.reason).toBe("Emergency paper stop");
  });
  it("a paused strategy still manages its exits but opens nothing", () => {
    const st = run([...flat(60), bar(60, 100, 100, 100, 100)]).state;
    const r = run([...flat(60), bar(60, 100, 100, 100, 100), bar(61, 100, 100, 97, 99), bar(62, 99, 99, 99, 99)], { from: 61, state: st, entriesAllowed: false });
    expect(r.trades).toHaveLength(1);
    expect(r.records[0]!.signal).toBe("rejected");
    expect(r.events.some((e) => e.intent === "entry")).toBe(false);
  });
});
