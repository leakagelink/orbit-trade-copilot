// Offline evaluation of Engine B's 1–5 minute scalping strategy and its walk-forward logistic model on REAL public
// Binance USD-M Futures history (credential-free GET: /fapi/v1/klines and /fapi/v1/fundingRate). No orders, no AI.
// Usage: bun scripts/scalp-eval/evaluate-intraday.ts [days=60] [symbols=BTCUSDT,ETHUSDT]
// Writes docs/evaluation/intraday-scalp-<date>.json. Parameters are the fixed defaults — nothing is tuned on test data.
import { writeFileSync } from "node:fs";
import { validateCandles } from "../../src/lib/historical-data";
import { aggregateCandles, DEFAULT_INTRADAY, scalpSimulate, type IntradayConfig, type ScalpTrade } from "../../src/lib/scalp-intraday";
import { walkForwardModel } from "../../src/lib/scalp-model";
import { performanceMetrics } from "../../src/lib/backtest-metrics";
import { chronologicalSplit } from "../../src/lib/backtest-splits";
import type { Candle } from "../../src/lib/indicators";

const DAYS = Number(process.argv[2] ?? 60), SYMBOLS = (process.argv[3] ?? "BTCUSDT,ETHUSDT").split(",");
const M = 60_000, HOST = "https://fapi.binance.com";
// Cost assumptions (stated, not verified against an account): taker fee 0.05%/side, spread 0.01%, slippage 0.01%/side.
const COSTS = { feePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null };
const NOTIONAL = 1000;
const end = Math.floor(Date.now() / M) * M - M, start = end - DAYS * 86_400_000;

async function klines(symbol: string): Promise<Candle[]> {
  const out: Candle[] = []; let from = start;
  while (from < end) {
    const r = await fetch(`${HOST}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end - 1}&limit=1500`, { method: "GET" });
    if (!r.ok) throw new Error(`klines ${r.status}`);
    const rows = (await r.json()) as unknown[][]; if (!rows.length) break;
    for (const k of rows) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
    from = Number(rows.at(-1)![0]) + M;
  }
  return out.filter((c) => c.t >= start && c.t < end);
}
async function funding(symbol: string) {
  const out: { t: number; rate: number }[] = []; let from = start - 86_400_000;
  while (from < end) {
    const r = await fetch(`${HOST}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${from}&endTime=${end}&limit=1000`, { method: "GET" });
    if (!r.ok) throw new Error(`funding ${r.status}`);
    const rows = (await r.json()) as { fundingTime: number; fundingRate: string }[]; if (!rows.length) break;
    for (const x of rows) out.push({ t: x.fundingTime, rate: Number(x.fundingRate) });
    from = rows.at(-1)!.fundingTime + 1; if (rows.length < 1000) break;
  }
  return out;
}
const metrics = (trades: ScalpTrade[], from: number, tfMs: number) => {
  let eq = NOTIONAL; const curve = [{ t: from, v: eq }];
  for (const t of trades) { eq += t.net; curve.push({ t: t.exitT, v: eq }); }
  // performanceMetrics annualizes per-curve-point returns as if they were per-bar; this curve has one point per TRADE,
  // so that Sharpe is not meaningful. Replace it with a Sharpe computed from daily net P&L (zero-trade days included).
  const { sharpe: _perTradeSharpe, ...m } = performanceMetrics(trades, curve, NOTIONAL, tfMs); void _perTradeSharpe;
  const last = trades.at(-1)?.exitT ?? from, days = Math.max(1, Math.ceil((last - from) / 86_400_000)), daily = new Array(days).fill(0);
  for (const t of trades) { const d = Math.floor((t.exitT - from) / 86_400_000); if (d >= 0 && d < days) daily[d] += t.net; }
  const dm = daily.reduce((a, x) => a + x, 0) / days, dsd = Math.sqrt(daily.reduce((a, x) => a + (x - dm) ** 2, 0) / Math.max(1, days - 1));
  const dailySharpe = dsd > 0 ? (dm / dsd) * Math.sqrt(365) : null;
  const by = (k: "LONG" | "SHORT") => trades.filter((t) => t.side === k).length;
  return { ...m, dailySharpe, longs: by("LONG"), shorts: by("SHORT"), grossBeforeCosts: trades.reduce((a, t) => a + t.pnl + t.spread + t.slippage, 0) };
};

