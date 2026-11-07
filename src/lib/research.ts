import { z } from "zod";
import { ema, rsi, type Candle } from "./indicators";

export const RESEARCH_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "AAPL", "MSFT", "RELIANCE.NS", "TCS.NS"] as const;
export const researchInput = z.object({ requestId: z.string().uuid(), symbol: z.enum(RESEARCH_SYMBOLS) });
export const analystReport = z.object({
  summary: z.string().min(1).max(1800),
  outlook: z.enum(["bullish", "neutral", "bearish", "insufficient_data"]),
  observations: z.array(z.string().max(500)).max(6),
  risks: z.array(z.string().max(500)).max(6),
  limitations: z.array(z.string().max(500)).max(6),
});
export function researchSnapshot(candles: Candle[], now = Date.now()) {
  const closed = candles.filter(c => c.t + 86400000 <= now && [c.o,c.h,c.l,c.c,c.v].every(Number.isFinite) && c.c > 0).sort((a,b) => a.t-b.t);
  if (closed.length < 50) throw new Error("Not enough completed daily candles for research");
  const last = closed.at(-1);
  if (!last) throw new Error("Market data unavailable");
  if (now - last.t > 7 * 86400000) throw new Error("Market data is too old for research");
  const closes = closed.map(c => c.c);
  return { provider: "Yahoo Finance", timeframe: "1d", fetchedAt: new Date(now).toISOString(), asOf: new Date(last.t).toISOString(), close: last.c, ema20: ema(closes,20).at(-1) ?? null, ema50: ema(closes,50).at(-1) ?? null, rsi14: rsi(closes,14).at(-1) ?? null, candles: closed.slice(-60).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })) };
}
export function unavailableReport(reason: string) {
  return { summary: reason, outlook: "insufficient_data" as const, observations: [], risks: [], limitations: [reason] };
}