// Public, credential-free candle data for forward paper trading. GET requests to Binance's public market-data endpoints
// only — no signed endpoint, no API key, no order route. Simulated paper fills are priced from these candles.
import type { Candle } from "./indicators";

export const PAPER_DATA_SOURCE = "binance-public-spot-klines";
export const PAPER_KLINE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"] as const;

export class PaperDataOutage extends Error {}

export async function fetchPaperCandles(pair: string, timeframe: string, limit = 500, fetcher: typeof fetch = fetch): Promise<{ candles: Candle[]; fetchedAt: number; host: string }> {
  if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(pair)) throw new Error("Unsupported pair");
  const params = new URLSearchParams({ symbol: pair.replace("/", ""), interval: timeframe, limit: String(Math.min(1000, Math.max(2, limit))) });
  let last = "Public market data unavailable";
  for (const host of PAPER_KLINE_HOSTS) {
    try {
      const res = await fetcher(`${host}/api/v3/klines?${params}`, { method: "GET", credentials: "omit", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { last = `Public market data returned HTTP ${res.status}`; continue; }
      const rows: unknown = await res.json();
      if (!Array.isArray(rows)) { last = "Public market data returned an invalid response"; continue; }
      const candles = rows.map((r: unknown) => {
        if (!Array.isArray(r)) throw new PaperDataOutage("Invalid candle row");
        return { t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) };
      });
      return { candles: candles.sort((a, b) => a.t - b.t), fetchedAt: Date.now(), host };
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
  }
  throw new PaperDataOutage(last);
}
