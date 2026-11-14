// Loads the recorded PUBLIC Binance USD-M fixture (scripts/live-scalp/record-public-feed.ts) and replays it.
import { readFileSync } from "node:fs";
import { FeedEngine, LIVE_SYMBOLS, type LiveSymbol } from "@/lib/live-feed";

export interface Recorded {
  recordedAt: string; seconds: number; serverTime: { localAt: number; body: { serverTime: number } };
  snapshots: Record<LiveSymbol, { r: number; body: { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] } }>;
  rest: Record<LiveSymbol, { klines1m: unknown[][]; klines5m: unknown[][]; premiumIndex: Record<string, string | number>; fundingRate: unknown[] }>;
  exchangeInfo: { symbols: unknown[] }; messages: { r: number; d: { stream: string; data: Record<string, unknown> } }[];
}
let cache: Recorded | null = null;
export const recorded = (): Recorded => (cache ??= JSON.parse(readFileSync("src/test/fixtures/binance-usdm/recorded-feed.json", "utf8")) as Recorded);
/** Replays messages in receive order, applying each REST snapshot at the moment it was received. */
export function replay(engine = new FeedEngine(LIVE_SYMBOLS), o: { until?: number; mutate?: (m: Recorded["messages"][number], i: number) => unknown | null } = {}) {
  const f = recorded(), snaps = LIVE_SYMBOLS.map((s) => ({ s, ...f.snapshots[s] })).sort((a, b) => a.r - b.r);
  let si = 0, n = 0;
  for (let i = 0; i < f.messages.length; i++) {
    const m = f.messages[i]!;
    if (o.until !== undefined && m.r > o.until) break;
    while (si < snaps.length && snaps[si]!.r <= m.r) { engine.applySnapshot(snaps[si]!.s, snaps[si]!.body, snaps[si]!.r); si++; }
    const d = o.mutate ? o.mutate(m, i) : m.d;
    if (d === null) continue;
    engine.ingest(JSON.stringify(d), m.r); n++;
  }
  return { engine, last: f.messages.at(-1)!.r, ingested: n };
}
