// Market-data provenance for the Futures PAPER worker (Phase 4F, workstream E). Pure; no network. The worker's market
// port fetches public, credential-free Binance USD-M klines (trade, mark, index) and funding; this module decides whether
// ONE closed candle per account symbol may be simulated, and records where it came from. It checks source identity,
// symbol, timeframe, open/close timestamps, the closed-candle requirement, duplicates and ordering, stale and future
// timestamps, gaps and malformed rows. It does NOT authenticate prices: a well-formed candle from the public feed is
// still unverified public data, and the database's arithmetic over it (draft 0049) proves internal consistency only.
import type { FPBar } from "./futures-paper-engine";

export const FUTURES_PAPER_DATA_SOURCE = "binance-public-usdm" as const;
export const FP_TIMEFRAMES = { "1m": 60_000, "5m": 300_000, "15m": 900_000 } as const;
export type FPTimeframe = keyof typeof FP_TIMEFRAMES;
export const MARKET_DATA_CODES = [
  "SOURCE_MISMATCH", "SYMBOL_MISMATCH", "TIMEFRAME_MISMATCH", "FETCH_TIME_INVALID", "CANDLE_MALFORMED", "CANDLE_MISALIGNED",
  "CLOSE_TIME_MISMATCH", "CANDLE_OUT_OF_SEQUENCE", "CANDLE_DUPLICATE_CONFLICT", "CANDLE_FUTURE", "CANDLE_NOT_CLOSED",
  "CANDLE_STALE_FEED", "CANDLE_MISSING", "MARK_MISSING", "FUNDING_INVALID", "SYMBOL_SET_MISMATCH",
] as const;
export type MarketDataCode = (typeof MARKET_DATA_CODES)[number];

/** What the market port returns for one symbol (raw Binance rows: [openTime, o, h, l, c, v, closeTime, ...]). */
export interface RawSymbolBundle { source: string; symbol: string; timeframe: string; fetchedAt: number; trade: unknown[]; mark: unknown[]; index: unknown[]; funding: unknown[] }
export interface CandleRequest { symbols: string[]; timeframe: FPTimeframe; barT: number; now: number; closeGraceMs: number; maxFutureSkewMs: number }
export interface CandleProvenance {
  source: typeof FUTURES_PAPER_DATA_SOURCE; symbol: string; timeframe: FPTimeframe; openTime: number; closeTime: number; fetchedAt: number;
  closedAtFetch: true; series: { trade: true; mark: true; index: boolean }; fundingEvents: number; dedupedRows: number;
  verification: "public market data — format, sequence and timing checked; prices NOT independently verified";
}
export type CandleCheck = { ok: true; bars: FPBar[]; provenance: CandleProvenance[] } | { ok: false; code: MarketDataCode; symbol: string | null; detail: string };
interface K { t: number; o: number; h: number; l: number; c: number; v: number; ct: number }

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const n = (x: unknown) => (typeof x === "string" && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(x.trim()) ? Number(x) : typeof x === "number" ? x : NaN);
const bad = (code: MarketDataCode, symbol: string | null, detail: string): CandleCheck => ({ ok: false, code, symbol, detail });

/** Strict kline parsing + sequence rules. Identical duplicate rows are dropped; conflicting duplicates refuse. */
export function parseKlines(rows: unknown[], tfMs: number, kind: string): { ok: true; rows: K[]; deduped: number } | { ok: false; code: MarketDataCode; detail: string } {
  if (!Array.isArray(rows)) return { ok: false, code: "CANDLE_MALFORMED", detail: `${kind}: not an array` };
  const out: K[] = []; let deduped = 0;
  for (const [i, r] of rows.entries()) {
    if (!Array.isArray(r) || r.length < 7) return { ok: false, code: "CANDLE_MALFORMED", detail: `${kind}[${i}]: expected [openTime, o, h, l, c, v, closeTime]` };
    const k: K = { t: n(r[0]), o: n(r[1]), h: n(r[2]), l: n(r[3]), c: n(r[4]), v: n(r[5]), ct: n(r[6]) };
    if (![k.t, k.ct].every((x) => Number.isInteger(x) && x > 0) || ![k.o, k.h, k.l, k.c].every((x) => fin(x) && x > 0) || !(fin(k.v) && k.v >= 0)
      || k.h < Math.max(k.o, k.c) || k.l > Math.min(k.o, k.c)) return { ok: false, code: "CANDLE_MALFORMED", detail: `${kind}[${i}]: non-numeric, non-positive or inconsistent OHLC` };
    if (k.t % tfMs !== 0) return { ok: false, code: "CANDLE_MISALIGNED", detail: `${kind}[${i}]: open time ${k.t} is not aligned to ${tfMs} ms` };
    if (k.ct !== k.t + tfMs - 1) return { ok: false, code: "CLOSE_TIME_MISMATCH", detail: `${kind}[${i}]: close time ${k.ct} ≠ open + timeframe − 1` };
    const last = out.at(-1);
    if (last && k.t < last.t) return { ok: false, code: "CANDLE_OUT_OF_SEQUENCE", detail: `${kind}[${i}]: ${k.t} after ${last.t}` };
    if (last && k.t === last.t) {
      if (k.o === last.o && k.h === last.h && k.l === last.l && k.c === last.c && k.v === last.v) { deduped++; continue; }
      return { ok: false, code: "CANDLE_DUPLICATE_CONFLICT", detail: `${kind}: two different candles for ${k.t}` };
    }
    out.push(k);
  }
  return { ok: true, rows: out, deduped };
}

