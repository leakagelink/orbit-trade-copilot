// Exchange adapters: public market data + signed balance reads. Web Crypto only (Workers-safe).
import type { Candle } from "./indicators";

export interface Creds { apiKey: string; apiSecret: string; passphrase?: string }
export interface Balance { asset: string; free: number; locked: number }

/** Spot order-book depth. Quotes are fetched on the server, never inferred from candles. */
export async function fetchArbitrageBook(exchange: string, pair: string, testnet = false): Promise<import("./arbitrage").Book> {
  const [base, quote] = pair.split("/");
  if (!base || !quote) throw new Error("Invalid market");
  let bids: unknown[][], asks: unknown[][];
  switch (exchange) {
    case "binance": {
      const j = await getJson(`${testnet ? "https://testnet.binance.vision" : "https://api.binance.com"}/api/v3/depth?symbol=${base}${quote}&limit=100`);
      bids = j.bids; asks = j.asks; break;
    }
    case "bybit": {
      const j = await getJson(`${testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"}/v5/market/orderbook?category=spot&symbol=${base}${quote}&limit=50`);
      if (j.retCode !== 0) throw new Error("Bybit market unavailable");
      bids = j.result.b; asks = j.result.a; break;
    }
    case "okx": {
      const j = await getJson(`https://www.okx.com/api/v5/market/books?instId=${base}-${quote}&sz=100`);
      if (j.code !== "0" || !j.data?.[0]) throw new Error("OKX market unavailable");
      bids = j.data[0].bids; asks = j.data[0].asks; break;
    }
    case "kucoin": {
      if (testnet) throw new Error("KuCoin testnet unavailable");
      const j = await getJson(`https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=${base}-${quote}`);
      if (j.code !== "200000") throw new Error("KuCoin market unavailable");
      bids = j.data.bids; asks = j.data.asks; break;
    }
    default: throw new Error("Unsupported arbitrage exchange");
  }
  const levels = (rows: unknown[][]): [number, number][] => rows.map((r) => [Number(r[0]), Number(r[1])]);
  return { exchange, bids: levels(bids), asks: levels(asks), fetchedAt: Date.now() };
}

const te = new TextEncoder();
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(msg)));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

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

const split = (pair: string) => { const [b, q] = pair.toUpperCase().split("/"); return { b: b!, q: q! }; };

/** Same Binance market, alternate official data-only host; never changes order routing or testnet. */
async function binanceKlines(query: string, testnet = false) {
  if (testnet) return getJson(`https://testnet.binance.vision/api/v3/klines?${query}`);
  try {
    return await getJson(`https://api.binance.com/api/v3/klines?${query}`);
  } catch {
    return getJson(`https://data-api.binance.vision/api/v3/klines?${query}`);
  }
}

const TF_MS: Record<string, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
export const timeframeMs = (tf: string) => TF_MS[tf] ?? 3600e3;

