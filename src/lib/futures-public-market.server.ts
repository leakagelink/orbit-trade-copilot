// Credential-free Binance USD-M market data for risk context and Futures PAPER simulation. GET only, fixed host, exact
// path allowlist, no signing, no API key header. It cannot place orders or read an account.
const HOST = "https://fapi.binance.com";
const ALLOWED = new Set(["/fapi/v1/premiumIndex", "/fapi/v1/exchangeInfo", "/fapi/v1/klines", "/fapi/v1/markPriceKlines", "/fapi/v1/indexPriceKlines", "/fapi/v1/fundingRate"]);

export async function publicFuturesGet<T>(path: string, params: Record<string, string | number>, fetcher: typeof fetch = fetch): Promise<T> {
  if (!ALLOWED.has(path)) throw new Error(`Public Futures path not allowed: ${path}`);
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await fetcher(`${HOST}${path}?${q}`, { method: "GET" });
  if (!r.ok) throw new Error(`Binance public ${path} ${r.status}`);
  return (await r.json()) as T;
}
export const PUBLIC_FUTURES_ALLOWLIST = [...ALLOWED];

/** Mark and index price with the exchange timestamp. Null on any failure (callers treat it as missing data). */
export async function publicMarkPrice(symbol: string, fetcher: typeof fetch = fetch) {
  try {
    const x = await publicFuturesGet<{ markPrice: string; indexPrice: string; time: number }>("/fapi/v1/premiumIndex", { symbol }, fetcher);
    const markPrice = Number(x.markPrice), indexPrice = Number(x.indexPrice), time = Number(x.time);
    return markPrice > 0 && indexPrice > 0 && Number.isFinite(time) ? { markPrice, indexPrice, time } : null;
  } catch { return null; }
}
/** Lot size and minimum notional from exchangeInfo. Maintenance margin needs the signed leverage-bracket endpoint, so it
 *  is NOT available here (null) — the Risk Engine then returns INSUFFICIENT_DATA for Futures. */
export async function publicSymbolRules(symbol: string, fetcher: typeof fetch = fetch) {
  try {
    const x = await publicFuturesGet<{ symbols: { symbol: string; filters: { filterType: string; stepSize?: string; tickSize?: string; notional?: string }[] }[] }>("/fapi/v1/exchangeInfo", {}, fetcher);
    const s = x.symbols.find((v) => v.symbol === symbol); if (!s) return null;
    const lot = s.filters.find((f) => f.filterType === "MARKET_LOT_SIZE") ?? s.filters.find((f) => f.filterType === "LOT_SIZE");
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER"), mn = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
    const stepSize = Number(lot?.stepSize), tickSize = Number(price?.tickSize), minNotional = Number(mn?.notional);
    return stepSize > 0 && tickSize > 0 && minNotional > 0 ? { stepSize, tickSize, minNotional, maintenanceMarginRate: null as number | null } : null;
  } catch { return null; }
}
