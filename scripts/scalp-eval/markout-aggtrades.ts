// Offline adverse-selection / edge study for Engine B ultrafast signals on REAL public Binance USD-M aggTrades
// (data.binance.vision daily archive, credential-free). Measures the average price move after strong aggressive
// trade-flow imbalance, against round-trip taker costs. Order-book features cannot be studied: Binance stopped
// publishing UM bookTicker archives, so spread / imbalance / microprice need a live recorder. No orders, no AI.
// Usage: bun scripts/scalp-eval/markout-aggtrades.ts <SYMBOL> <YYYY-MM-DD>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { markoutBps, tradeFlow, type Trade } from "../../src/lib/scalp-microstructure";

const SYM = process.argv[2] ?? "BTCUSDT", DAY = process.argv[3]!;
const url = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYM}/${SYM}-aggTrades-${DAY}.zip`;
const dir = mkdtempSync("/tmp/aggtrades-");
const res = await fetch(url, { method: "GET" }); if (!res.ok) throw new Error(`download ${res.status}`);
writeFileSync(`${dir}/a.zip`, Buffer.from(await res.arrayBuffer()));
execFileSync("unzip", ["-q", "-o", `${dir}/a.zip`, "-d", dir]);
const csv = readFileSync(`${dir}/${SYM}-aggTrades-${DAY}.csv`, "utf8"); rmSync(dir, { recursive: true, force: true });
// columns: agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
const trades: Trade[] = [];
for (const line of csv.split("\n")) { const p = line.split(","); if (p.length < 7 || p[0] === "agg_trade_id") continue; trades.push({ t: Number(p[5]), price: Number(p[1]), qty: Number(p[2]), buyerAggressor: p[6]!.trim() === "false" }); }
trades.sort((a, b) => a.t - b.t);
// Last trade price at or before t (binary search).
const priceAt = (t: number) => { let lo = 0, hi = trades.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (trades[m]!.t <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans >= 0 ? trades[ans]!.price : null; };
const start = trades[0]!.t, end = trades.at(-1)!.t, out: Record<string, unknown>[] = [];
for (const thr of [0.5, 0.7, 0.9]) {
  const sig: { t: number; side: 1 | -1 }[] = [];
  let lastSig = -Infinity, j = 0;
  for (let t = start + 5_000; t < end - 60_000; t += 1_000) {
    while (j < trades.length && trades[j]!.t <= t) j++;
    const f = tradeFlow(trades.slice(Math.max(0, j - 5_000), j), t, 5_000);
    if (f.trades >= 20 && Math.abs(f.imbalance) >= thr && t - lastSig >= 5_000) { sig.push({ t, side: f.imbalance > 0 ? 1 : -1 }); lastSig = t; }
  }
  const row: Record<string, unknown> = { flowImbalanceThreshold: thr, signals: sig.length };
  for (const h of [1_000, 5_000, 30_000, 60_000]) row[`markout_${h / 1000}s`] = markoutBps(sig, priceAt, h);
  out.push(row);
}
const report = { generatedAt: new Date().toISOString(), source: url, symbol: SYM, day: DAY, trades: trades.length, roundTripTakerCostBps: 12, note: "Mean signed move after the signal in the signal's direction (bps), last-trade prices; positive = edge before costs. Taker round trip ≈ 2×5 bps fee + spread/slippage ≈ 12 bps (assumption).", results: out };
const file = `docs/evaluation/ultrafast-markout-${SYM}-${DAY}.json`; writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(out, null, 1)); console.log("wrote", file);
