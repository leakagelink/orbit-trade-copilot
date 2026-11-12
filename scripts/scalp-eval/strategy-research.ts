// Phase 4A offline strategy + model research on REAL public Binance USD-M history (credential-free GET klines and
// funding). No orders, no AI, no credentials. Usage: bun scripts/scalp-eval/strategy-research.ts [days=120]
// Writes docs/evaluation/phase4a-strategy-research-<date>.json. The grid, the folds and the selection rule are fixed
// in code BEFORE any test window is scored; nothing is tuned on test data.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { validateCandles } from "../../src/lib/historical-data";
import type { Candle } from "../../src/lib/indicators";
import { DEFAULT_INTRADAY } from "../../src/lib/scalp-intraday";
import { candlesFor, featuresFor, researchFolds, researchGrid, researchSimulate, roundTripCostPct, tradeStats, variantSignals, walkForwardSelect, SCALP_RESEARCH_VERSION, type ResearchTrade, type Variant } from "../../src/lib/scalp-research";
import { walkForwardModel } from "../../src/lib/scalp-model";
import { scalpSimulate } from "../../src/lib/scalp-intraday";

const DAYS = Number(process.argv[2] ?? 120), SYMBOLS = ["BTCUSDT", "ETHUSDT"], M = 60_000, D = 86_400_000, HOST = "https://fapi.binance.com";
// Stated assumptions (Binance USD-M regular-tier list fees; not verified against an account): taker 0.05%, maker 0.02%.
const COSTS = { takerFeePct: 0.05, makerFeePct: 0.02, spreadPct: 0.01, slippagePct: 0.01 };
const NOTIONAL = 1000;
const FOLDS = { selectionDays: 28, purgeDays: 1, testDays: 7 };
const RULE = { minTrades: 30, minTStat: 2 }; // primary, pre-declared
const end = Math.floor(Date.now() / D) * D, start = end - DAYS * D; // whole UTC days

