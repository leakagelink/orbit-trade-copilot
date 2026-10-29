// Exchange adapters: public market data + signed balance reads. Web Crypto only (Workers-safe).
import type { Candle } from "./indicators";

export interface Creds { apiKey: string; apiSecret: string; passphrase?: string }
export interface Balance { asset: string; free: number; locked: number }

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

const TF_MS: Record<string, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
export const timeframeMs = (tf: string) => TF_MS[tf] ?? 3600e3;

/** Returns candles oldest → newest. The last candle may still be forming. */
export async function fetchCandles(exchange: string, pair: string, tf: string, testnet: boolean, limit = 300): Promise<Candle[]> {
  const { b, q } = split(pair);
  const n = (x: unknown) => Number(x);
  switch (exchange) {
    case "binance": {
      const host = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
      const rows = await getJson(`${host}/api/v3/klines?symbol=${b}${q}&interval=${tf}&limit=${limit}`);
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
    const rows = await getJson(`https://api.binance.com/api/v3/klines?symbol=${b}${q}&interval=${tf}&startTime=${from}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows as unknown[][]) out.push({ t: +r[0]!, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +r[5]! });
    from = out[out.length - 1]!.t + tfMs;
    if (rows.length < 1000) break;
  }
  return closed(out);
}

// ───────────── Live order execution (spot, market orders only) ─────────────
export interface Fill { orderId: string; qty: number; avgPrice: number; feeQuote: number }

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
