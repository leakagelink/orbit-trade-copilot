// Phase 4C offline EMA forward evaluation on REAL public Binance USD-M history (credential-free GET klines + funding).
// No orders, AI, credentials, database, scheduler or paper engine. Usage: bun scripts/ema-forward/run.ts
// The candidate, windows, metrics and decision rule are frozen in src/lib/ema-forward-research.ts and their hash is
// checked against docs/phase-4c/ema-forward-spec.json BEFORE any data is fetched. Writes
// docs/evaluation/phase4c-ema-forward-<date>.json (raw result artifact). Phase 4B files are never read or written.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Candle } from "../../src/lib/indicators";
import { aggregate, buyAndHold, D, emaAlwaysIn, H, splitPeriods, type Funding } from "../../src/lib/lowfreq-research";
import { candleHash, EMA_FORWARD_SPEC as S, emaAlwaysInTrades, emaMetrics, emaSpecHash, emaVerdict, rollingWindows, scaleCosts, type EmaMetrics } from "../../src/lib/ema-forward-research";

const frozen = JSON.parse(readFileSync("docs/phase-4c/ema-forward-spec.json", "utf8")) as { specSha256: string; frozenAtUtc: string };
const specHash = await emaSpecHash();
if (specHash !== frozen.specSha256) throw new Error(`spec hash ${specHash} differs from the frozen ${frozen.specSha256}: refusing to run`);

