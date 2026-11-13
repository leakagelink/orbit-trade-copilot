// One-off: saves a small fixture of PUBLIC Binance USD-M market data (no key, GET-only allowlisted paths) for the
// Phase 4F historical replay test. Raw rows are kept in Binance format (first 7 fields) so the provenance checks run
// on real feed output. Usage: bun scripts/futures-paper/fetch-history-fixture.ts [days=3] [interval=5m]
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { publicFuturesGet, publicSymbolRules } from "../../src/lib/futures-public-market.server";

const DAYS = Number(process.argv[2] ?? 3), INTERVAL = process.argv[3] ?? "5m", TF = { "1m": 60_000, "5m": 300_000, "15m": 900_000 }[INTERVAL]!, D = 86_400_000;
const end = Math.floor(Date.now() / D) * D, start = end - DAYS * D;
async function series(path: string, symbol: string, key: "symbol" | "pair") {
  const out: unknown[][] = []; let from = start;
  while (from < end) {
    const rows = await publicFuturesGet<unknown[][]>(path, { [key]: symbol, interval: INTERVAL, startTime: from, endTime: end - 1, limit: 1500 });
    if (!rows.length) break;
    out.push(...rows.map((r) => r.slice(0, 7))); from = Number(rows.at(-1)![0]) + TF;
  }
  return out;
}
const fixture: Record<string, unknown> = { source: "binance-public-usdm", interval: INTERVAL, start, end, fetchedAt: Date.now(), note: "Public market data for replay tests only. Not verified; not a performance record.", symbols: {} };
for (const s of ["BTCUSDT", "ETHUSDT"]) {
  const rules = await publicSymbolRules(s);
  const [trade, mark, index, funding] = await Promise.all([series("/fapi/v1/klines", s, "symbol"), series("/fapi/v1/markPriceKlines", s, "symbol"), series("/fapi/v1/indexPriceKlines", s, "pair"),
    publicFuturesGet<{ fundingTime: number; fundingRate: string }[]>("/fapi/v1/fundingRate", { symbol: s, startTime: start, endTime: end, limit: 1000 })]);
  (fixture["symbols"] as Record<string, unknown>)[s] = { rules, trade, mark, index, funding: funding.map((f) => ({ fundingTime: f.fundingTime, fundingRate: f.fundingRate })) };
}
const text = JSON.stringify(fixture);
const out = `src/test/fixtures/futures-paper-history-${INTERVAL}.json`;
writeFileSync(out, text);
console.log(out, text.length, "bytes", createHash("sha256").update(text).digest("hex"));
