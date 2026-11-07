// Pure market summary from real candles + computed indicators. Shared by AI trade ideas and the AI Autopilot.
import { computeIndicator, type Candle } from "./indicators";

export function marketFacts(cs: Candle[], market: string, timeframe: string) {
  if (cs.length < 60) throw new Error("Not enough market data");
  const at = (type: "RSI" | "EMA" | "ATR" | "MACD" | "BBANDS", params: Record<string, number>) => computeIndicator({ id: "x", type, params }, cs).at(-1);
  const last = cs.at(-1)!.c;
  return {
    market, timeframe, price: last,
    change_24_bars_pct: ((last / cs.at(-25)!.c - 1) * 100).toFixed(2),
    high_100: Math.max(...cs.slice(-100).map((c) => c.h)), low_100: Math.min(...cs.slice(-100).map((c) => c.l)),
    rsi14: at("RSI", { period: 14 }), ema20: at("EMA", { period: 20 }), ema50: at("EMA", { period: 50 }), ema200: at("EMA", { period: 200 }),
    atr14: at("ATR", { period: 14 }), macd_hist: at("MACD", { fast: 12, slow: 26, signal: 9 }), bb_percent_b: at("BBANDS", { period: 20, stddev: 2 }),
    last_10_closes: cs.slice(-10).map((c) => c.c),
  };
}
