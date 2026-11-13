// Phase 4F — long replays of the 0049-aligned engine against DRAFT 0049 in PGlite (NOT applied anywhere real).
//  1. Synthetic: 1 m candles, two symbols, two accounts of one owner sharing Research/Scalping budgets, gaps, thin volume
//     (partial fills → expiry), funding, liquidations, tight budgets. After EVERY commit the engine's ledger view must
//     equal what the database computes (closed, open and pending risk per strategy) and the database must refuse nothing.
//  2. Historical: 3 days of PUBLIC Binance USD-M 5 m candles (trade, mark, index, funding) run through the provenance
//     checks and the disabled-by-default worker (enabled explicitly here) — zero database refusals expected.
// These are engine/ledger consistency replays, not strategy research: no result here is a performance claim.
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reconcileFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPIntent } from "@/lib/futures-paper-engine";
import { runFuturesPaperWorkerTick, type WorkerMetric } from "@/lib/futures-paper-worker";
import type { RawSymbolBundle } from "@/lib/futures-paper-market-data";
import { CFG, M, accountBudget, commitRaw, freshUser, loadView, makeDb, newAccount, pglitePorts, stepView, strategyBudget } from "./helpers/fp-v3-harness";

let db: PGlite;
beforeAll(async () => { db = await makeDb(); }, 120_000);
const OUT = process.env["REPLAY_STATS_OUT"];
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
async function dbEvents(id: string): Promise<FPEvent[]> {
  return (await db.query<Record<string, string>>(`SELECT * FROM public.futures_paper_events WHERE account_id=$1 ORDER BY seq`, [id])).rows.map((r) => ({ seq: Number(r["seq"]), t: Number(r["t"]), symbol: r["symbol"]!, kind: r["kind"] as FPEvent["kind"], side: (r["side"] ?? null) as FPEvent["side"], qty: Number(r["qty"]), price: r["price"] === null ? null : Number(r["price"]), fee: Number(r["fee"]), pnl: Number(r["pnl"]), walletDelta: Number(r["wallet_delta"]), marginDelta: Number(r["margin_delta"]), reason: r["reason"]!, proposalId: r["proposal_id"] ?? null }));
}

// Deterministic PRNG (mulberry32).
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

