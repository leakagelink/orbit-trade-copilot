// Phase 4B offline lower-frequency research on REAL public Binance USD-M history (credential-free GET klines and
// funding). No orders, no AI, no credentials, no database. Usage: bun scripts/lowfreq-eval/run.ts
// Writes docs/evaluation/phase4b-lowfreq-research-<date>.json. Grid, split and selection rule are fixed in
// src/lib/lowfreq-research.ts BEFORE any period is scored; the locked test is scored only for validation survivors.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Candle } from "../../src/lib/indicators";
import { aggregate, buyAndHold, D, emaAlwaysIn, features, H, leakageCheck, LOWFREQ_RESEARCH_VERSION, lowfreqGrid, maxHoldMs, neighbours, RULE, selectCandidates, simulate, splitPeriods, stats, walkForward, type Costs, type Features, type Funding, type LFTrade, type Stats } from "../../src/lib/lowfreq-research";

const HOST = "https://fapi.binance.com", CACHE = "/tmp/lowfreq-cache", SYMBOLS = ["BTCUSDT", "ETHUSDT"];
// Stated assumptions (Binance USD-M regular-tier list fees; NOT verified against an account). No historical bid/ask data
// exists here, so spread is an assumption too.
const COSTS: Costs = { takerFeePct: 0.05, makerFeePct: 0.02, spreadPct: 0.01, slippagePct: 0.01 };
const NOTIONAL = 1000, GAP = 14 * D;
const END = Math.floor(Date.now() / D) * D, START = END - 3 * 365 * D;

