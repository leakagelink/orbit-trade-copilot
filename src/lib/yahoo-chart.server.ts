// Yahoo Finance public chart API (no key, no credentials, read-only). Kept separate from exchange-adapters.server.ts so
// AI research can load prices without importing any order-capable code. Behaviour is identical to the previous copy.
import type { Candle } from "./indicators";

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body ? JSON.stringify(body).slice(0, 200) : String(body).slice(0, 200);
    throw new Error(`Exchange returned ${res.status}: ${msg}`);
  }
  return body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const Y_INT: Record<string, [string, string]> = {
  "1m": ["1m", "5d"], "5m": ["5m", "1mo"], "15m": ["15m", "1mo"], "30m": ["30m", "1mo"], "1h": ["60m", "6mo"], "4h": ["60m", "2y"], "1d": ["1d", "5y"],
};
export async function yahooChart(ticker: string, tf: string, limit = 300): Promise<Candle[]> {
  const [interval, range] = Y_INT[tf] ?? ["60m", "6mo"];
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const init = { headers: { "User-Agent": "Mozilla/5.0 (compatible; AlgoVirt/1.0)", Accept: "application/json" } };
  let j;
  try { j = await getJson(`https://query1.finance.yahoo.com${path}`, init); }
  catch { j = await getJson(`https://query2.finance.yahoo.com${path}`, init); }
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`Yahoo Finance has no data for ${ticker}`);
  const qt = r.indicators.quote[0];
  let out: Candle[] = [];
  (r.timestamp as number[]).forEach((ts, i) => {
    const c = qt.close[i];
    if (c == null || qt.open[i] == null) return;
    out.push({ t: ts * 1000, o: qt.open[i], h: qt.high[i] ?? c, l: qt.low[i] ?? c, c, v: qt.volume?.[i] ?? 0 });
  });
  if (tf === "4h") {
    const agg = new Map<number, Candle>();
    for (const k of out) {
      const t = Math.floor(k.t / 14400e3) * 14400e3;
      const a = agg.get(t);
      if (!a) agg.set(t, { ...k, t });
      else { a.h = Math.max(a.h, k.h); a.l = Math.min(a.l, k.l); a.c = k.c; a.v += k.v; }
    }
    out = [...agg.values()];
  }
  return out.slice(-limit);
}

