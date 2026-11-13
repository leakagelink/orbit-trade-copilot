// Phase 4H — long replays of the unchanged Phase 4F engine through DRAFT 0051 (completeness-checked commit over drafts
// 0049 + 0050, PGlite; nothing is applied anywhere real). Purpose: show that the database's own derivation of every
// required funding charge and exit agrees with the engine on every candle (zero refusals) and that each engine trade's
// exit reason equals the outcome the database recorded. Funding follows the real 8 h grid (with Binance-style ms jitter).
// Engine/ledger consistency only; nothing here is a performance claim.
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reconcileFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPTrade } from "@/lib/futures-paper-engine";
import { runFuturesPaperWorkerTick, type CommitOutcome, type WorkerMetric } from "@/lib/futures-paper-worker";
import type { RawSymbolBundle } from "@/lib/futures-paper-market-data";
import { CFG, M, accountBudget, freshUser, loadView, newAccount, pglitePorts, stepView, strategyBudget } from "./helpers/fp-v3-harness";
import { H8, WITH_0052, commitV4, makeCompletenessDb } from "./helpers/fp-v4-harness";
// FP_WITH_0052=1 re-runs every replay through DRAFT 0052 (v5: entry-fill completeness) and also tallies its entry checks.
const TAG = WITH_0052 ? "0052" : "0051";
const entryOf = async (id: string) => WITH_0052 ? (await db.query<{ outcome: string }>(`SELECT outcome FROM public.futures_paper_entry_checks WHERE account_id=$1`, [id])).rows.map((r) => r.outcome) : [];

let db: PGlite;
beforeAll(async () => { db = await makeCompletenessDb(); }, 120_000);
const OUT = process.env["REPLAY_STATS_OUT"];
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
const REASON: Record<string, FPTrade["reason"]> = { stop_open: "stop", stop: "stop", target_open: "target", target: "target", time: "time", liquidation_open: "liquidation", liquidation: "liquidation" };
async function dbEvents(id: string): Promise<FPEvent[]> {
  return (await db.query<Record<string, string>>(`SELECT * FROM public.futures_paper_events WHERE account_id=$1 ORDER BY seq`, [id])).rows.map((r) => ({ seq: Number(r["seq"]), t: Number(r["t"]), symbol: r["symbol"]!, kind: r["kind"] as FPEvent["kind"], side: (r["side"] ?? null) as FPEvent["side"], qty: Number(r["qty"]), price: r["price"] === null ? null : Number(r["price"]), fee: Number(r["fee"]), pnl: Number(r["pnl"]), walletDelta: Number(r["wallet_delta"]), marginDelta: Number(r["margin_delta"]), reason: r["reason"]!, proposalId: r["proposal_id"] ?? null }));
}
const checksOf = async (id: string) => (await db.query<{ bar_t: string; symbol: string; outcome: string; funding_required: number }>(`SELECT bar_t, symbol, outcome, funding_required FROM public.futures_paper_candle_checks WHERE account_id=$1`, [id])).rows;
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