// ---- Yahoo Finance (public chart API, no key) — forex & commodities prices for the demo wallet ----
const Y_INT: Record<string, [string, string]> = {
  "1m": ["1m", "5d"], "5m": ["5m", "1mo"], "15m": ["15m", "1mo"], "30m": ["30m", "1mo"], "1h": ["60m", "6mo"], "4h": ["60m", "2y"], "1d": ["1d", "5y"],
};
export async function yahooChart(ticker: string, tf: string, limit = 300): Promise<Candle[]> {
  const [interval, range] = Y_INT[tf] ?? ["60m", "6mo"];
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const init = { headers: { "User-Agent": "Mozilla/5.0 (compatible; Quantra/1.0)", Accept: "application/json" } };
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

/** Converts 1 unit of a market's quote currency to USD (1 for USD/USDT quotes). */
export async function quoteToUsd(symbol: string, price: number): Promise<number> {
  const { quoteUsdSource } = await import("./markets");
  const src = quoteUsdSource(symbol, price);
  if (typeof src === "number") return src;
  const cs = await yahooChart(src, "1h", 2);
  return cs.at(-1)!.c;
}

/** Returns candles oldest → newest. The last candle may still be forming. */
export async function fetchCandles(exchange: string, pair: string, tf: string, testnet: boolean, limit = 300): Promise<Candle[]> {
  if (exchange === "yahoo") {
    const { yahooTicker } = await import("./markets");
    const t = yahooTicker(pair);
    if (!t) throw new Error(`${pair} has no Yahoo Finance price feed`);
    return yahooChart(t, tf, limit);
  }
  const { b, q } = split(pair);
  const n = (x: unknown) => Number(x);
  switch (exchange) {
    case "binance": {
      const rows = await binanceKlines(`symbol=${b}${q}&interval=${tf}&limit=${limit}`, testnet);
      return rows.map((r: unknown[]) => ({ t: n(r[0]), o: n(r[1]), h: n(r[2]), l: n(r[3]), c: n(r[4]), v: n(r[5]) }));
    }
    case "bybit": {
      const iv: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" };
      const host = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      const j = await getJson(`${host}/v5/market/kline?category=spot&symbol=${b}${q}&interval=${iv[tf]}&limit=${Math.min(limit, 1000)}`);
      if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
      return (j.result.list as string[][]).map((r) => ({ t: n(r[0]), o: n(r[1]), h: n(r[2]), l: n(r[3]), c: n(r[4]), v: n(r[5]) })).reverse();
    }
    case "okx": {
      const bar: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };
      const j = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${b}-${q}&bar=${bar[tf]}&limit=${Math.min(limit, 300)}`,
        testnet ? { headers: { "x-simulated-trading": "1" } } : undefined);
      if (j.code !== "0") throw new Error(`OKX: ${j.msg}`);
      return (j.data as string[][]).map((r) => ({ t: n(r[0]), o: n(r[1]), h: n(r[2]), l: n(r[3]), c: n(r[4]), v: n(r[5]) })).reverse();
    }
    case "kucoin": {
      const ty: Record<string, string> = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "4h": "4hour", "1d": "1day" };
      const j = await getJson(`https://api.kucoin.com/api/v1/market/candles?type=${ty[tf]}&symbol=${b}-${q}`);
      if (j.code !== "200000") throw new Error(`KuCoin: ${j.msg}`);
      return (j.data as string[][]).slice(0, limit).map((r) => ({ t: n(r[0]) * 1000, o: n(r[1]), c: n(r[2]), h: n(r[3]), l: n(r[4]), v: n(r[5]) })).reverse();
    }
    case "coinbase": {
      const g: Record<string, string> = { "1m": "ONE_MINUTE", "5m": "FIVE_MINUTE", "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE", "1h": "ONE_HOUR", "1d": "ONE_DAY" };
      if (!g[tf]) throw new Error(`Coinbase does not offer ${tf} candles`);
      const end = Math.floor(Date.now() / 1000), start = end - Math.floor((timeframeMs(tf) / 1000) * Math.min(limit, 300));
      const j = await getJson(`https://api.coinbase.com/api/v3/brokerage/market/products/${b}-${q}/candles?start=${start}&end=${end}&granularity=${g[tf]}`);
      return (j.candles as Record<string, string>[]).map((r) => ({ t: n(r["start"]) * 1000, o: n(r["open"]), h: n(r["high"]), l: n(r["low"]), c: n(r["close"]), v: n(r["volume"]) })).reverse();
    }
  }
  throw new Error(`No market data adapter for ${exchange}`);
}