/** One closed candle for every account symbol at `req.barT`, or the first problem found (nothing is ever forward-filled). */
export function selectClosedCandles(bundles: RawSymbolBundle[], req: CandleRequest): CandleCheck {
  const tf = FP_TIMEFRAMES[req.timeframe];
  if (!tf || !Number.isInteger(req.barT) || req.barT % tf !== 0 || !fin(req.now)) return bad("TIMEFRAME_MISMATCH", null, "request timeframe or candle time is invalid");
  const got = bundles.map((b) => b?.symbol).sort(), want = [...req.symbols].sort();
  if (got.length !== want.length || got.some((s, i) => s !== want[i])) return bad("SYMBOL_SET_MISMATCH", null, `expected ${want.join(",")}, got ${got.join(",")}`);
  const bars: FPBar[] = [], provenance: CandleProvenance[] = [];
  for (const b of bundles) {
    const sym = b.symbol;
    if (b.source !== FUTURES_PAPER_DATA_SOURCE) return bad("SOURCE_MISMATCH", sym, `source ${String(b.source)} is not ${FUTURES_PAPER_DATA_SOURCE}`);
    if (b.timeframe !== req.timeframe) return bad("TIMEFRAME_MISMATCH", sym, `timeframe ${String(b.timeframe)} ≠ ${req.timeframe}`);
    if (!Number.isInteger(b.fetchedAt) || b.fetchedAt > req.now + req.maxFutureSkewMs) return bad("FETCH_TIME_INVALID", sym, "fetch time missing or in the future");
    const series: Record<"trade" | "mark" | "index", K | null> = { trade: null, mark: null, index: null }; let deduped = 0;
    for (const kind of ["trade", "mark", "index"] as const) {
      const p = parseKlines(b[kind], tf, `${sym} ${kind}`);
      if (!p.ok) return bad(p.code, sym, p.detail);
      deduped += p.deduped;
      if (p.rows.some((k) => k.t > req.now + req.maxFutureSkewMs)) return bad("CANDLE_FUTURE", sym, `${kind} has a candle opening in the future`);
      const hit = p.rows.find((k) => k.t === req.barT) ?? null;
      if (!hit) {
        if (kind === "index") continue; // the engine and 0049 refuse NEW entries without an index; exits still run
        const newest = p.rows.at(-1)?.t;
        if (newest === undefined || newest < req.barT) return bad(kind === "mark" ? "MARK_MISSING" : "CANDLE_STALE_FEED", sym, `${kind}: newest candle ${newest ?? "none"} is before ${req.barT}`);
        return bad(kind === "mark" ? "MARK_MISSING" : "CANDLE_MISSING", sym, `${kind}: no candle at ${req.barT} (gap)`);
      }
      if (hit.ct >= b.fetchedAt || hit.ct + 1 + req.closeGraceMs > req.now) return bad("CANDLE_NOT_CLOSED", sym, `${kind} candle ${req.barT} was not closed when fetched`);
      series[kind] = hit;
    }
    const fund: { t: number; rate: number }[] = [];
    if (!Array.isArray(b.funding)) return bad("FUNDING_INVALID", sym, "funding is not an array");
    for (const f of b.funding) {
      const x = f as { fundingTime?: unknown; fundingRate?: unknown };
      const ft = n(x?.fundingTime), rate = n(x?.fundingRate);
      if (!Number.isInteger(ft) || !fin(rate) || Math.abs(rate) > 0.05) return bad("FUNDING_INVALID", sym, "funding entry is malformed or out of range");
      if (ft < req.barT || ft >= req.barT + tf) continue;
      const dup = fund.find((y) => y.t === ft);
      if (dup) { if (dup.rate !== rate) return bad("FUNDING_INVALID", sym, `two different funding rates at ${ft}`); continue; }
      fund.push({ t: ft, rate });
    }
    const tr = series.trade!, mk = series.mark!, ix = series.index;
    bars.push({ symbol: sym, t: req.barT, tfMs: tf, trade: { o: tr.o, h: tr.h, l: tr.l, c: tr.c, v: tr.v }, mark: { o: mk.o, h: mk.h, l: mk.l, c: mk.c }, index: ix ? { c: ix.c } : null, funding: fund.sort((a, c) => a.t - c.t) });
    provenance.push({ source: FUTURES_PAPER_DATA_SOURCE, symbol: sym, timeframe: req.timeframe, openTime: req.barT, closeTime: tr.ct, fetchedAt: b.fetchedAt, closedAtFetch: true, series: { trade: true, mark: true, index: !!ix }, fundingEvents: fund.length, dedupedRows: deduped, verification: "public market data — format, sequence and timing checked; prices NOT independently verified" });
  }
  return { ok: true, bars: bars.sort((a, c) => (a.symbol < c.symbol ? -1 : 1)), provenance };
}