const HOST = "https://fapi.binance.com", CACHE = "/tmp/ema-forward-cache", RUN_AT = Date.now(), H4 = 4 * H;
const END = Math.floor(RUN_AT / H4) * H4; // only fully closed 4h buckets
const W = S.windows;
async function get<T>(url: string): Promise<T> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { method: "GET" });
    if (r.ok) return (await r.json()) as T;
    if ((r.status === 429 || r.status === 418) && k < 5) { await new Promise((ok) => setTimeout(ok, 30_000 * (k + 1))); continue; }
    throw new Error(`${url} ${r.status}`);
  }
}
async function pages<T>(sym: string, kind: string, url: (t: number) => string, next: (page: T[]) => number): Promise<T[]> {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${sym}-${kind}-${END}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as T[];
  const rows: T[] = [];
  for (let t = W.historyRequestStart; t < END;) { const p = await get<T[]>(url(t)); if (!p.length) break; rows.push(...p); t = next(p); }
  writeFileSync(f, JSON.stringify(rows)); return rows;
}
async function klines(sym: string): Promise<Candle[]> {
  const rows = await pages<(string | number)[]>(sym, "klines", (t) => `${HOST}/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${t}&endTime=${END - 1}&limit=1500`, (p) => Number(p.at(-1)![0]) + 1);
  const m = new Map<number, Candle>();
  for (const r of rows) { const t = Number(r[0]); if (t < END && Number(r[6]) < Math.min(END, RUN_AT)) m.set(t, { t, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +r[5]! }); }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
async function fundingHist(sym: string): Promise<Funding[]> {
  type R = { fundingTime: number; fundingRate: string; markPrice?: string };
  const rows = await pages<R>(sym, "funding", (t) => `${HOST}/fapi/v1/fundingRate?symbol=${sym}&startTime=${t}&endTime=${END - 1}&limit=1000`, (p) => p.at(-1)!.fundingTime + 1);
  const m = new Map<number, Funding>();
  for (const r of rows) if (r.fundingTime < END) m.set(r.fundingTime, { t: r.fundingTime, rate: Number(r.fundingRate), mark: r.markPrice && Number(r.markPrice) > 0 ? Number(r.markPrice) : null });
  return [...m.values()].sort((a, b) => a.t - b.t);
}
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const r2 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const brief = (s: EmaMetrics | null) => s && { trades: s.trades, grossExp: r2(s.grossExp), netExp: r2(s.netExp), net: r2(s.net), totalNetReturnPct: r2(s.totalNetReturnPct), profitFactor: r2(s.profitFactor), maxDrawdownRealized: r2(s.maxDrawdown), maxDrawdownMarked: r2(s.maxDrawdownMarked),
  winRatePct: s.winRate === null ? null : r2(s.winRate * 100), avgWin: r2(s.avgWin), avgLoss: r2(s.avgLoss), exposurePct: r2(s.exposurePct), avgHoldHours: r2(s.avgHoldHours), fees: r2(s.fees), spread: r2(s.spread), slippage: r2(s.slippage), funding: r2(s.funding), tStat: r2(s.tStat), dailySharpe: r2(s.dailySharpe) };

const out: Record<string, unknown> = { version: S.version, specSha256: specHash, specFrozenAtUtc: frozen.frozenAtUtc, runAtUtc: iso(RUN_AT), lastClosed4hBarEndUtc: iso(END), source: HOST, symbols: {} as Record<string, unknown> };
for (const sym of S.symbols) {
  const c1 = await klines(sym), fund = await fundingHist(sym), c4 = aggregate(c1, 4);
  const gaps1h = c1.slice(1).map((c, i) => [c1[i]!.t, c.t] as const).filter(([a, b]) => b - a !== H);
  const histFrom = Math.ceil((c1[0]!.t + W.historyWarmupDays * D) / D) * D, histTo = W.historyUnseenEnd;
  const periods = splitPeriods(histFrom, histTo, W.embargoDays * D, [...W.splitFractions]);
  const run = (from: number, to: number, costs = S.costs, fast: number = S.candidate.emaFast, slow: number = S.candidate.emaSlow, cs = c4, tf = H4) => {
    const r = emaAlwaysInTrades(cs, fund, from, to, costs, fast, slow, S.notional, tf);
    return { r, m: from < to && cs.some((c) => c.t >= from && c.t < to) ? emaMetrics(r, from, to, S.notional) : null };
  };
  const full = run(histFrom, histTo), byP = Object.fromEntries(periods.map((p) => [p.name, run(p.from, p.to).m]));
  const wins = rollingWindows(histFrom, histTo, W.walkForwardWindowDays).map((w) => ({ w, m: run(w.from, w.to).m }));
  const traded = wins.filter((x) => x.m && x.m.trades > 0);
  const stress = run(histFrom, histTo, scaleCosts(S.costs, S.stressCostMultiplier)).m;
  const fwdBars = c4.filter((c) => c.t >= W.forwardFrom && c.t + H4 <= END);
  const forward = fwdBars.length ? run(W.forwardFrom, END).m : null;
  // A FORWARD trade only counts when it opened and closed inside the forward window; the final close is the segment end.
  const contaminated = run(W.contaminatedFrom, W.contaminatedTo).m;
  const evidence = { full: full.m, train: byP["train"] ?? null, validation: byP["validation"] ?? null, test: byP["test"] ?? null, windows: { traded: traded.length, positive: traded.filter((x) => x.m!.net > 0).length }, stressFull: stress, forward };
  const verdict = emaVerdict(evidence);
  const bench = (from: number, to: number) => {
    const b = buyAndHold(c1, fund, from, to, S.costs, S.notional);
    return { cash: 0, buyAndHold: b && { net: r2(b.net), gross: r2(b.gross), funding: r2(b.funding), maxDrawdownMarked: r2(b.maxDrawdownMtm) }, emaAlwaysIn1h_50_200: (() => { const s = emaAlwaysIn(c1, fund, from, to, S.costs, 50, 200, S.notional, H); return { trades: s.trades, net: r2(s.net), netExp: r2(s.netExp) }; })() };
  };
  const histSlice = c1.filter((c) => c.t >= histFrom && c.t < histTo), fwdSlice = c1.filter((c) => c.t >= W.forwardFrom && c.t < END);
  (out.symbols as Record<string, unknown>)[sym] = {
    data: { first1h: iso(c1[0]!.t), last1hOpen: iso(c1.at(-1)!.t), bars1h: c1.length, bars4h: c4.length, internalGaps1h: gaps1h.length, gapList: gaps1h.slice(0, 20).map(([a, b]) => `${iso(a)} -> ${iso(b)} (${(b - a) / H - 1} h missing)`), largestGapHours: gaps1h.length ? Math.max(...gaps1h.map(([a, b]) => (b - a) / H - 1)) : 0,
      fundingEvents: fund.length, fundingWithMark: fund.filter((f) => f.mark !== null).length, fundingFirst: fund[0] ? iso(fund[0].t) : null,
      sha256: { historyUnseen1h: await candleHash(histSlice), forward1h: await candleHash(fwdSlice) }, historyUnseenBars1h: histSlice.length, forwardClosed4hBars: fwdBars.length },
    windows: { historyUnseen: { from: iso(histFrom), toExclusive: iso(histTo) }, periods: periods.map((p) => ({ name: p.name, from: iso(p.from), toExclusive: iso(p.to) })), contaminated: { from: iso(W.contaminatedFrom), toExclusive: iso(W.contaminatedTo), note: "Phase 4B window where the candidate was noticed — context only, not evidence" }, forward: { from: iso(W.forwardFrom), toExclusive: iso(END) } },
    historyUnseen: { full: brief(full.m), train: brief(evidence.train), validation: brief(evidence.validation), test: brief(evidence.test), stress2xCosts: brief(stress) },
    walkForward: { windowDays: W.walkForwardWindowDays, windows: wins.length, traded: traded.length, positive: evidence.windows.positive, list: wins.map((x) => ({ from: iso(x.w.from), net: r2(x.m?.net), trades: x.m?.trades ?? 0 })) },
    sensitivityHistoryUnseen: [...S.sensitivity.pairs4h.map(([a, b]) => ({ id: `4h-${a}/${b}`, m: run(histFrom, histTo, S.costs, a, b).m })), { id: "1h-50/200", m: run(histFrom, histTo, S.costs, 50, 200, c1, H).m }].map((x) => ({ id: x.id, trades: x.m?.trades ?? 0, netExp: r2(x.m?.netExp), net: r2(x.m?.net), profitFactor: r2(x.m?.profitFactor) })),
    forward: brief(forward), contaminatedContextOnly: brief(contaminated),
    baselines: { historyUnseen: bench(histFrom, histTo), ...Object.fromEntries(periods.map((p) => [p.name, bench(p.from, p.to)])), contaminated: bench(W.contaminatedFrom, W.contaminatedTo), forward: fwdBars.length ? bench(W.forwardFrom, END) : null },
    verdict,
  };
  console.log(sym, verdict.verdict, Object.fromEntries(Object.entries(verdict.rules).map(([k, v]) => [k, v.pass])), "forward 4h bars", fwdBars.length);
}
const file = `docs/evaluation/phase4c-ema-forward-${iso(RUN_AT).slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(out, null, 1)); console.log("wrote", file);
