import { describe, expect, it } from "vitest";
import { runBacktest } from "@/lib/backtest";
import { groupStats } from "@/lib/metrics";
import { emptyStrategyConfig } from "@/lib/strategy";
import type { Candle } from "@/lib/indicators";

const candles = (closes: number[], low?: (i: number) => number): Candle[] =>
  closes.map((c, i) => ({ t: i * 3600e3, o: c, h: c, l: low ? low(i) : c, c, v: 1 }));

describe("backtest", () => {
  it("uses only previous-bar signals and fills at the next open",()=>{
    const cfg={...emptyStrategyConfig(),entry:{logic:"all" as const,conditions:[{left:"price",operator:">" as const,right:"150"}]}};
    const cs=candles([100,200,300]); cs[2]={t:7200000,o:210,h:300,l:210,c:300,v:1};
    const r=runBacktest(cfg,cs,{capital:1000,feePct:0,slippagePct:0,tfMs:3600000});
    expect(r.trades[0]?.entryT).toBe(7200000);expect(r.trades[0]?.entry).toBe(210);
  });
  it("does not fabricate a stop-price fill when the market gaps below it",()=>{
    const cfg={...emptyStrategyConfig(),entry:{logic:"all" as const,conditions:[{left:"price",operator:">" as const,right:"0"}]}};
    cfg.risk={...cfg.risk,stop_loss_pct:2,take_profit_pct:null,max_open_positions:1};
    const cs=candles([100,100,90]);
    const r=runBacktest(cfg,cs,{capital:1000,feePct:0,slippagePct:0,tfMs:3600000});
    expect(r.trades[0]?.exit).toBe(90);expect(r.trades[0]?.reason).toBe("stop_loss");
  });
  it("stop loss closes at the stop price when the candle low reaches it", () => {
    const cfg = { ...emptyStrategyConfig(), entry: { logic: "all" as const, conditions: [{ left: "price", operator: ">" as const, right: "0" }] } };
    cfg.risk = { ...cfg.risk, stop_loss_pct: 2, take_profit_pct: null, max_open_positions: 1 };
    const r = runBacktest(cfg, candles([100, 100, 100, 100], (i) => (i === 2 ? 90 : 100)), { capital: 1000, feePct: 0, slippagePct: 0, tfMs: 3600e3 });
    expect(r.trades[0]!.reason).toBe("stop_loss");
    expect(r.trades[0]!.exit).toBeCloseTo(98);
  });
  it("position size % limits capital per trade", () => {
    const cfg = { ...emptyStrategyConfig(), entry: { logic: "all" as const, conditions: [{ left: "price", operator: ">" as const, right: "0" }] } };
    cfg.risk = { ...cfg.risk, position_size_pct: 10, stop_loss_pct: 50, take_profit_pct: null };
    const r = runBacktest(cfg, candles([100, 100, 100]), { capital: 1000, feePct: 0, slippagePct: 0, tfMs: 3600e3 });
    expect(r.trades[0]!.qty * r.trades[0]!.entry).toBeCloseTo(100);
  });
});

describe("analytics", () => {
  it("net PnL subtracts fees and profit factor = gross win / gross loss", () => {
    const t = (pnl: number, fees: number) => ({ realized_pnl: pnl, fees, closed_at: "2026-10-01", bot_id: "b", strategy_id: null, trading_pair: "BTC/USDT" });
    const [g] = groupStats([t(12, 2), t(-4, 1)], (x) => x.bot_id);
    expect(g!.net).toBe(5);
    expect(g!.profitFactor).toBe(2);
  });
});
