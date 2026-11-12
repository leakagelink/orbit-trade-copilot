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


describe("additional readiness coverage", () => {
  for (const sym of ["BTCUSDT", "ETHUSDT"]) for (const side of ["LONG", "SHORT"] as const) {
    it(`${sym} ${side}: funding signs, isolated margin and deterministic recovery`, () => {
      const i = intent(0, side, side === "LONG" ? 99 : 101, null, {symbol:sym});
      const a = run([{b:bar(0,100,100,100,100,{},sym),i:[i]}, {b:bar(1,100,100,100,100,{},sym)}]);
      const b = bar(2,100,100,100,100,{funding:[{t:T0+2*M,rate:0.001}]},sym);
      const r = stepFuturesPaper(a.s,CFG,b,[]);
      expect(r).toEqual(stepFuturesPaper(structuredClone(a.s),CFG,b,[]));
      const p=a.s.positions[sym]!;
      expect(p.margin).toBeCloseTo(p.qty*p.entryPrice/p.leverage,9);
      expect(r.events[0]!.walletDelta).toBeCloseTo((side==="LONG"?-1:1)*p.qty*100*0.001,9);
      const c = stepFuturesPaper(r.state,CFG,bar(3,100,100,100,100,{funding:[{t:T0+3*M,rate:-0.001}]},sym),[]);
      expect(c.events[0]!.walletDelta).toBeCloseTo(-r.events[0]!.walletDelta,9);
      expect(reconcileFuturesPaper(c.state,[...a.events,...r.events,...c.events],1000)).toEqual([]);
    });
  }
  it("exhausted strategy budget rejects",()=>{
    const s=initialFuturesPaperState(1000);s.strategyLoss["s1"]=100;
    const r=stepFuturesPaper(s,CFG,bar(0,100,100,100,100),[intent(0,"LONG",99,110)]);
    expect(r.decisions[0]!.checks.find(c=>c.id==="strategy_budget")!.status).toBe("fail");
  });
  it("halted account rejects proposals but manages existing exits",()=>{
    const a=run([{b:bar(0,100,100,100,100),i:[intent(0,"LONG",99,110)]},{b:bar(1,100,100,100,100)}]);
    a.s.halted=true;
    const r=stepFuturesPaper(a.s,CFG,bar(2,98,98,98,98),[intent(2,"LONG",97,110)]);
    expect(r.trades[0]!.reason).toBe("stop");
    expect(r.decisions[0]!.verdict).toBe("REJECT");
  });
  it("emergency paper stop: a pending entry is cancelled, never filled (regression for Phase 4B review defect)",()=>{
    const a=run([{b:bar(0,100,100,100,100),i:[intent(0,"LONG",99,110)]}]);a.s.halted=true;
    const r=stepFuturesPaper(a.s,CFG,bar(1,100,100,100,100),[]);
    expect(r.events.some(e=>e.kind==="entry_fill")).toBe(false);
    expect(r.events.map(e=>e.kind)).toEqual(["entry_cancelled"]);
    expect(r.state.pending).toEqual({}); expect(r.state.positions).toEqual({});
    expect(reconcileFuturesPaper(r.state,[...a.events,...r.events],1000)).toEqual([]);
  });
  it("a duplicate or out-of-order candle is refused, so funding is never charged twice (regression)",()=>{
    const a=run([{b:bar(0,100,100,100,100),i:[intent(0,"LONG",99,110)]},{b:bar(1,100,100,100,100)}]);
    const b=bar(2,100,100,100,100,{funding:[{t:T0+2*M,rate:0.001}]});
    const r=stepFuturesPaper(a.s,CFG,b,[]);
    expect(()=>stepFuturesPaper(r.state,CFG,b,[])).toThrow(FuturesPaperDataError);
    expect(()=>stepFuturesPaper(r.state,CFG,bar(1,100,100,100,100),[])).toThrow(/duplicate or out-of-order/);
    // Cursors are per symbol: ETH at the same timestamp is still accepted.
    expect(()=>stepFuturesPaper(r.state,CFG,bar(2,100,100,100,100,{},"ETHUSDT"),[])).not.toThrow();
  });
  it("detects wallet tampering",()=>{
    const a=run([{b:bar(0,100,100,100,100),i:[intent(0,"LONG",99,110)]},{b:bar(1,100,100,100,100)}]);a.s.wallet+=1;
    expect(reconcileFuturesPaper(a.s,a.events,1000).some(x=>x.includes("wallet"))).toBe(true);
  });
});