/** Signed read-only call. Proves the keys work and returns non-zero balances. */
export async function fetchBalances(exchange: string, c: Creds, testnet: boolean): Promise<Balance[]> {
  const nz = (xs: Balance[]) => xs.filter((x) => x.free + x.locked > 0);
  switch (exchange) {
    case "binance": {
      const host = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
      const qs = `timestamp=${Date.now()}&recvWindow=10000`;
      const j = await getJson(`${host}/api/v3/account?${qs}&signature=${hex(await hmac(c.apiSecret, qs))}`, { headers: { "X-MBX-APIKEY": c.apiKey } });
      return nz((j.balances as { asset: string; free: string; locked: string }[]).map((x) => ({ asset: x.asset, free: +x.free, locked: +x.locked })));
    }
    case "bybit": {
      const host = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      const ts = String(Date.now()), recv = "10000", qs = "accountType=UNIFIED";
      const sign = hex(await hmac(c.apiSecret, ts + c.apiKey + recv + qs));
      const j = await getJson(`${host}/v5/account/wallet-balance?${qs}`, { headers: { "X-BAPI-API-KEY": c.apiKey, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sign } });
      if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
      const coins = (j.result.list?.[0]?.coin ?? []) as { coin: string; walletBalance: string; locked: string }[];
      return nz(coins.map((x) => ({ asset: x.coin, free: +x.walletBalance - +(x.locked || 0), locked: +(x.locked || 0) })));
    }
    case "okx": {
      if (!c.passphrase) throw new Error("OKX requires a passphrase");
      const ts = new Date().toISOString(), path = "/api/v5/account/balance";
      const sign = b64(await hmac(c.apiSecret, ts + "GET" + path));
      const headers: Record<string, string> = { "OK-ACCESS-KEY": c.apiKey, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": c.passphrase };
      if (testnet) headers["x-simulated-trading"] = "1";
      const j = await getJson(`https://www.okx.com${path}`, { headers });
      if (j.code !== "0") throw new Error(`OKX: ${j.msg}`);
      const d = (j.data?.[0]?.details ?? []) as { ccy: string; availBal: string; frozenBal: string }[];
      return nz(d.map((x) => ({ asset: x.ccy, free: +x.availBal, locked: +x.frozenBal })));
    }
    case "kucoin": {
      if (!c.passphrase) throw new Error("KuCoin requires a passphrase");
      const ts = String(Date.now()), path = "/api/v1/accounts";
      const headers = {
        "KC-API-KEY": c.apiKey, "KC-API-TIMESTAMP": ts, "KC-API-KEY-VERSION": "2",
        "KC-API-SIGN": b64(await hmac(c.apiSecret, ts + "GET" + path)),
        "KC-API-PASSPHRASE": b64(await hmac(c.apiSecret, c.passphrase)),
      };
      const j = await getJson(`https://api.kucoin.com${path}`, { headers });
      if (j.code !== "200000") throw new Error(`KuCoin: ${j.msg}`);
      const acc = new Map<string, Balance>();
      for (const x of j.data as { currency: string; available: string; holds: string }[]) {
        const cur = acc.get(x.currency) ?? { asset: x.currency, free: 0, locked: 0 };
        cur.free += +x.available; cur.locked += +x.holds; acc.set(x.currency, cur);
      }
      return nz([...acc.values()]);
    }
    case "oanda": {
      const a = await oandaSummary(c, testnet);
      return [{ asset: a.currency, free: a.balance, locked: 0 }];
    }
    case "coinbase":
      throw new Error("Coinbase key verification is not supported yet (Coinbase uses a different key format). Market data works.");
  }
  throw new Error(`No adapter for ${exchange}`);
}

/** Historical candles between start and end (closed only). Binance paginates up to 5000 candles; others return their latest page. */
export async function fetchHistory(exchange: string, pair: string, tf: string, start: number, end: number): Promise<Candle[]> {
  const tfMs = timeframeMs(tf);
  const closed = (cs: Candle[]) => cs.filter((c) => c.t >= start && c.t + tfMs <= end);
  if (exchange !== "binance") return closed(await fetchCandles(exchange, pair, tf, false, 1000));
  const { b, q } = split(pair);
  const out: Candle[] = [];
  let from = Math.max(start, end - tfMs * 5000);
  while (from < end && out.length < 5000) {
    const rows = await binanceKlines(`symbol=${b}${q}&interval=${tf}&startTime=${from}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows as unknown[][]) out.push({ t: +r[0]!, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +r[5]! });
    from = out[out.length - 1]!.t + tfMs;
    if (rows.length < 1000) break;
  }
  return closed(out);
}

// ───────────── Live order execution (spot, market orders only) ─────────────
export interface Fill { orderId: string; qty: number; avgPrice: number; feeQuote: number }

/** Lookup only: unknown/expired IDs and provider errors must never imply no fill. */
export async function lookupArbitrageOrder(exchange: string, c: Creds, testnet: boolean, pair: string, side: "buy" | "sell", clientId: string): Promise<import("./arbitrage-recovery").OrderEvidence> {
  const { b, q } = split(pair);
  if (exchange === "binance") {
    const host = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    const signed = async (path: string, params: Record<string, string>) => {
      const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
      return getJson(`${host}${path}?${qs}&signature=${hex(await hmac(c.apiSecret, qs))}`, { headers: { "X-MBX-APIKEY": c.apiKey } });
    };
    const o = await signed("/api/v3/order", { symbol: b + q, origClientOrderId: clientId.slice(0, 36) });
    if (o.symbol !== b + q || o.side !== side.toUpperCase() || o.clientOrderId !== clientId.slice(0, 36)) throw new Error("Exchange order identity mismatch");
    const gross = Number(o.executedQty), quoteValue = Number(o.cummulativeQuoteQty), avgPrice = gross > 0 ? quoteValue / gross : 0;
    let baseFee = 0, feeQuote: number | null = 0;
    if (gross > 0) {
      const trades = await signed("/api/v3/myTrades", { symbol: b + q, orderId: String(o.orderId), limit: "1000" });
      let tradeQty = 0;
      for (const t of trades) {
        if (String(t.orderId) !== String(o.orderId)) continue;
        if (![t.qty, t.commission].every((v) => v !== "" && Number.isFinite(Number(v))) || Number(t.commission) < 0) throw new Error("Invalid exchange fee details");
        tradeQty += Number(t.qty);
        const fee = Number(t.commission);
        if (t.commissionAsset === b) { baseFee += fee; if (feeQuote != null) feeQuote += fee * avgPrice; }
        else if (t.commissionAsset === q) { if (feeQuote != null) feeQuote += fee; }
        else if (fee > 0) feeQuote = null;
      }
      if (Math.abs(tradeQty - gross) > gross * 1e-8) throw new Error("Incomplete exchange fill history");
    }
    return { orderId: String(o.orderId), state: o.status === "FILLED" ? "filled" : ["CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(o.status) ? "cancelled" : "open", qty: side === "buy" ? gross - baseFee : gross + baseFee, avgPrice, quoteValue, feeQuote: feeQuote == null ? null : feeQuote - baseFee * avgPrice };
  }
  if (exchange === "okx") {
    if (!c.passphrase) throw new Error("Missing OKX passphrase");
    const cid = clientId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    const path = `/api/v5/trade/order?instId=${b}-${q}&clOrdId=${cid}`, ts = new Date().toISOString();
    const headers: Record<string, string> = { "OK-ACCESS-KEY": c.apiKey, "OK-ACCESS-SIGN": b64(await hmac(c.apiSecret, ts + "GET" + path)), "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": c.passphrase };
    if (testnet) headers["x-simulated-trading"] = "1";
    const j = await getJson(`https://www.okx.com${path}`, { headers });
    const o = j.data?.[0];
    if (j.code !== "0" || !o || o.clOrdId !== cid || o.instId !== `${b}-${q}` || o.side !== side) throw new Error("OKX order could not be verified");
    const gross = Number(o.accFillSz), avgPrice = Number(o.avgPx || 0);
    const feesKnown = typeof o.fee === "string" && o.fee !== "" && Number.isFinite(Number(o.fee)) && typeof o.rebate === "string" && o.rebate !== "" && Number.isFinite(Number(o.rebate));
    if (gross > 0 && !feesKnown) throw new Error("Incomplete OKX fee details");
    const fee = -Number(o.fee || 0), rebate = Number(o.rebate || 0);
    const baseFee = (o.feeCcy === b ? fee : 0) - (o.rebateCcy === b ? rebate : 0);
    const valued = (o.feeCcy === b || o.feeCcy === q || fee === 0) && (o.rebateCcy === b || o.rebateCcy === q || rebate === 0);
    return { orderId: String(o.ordId), state: o.state === "filled" ? "filled" : ["canceled", "mmp_canceled"].includes(o.state) ? "cancelled" : "open", qty: side === "buy" ? gross - baseFee : gross + baseFee, avgPrice, quoteValue: gross * avgPrice, feeQuote: valued ? (o.feeCcy === q ? fee : 0) - (o.rebateCcy === q ? rebate : 0) : null };
  }
  throw new Error("Order reconciliation supports Binance and OKX only");
}

const decimals = (step: number) => { const s = step.toString(); return s.includes("e-") ? Number(s.split("e-")[1]) : (s.split(".")[1]?.length ?? 0); };
export const floorToStep = (qty: number, step: number) => { if (!(step > 0)) return qty; const d = decimals(step); return Number((Math.floor(qty / step + 1e-9) * step).toFixed(d)); };

/** Base-quantity step size for the pair, used to round sell quantities down. */
export async function getStepSize(exchange: string, pair: string, testnet: boolean): Promise<number> {
  const { b, q } = split(pair);
  switch (exchange) {
    case "binance": {
      const host = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
      const j = await getJson(`${host}/api/v3/exchangeInfo?symbol=${b}${q}`);
      const f = (j.symbols?.[0]?.filters ?? []).find((x: { filterType: string }) => x.filterType === "LOT_SIZE");
      return Number(f?.stepSize ?? 0);
    }
    case "bybit": {
      const host = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      const j = await getJson(`${host}/v5/market/instruments-info?category=spot&symbol=${b}${q}`);
      return Number(j.result?.list?.[0]?.lotSizeFilter?.basePrecision ?? 0);
    }
    case "okx": {
      const j = await getJson(`https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=${b}-${q}`);
      return Number(j.data?.[0]?.lotSz ?? 0);
    }
    case "kucoin": {
      const j = await getJson(`https://api.kucoin.com/api/v2/symbols/${b}-${q}`);
      return Number(j.data?.baseIncrement ?? 0);
    }
  }
  throw new Error(`Live trading is not supported on ${exchange}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Market order. Buys spend `amount` of the quote currency; sells sell `amount` of the base currency.
 * Returns the net base quantity received (after base-currency fees) for buys.
 */
export async function placeMarketOrder(exchange: string, c: Creds, testnet: boolean, pair: string, side: "buy" | "sell", amount: number, clientId: string): Promise<Fill> {
  const { b, q } = split(pair);
  const amt = side === "buy" ? amount.toFixed(2) : String(amount);
  switch (exchange) {
    case "binance": {
      const host = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
      const qs = new URLSearchParams({ symbol: b + q, side: side.toUpperCase(), type: "MARKET", newOrderRespType: "FULL", newClientOrderId: clientId.slice(0, 36), recvWindow: "10000", timestamp: String(Date.now()) });
      qs.set(side === "buy" ? "quoteOrderQty" : "quantity", amt);
      const s = qs.toString();
      const j = await getJson(`${host}/api/v3/order?${s}&signature=${hex(await hmac(c.apiSecret, s))}`, { method: "POST", headers: { "X-MBX-APIKEY": c.apiKey } });
      const qty = Number(j.executedQty), quote = Number(j.cummulativeQuoteQty);
      if (!(qty > 0)) throw new Error(`Binance order ${j.status}`);
      const avg = quote / qty;
      let baseFee = 0, feeQuote = 0;
      for (const f of (j.fills ?? []) as { commission: string; commissionAsset: string }[]) {
        if (f.commissionAsset === b) { baseFee += +f.commission; feeQuote += +f.commission * avg; } else if (f.commissionAsset === q) feeQuote += +f.commission;
      }
      return { orderId: String(j.orderId), qty: side === "buy" ? qty - baseFee : qty, avgPrice: avg, feeQuote };
    }
    case "bybit": {
      const host = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      const call = async (method: "GET" | "POST", path: string, payload: string) => {
        const ts = String(Date.now()), recv = "10000";
        const headers: Record<string, string> = { "X-BAPI-API-KEY": c.apiKey, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": hex(await hmac(c.apiSecret, ts + c.apiKey + recv + payload)), "Content-Type": "application/json" };
        const j = await getJson(method === "GET" ? `${host}${path}?${payload}` : `${host}${path}`, method === "GET" ? { headers } : { method, headers, body: payload });
        if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
        return j.result;
      };
      const r = await call("POST", "/v5/order/create", JSON.stringify({ category: "spot", symbol: b + q, side: side === "buy" ? "Buy" : "Sell", orderType: "Market", qty: amt, marketUnit: side === "buy" ? "quoteCoin" : "baseCoin", orderLinkId: clientId.slice(0, 36) }));
      for (let i = 0; i < 5; i++) {
        await wait(400);
        const o = (await call("GET", "/v5/order/realtime", `category=spot&orderId=${r.orderId}`)).list?.[0];
        if (o && Number(o.cumExecQty) > 0 && ["Filled", "PartiallyFilledCanceled", "Cancelled"].includes(o.orderStatus)) {
          const qty = +o.cumExecQty, avg = +o.avgPrice || +o.cumExecValue / qty, fee = +o.cumExecFee || 0;
          return { orderId: r.orderId, qty: side === "buy" ? qty - fee : qty, avgPrice: avg, feeQuote: side === "buy" ? fee * avg : fee };
        }
      }
      throw new Error(`Bybit order ${r.orderId} did not fill in time`);
    }
    case "okx":
    case "kucoin": {
      const okx = exchange === "okx";
      if (!c.passphrase) throw new Error(`${okx ? "OKX" : "KuCoin"} requires a passphrase`);
      if (!okx && testnet) throw new Error("KuCoin has no testnet");
      const host = okx ? "https://www.okx.com" : "https://api.kucoin.com";
      const call = async (method: "GET" | "POST", path: string, body = "") => {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (okx) {
          const ts = new Date().toISOString();
          Object.assign(headers, { "OK-ACCESS-KEY": c.apiKey, "OK-ACCESS-SIGN": b64(await hmac(c.apiSecret, ts + method + path + body)), "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": c.passphrase! });
          if (testnet) headers["x-simulated-trading"] = "1";
        } else {
          const ts = String(Date.now());
          Object.assign(headers, { "KC-API-KEY": c.apiKey, "KC-API-TIMESTAMP": ts, "KC-API-KEY-VERSION": "2", "KC-API-SIGN": b64(await hmac(c.apiSecret, ts + method + path + body)), "KC-API-PASSPHRASE": b64(await hmac(c.apiSecret, c.passphrase!)) });
        }
        const j = await getJson(host + path, { method, headers, ...(body ? { body } : {}) });
        if (okx ? j.code !== "0" : j.code !== "200000") throw new Error(`${okx ? "OKX" : "KuCoin"}: ${j.msg || j.data?.[0]?.sMsg}`);
        return j.data;
      };
      const cid = clientId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
      const orderId: string = okx
        ? (await call("POST", "/api/v5/trade/order", JSON.stringify({ instId: `${b}-${q}`, tdMode: "cash", side, ordType: "market", sz: amt, tgtCcy: side === "buy" ? "quote_ccy" : "base_ccy", clOrdId: cid })))[0].ordId
        : (await call("POST", "/api/v1/orders", JSON.stringify({ clientOid: cid, side, symbol: `${b}-${q}`, type: "market", ...(side === "buy" ? { funds: amt } : { size: amt }) }))).orderId;
      for (let i = 0; i < 5; i++) {
        await wait(400);
        if (okx) {
          const o = (await call("GET", `/api/v5/trade/order?instId=${b}-${q}&ordId=${orderId}`))[0];
          if (o && +o.accFillSz > 0 && o.state === "filled") {
            const fee = Math.abs(+o.fee || 0), qty = +o.accFillSz, avg = +o.avgPx;
            const baseFee = o.feeCcy === b ? fee : 0;
            return { orderId, qty: side === "buy" ? qty - baseFee : qty, avgPrice: avg, feeQuote: o.feeCcy === b ? fee * avg : fee };
          }
        } else {
          const o = await call("GET", `/api/v1/orders/${orderId}`);
          if (o && !o.isActive && +o.dealSize > 0) {
            const qty = +o.dealSize, avg = +o.dealFunds / qty, fee = +o.fee || 0;
            return { orderId, qty, avgPrice: avg, feeQuote: o.feeCurrency === b ? fee * avg : fee };
          }
        }
      }
      throw new Error(`Order ${orderId} did not fill in time`);
    }
  }
  throw new Error(`Live trading is not supported on ${exchange}`);
}

// ───────────── OANDA (forex + commodities CFDs). apiKey = token, apiSecret = account ID ─────────────
const oHost = (practice: boolean) => (practice ? "https://api-fxpractice.oanda.com" : "https://api-fxtrade.oanda.com");
const oInst = (pair: string) => pair.toUpperCase().replace("/", "_");
async function oanda(c: Creds, practice: boolean, path: string, init?: RequestInit) {
  return getJson(oHost(practice) + path, { ...init, headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json", "Accept-Datetime-Format": "UNIX" } });
}

export async function oandaCandles(c: Creds, practice: boolean, pair: string, tf: string, count = 300): Promise<Candle[]> {
  const g: Record<string, string> = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D" };
  const j = await oanda(c, practice, `/v3/instruments/${oInst(pair)}/candles?granularity=${g[tf] ?? "H1"}&count=${count}&price=M`);
  return (j.candles as { time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }[]).map((x) => ({
    t: Math.round(Number(x.time) * 1000), o: +x.mid.o, h: +x.mid.h, l: +x.mid.l, c: +x.mid.c, v: x.volume,
  }));
}

export async function oandaSummary(c: Creds, practice: boolean) {
  const j = await oanda(c, practice, `/v3/accounts/${c.apiSecret}/summary`);
  return { balance: +j.account.balance, nav: +j.account.NAV, currency: j.account.currency as string, unrealized: +j.account.unrealizedPL };
}

/** Market order in units (positive buy / negative sell) with broker-side SL/TP. */
export async function oandaMarketOrder(c: Creds, practice: boolean, pair: string, units: number, sl: number | null, tp: number | null) {
  const inst = oInst(pair);
  const meta = await oanda(c, practice, `/v3/accounts/${c.apiSecret}/instruments?instruments=${inst}`);
  const prec = Number(meta.instruments?.[0]?.displayPrecision ?? 5);
  const order: Record<string, unknown> = { type: "MARKET", instrument: inst, units: String(Math.trunc(units)), timeInForce: "FOK", positionFill: "DEFAULT" };
  if (sl != null) order["stopLossOnFill"] = { price: sl.toFixed(prec) };
  if (tp != null) order["takeProfitOnFill"] = { price: tp.toFixed(prec) };
  const j = await oanda(c, practice, `/v3/accounts/${c.apiSecret}/orders`, { method: "POST", body: JSON.stringify({ order }) });
  const fill = j.orderFillTransaction;
  if (!fill?.tradeOpened) throw new Error(`OANDA: ${j.orderCancelTransaction?.reason ?? "order not filled"}`);
  return { tradeId: String(fill.tradeOpened.tradeID), price: +fill.price, units: Math.abs(+fill.tradeOpened.units), orderId: String(fill.orderID ?? fill.id), fee: Math.abs(+(fill.commission ?? 0)) + Math.abs(+(fill.halfSpreadCost ?? 0)) };
}

export async function oandaTrade(c: Creds, practice: boolean, tradeId: string) {
  const j = await oanda(c, practice, `/v3/accounts/${c.apiSecret}/trades/${tradeId}`);
  const t = j.trade;
  return { state: t.state as string, price: +t.price, exit: t.averageClosePrice != null ? +t.averageClosePrice : null, realized: +(t.realizedPL ?? 0), unrealized: +(t.unrealizedPL ?? 0), fees: Math.abs(+(t.financing ?? 0)) };
}

export async function oandaCloseTrade(c: Creds, practice: boolean, tradeId: string) {
  const j = await oanda(c, practice, `/v3/accounts/${c.apiSecret}/trades/${tradeId}/close`, { method: "PUT", body: "{}" });
  const f = j.orderFillTransaction;
  if (!f) throw new Error(`OANDA: ${j.orderCancelTransaction?.reason ?? "close failed"}`);
  return { price: +f.price, realized: +(f.pl ?? 0), fee: Math.abs(+(f.commission ?? 0)) + Math.abs(+(f.financing ?? 0)) };
}