async function get<T>(url: string): Promise<T> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { method: "GET" });
    if (r.ok) return (await r.json()) as T;
    if ((r.status === 429 || r.status === 418) && k < 5) { await new Promise((ok) => setTimeout(ok, 30_000 * (k + 1))); continue; }
    throw new Error(`${url} ${r.status}`);
  }
}
function cached(sym: string, kind: string): unknown[] {
  if (!existsSync(CACHE)) return [];
  return readdirSync(CACHE).filter((f) => f.startsWith(`${sym}-${kind}-`)).flatMap((f) => JSON.parse(readFileSync(`${CACHE}/${f}`, "utf8")) as unknown[]);
}
async function klines(sym: string): Promise<Candle[]> {
  let rows = cached(sym, "klines") as (string | number)[][];
  const have = new Set(rows.map((r) => Number(r[0])));
  if (!have.has(START) || !have.has(END - H)) {
    rows = []; mkdirSync(CACHE, { recursive: true });
    for (let t = START; t < END;) {
      const page = await get<(string | number)[][]>(`${HOST}/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${t}&endTime=${END - 1}&limit=1500`);
      if (!page.length) break; rows.push(...page); writeFileSync(`${CACHE}/${sym}-klines-${t}-${END}.json`, JSON.stringify(page));
      t = Number(page.at(-1)![0]) + 1;
    }
  }
  const m = new Map<number, Candle>();
  for (const r of rows) { const t = Number(r[0]); if (t >= START && t < END && Number(r[6]) < END) m.set(t, { t, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +r[5]! }); }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
async function fundingHist(sym: string): Promise<Funding[]> {
  let rows = cached(sym, "fundingRate") as { fundingTime: number; fundingRate: string; markPrice?: string }[];
  if (!rows.length) {
    mkdirSync(CACHE, { recursive: true });
    for (let t = START; t < END;) {
      const page = await get<typeof rows>(`${HOST}/fapi/v1/fundingRate?symbol=${sym}&startTime=${t}&endTime=${END - 1}&limit=1000`);
      if (!page.length) break; rows.push(...page); writeFileSync(`${CACHE}/${sym}-fundingRate-${t}-${END}.json`, JSON.stringify(page));
      t = page.at(-1)!.fundingTime + 1;
    }
  }
  const m = new Map<number, Funding>();
  for (const r of rows) if (r.fundingTime >= START && r.fundingTime < END) m.set(r.fundingTime, { t: r.fundingTime, rate: Number(r.fundingRate), mark: r.markPrice && Number(r.markPrice) > 0 ? Number(r.markPrice) : null });
  return [...m.values()].sort((a, b) => a.t - b.t);
}
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const brief = (s: Stats | null | undefined) => s && { trades: s.trades, grossExp: r2(s.grossExp), netExp: r2(s.netExp), netExpPct: s.netExpPct === 0 ? 0 : Math.round(s.netExpPct * 1000) / 1000, net: r2(s.net), fees: r2(s.fees), spread: r2(s.spread), slippage: r2(s.slippage), funding: r2(s.funding), winRate: s.winRate === null ? null : Math.round(s.winRate * 1000) / 10, profitFactor: r2(s.profitFactor), maxDrawdownRealized: r2(s.maxDrawdown), dailySharpe: r2(s.dailySharpe), tStat: r2(s.tStat) };

const grid = lowfreqGrid();
const out: Record<string, unknown> = { version: LOWFREQ_RESEARCH_VERSION, generatedAt: new Date().toISOString(), costs: COSTS, notionalPerTrade: NOTIONAL, gapDays: GAP / D, maxHoldDays: maxHoldMs(grid) / D, rule: RULE, gridSize: grid.length, symbols: {} as Record<string, unknown> };
for (const sym of SYMBOLS) {
  const c1 = await klines(sym), fund = await fundingHist(sym), c4 = aggregate(c1, 4);
  const gaps = c1.slice(1).filter((c, i) => c.t - c1[i]!.t !== H).length;
  const fGaps = fund.slice(1).filter((f, i) => f.t - fund[i]!.t > 8.5 * H).length;
  const periods = splitPeriods(START, END, GAP);
  const [train, val, test] = periods as [typeof periods[0], typeof periods[0], typeof periods[0]];
  const fcache = new Map<string, Features>(), trades = new Map<string, LFTrade[]>(), extra = new Map<string, { signals: number; makerMissed: number }>();
  for (const v of grid) {
    const cs = v.tfH === 1 ? c1 : c4, key = `${v.tfH}-${v.family}-${v.p1}-${v.p2}`;
    if (!fcache.has(key)) fcache.set(key, features(cs, v.tfH * H, v, fund));
    const r = simulate(cs, fcache.get(key)!, v, fund, COSTS, NOTIONAL);
    trades.set(v.id, r.trades); extra.set(v.id, { signals: r.signals, makerMissed: r.makerMissed });
  }
  const trS = new Map(grid.map((v) => [v.id, stats(trades.get(v.id)!, train.from, train.to, NOTIONAL)]));
  const vaS = new Map(grid.map((v) => [v.id, stats(trades.get(v.id)!, val.from, val.to, NOTIONAL)]));
  const sel = selectCandidates(trS, vaS);
  const locked = sel.validationPass.map((id) => ({ id, train: brief(trS.get(id)), validation: brief(vaS.get(id)), test: brief(stats(trades.get(id)!, test.from, test.to, NOTIONAL)) }));
  const verdictCands = locked.filter((x) => x.test!.trades >= RULE.testMinTrades && x.test!.netExp! > 0);
  // Diagnostics only (never used for selection): the best-train variant by t-stat with the trade floor.
  const bestTrain = [...trS].filter(([, s]) => s.trades >= RULE.trainMinTrades).sort((a, b) => (b[1].tStat ?? -99) - (a[1].tStat ?? -99))[0];
  const bt = bestTrain && grid.find((v) => v.id === bestTrain[0])!;
  const wf = walkForward(trades, train.from, val.to, GAP);
  // Maker vs taker twins (train period).
  const twins = grid.filter((v) => v.mode === "maker").map((m) => { const t = grid.find((x) => x.id === m.id.replace(/-maker$/, "-taker"))!; return { m: trS.get(m.id)!, t: trS.get(t.id)!, ex: extra.get(m.id)!, mt: trades.get(m.id)!.filter((x) => x.entryT >= train.from && x.entryT < train.to), tt: trades.get(t.id)!.filter((x) => x.entryT >= train.from && x.entryT < train.to) }; });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const makerVsTaker = {
    twinPairs: twins.length, makerBetterNetExpPairs: twins.filter((p) => p.m.trades && p.t.trades && p.m.netExp > p.t.netExp).length,
    makerFillRatePct: r2(100 * twins.reduce((a, p) => a + p.ex.signals - p.ex.makerMissed, 0) / Math.max(1, twins.reduce((a, p) => a + p.ex.signals, 0))),
    avgMarkout4BarsBps: { maker: r2(avg(twins.flatMap((p) => p.mt.map((x) => x.markout4Bps).filter((x): x is number => x !== null)))), taker: r2(avg(twins.flatMap((p) => p.tt.map((x) => x.markout4Bps).filter((x): x is number => x !== null)))) },
    makerStoppedOnFillBarPct: r2(100 * twins.reduce((a, p) => a + p.mt.filter((x) => x.holdBars === 1 && x.reason === "stop").length, 0) / Math.max(1, twins.reduce((a, p) => a + p.mt.length, 0))),
  };
  const sample = grid.filter((_, i) => i % 37 === 0);
  const leak = sample.map((v) => { const cs = v.tfH === 1 ? c1 : c4; const n = cs.length; return { id: v.id, ...leakageCheck(cs, v.tfH * H, v, fund, [Math.floor(n * 0.3), Math.floor(n * 0.6), n - 2]) }; });
  const bench = Object.fromEntries(periods.map((p) => [p.name, {
    buyAndHold: (() => { const b = buyAndHold(c1, fund, p.from, p.to, COSTS, NOTIONAL); return b && { net: r2(b.net), gross: r2(b.gross), funding: r2(b.funding), maxDrawdownMtm: r2(b.maxDrawdownMtm) }; })(),
    emaAlwaysIn1h_50_200: brief(emaAlwaysIn(c1, fund, p.from, p.to, COSTS, 50, 200, NOTIONAL, H)),
    emaAlwaysIn4h_50_200: brief(emaAlwaysIn(c4, fund, p.from, p.to, COSTS, 50, 200, NOTIONAL, 4 * H)),
  }]));
  const positiveTrain = [...trS.values()].filter((s) => s.trades >= RULE.trainMinTrades && s.netExp > 0).length;
  (out.symbols as Record<string, unknown>)[sym] = {
    data: { from: iso(c1[0]!.t), toExclusive: iso(c1.at(-1)!.t + H), bars1h: c1.length, bars4h: c4.length, internalGaps1h: gaps, fundingEvents: fund.length, fundingGapsOver8_5h: fGaps, fundingWithMark: fund.filter((f) => f.mark !== null).length },
    periods: periods.map((p) => ({ name: p.name, from: iso(p.from), toExclusive: iso(p.to) })),
    trainPositiveNetWithFloor: positiveTrain, trainPassCount: sel.trainPass.length, checkedOnValidation: sel.checked.map((id) => ({ id, train: brief(trS.get(id)), validation: brief(vaS.get(id)) })),
    validationPassCount: sel.validationPass.length, lockedTest: locked,
    verdict: verdictCands.length ? "CANDIDATE (historical only — not viable without forward paper evidence)" : "NO TRADE",
    diagnosticBestTrain: bt && { id: bt.id, note: "Diagnostic only; it did not pass the selection rule unless listed above, and its test numbers drove nothing.", train: brief(trS.get(bt.id)), validation: brief(vaS.get(bt.id)), test: brief(stats(trades.get(bt.id)!, test.from, test.to, NOTIONAL)),
      neighboursTrain: neighbours(bt, grid).map((n) => ({ id: n.id, netExp: r2(trS.get(n.id)!.netExp), trades: trS.get(n.id)!.trades, tStat: r2(trS.get(n.id)!.tStat) })) },
    walkForward: { selectDays: 180, embargoDays: GAP / D, testDays: 60, folds: wf.folds.length, foldsTraded: wf.foldsTraded, positiveFolds: wf.positiveFolds, pooledOosTrades: wf.pooledOosTrades, pooledOosNet: r2(wf.pooledOosNet), chosen: wf.folds.map((f) => ({ test: `${iso(f.testFrom)}..${iso(f.testTo)}`, chosen: f.chosen, oosNet: r2(f.oos?.net ?? null), oosTrades: f.oos?.trades ?? 0 })) },
    makerVsTaker, leakageChecks: { sampled: leak.length, allOk: leak.every((l) => l.ok) }, benchmarks: bench,
  };
  console.log(sym, JSON.stringify({ trainPass: sel.trainPass.length, validationPass: sel.validationPass.length, verdict: verdictCands.length ? "CANDIDATE" : "NO TRADE", positiveTrain, wf: { folds: wf.folds.length, traded: wf.foldsTraded, pos: wf.positiveFolds, net: r2(wf.pooledOosNet) } }));
}
const file = `docs/evaluation/phase4b-lowfreq-research-${iso(END)}.json`;
writeFileSync(file, JSON.stringify(out, null, 1)); console.log("wrote", file);
