// Candle provenance records for the Futures PAPER worker gateway (Phase 4G, workstream E). Pure apart from WebCrypto
// SHA-256 (available in Workers and Node); no network, database, credential or order access. It re-runs the Phase 4F
// closed-candle checks, refuses stale or future fetches, and fingerprints the RAW public payload exactly as fetched
// (canonical JSON, SHA-256) so a later reviewer can tell which bytes a commit was computed from. It does NOT verify
// prices: `independently_verified` is always false, and draft 0050 refuses any record that claims otherwise.
import { selectClosedCandles, FP_TIMEFRAMES, FUTURES_PAPER_DATA_SOURCE, type FPTimeframe, type MarketDataCode, type RawSymbolBundle } from "./futures-paper-market-data";

export const PROVENANCE_CODES = ["PROVENANCE_FETCH_STALE", "PROVENANCE_FETCH_FUTURE"] as const;
export type ProvenanceCode = (typeof PROVENANCE_CODES)[number] | MarketDataCode;
/** Engineering defaults awaiting review (not approved policy): the database backstop in 0050 is 15 minutes. */
export const PROVENANCE_DEFAULTS = { maxFetchAgeMs: 120_000, maxFutureSkewMs: 5_000, closeGraceMs: 2_000 } as const;

export interface ProvenanceRecord {
  symbol: string; source: typeof FUTURES_PAPER_DATA_SOURCE; timeframe: FPTimeframe; open_t: number; close_t: number; fetched_at: number;
  raw_sha256: string; independently_verified: false;
}
export type ProvenanceResult = { ok: true; records: ProvenanceRecord[] } | { ok: false; code: ProvenanceCode; symbol: string | null };

/** Canonical JSON: object keys sorted, arrays in order, no whitespace. Equal values always give equal strings. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
  return JSON.stringify(v) ?? "null";
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProvenanceRequest { symbols: string[]; timeframe: FPTimeframe; barT: number; now: number; maxFetchAgeMs?: number; maxFutureSkewMs?: number; closeGraceMs?: number }
/** One provenance record per account symbol for the closed candle at `barT`, or the first problem found. */
export async function buildCandleProvenance(bundles: RawSymbolBundle[], req: ProvenanceRequest): Promise<ProvenanceResult> {
  const o = { ...PROVENANCE_DEFAULTS, ...req };
  const chk = selectClosedCandles(bundles, { symbols: o.symbols, timeframe: o.timeframe, barT: o.barT, now: o.now, closeGraceMs: o.closeGraceMs, maxFutureSkewMs: o.maxFutureSkewMs });
  if (!chk.ok) return { ok: false, code: chk.code, symbol: chk.symbol };
  const tf = FP_TIMEFRAMES[o.timeframe], records: ProvenanceRecord[] = [];
  for (const p of chk.provenance) {
    const b = bundles.find((x) => x.symbol === p.symbol)!;
    if (b.fetchedAt > o.now + o.maxFutureSkewMs) return { ok: false, code: "PROVENANCE_FETCH_FUTURE", symbol: p.symbol };
    if (o.now - b.fetchedAt > o.maxFetchAgeMs) return { ok: false, code: "PROVENANCE_FETCH_STALE", symbol: p.symbol };
    records.push({ symbol: p.symbol, source: FUTURES_PAPER_DATA_SOURCE, timeframe: o.timeframe, open_t: o.barT, close_t: o.barT + tf - 1, fetched_at: b.fetchedAt,
      raw_sha256: await sha256Hex(canonicalJson(b)), independently_verified: false });
  }
  return { ok: true, records };
}
