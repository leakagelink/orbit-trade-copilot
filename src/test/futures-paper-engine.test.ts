// Futures paper accounting: Risk-Engine sizing, next-open fills, exchange-style stop/target, funding, liquidation,
// partial fills, daily-loss and exposure controls, data checks and ledger reconciliation. All simulated.
import { describe, expect, it } from "vitest";
import { FuturesPaperDataError, initialFuturesPaperState, isolatedLiquidationPrice, reconcileFuturesPaper, stepFuturesPaper, takerFill, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPState } from "@/lib/futures-paper-engine";

const M = 60_000, T0 = Date.UTC(2026, 10, 10, 0, 0);
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 }, ETHUSDT: { stepSize: 0.001, tickSize: 0.01, minNotional: 5, maintenanceMarginRate: 0.005 } },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: { s1: 100 },
};
const bar = (k: number, o: number, h: number, l: number, c: number, x: Partial<FPBar> = {}, sym = "BTCUSDT"): FPBar => ({ symbol: sym, t: T0 + k * M, tfMs: M, trade: { o, h, l, c, v: 1e6 }, mark: { o, h, l, c }, index: { c }, funding: [], ...x });
let n = 0;
const intent = (k: number, side: "LONG" | "SHORT", stop: number, target: number | null, x: Record<string, unknown> = {}): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: `prop-${k}-${side}-${n++}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: stop, takeProfitPrice: target, createdAt: T0 + (k + 1) * M, ...x } as FPIntent["proposal"] });

function run(steps: { b: FPBar; i?: FPIntent[] }[], cfg = CFG, start: FPState = initialFuturesPaperState(cfg.startingBalance)) {
  let s = start; const events: FPEvent[] = [], trades = [], decisions = [];
  for (const st of steps) { const r = stepFuturesPaper(s, cfg, st.b, st.i ?? []); s = r.state; events.push(...r.events); trades.push(...r.trades); decisions.push(...r.decisions); }
  return { s, events, trades, decisions };
}

describe("Futures paper engine", () => {
  it("sizes only through the Risk Engine, fills at the next open as taker, and exits at the target", () => {
    const r = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 102)] }, { b: bar(1, 100, 100.5, 99.8, 100.2) }, { b: bar(2, 100.2, 103, 100.1, 102.5) }]);
    const d = r.decisions[0]!;
    expect(d.verdict).toBe("ACCEPT"); expect(d.executionAuthorized).toBe(false);
    // room = max loss per trade 10; per-unit loss = 1 + 0.13% of 100 → notional 884.96; margin cap 200 → 5×.
    expect(d.sizing!.leverage).toBe(5); expect(d.sizing!.qty).toBeCloseTo(8.849, 9);
    const entry = r.events.find((e) => e.kind === "entry_fill")!, exit = r.events.find((e) => e.kind === "exit_fill")!;
    const ef = takerFill("buy", 100, 8.849, CFG.costs);
    expect(entry.price).toBeCloseTo(ef.price, 9); expect(entry.fee).toBeCloseTo(ef.fee, 9); expect(entry.marginDelta).toBeCloseTo((ef.price * 8.849) / 5, 9);
    expect(exit.reason).toBe("target");
    const t = r.trades[0]!;
    expect(t.net).toBeCloseTo(t.pnl - t.fees + t.funding, 9);
    expect(r.s.wallet).toBeCloseTo(1000 + t.net, 9);
    expect(reconcileFuturesPaper(r.s, r.events, 1000)).toEqual([]);
  });

  it("SHORT stop-loss loses money and is charged to the strategy budget", () => {
    const r = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "SHORT", 101, 98)] }, { b: bar(1, 100, 100.2, 99.9, 100.1) }, { b: bar(2, 100.1, 101.5, 100, 101.2) }]);
    const t = r.trades[0]!;
    expect(t.side).toBe("SHORT"); expect(t.reason).toBe("stop"); expect(t.net).toBeLessThan(0);
    expect(r.s.strategyLoss["s1"]).toBeCloseTo(-t.net, 9);
    expect(reconcileFuturesPaper(r.s, r.events, 1000)).toEqual([]);
  });

  it("assumes the stop first when stop and target are both touched in one candle", () => {
    const r = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 101)] }, { b: bar(1, 100, 100, 100, 100) }, { b: bar(2, 100, 102, 98.5, 100) }]);
    expect(r.trades[0]!.reason).toBe("stop");
  });

  it("triggers protection on MARK price by default and on last price when configured", () => {
    const steps = () => [{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 105)] }, { b: bar(1, 100, 100, 100, 100) },
      { b: { ...bar(2, 100, 100.3, 98.7, 100), mark: { o: 100, h: 100.2, l: 99.5, c: 100 } } }];
    expect(run(steps()).trades).toHaveLength(0); // last price wicked through the stop, mark did not
    expect(run(steps(), { ...CFG, triggerSource: "CONTRACT" }).trades[0]!.reason).toBe("stop");
  });

  it("applies funding at the mark open to positions held before the timestamp, through the isolated margin", () => {
    const r = run([
      { b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110)] },
      { b: bar(1, 100, 100, 100, 100, { funding: [{ t: T0 + M, rate: 0.001 }] }) }, // position opens at this open: no funding
      { b: bar(2, 100, 100, 100, 100, { funding: [{ t: T0 + 2 * M, rate: 0.001 }] }) },
      { b: bar(3, 100, 100, 100, 100, { funding: [{ t: T0 + 3 * M, rate: -0.002 }] }) },
    ]);
    const f = r.events.filter((e) => e.kind === "funding");
    expect(f).toHaveLength(2);
    const q = r.s.positions["BTCUSDT"]!.qty;
    expect(f[0]!.walletDelta).toBeCloseTo(-q * 100 * 0.001, 9); // long pays a positive rate
    expect(f[1]!.walletDelta).toBeCloseTo(q * 100 * 0.002, 9);  // and receives a negative one
    expect(r.s.positions["BTCUSDT"]!.funding).toBeCloseTo(q * 100 * 0.001, 9);
    expect(reconcileFuturesPaper(r.s, r.events, 1000)).toEqual([]);
  });

  it("liquidates on a mark gap beyond the liquidation price and loses the whole isolated margin", () => {
    const r = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110)] }, { b: bar(1, 100, 100, 100, 100) }, { b: bar(2, 70, 70, 69, 69.5) }]);
    const liqEv = r.events.find((e) => e.kind === "liquidation")!, entry = r.events.find((e) => e.kind === "entry_fill")!;
    expect(liqEv).toBeTruthy();
    expect(liqEv.walletDelta).toBeCloseTo(-entry.marginDelta, 9);
    const t = r.trades[0]!;
    expect(t.reason).toBe("liquidation"); expect(t.net).toBeCloseTo(-entry.marginDelta - entry.fee, 9);
    expect(isolatedLiquidationPrice("LONG", entry.price!, entry.qty, entry.marginDelta, 0.004)!).toBeGreaterThan(70);
    expect(reconcileFuturesPaper(r.s, r.events, 1000)).toEqual([]);
  });

  it("fills partially under a volume cap, re-anchors protection, and cancels the remainder at its time limit", () => {
    const cfg = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const lowVol = (k: number) => ({ ...bar(k, 100, 100, 100, 100), trade: { o: 100, h: 100, l: 100, c: 100, v: 200 } }); // 1% of 200 = 2 per candle
    const r = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110)] }, { b: lowVol(1) }, { b: lowVol(2) }, { b: lowVol(3) }, { b: lowVol(4) }], cfg);
    const fills = r.events.filter((e) => e.kind === "entry_fill");
    expect(fills.map((e) => e.qty)).toEqual([2, 2, 2]);
    expect(fills[0]!.reason).toMatch(/partial/);
    expect(r.events.some((e) => e.kind === "entry_cancelled")).toBe(true);
    const p = r.s.positions["BTCUSDT"]!;
    expect(p.qty).toBeCloseTo(6, 9); expect(p.stop).toBeCloseTo(p.entryPrice - 1, 9);
    expect(r.s.pending["BTCUSDT"]).toBeUndefined();
    expect(reconcileFuturesPaper(r.s, r.events, 1000)).toEqual([]);
  });

  it("blocks new entries after the daily loss limit, until the next UTC day", () => {
    const cfg = { ...CFG, limits: { ...CFG.limits, maxDailyLoss: 5 }, strategyBudgets: { s1: 1000 } };
    const day2 = 1440;
    const r = run([
      { b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110)] }, { b: bar(1, 100, 100, 100, 100) }, { b: bar(2, 98.5, 98.5, 98, 98.5) }, // gap through the stop: loss > 5
      { b: bar(3, 98.5, 98.5, 98.5, 98.5), i: [intent(3, "LONG", 97.5, 110)] },
      { b: bar(day2, 98.5, 98.5, 98.5, 98.5), i: [intent(day2, "LONG", 97.5, 110)] },
    ], cfg);
    expect(r.decisions[1]!.verdict).toBe("REJECT");
    expect(r.decisions[1]!.checks.find((c) => c.id === "daily_loss")!.status).toBe("fail");
    expect(r.decisions[2]!.verdict).toBe("ACCEPT");
  });

  it("enforces account exposure and one position per symbol across symbols", () => {
    const cfg = { ...CFG, limits: { ...CFG.limits, maxExposure: 1000 } };
    let s = initialFuturesPaperState(1000);
    s = stepFuturesPaper(s, cfg, bar(0, 100, 100, 100, 100), [intent(0, "LONG", 99, 110)]).state;
    s = stepFuturesPaper(s, cfg, bar(1, 100, 100, 100, 100), []).state;
    const again = stepFuturesPaper(s, cfg, bar(2, 100, 100, 100, 100), [intent(2, "LONG", 99, 110)]);
    expect(again.decisions[0]!.checks.find((c) => c.id === "one_position_per_symbol")!.status).toBe("fail");
    const eth = stepFuturesPaper(again.state, cfg, bar(2, 50, 50, 50, 50, {}, "ETHUSDT"), [intent(2, "LONG", 49.5, 55, { symbol: "ETHUSDT" })], { BTCUSDT: 100 });
    const d = eth.decisions[0]!;
    // 884.9 of 1000 exposure is used by BTC: the ETH trade is capped by the remaining exposure.
    expect(d.verdict).toBe("ACCEPT"); expect(d.sizing!.binding).toBe("account exposure"); expect(d.sizing!.notional).toBeLessThanOrEqual(1000 - 884.9 + 1e-6);
  });

  it("refuses proposals carrying size or leverage, non-paper environments and duplicates", () => {
    const sized = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110, { quantity: 50 })] }]);
    expect(sized.decisions[0]!.verdict).toBe("REJECT"); expect(sized.decisions[0]!.checks[0]!.id).toBe("proposal_schema");
    const live = run([{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 110, { environment: "live" })] }]);
    expect(live.decisions).toHaveLength(0); expect(live.events[0]!.kind).toBe("order_rejected");
    const p = intent(0, "LONG", 99, 110);
    const dup = run([{ b: bar(0, 100, 100, 100, 100), i: [p] }, { b: bar(1, 100, 100, 99.5, 100) }, { b: bar(2, 100, 100, 98, 98.5) }, { b: bar(3, 98.5, 98.5, 98.5, 98.5), i: [{ ...p, proposal: { ...p.proposal, createdAt: T0 + 4 * M } }] }]);
    expect(dup.decisions[1]!.checks.find((c) => c.id === "duplicate")!.status).toBe("fail");
  });

  it("refuses entries on wide mark/index basis or missing index, and treats a missing mark candle as invalid data", () => {
    const wide = run([{ b: bar(0, 100, 100, 100, 100, { index: { c: 101 } }), i: [intent(0, "LONG", 99, 110)] }]);
    expect(wide.events[0]!.reason).toMatch(/basis/);
    const noIdx = run([{ b: bar(0, 100, 100, 100, 100, { index: null }), i: [intent(0, "LONG", 99, 110)] }]);
    expect(noIdx.events[0]!.reason).toMatch(/Index price unavailable/);
    expect(() => stepFuturesPaper(initialFuturesPaperState(1000), CFG, bar(0, 100, 100, 100, 100, { mark: null }), [])).toThrow(FuturesPaperDataError);
    expect(() => stepFuturesPaper(initialFuturesPaperState(1000), CFG, bar(0, 100, 100, 100, 100, { funding: [{ t: T0 + 5 * M, rate: 0.0001 }] }), [])).toThrow(FuturesPaperDataError);
  });

  it("is deterministic and reconciliation detects tampering", () => {
    const steps = [{ b: bar(0, 100, 100, 100, 100), i: [intent(0, "LONG", 99, 102)] }, { b: bar(1, 100, 101, 99.5, 100.5) }, { b: bar(2, 100.5, 102.5, 100, 102) }];
    n = 0; const a = run(steps); n = 0; const b = run(steps);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
    expect(reconcileFuturesPaper({ ...a.s, wallet: a.s.wallet + 1 }, a.events, 1000)[0]).toMatch(/wallet/);
    expect(reconcileFuturesPaper(a.s, a.events.filter((e) => e.kind !== "entry_fill"), 1000).length).toBeGreaterThan(0);
    expect(reconcileFuturesPaper(a.s, a.events.slice(1), 1000)).toContain("ledger sequence has a gap");
  });
});