async function synthetic(tf: number, N: number, seed: number) {
  const T0 = Math.floor(Date.now() / H8) * H8 - Math.ceil(((N + 10) * tf) / H8) * H8 - 3 * tf, R = rng(seed);
  const user = freshUser();
  await accountBudget(db, user, 2000, 800, 1200); await strategyBudget(db, user, "scalp-a", "scalping", 600); await strategyBudget(db, user, "scalp-b", "scalping", 40); await strategyBudget(db, user, "res-a", "research", 800);
  const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 2 }, limits: { ...CFG.limits, maxDailyLoss: 250, maxLossPerTrade: 8, maxExposure: 4000 } };
  const tfName = tf === M ? "1m" : "5m";
  const ids = [await newAccount(db, user, T0 - tf, cfg, ["BTCUSDT", "ETHUSDT"], tfName), await newAccount(db, user, T0 - tf, { ...cfg, triggerSource: "CONTRACT" }, ["BTCUSDT", "ETHUSDT"], tfName)];
  const px: Record<string, number> = { BTCUSDT: 100, ETHUSDT: 50 };
  const bars: Record<string, FPBar[]> = { BTCUSDT: [], ETHUSDT: [] };
  for (let k = 0; k < N; k++) for (const s of ["BTCUSDT", "ETHUSDT"]) {
    const t = T0 + k * tf;
    const gap = R() < 0.004 ? (R() < 0.5 ? -1 : 1) * (0.1 + R() * 0.15) : 0;
    const o = px[s]! * (1 + gap), shock = R() < 0.004 ? (R() < 0.5 ? -1 : 1) * (0.06 + R() * 0.08) : 0;
    const c = Math.max(1, o * (1 + (R() - 0.5) * 0.008 + shock)), h = Math.max(o, c) * (1 + R() * 0.002), l = Math.min(o, c) * (1 - R() * 0.002);
    const v = R() < 0.35 ? 20 + R() * 200 : 1e6;
    // Mark differs slightly from the last price so MARK and CONTRACT triggers can disagree.
    const mo = o * (1 + (R() - 0.5) * 0.0004), mc = c * (1 + (R() - 0.5) * 0.0004), mh = Math.max(mo, mc, h * (1 + (R() - 0.5) * 0.0004)), ml = Math.min(mo, mc, l * (1 + (R() - 0.5) * 0.0004));
    const funding = t % H8 === 0 ? [{ t: t + Math.floor(R() * 4), rate: (R() - 0.5) * 0.0012 }] : [];
    bars[s]!.push({ symbol: s, t, tfMs: tf, trade: { o, h, l, c, v }, mark: { o: mo, h: mh, l: ml, c: mc }, index: R() < 0.01 ? null : { c: mc * (1 + (R() - 0.5) * 0.001) }, funding });
    px[s] = c;
  }
  const strategies = ["scalp-a", "scalp-b", "res-a", "no-budget"];
  const mkIntents = (acct: number, k: number): FPIntent[] => ["BTCUSDT", "ETHUSDT"].flatMap((s) => {
    if ((k + acct * 3 + (s === "ETHUSDT" ? 5 : 0)) % 7 !== 0) return [];
    const b = bars[s]![k]!, side = (k / 7 + acct) % 2 < 1 ? "LONG" : "SHORT", d = b.mark!.c * (0.003 + ((k * 13) % 7) * 0.001);
    const strat = strategies[(k + acct + (s === "ETHUSDT" ? 1 : 0)) % 4]!;
    // Every third proposal has no take-profit (target distance null).
    const tp = k % 3 === 0 ? null : side === "LONG" ? b.mark!.c + 2 * d : b.mark!.c - 2 * d;
    return [{ maxHoldBars: 20 + (k % 15), proposal: { proposalId: `syn${tf}-${acct}-${s}-${k}`, engine: strat.startsWith("res") ? "research" : "scalp_intraday", strategyId: strat, symbol: s, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: side === "LONG" ? b.mark!.c - d : b.mark!.c + d, takeProfitPrice: tp, createdAt: b.t + tf - (k % 3) * 20_000 } } as FPIntent];
  });
  const dbRefusals: string[] = [], kinds: string[] = [], trades: FPTrade[] = [];
  for (let k = 0; k < N; k++) for (const [acct, id] of ids.entries()) {
    const v = await loadView(db, id), its = mkIntents(acct, k);
    const evaluated = (await db.query<{ proposal_id: string }>(`SELECT proposal_id FROM public.futures_paper_risk_approvals WHERE user_id=$1 AND proposal_id = ANY($2::text[])`, [user, its.map((i) => i.proposal.proposalId)])).rows.map((r) => r.proposal_id);
    const r = stepView(v, [bars["BTCUSDT"]![k]!, bars["ETHUSDT"]![k]!], its, evaluated);
    try { expect(await commitV4(db, id, v.seq, T0 + k * tf, r.payload)).toBe(r.state.seq); }
    catch (e) { dbRefusals.push(`${k}:${String((e as Error).message).slice(0, 220)}`); throw e; }
    kinds.push(...r.events.map((e) => e.kind)); trades.push(...r.trades.map((x) => ({ ...x, account: id }) as FPTrade));
  }
  const outcomes: string[] = [], mismatches: string[] = [];
  let fundingRequired = 0;
  for (const id of ids) {
    const v = await loadView(db, id); expect(reconcileFuturesPaper(v.state, await dbEvents(id), 1000)).toEqual([]);
    for (const c of await checksOf(id)) {
      outcomes.push(c.outcome); fundingRequired += c.funding_required;
      if (c.outcome === "none") continue;
      const tr = trades.find((x) => (x as FPTrade & { account: string }).account === id && x.symbol === c.symbol && (c.outcome === "time" ? x.exitT === Number(c.bar_t) + tf : x.exitT === Number(c.bar_t)));
      if (!tr || tr.reason !== REASON[c.outcome]) mismatches.push(`${c.bar_t}:${c.symbol}:${c.outcome}:${tr?.reason}`);
    }
  }
  expect(dbRefusals).toEqual([]); expect(mismatches).toEqual([]);
  const entry = WITH_0052 ? { entryOutcomes: tally((await Promise.all(ids.map(entryOf))).flat()) } : {};
  expect(trades.length).toBe(outcomes.filter((o) => o !== "none").length);
  return { timeframe: tfName, candles: N, accounts: ids.length, commits: N * ids.length, databaseRefusals: dbRefusals.length, events: tally(kinds), databaseOutcomes: tally(outcomes), engineExitReasons: tally(trades.map((x) => x.reason)), fundingChargesRequired: fundingRequired, reasonMismatches: mismatches.length, ...entry };
}