describe("synthetic long replay (1 m, two symbols, two accounts, shared budgets)", () => {
  it("1,200 candles × 2 accounts: zero database refusals; engine ledger == database usage after every commit; reconciles", async () => {
    const N = 1200, T0 = Math.floor(Date.now() / M) * M - (N + 10) * M, R = rng(4242);
    const user = freshUser();
    await accountBudget(db, user, 2000, 800, 1200); await strategyBudget(db, user, "scalp-a", "scalping", 600); await strategyBudget(db, user, "scalp-b", "scalping", 40); await strategyBudget(db, user, "res-a", "research", 800); // scalp-b is deliberately tight
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 2 }, limits: { ...CFG.limits, maxDailyLoss: 250, maxLossPerTrade: 8, maxExposure: 4000 } };
    const ids = [await newAccount(db, user, T0 - M, cfg), await newAccount(db, user, T0 - M, cfg)];
    const px: Record<string, number> = { BTCUSDT: 100, ETHUSDT: 50 };
    const bars: Record<string, FPBar[]> = { BTCUSDT: [], ETHUSDT: [] };
    for (let k = 0; k < N; k++) for (const s of ["BTCUSDT", "ETHUSDT"]) {
      const gap = R() < 0.004 ? (R() < 0.5 ? -1 : 1) * (0.1 + R() * 0.15) : 0; // opening gaps → stop-through and liquidations
      const o = px[s]! * (1 + gap), shock = R() < 0.004 ? (R() < 0.5 ? -1 : 1) * (0.06 + R() * 0.08) : 0;
      const c = Math.max(1, o * (1 + (R() - 0.5) * 0.008 + shock)), h = Math.max(o, c) * (1 + R() * 0.002), l = Math.min(o, c) * (1 - R() * 0.002);
      const v = R() < 0.35 ? 20 + R() * 200 : 1e6; // thin candles → partial fills (2% participation)
      const t = T0 + k * M;
      bars[s]!.push({ symbol: s, t, tfMs: M, trade: { o, h, l, c, v }, mark: { o, h, l, c }, index: R() < 0.01 ? null : { c: c * (1 + (R() - 0.5) * 0.001) }, funding: k % 240 === 120 ? [{ t, rate: (R() - 0.5) * 0.0006 }] : [] });
      px[s] = c;
    }
    const strategies = ["scalp-a", "scalp-b", "res-a", "no-budget"];
    const mkIntents = (acct: number, k: number): FPIntent[] => {
      const out: FPIntent[] = [];
      for (const s of ["BTCUSDT", "ETHUSDT"]) {
        if ((k + acct * 3 + (s === "ETHUSDT" ? 5 : 0)) % 7 !== 0) continue;
        const b = bars[s]![k]!, side = (k / 7 + acct) % 2 < 1 ? "LONG" : "SHORT", d = b.mark!.c * (0.003 + ((k * 13) % 7) * 0.001);
        const strat = strategies[(k + acct + (s === "ETHUSDT" ? 1 : 0)) % 4]!;
        out.push({ maxHoldBars: 20 + (k % 15), proposal: { proposalId: `syn-${acct}-${s}-${k}`, engine: strat.startsWith("res") ? "research" : "scalp_intraday", strategyId: strat, symbol: s, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: side === "LONG" ? b.mark!.c - d : b.mark!.c + d, takeProfitPrice: side === "LONG" ? b.mark!.c + 2 * d : b.mark!.c - 2 * d, createdAt: b.t + M - (k % 3) * 20_000 } });
      }
      return out;
    };
    const refusals: string[] = [], kinds: string[] = [], dbRefusals: string[] = [];
    let maxDiff = 0, checks = 0;
    for (let k = 0; k < N; k++) for (const [acct, id] of ids.entries()) {
      const v = await loadView(db, id), its = mkIntents(acct, k);
      const evaluated = (await db.query<{ proposal_id: string }>(`SELECT proposal_id FROM public.futures_paper_risk_approvals WHERE user_id=$1 AND proposal_id = ANY($2::text[])`, [user, its.map((i) => i.proposal.proposalId)])).rows.map((r) => r.proposal_id);
      const r = stepView(v, [bars["BTCUSDT"]![k]!, bars["ETHUSDT"]![k]!], its, evaluated);
      try { expect(await commitRaw(db, id, v.seq, T0 + k * M, r.payload)).toBe(r.state.seq); }
      catch (e) { dbRefusals.push(String((e as Error).message).slice(0, 160)); throw e; }
      refusals.push(...r.refusals.map((x) => `${x.stage}:${x.code}:${x.source}`)); kinds.push(...r.events.map((e) => e.kind));
      const after = await loadView(db, id);
      for (const s of after.ledger.strategies) {
        const a = after.ledger.usage[s.strategyId]!, b = r.ledger.usage[s.strategyId]!;
        maxDiff = Math.max(maxDiff, Math.abs(a.closedLoss - b.closedLoss), Math.abs(a.openRisk - b.openRisk), Math.abs(a.pendingRisk - b.pendingRisk)); checks++;
        expect(a.closedLoss + a.openRisk + a.pendingRisk).toBeLessThanOrEqual(s.maxLoss + 1e-6 + Math.max(0, a.closedLoss - s.maxLoss)); // closed gaps aside, usage ≤ budget
      }
    }
    expect(dbRefusals).toEqual([]);
    expect(maxDiff).toBeLessThan(1e-6);
    for (const id of ids) { const v = await loadView(db, id); expect(reconcileFuturesPaper(v.state, await dbEvents(id), 1000)).toEqual([]); }
    const stats = { candles: N, accounts: ids.length, commits: N * ids.length, databaseRefusals: dbRefusals.length, budgetEqualityChecks: checks, maxBudgetDifference: maxDiff, events: tally(kinds), engineRefusals: tally(refusals) };
    console.log("SYNTHETIC", JSON.stringify(stats));
    if (OUT) writeFileSync(`${OUT}/replay-synthetic.json`, JSON.stringify(stats, null, 2));
    expect(stats.events["order_accepted"]).toBeGreaterThan(50); expect(stats.events["entry_fill"]).toBeGreaterThan(50);
    expect(Object.keys(stats.engineRefusals).some((k) => k.startsWith("expiry:APPROVAL_EXPIRED"))).toBe(true);
    expect(Object.keys(stats.engineRefusals).some((k) => k.includes("APPROVAL_BUDGET_MISSING"))).toBe(true);
  }, 600_000);
});

