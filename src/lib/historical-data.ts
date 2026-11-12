// Pure historical market-data integrity checks, point-in-time filters and a hashed data manifest.
// Fails closed: any duplicate, gap, invalid price/volume or uncovered part of the requested range is an issue.
import type { Candle } from "./indicators";
import { evidenceHash } from "./evidence-hash";

export type DataIssueKind = "invalid_price" | "invalid_volume" | "impossible_range" | "misaligned" | "duplicate" | "out_of_order" | "missing" | "coverage_start" | "coverage_end" | "too_few";
export interface DataIssue { kind: DataIssueKind; t: number | null; detail: string }
export interface DataCoverage { expectedFirst: number; expectedLast: number; expected: number; actual: number; missing: number; completenessPct: number }

const iso = (t: number) => new Date(t).toISOString();

/** First bar opening at or after `start`, and the last bar fully closed by `end` (bars aligned to the epoch). */
export function expectedRange(start: number, end: number, tfMs: number) {
  const expectedFirst = Math.ceil(start / tfMs) * tfMs;
  const expectedLast = Math.floor((end - tfMs) / tfMs) * tfMs;
  return { expectedFirst, expectedLast, expected: expectedLast >= expectedFirst ? (expectedLast - expectedFirst) / tfMs + 1 : 0 };
}

export function validateCandles(cs: Candle[], o: { tfMs: number; start: number; end: number; minCandles?: number }) {
  const issues: DataIssue[] = [];
  const add = (kind: DataIssueKind, t: number | null, detail: string) => { if (issues.length < 200) issues.push({ kind, t, detail }); };
  if (!(o.tfMs > 0) || !(o.end > o.start)) throw new Error("Valid timeframe and date range required");
  let missing = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const prices = [c.o, c.h, c.l, c.c];
    if (!Number.isFinite(c.t) || !prices.every((p) => Number.isFinite(p) && p > 0)) { add("invalid_price", Number.isFinite(c.t) ? c.t : null, "Price is missing, zero, negative or not a number"); continue; }
    if (!Number.isFinite(c.v) || c.v < 0) add("invalid_volume", c.t, "Volume is missing, negative or not a number");
    if (c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c, c.h)) add("impossible_range", c.t, "High/low do not contain open and close");
    if (c.t % o.tfMs !== 0) add("misaligned", c.t, `Candle ${iso(c.t)} is not on the ${o.tfMs / 60000}-minute grid`);
    const prev = cs[i - 1];
    if (prev && Number.isFinite(prev.t)) {
      if (c.t === prev.t) add("duplicate", c.t, `Duplicate candle at ${iso(c.t)}`);
      else if (c.t < prev.t) add("out_of_order", c.t, `Candle ${iso(c.t)} comes after ${iso(prev.t)}`);
      else if (c.t - prev.t > o.tfMs) {
        const gap = Math.round((c.t - prev.t) / o.tfMs) - 1; missing += gap;
        add("missing", prev.t + o.tfMs, `${gap} candle(s) missing from ${iso(prev.t + o.tfMs)}`);
      }
    }
  }
  const r = expectedRange(o.start, o.end, o.tfMs);
  const first = cs[0], last = cs.at(-1);
  if (first && first.t > r.expectedFirst) { const n = Math.round((first.t - r.expectedFirst) / o.tfMs); missing += n; add("coverage_start", r.expectedFirst, `${n} candle(s) missing at the start of the requested range (data begins ${iso(first.t)})`); }
  if (last && last.t < r.expectedLast) { const n = Math.round((r.expectedLast - last.t) / o.tfMs); missing += n; add("coverage_end", last.t + o.tfMs, `${n} candle(s) missing at the end of the requested range (data ends ${iso(last.t)})`); }
  if (!cs.length) { missing = r.expected; add("coverage_start", r.expectedFirst, "No candles returned for the requested range"); }
  if (cs.length < (o.minCandles ?? 2)) add("too_few", null, `Only ${cs.length} candles; at least ${o.minCandles ?? 2} are required`);
  const actual = new Set(cs.map((c) => c.t)).size;
  const coverage: DataCoverage = { expectedFirst: r.expectedFirst, expectedLast: r.expectedLast, expected: r.expected, actual, missing, completenessPct: r.expected ? Math.max(0, Math.min(100, ((r.expected - missing) / r.expected) * 100)) : 0 };
  return { ok: issues.length === 0, issues, coverage };
}

/** Only candles that had fully closed by the decision cut-off. */
export function candlesAvailableAt(cs: Candle[], cutoff: number, tfMs: number) {
  return cs.filter((c) => c.t + tfMs <= cutoff);
}

/** Only evidence published at or before the cut-off; items without a publication time are excluded (fail closed). */
export function evidenceAvailableAt<T extends { publishedAt?: number | null }>(items: T[], cutoff: number) {
  return items.filter((x) => typeof x.publishedAt === "number" && Number.isFinite(x.publishedAt) && x.publishedAt <= cutoff);
}

export interface DataSource { provider: string; endpoint: string; market: "spot" | "futures"; pair: string; timeframe: string }

/** Provenance manifest: what was requested, what was received, when, and the SHA-256 of the exact candles used. */
export async function dataManifest(i: { source: DataSource; tfMs: number; start: number; end: number; decisionCutoff: number; fetchedAt: number; candles: Candle[]; coverage: DataCoverage }) {
  const candleSha256 = await evidenceHash(i.candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]));
  return {
    version: "historical-data-v1" as const, source: i.source, tfMs: i.tfMs,
    requested: { start: i.start, end: i.end }, decisionCutoff: i.decisionCutoff, fetchedAt: i.fetchedAt,
    received: { candles: i.candles.length, first: i.candles[0]?.t ?? null, last: i.candles.at(-1)?.t ?? null },
    coverage: i.coverage, candleSha256,
  };
}