describe("synthetic long replays through 0051 (MARK and CONTRACT triggers, partial fills, gaps, shocks, grid funding)", () => {
  it("1 m: 1,200 candles × 2 accounts — zero refusals; every exit reason equals the database's outcome", async () => {
    const stats = await synthetic(M, 1200, 4242);
    console.log(`SYNTHETIC_1M_${TAG}`, JSON.stringify(stats)); if (OUT) writeFileSync(`${OUT}/replay-${TAG}-synthetic-1m.json`, JSON.stringify(stats, null, 2));
    expect(stats.databaseOutcomes["stop"] ?? 0).toBeGreaterThan(10); expect(stats.engineExitReasons["time"] ?? 0).toBeGreaterThan(0);
  }, 600_000);
  it("5 m: 600 candles × 2 accounts (≈ 50 h, six funding times) — zero refusals; funding charged at every grid point held", async () => {
    const stats = await synthetic(5 * M, 600, 777);
    console.log(`SYNTHETIC_5M_${TAG}`, JSON.stringify(stats)); if (OUT) writeFileSync(`${OUT}/replay-${TAG}-synthetic-5m.json`, JSON.stringify(stats, null, 2));
    expect(stats.fundingChargesRequired).toBeGreaterThan(0); expect(stats.events["funding"] ?? 0).toBe(stats.fundingChargesRequired);
  }, 600_000);
});

