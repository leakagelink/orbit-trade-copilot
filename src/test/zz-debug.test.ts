import { it } from "vitest";
import { initialPaperState, stepPaperBar } from "@/lib/paper-engine";
const TF = 3_600_000, T0 = Date.UTC(2026, 0, 1);
const flat = (n: number, px = 100) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * TF, o: px, h: px, l: px, c: px, v: 1000 }));
const bar = (k: number, o: number, h: number, l: number, c: number) => ({ t: T0 + k * TF, o, h, l, c, v: 1000 });
const cfg = (exitAbove = "1000000") => ({ pairs: ["BTC/USDT"], timeframe: "1h", indicators: [], entry: { logic: "all", conditions: [{ left: "price", operator: ">", right: "0" }] }, exit: { logic: "any", conditions: [{ left: "price", operator: ">", right: exitAbove }] }, risk: {} }) as never;
it("dbg", () => {
  const cs = [...flat(60), bar(60, 100, 100, 100, 100), bar(61, 101, 101.5, 100.5, 101), bar(62, 100.5, 100.5, 100.5, 100.5)];
  let state = initialPaperState(1000);
  for (let k = 59; k < cs.length; k++) {
    const r = stepPaperBar({ strategyKey: "S", state, history: cs.slice(0, k + 1), tfMs: TF, cfg: cfg(k >= 61 ? "100.9" : "1000000"), costs: { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: null }, policy: { riskPerTradePct: 1, positionSizePct: 50, maxPositionNotional: 300, stopLossPct: 2, takeProfitPct: 4, dailyLossLimit: 20, strategyBudget: 1000, entryOrder: "market", limitOffsetPct: 0, orderTtlBars: 3 }, entriesAllowed: true, haltedAt: null, account: { maxExposure: 1000, maxDailyLoss: 50, maxOpenPositions: 3, maxPositionNotional: 500, otherExposure: 0, otherOpenPositions: 0, otherDayNet: 0 } });
    state = r.state;
    console.log(k, r.record.signal, JSON.stringify(r.events.map((e) => [e.event, e.intent, e.kind, e.qty, e.price, e.reason])), state.position?.qty, state.orders.length);
  }
});