function evaluateRules(cs: Candle[], tfMs: number, cfg: IntradayConfig, fund: { t: number; rate: number }[]) {
  const segs = chronologicalSplit(cs, { trainPct: 60, validationPct: 20, purgeBars: cfg.maxHoldBars + 2, embargoBars: 2 });
  return Object.fromEntries(segs.map((s) => {
    const r = scalpSimulate(cs.slice(0, s.endIdx + 1), cfg, { baseMs: tfMs, costs: COSTS, notional: NOTIONAL, funding: fund, tradeFrom: s.startT, tradeTo: s.endT });
    return [s.name, { from: new Date(s.startT).toISOString(), to: new Date(s.endT).toISOString(), ...metrics(r.trades, s.startT, tfMs) }];
  }));
}

const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), source: "Binance USD-M public /fapi/v1/klines + /fapi/v1/fundingRate (credential-free)", period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days: DAYS }, costs: COSTS, notionalPerTrade: NOTIONAL, config: DEFAULT_INTRADAY, note: "Fixed default parameters; no tuning on test data. Candle-level simulation (no order-book queue); historical results do not predict future profit.", results: {} };
for (const sym of SYMBOLS) {
  const cs1 = await klines(sym), fund = await funding(sym);
  const v = validateCandles(cs1, { tfMs: M, start, end: end - M });
  const res: Record<string, unknown> = { candles1m: cs1.length, dataCheck: { ok: v.ok, completenessPct: v.coverage.completenessPct, issues: v.issues.slice(0, 5) }, fundingEvents: fund.length };
  if (!v.ok) { res["skipped"] = "Data check failed: nothing simulated"; (report.results as Record<string, unknown>)[sym] = res; continue; }
  const cs5 = aggregateCandles(cs1, M, 5);
  res["rules_1m"] = evaluateRules(cs1, M, DEFAULT_INTRADAY, fund);
  res["rules_5m"] = evaluateRules(cs5, 5 * M, { ...DEFAULT_INTRADAY, htfMultiple: 3 }, fund);
  const sim = { baseMs: 5 * M, costs: COSTS, notional: NOTIONAL, funding: fund };
  const wf = walkForwardModel(cs5, { ...DEFAULT_INTRADAY, htfMultiple: 3 }, sim, { trainBars: 288 * 21, validationBars: 288 * 7, testBars: 288 * 7, thresholds: [0.5, 0.55, 0.6, 0.65, 0.7], minValidationTrades: 20 });
  const firstTest = wf.folds[0]?.testRange[0] ?? end;
  const oos = scalpSimulate(cs5, { ...DEFAULT_INTRADAY, htfMultiple: 3 }, { ...sim, tradeFrom: firstTest }, wf.signals);
  res["model_5m_walkforward"] = {
    featureVersion: wf.featureVersion, modelVersion: wf.models[0]?.long.version ?? null, folds: wf.folds.map((f) => ({ test: [new Date(f.testRange[0]).toISOString(), new Date(f.testRange[1]).toISOString()], threshold: f.threshold, signals: f.signals,
      longAuc: f.long?.auc ?? null, longBrier: f.long?.brier ?? null, longBrierBaseline: f.long?.brierBaseline ?? null, longEce: f.long?.ece ?? null, shortAuc: f.short?.auc ?? null, shortBrier: f.short?.brier ?? null, shortBrierBaseline: f.short?.brierBaseline ?? null })),
    outOfSample: metrics(oos.trades, firstTest, 5 * M),
  };
  (report.results as Record<string, unknown>)[sym] = res;
  console.log(sym, JSON.stringify({ rules1mTest: (res["rules_1m"] as Record<string, Record<string, unknown>>)["test"], rules5mTest: (res["rules_5m"] as Record<string, Record<string, unknown>>)["test"], model: (res["model_5m_walkforward"] as Record<string, unknown>)["outOfSample"] }).slice(0, 1500));
}
const file = `docs/evaluation/intraday-scalp-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.log("wrote", file);
