// Phase 4G — independent review of DRAFT 0049 (not applied anywhere real), finding G2: CHARACTERIZATION tests. They
// pin what 0049 does NOT enforce today, so the gap is visible and any successor that closes it must change these
// expectations deliberately. 0049 validates every event a worker submits, but it does not require the events the
// recorded candle implies: a recorded stop crossing, liquidation-level mark or funding entry with no matching event is
// accepted. The engine always produces those events (Phase 4F replays); a faulty worker is the risk. PGlite only.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { FPIntent } from "@/lib/futures-paper-engine";
import { selectClosedCandles } from "@/lib/futures-paper-market-data";
import { CFG, M, accountBudget, commitRaw, freshUser, loadView, makeDb, newAccount, rawBundle, stepView, strategyBudget } from "./helpers/fp-v3-harness";

let db: PGlite;
beforeAll(async () => { db = await makeDb(); }, 120_000);
const T0 = Math.floor(Date.now() / M) * M - 100 * M, NOW = T0 + 50 * M;
const px = (k: number): [number, number, number, number] => [100 + k * 0.01, 100.3 + k * 0.01, 99.8 + k * 0.01, 100.05 + k * 0.01];
const bars = (barT: number) => {
  const k = (barT - T0) / M, b = ["BTCUSDT", "ETHUSDT"].map((s) => rawBundle(s, barT, M, { trade: s === "BTCUSDT" ? px(k) : [50, 50.2, 49.9, 50.1] }, NOW));
  const c = selectClosedCandles(b, { symbols: ["BTCUSDT", "ETHUSDT"], timeframe: "1m", barT, now: NOW, closeGraceMs: 2_000, maxFutureSkewMs: 5_000 });
  if (!c.ok) throw new Error(c.code); return c.bars;
};
const long: FPIntent = { maxHoldBars: 30, proposal: { proposalId: "g2-long-0", engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 103, createdAt: T0 + M } };
async function openLong() {
  const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
  const id = await newAccount(db, user, T0 - M, CFG);
  for (const [i, intents] of [[0, [{ ...long, proposal: { ...long.proposal, proposalId: `g2-${id.slice(-6)}` } }]], [1, []]] as const) {
    const v = await loadView(db, id), s = stepView(v, bars(T0 + i * M), [...intents]); await commitRaw(db, id, v.seq, T0 + i * M, s.payload);
  }
  const pos = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).rows[0]!.n;
  expect(pos).toBe(1);
  return id;
}
const eventsAt = async (id: string, barT: number) => (await db.query<{ kind: string }>(`SELECT kind FROM public.futures_paper_events WHERE account_id=$1 AND bar_t=$2`, [id, barT])).rows.map((r) => r.kind);

describe("G2 (open): 0049 checks submitted events but does not require the events a recorded candle implies", () => {
  it("a recorded mark low below the stop with NO exit event is accepted (the position stays open)", async () => {
    const id = await openLong(), barT = T0 + 2 * M, v = await loadView(db, id), s = stepView(v, bars(barT), []);
    const p = s.payload as { candles: Record<string, { mark: { l: number }; trade: { l: number } }> };
    p.candles["BTCUSDT"]!.mark.l = 98.5; p.candles["BTCUSDT"]!.trade.l = 98.5; // stop is 99
    expect(await commitRaw(db, id, v.seq, barT, p)).toBe(v.seq);
    expect(await eventsAt(id, barT)).toEqual([]);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).rows[0]!.n).toBe(1);
  });
  it("a recorded funding entry on a held position with NO funding event is accepted (funding cash omitted)", async () => {
    const id = await openLong(), barT = T0 + 2 * M, v = await loadView(db, id), s = stepView(v, bars(barT), []);
    const p = s.payload as { candles: Record<string, { funding: { t: number; rate: number }[] }> };
    p.candles["BTCUSDT"]!.funding = [{ t: barT, rate: 0.01 }];
    expect(await commitRaw(db, id, v.seq, barT, p)).toBe(v.seq);
    expect(await eventsAt(id, barT)).toEqual([]);
  });
  it("control: an exit OUTSIDE the recorded candle range is refused (what 0049 does enforce)", async () => {
    const id = await openLong(), barT = T0 + 2 * M, v = await loadView(db, id);
    const b = bars(barT); b[0] = { ...b[0]!, mark: { ...b[0]!.mark, l: 98.5 }, trade: { ...b[0]!.trade, l: 98.5 } } as (typeof b)[number];
    const s = stepView(v, b, []); // the engine exits at the stop because its bar crossed it…
    expect(s.events.map((e) => e.kind)).toContain("exit_fill");
    const p = s.payload as { candles: Record<string, { mark: { l: number }; trade: { l: number } }> };
    p.candles["BTCUSDT"]!.mark.l = 99.8; p.candles["BTCUSDT"]!.trade.l = 99.8; // …but the recorded candle never went there
    await expect(commitRaw(db, id, v.seq, barT, p)).rejects.toThrow(/exit price .* is outside the recorded candle/);
  });
});
