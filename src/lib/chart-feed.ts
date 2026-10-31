import type { Candle } from "./indicators";

/** Display-only public Binance feed. Never used to submit or price an order. */
export async function fetchBinanceChart(pair: string, timeframe: string): Promise<Candle[]> {
  const symbol = pair.replace("/", "").toUpperCase();
  const params = new URLSearchParams({ symbol, interval: timeframe, limit: "500" });
  const response = await fetch(`https://data-api.binance.vision/api/v3/klines?${params}`, {
    credentials: "omit",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Public chart feed unavailable");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invalid chart response");
  const candles: Candle[] = rows.map((row: unknown) => {
    if (!Array.isArray(row)) throw new Error("Invalid chart candle");
    return { t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) };
  });
  if (!candles.length || candles.some((c) => !Object.values(c).every(Number.isFinite) || c.t <= 0 || c.l <= 0 || c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c))) {
    throw new Error("Invalid chart candles");
  }
  return candles.sort((a, b) => a.t - b.t);
}