// Public market-data GETs only; on HTTP 429/418 wait and retry the same read (never applies to orders — there are none).
async function get<T>(url: string): Promise<T> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { method: "GET" });
    if (r.ok) return (await r.json()) as T;
    if ((r.status === 429 || r.status === 418) && k < 5) { await new Promise((ok) => setTimeout(ok, 30_000 * (k + 1))); continue; }
    throw new Error(`${url} ${r.status}`);
  }
}
async function klines(symbol: string): Promise<Candle[]> {
  const cache = `/tmp/scalp-cache/${symbol}-${start}-${end}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const out: Candle[] = []; let from = start;
  while (from < end) {
    const rows = await get<unknown[][]>(`${HOST}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end - 1}&limit=1500`);
    if (!rows.length) break;
    for (const k of rows) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
    from = Number(rows.at(-1)![0]) + M;
  }
  const cs = out.filter((c) => c.t >= start && c.t < end); writeFileSync(cache, JSON.stringify(cs)); return cs;
}
async function funding(symbol: string) {
  const out: { t: number; rate: number }[] = []; let from = start - D;
  while (from < end) {
    const rows = await get<{ fundingTime: number; fundingRate: string }[]>(`${HOST}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${from}&endTime=${end}&limit=1000`);
    if (!rows.length) break; for (const x of rows) out.push({ t: x.fundingTime, rate: Number(x.fundingRate) });
    from = rows.at(-1)!.fundingTime + 1; if (rows.length < 1000) break;
  }
  return out;
}
const r2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const brief = (s: ReturnType<typeof tradeStats>) => ({ trades: s.trades, tradesPerDay: r2(s.tradesPerDay), totalNet: r2(s.totalNet), meanNet: r2(s.meanNet, 4), tStat: r2(s.tStat), winRatePct: r2(s.winRatePct, 1), profitFactor: r2(s.profitFactor, 3), meanGrossBps: r2(s.meanGrossBps), meanCostBps: r2(s.meanCostBps), fees: r2(s.feesTotal), spread: r2(s.spreadTotal), slippage: r2(s.slippageTotal), funding: r2(s.fundingTotal), maxDrawdown: r2(s.maxDrawdown), dailySharpe: r2(s.dailySharpe), markoutBps: Object.fromEntries(Object.entries(s.meanMarkoutBps).map(([k, v]) => [k, r2(v)])) });
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };

const report: Record<string, unknown> = {
  version: SCALP_RESEARCH_VERSION, generatedAt: new Date().toISOString(), source: "Binance USD-M public /fapi/v1/klines (1m) + /fapi/v1/fundingRate, credential-free",
  period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days: DAYS }, costs: COSTS,
  roundTripCostPct: { taker: roundTripCostPct("taker", COSTS), maker: roundTripCostPct("maker", COSTS) }, notionalPerTrade: NOTIONAL,
  folds: FOLDS, selectionRule: RULE, grid: { variants: researchGrid().length, note: "576 pre-declared variants: timeframe 1/5/15m × setups × stop 1/2 ATR × reward 1/2 × hold 10/40 bars × taker/maker × cost-edge filter off/3× × cooldown 0/10 bars" },
  caveats: [
    "Candle-level simulation: no order-book queue position; maker fills require price to trade through the limit and same-candle stops are assumed hit first.",
    "Historical bid/ask spread is not available for these dates (Binance bookTicker archive returned 404), so no spread filter can be evaluated; spread is a fixed assumption.",
    "Fees are list-price assumptions, not account-verified; VIP tiers and BNB discounts are not modelled.",
    "576 variants were searched; the best selection-window result is biased upward by multiple testing, which is why only unseen test windows count.",
    "Factor tables are descriptive over the whole period and were NOT used for selection.",
  ],
  results: {},
};

for (const sym of SYMBOLS) {
  const t0 = Date.now();
  const cs1 = await klines(sym), fund = await funding(sym);
  const v = validateCandles(cs1, { tfMs: M, start, end: end - M });
  const res: Record<string, unknown> = { candles1m: cs1.length, completenessPct: v.coverage.completenessPct, dataOk: v.ok, fundingEvents: fund.length };
  (report.results as Record<string, unknown>)[sym] = res;
  if (!v.ok) { res["skipped"] = "data check failed"; continue; }
  const folds = researchFolds(start, end, FOLDS);
  const byVariant = new Map<string, ResearchTrade[]>(), meta = new Map<string, { v: Variant; signals: number; filled: number; missed: number }>();
  for (const tf of [1, 5, 15] as const) {
    const cs = candlesFor(cs1, tf), f = featuresFor(cs, tf);
    for (const variant of researchGrid().filter((x) => x.tfMin === tf)) {
      const sim = researchSimulate(cs, variantSignals(cs, f, variant, COSTS), variant, COSTS, { baseMs: tf * M, notional: NOTIONAL, funding: fund });
      byVariant.set(variant.id, sim.trades); meta.set(variant.id, { v: variant, signals: sim.signals, filled: sim.makerFilled, missed: sim.makerMissed });
    }
  }
  // 1. Why the four Phase-4 strategies lose: the baseline configuration (taker, no filters) decomposed.
  const baseline: Record<string, unknown> = {};
  for (const tf of [1, 5] as const) {
    const cs = candlesFor(cs1, tf), f = featuresFor(cs, tf);
    const bv: Variant = { id: `baseline-${tf}m`, tfMin: tf, setups: ["breakout", "pullback"], atrStopMult: DEFAULT_INTRADAY.atrStopMult, rewardRisk: DEFAULT_INTRADAY.rewardRisk, maxHoldBars: DEFAULT_INTRADAY.maxHoldBars, mode: "taker", minEdgeCostMultiple: 0, cooldownBars: 0, minRelVolume: DEFAULT_INTRADAY.minRelVolume };
    const sim = researchSimulate(cs, variantSignals(cs, f, bv, COSTS), bv, COSTS, { baseMs: tf * M, notional: NOTIONAL, funding: fund });
    const st = tradeStats(sim.trades, NOTIONAL, start, end);
    const zero = researchSimulate(cs, variantSignals(cs, f, bv, COSTS), bv, { takerFeePct: 0, makerFeePct: 0, spreadPct: 0, slippagePct: 0 }, { baseMs: tf * M, notional: NOTIONAL, funding: fund });
    const meanHold = sim.trades.length ? sim.trades.reduce((a, t) => a + t.holdBars, 0) / sim.trades.length : null;
    const reasons = Object.fromEntries(["stop", "target", "time", "end"].map((k) => [k, sim.trades.filter((t) => t.reason === k).length]));
    // Volume and volatility filter sensitivity on the same baseline (descriptive).
    const sens = [] as unknown[];
    for (const minRelVolume of [1, 1.5, 2.5, 4]) for (const minAtrPct of [0.03, 0.08, 0.15]) {
      const cfgV = { ...bv, minRelVolume };
      const sigs = variantSignals(cs, f, cfgV, COSTS).map((s) => (s && s.features.atrPct! >= minAtrPct ? s : null));
      const s2 = tradeStats(researchSimulate(cs, sigs, cfgV, COSTS, { baseMs: tf * M, notional: NOTIONAL, funding: fund }).trades, NOTIONAL, start, end);
      sens.push({ minRelVolume, minAtrPct, trades: s2.trades, meanNet: r2(s2.meanNet, 4), meanGrossBps: r2(s2.meanGrossBps), meanCostBps: r2(s2.meanCostBps) });
    }
    baseline[`${tf}m`] = { withCosts: brief(st), zeroCosts: brief(tradeStats(zero.trades, NOTIONAL, start, end)), meanHoldBars: r2(meanHold), exitReasons: reasons, fundingShareOfLossPct: st.totalNet < 0 ? r2((st.fundingTotal / st.totalNet) * 100) : null, volumeVolatilitySensitivity: sens };
  }
  res["baselineDecomposition"] = baseline;
  // 2. Factor analysis across the grid (descriptive, full period, not used for selection).
  const rows = [...byVariant].map(([id, trades]) => { const s = tradeStats(trades, NOTIONAL, start, end); return { id, v: meta.get(id)!.v, s, m: meta.get(id)! }; });
  const factor = (name: string, key: (v: Variant) => string) => {
    const groups = new Map<string, typeof rows>(); for (const r of rows) { const k = key(r.v); groups.set(k, [...(groups.get(k) ?? []), r]); }
    return { factor: name, levels: [...groups].map(([level, g]) => ({ level, variants: g.length, positiveVariants: g.filter((r) => r.s.trades >= 30 && r.s.meanNet > 0).length, medianTradesPerDay: r2(median(g.map((r) => r.s.tradesPerDay ?? 0))), medianMeanNetBps: r2(median(g.filter((r) => r.s.trades).map((r) => (r.s.meanNet / NOTIONAL) * 10_000))), medianGrossBps: r2(median(g.filter((r) => r.s.trades).map((r) => r.s.meanGrossBps!))), medianCostBps: r2(median(g.filter((r) => r.s.trades).map((r) => r.s.meanCostBps!))), medianMarkout5Bps: r2(median(g.filter((r) => r.s.meanMarkoutBps[5] !== null).map((r) => r.s.meanMarkoutBps[5]!))) })) };
  };
  res["factors"] = [
    factor("timeframe", (v) => `${v.tfMin}m`), factor("execution", (v) => v.mode), factor("cost-edge filter", (v) => (v.minEdgeCostMultiple ? `target ≥ ${v.minEdgeCostMultiple}× cost` : "off")),
    factor("cooldown (lower frequency)", (v) => `${v.cooldownBars} bars`), factor("holding limit", (v) => `${v.maxHoldBars} bars`), factor("stop", (v) => `${v.atrStopMult}× ATR`),
    factor("reward:risk", (v) => `${v.rewardRisk}`), factor("setups", (v) => v.setups.join("+")),
  ];
  const makers = rows.filter((r) => r.v.mode === "maker" && r.m.filled + r.m.missed > 0);
  res["makerAdverseSelection"] = { medianFillRatePct: r2(median(makers.map((r) => (r.m.filled / (r.m.filled + r.m.missed)) * 100))), medianMakerMarkout5Bps: r2(median(makers.filter((r) => r.s.meanMarkoutBps[5] !== null).map((r) => r.s.meanMarkoutBps[5]!))), medianTakerMarkout5Bps: r2(median(rows.filter((r) => r.v.mode === "taker" && r.s.meanMarkoutBps[5] !== null).map((r) => r.s.meanMarkoutBps[5]!))), note: "Markout = direction-adjusted move from the fill to the close 5 candles later, in basis points (before costs)." };
  const fullPositive = rows.filter((r) => r.s.trades >= 30 && r.s.meanNet > 0).sort((a, b) => b.s.meanNet - a.s.meanNet);
  res["fullPeriodPositiveVariants"] = { count: fullPositive.length, note: "In-sample over the WHOLE period (includes test windows) — shown only to illustrate selection bias; never used.", top5: fullPositive.slice(0, 5).map((r) => ({ id: r.id, ...brief(r.s) })) };
  // 3. Purged walk-forward selection → unseen test windows.
  const evalRule = (rule: typeof RULE) => {
    const choices = walkForwardSelect(byVariant, folds, rule), oos = choices.flatMap((c) => c.test);
    const st = tradeStats(oos, NOTIONAL, folds[0]!.testFrom, folds.at(-1)!.testTo);
    return { rule, folds: choices.map((c) => ({ test: [new Date(c.fold.testFrom).toISOString().slice(0, 10), new Date(c.fold.testTo).toISOString().slice(0, 10)], chosen: c.chosen ?? "NO TRADE", qualifyingVariants: c.candidates, selection: c.selection ? { trades: c.selection.trades, meanNet: r2(c.selection.meanNet, 4), tStat: r2(c.selection.tStat) } : null, testTrades: c.test.length, testNet: r2(c.test.reduce((a, t) => a + t.net, 0)) })), outOfSample: brief(st),
      verdict: st.trades >= 30 && st.meanNet > 0 && (st.tStat ?? 0) >= 2 ? "POSITIVE OUT-OF-SAMPLE EXPECTANCY (still research only)" : "NO TRADE — no positive out-of-sample net expectancy demonstrated" };
  };
  res["walkForward"] = { primary: evalRule(RULE), sensitivityAnyPositive: evalRule({ minTrades: 30, minTStat: 0 }) };
  // 4. Model research on 5m candles: logistic baseline vs pure-TS GBDT, identical purged folds.
  const cs5 = candlesFor(cs1, 5), cfg5 = { ...DEFAULT_INTRADAY, htfMultiple: 3 };
  const simO = { baseMs: 5 * M, costs: { feePct: COSTS.takerFeePct, spreadPct: COSTS.spreadPct, slippagePct: COSTS.slippagePct, maxParticipationPct: null }, notional: NOTIONAL, funding: fund };
  const models: Record<string, unknown> = {};
  for (const kind of ["logistic", "gbdt"] as const) {
    const wf = walkForwardModel(cs5, cfg5, simO, { trainBars: 288 * 28, validationBars: 288 * 7, testBars: 288 * 7, thresholds: [0.5, 0.55, 0.6, 0.65, 0.7], minValidationTrades: 20, model: kind, gbdt: { trees: 150, depth: 3, learningRate: 0.05, minLeaf: 80, l2: 1, bins: 32 } });
    const firstTest = wf.folds[0]?.testRange[0] ?? end;
    const oos = scalpSimulate(cs5, cfg5, { ...simO, tradeFrom: firstTest }, wf.signals);
    const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
    models[kind] = { version: wf.models[0]?.long.version ?? null, folds: wf.folds.length,
      meanAuc: { long: r2(mean(wf.folds.map((f) => f.long?.auc)), 3), short: r2(mean(wf.folds.map((f) => f.short?.auc)), 3) },
      meanBrier: { long: r2(mean(wf.folds.map((f) => f.long?.brier)), 4), short: r2(mean(wf.folds.map((f) => f.short?.brier)), 4) },
      meanBrierBaseline: { long: r2(mean(wf.folds.map((f) => f.long?.brierBaseline)), 4), short: r2(mean(wf.folds.map((f) => f.short?.brierBaseline)), 4) },
      meanEce: { long: r2(mean(wf.folds.map((f) => f.long?.ece)), 4), short: r2(mean(wf.folds.map((f) => f.short?.ece)), 4) },
      foldsWithThreshold: wf.folds.filter((f) => f.threshold !== null).length,
      outOfSample: { trades: oos.trades.length, totalNet: r2(oos.trades.reduce((a, t) => a + t.net, 0)), meanNet: oos.trades.length ? r2(oos.trades.reduce((a, t) => a + t.net, 0) / oos.trades.length, 4) : null } };
  }
  res["models5m"] = models;
  res["runtimeSeconds"] = Math.round((Date.now() - t0) / 1000);
  console.log(sym, JSON.stringify({ wf: (res["walkForward"] as { primary: { outOfSample: unknown; verdict: string } }).primary.verdict, models }).slice(0, 1200));
}
const file = `docs/evaluation/phase4a-strategy-research-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.log("wrote", file);