describe("historical replay — 3 days of public Binance USD-M 5 m candles (real funding times with ms jitter) through the worker", () => {
  it("every candle commits through 0051; zero refusals, halts or data errors; exit reasons equal database outcomes", async () => {
    const fx = JSON.parse(readFileSync("src/test/fixtures/futures-paper-history-5m.json", "utf8")) as { start: number; end: number; symbols: Record<string, { rules: { stepSize: number; minNotional: number; tickSize: number }; trade: unknown[][]; mark: unknown[][]; index: unknown[][]; funding: { fundingTime: number; fundingRate: string }[] }> };
    const F = 5 * M, syms = ["BTCUSDT", "ETHUSDT"], MMR: Record<string, number> = { BTCUSDT: 0.004, ETHUSDT: 0.005 };
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 }, specs: Object.fromEntries(syms.map((s) => [s, { ...fx.symbols[s]!.rules, maintenanceMarginRate: MMR[s]! }])),
      limits: { ...CFG.limits, maxExposure: 6000, maxMarginPerTrade: 400, maxLossPerTrade: 10, maxDailyLoss: 60, maxProposalAgeMs: 60_000 } };
    const user = freshUser(); await accountBudget(db, user, 150, 60, 90); await strategyBudget(db, user, "hist-scalp", "scalping", 60); await strategyBudget(db, user, "hist-res", "research", 40);
    const id = await newAccount(db, user, fx.start - F, cfg, syms, "5m");
    const rowAt = (rows: unknown[][], t: number) => rows.filter((r) => Number(r[0]) === t);
    const now = fx.end + 3_000;
    const market = { candles: async (symbols: string[], timeframe: string, barT: number): Promise<RawSymbolBundle[]> => symbols.map((s) => ({ source: "binance-public-usdm", symbol: s, timeframe, fetchedAt: now, trade: rowAt(fx.symbols[s]!.trade, barT), mark: rowAt(fx.symbols[s]!.mark, barT), index: rowAt(fx.symbols[s]!.index, barT), funding: fx.symbols[s]!.funding })) };
    const close = (s: string, t: number) => Number(rowAt(fx.symbols[s]!.mark, t)[0]?.[4]);
    // Long holds (up to 120 candles = 10 h) so positions are held across real funding times.
    const intents = { forCandle: async (_a: string, barT: number): Promise<FPIntent[]> => syms.flatMap((s, i) => {
      const k = (barT - fx.start) / F; if ((k + i * 3) % 6 !== 0 || !(close(s, barT) > 0)) return [];
      const c = close(s, barT), side = Math.floor(k / 6) % 2 === 0 ? "LONG" : "SHORT", d = c * 0.004;
      return [{ maxHoldBars: k % 4 === 0 ? 120 : 12, proposal: { proposalId: `h51-${s}-${barT}`, engine: i === 0 ? "scalp_intraday" : "research", strategyId: i === 0 ? "hist-scalp" : "hist-res", symbol: s, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: side === "LONG" ? c - d : c + d, takeProfitPrice: k % 4 === 0 ? null : side === "LONG" ? c + 2 * d : c - 2 * d, createdAt: barT + F } } as FPIntent];
    }) };
    const base = pglitePorts(db, { market, intents, now: () => now });
    const ports = { ...base.ports, db: { ...base.ports.db, async commit(acct: string, seq: number, barT: number, payload: unknown): Promise<CommitOutcome> {
      try { return { kind: "committed", seq: await commitV4(db, acct, seq, barT, payload) }; } catch (e) { return { kind: "refused", message: String((e as Error).message) }; }
    } } };
    const total = (fx.end - fx.start) / F; let committed = 0;
    for (let tick = 0; tick < total / 30 + 2; tick++) committed += (await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "replay51", accounts: [id], maxCandlesPerAccount: 30 })).committed;
    const metrics = base.metrics as WorkerMetric[], codes = metrics.map((m) => m.code);
    if (process.env["DBG"]) console.log("DBG", JSON.stringify(metrics.filter((m) => m.code !== "COMMITTED")));
    expect(committed).toBe(total);
    expect(codes.filter((c) => !["COMMITTED", "CATCH_UP_LIMIT", "WAIT_CANDLE_NOT_CLOSED"].includes(c))).toEqual([]);
    const v = await loadView(db, id), evs = await dbEvents(id);
    expect(reconcileFuturesPaper(v.state, evs, 1000)).toEqual([]);
    const checks = await checksOf(id);
    const exits = evs.filter((e) => e.kind === "exit_fill" || e.kind === "liquidation").length;
    expect(checks.filter((c) => c.outcome !== "none").length).toBe(exits);
    const funding = evs.filter((e) => e.kind === "funding").length;
    expect(checks.reduce((a, c) => a + c.funding_required, 0)).toBe(funding);
    const stats = { candles: total, timeframe: "5m", window: [new Date(fx.start).toISOString(), new Date(fx.end).toISOString()], committed, databaseRefusals: codes.filter((c) => c === "RECOMPUTE" || c === "HALT_FOR_REVIEW").length, events: tally(evs.map((e) => e.kind)), databaseOutcomes: tally(checks.map((c) => c.outcome)), fundingChargesRequired: funding, exposedSymbolCandlesChecked: checks.length };
    const stats2 = WITH_0052 ? { ...stats, entryOutcomes: tally(await entryOf(id)) } : stats;
    console.log(`HISTORICAL_${TAG}`, JSON.stringify(stats2)); if (OUT) writeFileSync(`${OUT}/replay-${TAG}-historical.json`, JSON.stringify(stats2, null, 2));
    expect(funding).toBeGreaterThan(0);
  }, 600_000);
});
