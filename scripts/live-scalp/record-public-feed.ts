// Records a short window of PUBLIC, credential-free Binance USD-M market data (BTCUSDT, ETHUSDT) as deterministic test
// fixtures: raw WebSocket messages with local receive times, plus REST depth snapshots taken while the diff stream is
// buffering, recent klines, premium index, funding and exchange filters. No API key, no signed request, no order.
// Usage: bun scripts/live-scalp/record-public-feed.ts <seconds> <outFile>
import { writeFileSync } from "node:fs";
const SECONDS = Number(process.argv[2] ?? 30), OUT = process.argv[3] ?? "src/test/fixtures/binance-usdm/recorded-feed.json";
const SYMS = ["BTCUSDT", "ETHUSDT"], REST = "https://fapi.binance.com";
const lc = SYMS.map((s) => s.toLowerCase());
const MARKET = `wss://fstream.binance.com/market/stream?streams=${lc.flatMap((s) => [`${s}@aggTrade`, `${s}@markPrice@1s`, `${s}@kline_1m`, `${s}@kline_5m`]).join("/")}`;
const PUBLIC = `wss://fstream.binance.com/public/stream?streams=${lc.flatMap((s) => [`${s}@depth@100ms`, `${s}@bookTicker`]).join("/")}`;
const msgs: { r: number; d: unknown }[] = []; let bookTickerSeen = 0, bookTickerKept = 0;
const get = async (p: string) => { const r = await fetch(REST + p); if (!r.ok) throw new Error(`${p} ${r.status}`); return { weight: r.headers.get("x-mbx-used-weight-1m"), body: await r.json() }; };
const open = (u: string) => new Promise<WebSocket>((res, rej) => { const ws = new WebSocket(u); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error("ws error")); ws.onmessage = (e) => {
  const d = JSON.parse(String(e.data)) as { stream: string };
  if (d.stream.endsWith("@bookTicker")) { bookTickerSeen++; if (bookTickerSeen % 25 !== 1) return; bookTickerKept++; } // thinned: every 25th
  msgs.push({ r: Date.now(), d });
}; });
const t0 = Date.now(), serverTime = await get("/fapi/v1/time");
const [a, b] = await Promise.all([open(MARKET), open(PUBLIC)]);
await new Promise((r) => setTimeout(r, 1500)); // let depth diffs buffer before the snapshots
const snapshots: Record<string, unknown> = {};
for (const s of SYMS) snapshots[s] = { r: Date.now(), ...(await get(`/fapi/v1/depth?symbol=${s}&limit=1000`)) };
await new Promise((r) => setTimeout(r, SECONDS * 1000));
a.close(); b.close();
const rest: Record<string, unknown> = {};
for (const s of SYMS) rest[s] = {
  klines1m: (await get(`/fapi/v1/klines?symbol=${s}&interval=1m&limit=200`)).body, klines5m: (await get(`/fapi/v1/klines?symbol=${s}&interval=5m&limit=200`)).body,
  premiumIndex: (await get(`/fapi/v1/premiumIndex?symbol=${s}`)).body, fundingRate: (await get(`/fapi/v1/fundingRate?symbol=${s}&limit=10`)).body,
};
const ex = (await get("/fapi/v1/exchangeInfo")).body as { symbols: { symbol: string }[]; rateLimits: unknown };
writeFileSync(OUT, JSON.stringify({
  source: "binance-public-usdm", recordedAt: new Date(t0).toISOString(), seconds: SECONDS, endpoints: { market: MARKET, public: PUBLIC, rest: REST },
  note: "Public market data only. bookTicker thinned to every 25th message; all other stream messages complete for the window.",
  serverTime: { localAt: t0, ...serverTime }, bookTicker: { seen: bookTickerSeen, kept: bookTickerKept },
  snapshots, rest, exchangeInfo: { rateLimits: ex.rateLimits, symbols: ex.symbols.filter((x) => SYMS.includes(x.symbol)) }, messages: msgs,
}));
console.log(`recorded ${msgs.length} messages (${bookTickerSeen} bookTicker seen, ${bookTickerKept} kept) in ${SECONDS}s → ${OUT}`);
process.exit(0);