describe("historical replay — 3 days of public Binance USD-M 5 m candles through the worker", () => {
  it("every candle passes provenance checks and commits; zero database refusals, halts or data errors", async () => {
    const fx = JSON.parse(readFileSync("src/test/fixtures/futures-paper-history-5m.json", "utf8")) as { start: number; end: number; symbols: Record<string, { rules: { stepSize: number; minNotional: number; tickSize: number }; trade: unknown[][]; mark: unknown[][]; index: unknown[][]; funding: { fundingTime: number; fundingRate: string }[] }> };
    const F = 5 * M, syms = ["BTCUSDT", "ETHUSDT"], MMR: Record<string, number> = { BTCUSDT: 0.004, ETHUSDT: 0.005 };
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 }, specs: Object.fromEntries(syms.map((s) => [s, { ...fx.symbols[s]!.rules, maintenanceMarginRate: MMR[s]! }])),
      limits: { ...CFG.limits, maxExposure: 6000, maxMarginPerTrade: 400, maxLossPerTrade: 10, maxDailyLoss: 60, maxProposalAgeMs: 60_000 } };
    const user = freshUser(); await accountBudget(db, user, 150, 60, 90); await strategyBudget(db, user, "hist-scalp", "scalping", 60); await strategyBudget(db, user, "hist-res", "research", 40);
    const id = await newAccount(db, user, fx.start - F, cfg, syms, "5m");
    const rowAt = (rows: unknown[][], t: number) => rows.filter((r) => Number(r[0]) === t);
    const now = fx.end + 3_000; // the last candle has just closed; the next one has not
    const market = { candles: async (symbols: string[], timeframe: string, barT: number): Promise<RawSymbolBundle[]> => symbols.map((s) => ({ source: "binance-public-usdm", symbol: s, timeframe, fetchedAt: now, trade: rowAt(fx.symbols[s]!.trade, barT), mark: rowAt(fx.symbols[s]!.mark, barT), index: rowAt(fx.symbols[s]!.index, barT), funding: fx.symbols[s]!.funding })) };
    // Deterministic, strategy-free intents (engine exercise only): every 6th candle per symbol, alternating side.
    const close = (s: string, t: number) => Number(rowAt(fx.symbols[s]!.mark, t)[0]?.[4]);
    const intents = { forCandle: async (_a: string, barT: number): Promise<FPIntent[]> => syms.flatMap((s, i) => {
      const k = (barT - fx.start) / F; if ((k + i * 3) % 6 !== 0 || !(close(s, barT) > 0)) return [];
      const c = close(s, barT), side = Math.floor(k / 6) % 2 === 0 ? "LONG" : "SHORT", d = c * 0.004;
      return [{ maxHoldBars: 12, proposal: { proposalId: `hist-${s}-${barT}`, engine: i === 0 ? "scalp_intraday" : "research", strategyId: i === 0 ? "hist-scalp" : "hist-res", symbol: s, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: side === "LONG" ? c - d : c + d, takeProfitPrice: side === "LONG" ? c + 2 * d : c - 2 * d, createdAt: barT + F } } as FPIntent];
    }) };
    const { ports, metrics } = pglitePorts(db, { market, intents, now: () => now });
    const total = (fx.end - fx.start) / F; let committed = 0;
    for (let tick = 0; tick < total / 30 + 2; tick++) committed += (await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "replay", accounts: [id], maxCandlesPerAccount: 30 })).committed;
    const codes = (metrics as WorkerMetric[]).map((m) => m.code);
    if (process.env["DBG"]) console.log("DBG", JSON.stringify((metrics as WorkerMetric[]).filter((m) => m.code !== "COMMITTED")));
    expect(committed).toBe(total);
    expect(codes.filter((c) => !["COMMITTED", "CATCH_UP_LIMIT", "WAIT_CANDLE_NOT_CLOSED"].includes(c))).toEqual([]);
    const v = await loadView(db, id); expect(v.cursorT).toBe(fx.end - F);
    const evs = await dbEvents(id);
    expect(reconcileFuturesPaper(v.state, evs, 1000)).toEqual([]);
    const refusals = (metrics as WorkerMetric[]).flatMap((m) => m.refusals ?? []).map((x) => `${x.stage}:${x.code}:${x.source}`);
    const stats = { candles: total, timeframe: "5m", symbols: syms, window: [new Date(fx.start).toISOString(), new Date(fx.end).toISOString()], committed, databaseRefusals: codes.filter((c) => c === "RECOMPUTE" || c === "HALT_FOR_REVIEW").length, workerCodes: tally(codes), events: tally(evs.map((e) => e.kind)), engineRefusals: tally(refusals), finalWallet: v.state.wallet };
    console.log("HISTORICAL", JSON.stringify(stats));
    if (OUT) writeFileSync(`${OUT}/replay-historical.json`, JSON.stringify(stats, null, 2));
    expect(stats.events["order_accepted"]).toBeGreaterThan(20);
  }, 600_000);
});
