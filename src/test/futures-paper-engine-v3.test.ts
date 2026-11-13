// Phase 4F — the 0049-aligned Futures PAPER engine (E1 expiry, E2 database budgets, E3 refusal codes, E4 costs) against
// DRAFT migration 0049 running verbatim in PGlite. Every engine payload below is committed to the database; a test passes
// only if the database ACCEPTS what the aligned engine produced (the point of alignment) and the engine's ledger view
// equals what the database computes. Policy values are TEST INPUTS (owner proposals), NOT approved policy.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { initialV3Ledger, planLedgerRefusalV3, resolveCost, stepFuturesPaperCandleV3, APPROVAL_REFUSALS, V3_APPROVAL_CODES, type CostAssumption, type FPV3Ledger } from "@/lib/futures-paper-engine-v3";
import { futuresPaperCommitPayloadV3 } from "@/lib/futures-paper-ledger-v3";
import { CFG, M, accountBudget, as, commitRaw, costOverride, freshUser, loadView, makeDb, newAccount, stepView, strategyBudget, usageOf } from "./helpers/fp-v3-harness";

let db: PGlite;
const T0 = Math.floor(Date.now() / (15 * M)) * (15 * M) - 2010 * M; // aligned to 1 m, 5 m and 15 m
type OHLC = [number, number, number, number];
const FLAT: OHLC = [100, 100.2, 99.9, 100];
const bar = (sym: string, t: number, tf: number, [o, h, l, c]: OHLC, v = 1e6, index: number | null = c): FPBar => ({ symbol: sym, t, tfMs: tf, trade: { o, h, l, c, v }, mark: { o, h, l, c }, index: index === null ? null : { c: index }, funding: [] });
const intent = (id: string, sym: string, closeT: number, side: "LONG" | "SHORT", stop: number, tp: number, strategyId = "s1"): FPIntent => ({ maxHoldBars: 50, proposal: { proposalId: `v3prop-${id}`, engine: "scalp_intraday", strategyId, symbol: sym, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: stop, takeProfitPrice: tp, createdAt: closeT } });

/** Load from the database, step the aligned engine, commit; returns the step and asserts DB == engine ledger. */
async function play(id: string, user: string, t: number, tf: number, px: Record<string, OHLC | { px: OHLC; v?: number; index?: number | null }>, intents: FPIntent[] = []) {
  const v = await loadView(db, id);
  const bars = Object.entries(px).map(([s, p]) => (Array.isArray(p) ? bar(s, t, tf, p) : bar(s, t, tf, p.px, p.v, p.index === undefined ? p.px[3] : p.index)));
  const evaluated = (await db.query<{ proposal_id: string }>(`SELECT proposal_id FROM public.futures_paper_risk_approvals WHERE user_id=$1 AND proposal_id = ANY($2::text[])`, [user, intents.map((i) => i.proposal.proposalId)])).rows.map((r) => r.proposal_id);
  const r = stepView(v, bars, intents, evaluated);
  const seq = await commitRaw(db, id, v.seq, t, r.payload);
  expect(seq).toBe(r.state.seq);
  const after = await loadView(db, id);
  for (const s of after.ledger.strategies) {
    const a = after.ledger.usage[s.strategyId]!, b = r.ledger.usage[s.strategyId] ?? { closedLoss: 0, openRisk: 0, pendingRisk: 0 };
    // Another account of the same owner may have moved owner-wide usage; compare only when this account is the owner's only one.
    if ((await db.query(`SELECT 1 FROM public.futures_paper_accounts WHERE user_id=$1`, [user])).rows.length === 1) {
      expect(a.closedLoss).toBeCloseTo(b.closedLoss, 6); expect(a.openRisk).toBeCloseTo(b.openRisk, 6); expect(a.pendingRisk).toBeCloseTo(b.pendingRisk, 6);
    }
  }
  return r;
}
const approval = async (id: string) => (await db.query<Record<string, string>>(`SELECT * FROM public.futures_paper_risk_approvals WHERE account_id=$1 ORDER BY approved_seq DESC LIMIT 1`, [id])).rows[0]!;

beforeAll(async () => { db = await makeDb(); }, 120_000);

describe("E1 — expiry cancellation of pending remainders", () => {
  it("1 m candles: partial fills at the approval time and at expiry, then the remainder is cancelled with APPROVAL_EXPIRED and the database accepts it", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const id = await newAccount(db, user, T0 - M, cfg);
    await play(id, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e1a", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    const ap = await approval(id); expect(Number(ap["expires_t"])).toBe(T0 + 2 * M);
    const thin = { px: FLAT, v: 200 };
    const r1 = await play(id, user, T0 + M, M, { BTCUSDT: thin, ETHUSDT: FLAT });
    const r2 = await play(id, user, T0 + 2 * M, M, { BTCUSDT: thin, ETHUSDT: FLAT });
    expect([r1, r2].map((r) => r.events.filter((e) => e.kind === "entry_fill").length)).toEqual([1, 1]);
    const r3 = await play(id, user, T0 + 3 * M, M, { BTCUSDT: thin, ETHUSDT: FLAT });
    const c = r3.events.find((e) => e.kind === "entry_cancelled")!;
    expect(c.reason).toMatch(/\[APPROVAL_EXPIRED\]/); expect(r3.events.some((e) => e.kind === "entry_fill")).toBe(false);
    expect(r3.refusals.map((x) => x.code)).toEqual(["APPROVAL_EXPIRED"]);
    const done = await approval(id); expect(done["status"]).toBe("cancelled"); expect(Number(done["filled_qty"])).toBeCloseTo(4, 9);
    expect(Number(c.qty)).toBeCloseTo(Number(done["approved_qty"]) - 4, 9); // cancellation covers exactly the unfilled remainder
    expect(Object.keys(r3.state.pending)).toEqual([]); expect(r3.state.positions["BTCUSDT"]!.qty).toBeCloseTo(4, 9);
  });
  it("5 m candles with a 60 s expiry: only the first open may fill; the remainder is cancelled at the next candle", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    const F = 5 * M, cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const id = await newAccount(db, user, T0 - F, cfg, ["BTCUSDT"], "5m");
    await play(id, user, T0, F, { BTCUSDT: FLAT }, [intent("e1b", "BTCUSDT", T0 + F, "LONG", 99, 103)]);
    const r1 = await play(id, user, T0 + F, F, { BTCUSDT: { px: FLAT, v: 300 } });
    expect(r1.events.filter((e) => e.kind === "entry_fill")).toHaveLength(1);
    const r2 = await play(id, user, T0 + 2 * F, F, { BTCUSDT: { px: FLAT, v: 300 } });
    expect(r2.events.map((e) => e.kind)).toEqual(["entry_cancelled"]); expect((await approval(id))["status"]).toBe("cancelled");
  });
  it("without E1 the core would keep filling after expiry and the database refuses that payload", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const id = await newAccount(db, user, T0 - M, cfg, ["BTCUSDT"]);
    await play(id, user, T0, M, { BTCUSDT: FLAT }, [intent("e1c", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    await play(id, user, T0 + M, M, { BTCUSDT: { px: FLAT, v: 200 } }); await play(id, user, T0 + 2 * M, M, { BTCUSDT: { px: FLAT, v: 200 } });
    const v = await loadView(db, id), b = [bar("BTCUSDT", T0 + 3 * M, M, FLAT, 200)];
    const core = stepFuturesPaper({ ...v.state }, { ...cfg, strategyBudgets: { s1: 1e15 } }, b[0]!, [], {}, { accountStatus: "active", accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 } }, marks: { BTCUSDT: { price: 100, t: T0 + 3 * M } }, maxMarkAgeMs: 0 });
    expect(core.events.some((e) => e.kind === "entry_fill")).toBe(true);
    await expect(commitRaw(db, id, v.seq, T0 + 3 * M, futuresPaperCommitPayloadV3(v.state, { ...core.state, accountCursor: T0 + 3 * M }, core.events, b, []))).rejects.toThrow(/expired/);
  });
});

describe("E2 — database-authoritative budgets (account, sub-budget, strategy; closed + open + pending)", () => {
  it("a second account of the same owner is sized into the room the first account's PENDING approval left; the database agrees", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 12);
    const a1 = await newAccount(db, user, T0 - M), a2 = await newAccount(db, user, T0 - M);
    const r1 = await play(a1, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e2a1", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    const used1 = await usageOf(db, user, "s1", null); expect(used1).toBeGreaterThan(9.9); expect(used1).toBeLessThanOrEqual(10 + 1e-9);
    const r2 = await play(a2, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e2a2", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    const acc2 = r2.events.find((e) => e.kind === "order_accepted")!;
    expect(acc2.reason).toMatch(/limited by database budget room/);
    expect(acc2.qty * 1.13).toBeLessThanOrEqual(12 - used1 + 1e-9); // risk ≤ remaining room (12 − pending of account 1)
    expect(await usageOf(db, user, "s1", null)).toBeLessThanOrEqual(12 + 1e-9);
    expect(await usageOf(db, user, "s1", null)).toBeCloseTo(12, 2);
    // Owner-wide engine view equals the database (both accounts).
    const v = await loadView(db, a2); expect(v.ledger.usage["s1"]!.pendingRisk).toBeCloseTo(r1.ledger.usage["s1"]!.pendingRisk + acc2.qty * 1.13, 6);
  });
  it("no room left → the intent is rejected with a budget code before the core sizes it; nothing reaches an approval", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 10);
    const a1 = await newAccount(db, user, T0 - M), a2 = await newAccount(db, user, T0 - M);
    await play(a1, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e2b1", "BTCUSDT", T0 + M, "LONG", 99.5, 103)]); // risk ≈ 10 × … capped by budget 10
    const r = await play(a2, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e2b2", "ETHUSDT", T0 + M, "LONG", 99, 103)]);
    expect(r.events.map((e) => e.kind)).toEqual(["order_rejected"]); expect(r.refusals[0]!.code).toBe("APPROVAL_STRATEGY_BUDGET");
  });
  it("sub-budget and account levels bind the sizing exactly as the database levels do (pure, crafted usage)", () => {
    const strategies = [{ strategyId: "r1", engine: "research" as const, maxLoss: 8 }, { strategyId: "r2", engine: "research" as const, maxLoss: 7 }, { strategyId: "s1", engine: "scalping" as const, maxLoss: 5 }];
    const base = initialV3Ledger({ maxLoss: 20, research: 15, scalping: 5 }, strategies);
    const run = (ledger: FPV3Ledger, strategyId: string) => stepFuturesPaperCandleV3({ ...initialFuturesPaperState(1000), accountCursor: T0 - M }, CFG, [bar("BTCUSDT", T0, M, FLAT)], [intent(`lv-${strategyId}`, "BTCUSDT", T0 + M, "LONG", 99, 103, strategyId)], { accountStatus: "active", accountHalted: false }, ledger);
    // r1's closed loss (a gap through its stop) exceeded its own budget: the research sub-budget binds for r2 (15 − 11 = 4).
    const sub = run({ ...base, usage: { ...base.usage, r1: { closedLoss: 11, openRisk: 0, pendingRisk: 0 } } }, "r2");
    const a = sub.events.find((e) => e.kind === "order_accepted")!; expect(a.qty * 1.13).toBeLessThanOrEqual(4 + 1e-9); expect(a.qty * 1.13).toBeGreaterThan(3.99);
    // Account level: research 15 used by losses beyond budgets plus scalping usage → account (20) binds below the strategy.
    const acct = run({ ...base, usage: { r1: { closedLoss: 9, openRisk: 0, pendingRisk: 0 }, r2: { closedLoss: 9, openRisk: 0, pendingRisk: 0 }, s1: { closedLoss: 0, openRisk: 0, pendingRisk: 0 } } }, "s1");
    const b = acct.events.find((e) => e.kind === "order_accepted")!; expect(b.qty * 1.13).toBeLessThanOrEqual(2 + 1e-9); expect(b.qty * 1.13).toBeGreaterThan(1.99);
    expect(acct.ledger.usage["s1"]!.pendingRisk).toBeCloseTo(b.qty * 1.13, 9);
  });
  it("a fill whose price drifts above the approval price would push usage past a fully used budget: the engine cancels it (STRATEGY_BUDGET_EXCEEDED) and the database accepts; the unaligned core fill is refused", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 5);
    const id = await newAccount(db, user, T0 - M, CFG, ["BTCUSDT"]);
    await play(id, user, T0, M, { BTCUSDT: FLAT }, [intent("e2d", "BTCUSDT", T0 + M, "LONG", 99, 110)]);
    expect(await usageOf(db, user, "s1", null)).toBeCloseTo(5, 2);
    const up: OHLC = [101, 101.5, 100.8, 101.2];
    const v = await loadView(db, id);
    const core = stepFuturesPaper(v.state, { ...CFG, strategyBudgets: { s1: 1e15 } }, bar("BTCUSDT", T0 + M, M, up), [], {}, { accountStatus: "active", accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 } }, marks: { BTCUSDT: { price: 101, t: T0 + M } }, maxMarkAgeMs: 0 });
    await expect(commitRaw(db, id, v.seq, T0 + M, futuresPaperCommitPayloadV3(v.state, { ...core.state, accountCursor: T0 + M }, core.events, [bar("BTCUSDT", T0 + M, M, up)], []))).rejects.toThrow(/would be exceeded at fill/);
    const r = await play(id, user, T0 + M, M, { BTCUSDT: up });
    expect(r.events.map((e) => e.kind)).toEqual(["entry_cancelled"]);
    expect(r.events[0]!.reason).toMatch(/\[STRATEGY_BUDGET_EXCEEDED\] \(0049-aligned pre-check\)/);
  });
});

describe("E2 — losses beyond reserved risk (liquidation) and the sub-budget level in the real database", () => {
  it("a gap liquidates a 10× position; its closed loss exceeds the strategy budget, so the next strategy in the same sub-budget is sized to the SUB-BUDGET room — database and engine agree", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30); await strategyBudget(db, user, "s2", "scalping", 30);
    const cfg: FPConfig = { ...CFG, limits: { ...CFG.limits, maxMarginPerTrade: 50, maxDailyLoss: 500 } };
    const id = await newAccount(db, user, T0 - M, cfg);
    const r0 = await play(id, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("liq1", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    expect(r0.state.pending["BTCUSDT"]!.leverage).toBe(10);
    await play(id, user, T0 + M, M, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    const pos = (await loadView(db, id)).state.positions["BTCUSDT"]!;
    const rl = await play(id, user, T0 + 2 * M, M, { BTCUSDT: [85, 86, 84, 85.5], ETHUSDT: FLAT });
    expect(rl.events.map((e) => e.kind)).toContain("liquidation");
    const closed = pos.margin + pos.fees;
    expect(await usageOf(db, user, "s1", null)).toBeCloseTo(closed, 6); expect(closed).toBeGreaterThan(30);
    const r2 = await play(id, user, T0 + 3 * M, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("liq2", "ETHUSDT", T0 + 4 * M, "LONG", 97, 106, "s2"), intent("liq3", "BTCUSDT", T0 + 4 * M, "LONG", 99, 103, "s1")]);
    const a = r2.events.find((e) => e.kind === "order_accepted")!;
    expect(a.symbol).toBe("ETHUSDT"); expect(a.qty * 3.13).toBeLessThanOrEqual(60 - closed + 1e-9); expect(a.qty * 3.13).toBeGreaterThan(60 - closed - 0.01); // scalping sub-budget room binds, not s2's own 30
    expect(r2.refusals.find((x) => x.proposalId === "v3prop-liq3")!.code).toBe("APPROVAL_STRATEGY_BUDGET");
    expect(await usageOf(db, user, null, "scalping")).toBeLessThanOrEqual(60 + 1e-6);
  });
});

describe("E4 — per-instrument/strategy costs, same precedence as 0049, frozen on the approval", () => {
  it("resolveCost equals fp3_cost for every combination of overrides", async () => {
    const user = freshUser(); const rows: CostAssumption[] = [];
    const combos: [string, string, number][] = [["s1", "BTCUSDT", 0.1], ["s1", "*", 0.11], ["*", "BTCUSDT", 0.15], ["*", "*", 0.17], ["s2", "ETHUSDT", 0.19]];
    for (const [k, [st, sy, pct]] of combos.entries()) {
      await costOverride(db, user, st, sy, pct); rows.push({ strategyId: st, symbol: sy, roundTripCostPct: pct, validationStatus: "unvalidated" });
      for (const s of ["s1", "s2", "s3"]) for (const y of ["BTCUSDT", "ETHUSDT"]) {
        const dbv = Number((await db.query<{ c: string }>(`SELECT public.fp3_cost($1,$2,$3,0.13)::numeric AS c`, [user, s, y])).rows[0]!.c);
        expect(resolveCost(rows, s, y, 0.13)!.costPct, `${k} ${s} ${y}`).toBe(dbv);
      }
    }
    expect(resolveCost([], "s1", "BTCUSDT", 0.13)).toEqual({ costPct: 0.13, source: "account_default", validated: false });
    expect(resolveCost([], "s1", "BTCUSDT", null)).toBeNull();
  });
  it("the engine sizes with the instrument's higher cost and the database freezes that same cost on the approval (previously refused)", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    await costOverride(db, user, "s1", "BTCUSDT", 0.2);
    const id = await newAccount(db, user, T0 - M);
    const r = await play(id, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("e4a", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    expect(r.costs["v3prop-e4a"]).toEqual({ costPct: 0.2, source: "exact", validated: false });
    const ap = await approval(id); expect(Number(ap["cost_pct"])).toBe(0.2);
    expect(Number(ap["risk_amount"])).toBeLessThanOrEqual(10 + 1e-9);
    expect(Number(ap["risk_amount"])).toBeCloseTo(r.events.find((e) => e.kind === "order_accepted")!.qty * 1.2, 9);
  });
  it("requireValidatedCost refuses unvalidated or default costs; a validated override is accepted; no default → COST_MISSING", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30); await strategyBudget(db, user, "s2", "scalping", 30);
    await costOverride(db, user, "s1", "BTCUSDT", 0.14, "validated");
    const id = await newAccount(db, user, T0 - M);
    const v = await loadView(db, id); v.ledger.requireValidatedCost = true;
    const bars = [bar("BTCUSDT", T0, M, FLAT), bar("ETHUSDT", T0, M, FLAT)];
    const r = stepView(v, bars, [intent("e4b", "BTCUSDT", T0 + M, "LONG", 99, 103), intent("e4c", "ETHUSDT", T0 + M, "LONG", 99, 103, "s2")]);
    expect(r.refusals.map((x) => [x.proposalId, x.code])).toEqual([["v3prop-e4c", "APPROVAL_COST_UNVALIDATED"]]);
    expect(await commitRaw(db, id, v.seq, T0, r.payload)).toBe(r.state.seq);
    const noCost = stepFuturesPaperCandleV3({ ...initialFuturesPaperState(1000), accountCursor: T0 - M }, { ...CFG, limits: { ...CFG.limits, roundTripCostPct: null } }, [bar("BTCUSDT", T0, M, FLAT)], [intent("e4d", "BTCUSDT", T0 + M, "LONG", 99, 103)], { accountStatus: "active", accountHalted: false }, initialV3Ledger({ maxLoss: 100, research: 40, scalping: 60 }, [{ strategyId: "s1", engine: "scalping", maxLoss: 30 }]));
    expect(noCost.refusals.map((x) => x.code)).toEqual(["APPROVAL_COST_MISSING"]);
  });
});

describe("cross-account duplicates and one intent per symbol", () => {
  it("a proposal already evaluated in another account is rejected (APPROVAL_DUPLICATE_PROPOSAL); extra intents for one symbol get APPROVAL_INTENT_LIMIT", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    const a1 = await newAccount(db, user, T0 - M), a2 = await newAccount(db, user, T0 - M);
    await play(a1, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dup", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    const r = await play(a2, user, T0, M, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dup", "BTCUSDT", T0 + M, "LONG", 99, 103), intent("dup2", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    expect(r.refusals.map((x) => x.code).sort()).toEqual(["APPROVAL_DUPLICATE_PROPOSAL", "APPROVAL_INTENT_LIMIT"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// E3 — every refusal message draft 0049 can raise has a deterministic, bounded classification.
// ---------------------------------------------------------------------------------------------------------------------
const SQL = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8");
const TEMPLATES = [...new Set([...SQL.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]!))];
const ev = (seq: number, kind: FPEvent["kind"], symbol: string, proposalId: string): FPEvent => ({ seq, t: T0, symbol, kind, side: "LONG", qty: 1, price: kind === "entry_fill" ? 100 : null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: kind === "entry_fill" ? 10 : 0, reason: "x", proposalId });
const pend = (symbol: string, proposalId: string, strategyId: string) => ({ symbol, side: "LONG" as const, qtyTotal: 2, qtyFilled: 0, leverage: 5, stopDist: 1, targetDist: null, strategyId, proposalId, maxHoldBars: 5, barsWaited: 0, ttlBars: 5, environment: "paper" as const });
const PREV: FPState = { ...initialFuturesPaperState(1000), pending: { ETHUSDT: pend("ETHUSDT", "Q", "s2") } };
const ATTEMPT = { events: [ev(1, "entry_fill", "ETHUSDT", "Q"), ev(2, "order_accepted", "BTCUSDT", "P")], state: { ...initialFuturesPaperState(1000), pending: { BTCUSDT: pend("BTCUSDT", "P", "s1") } } };
type Want = string; // "<action>:<code>[:<target>]"
// [template, rendered message, expected plan]
const TABLE: [string, string, Want][] = [
  ["approval refused: no paper risk budget for strategy %", "approval refused: no paper risk budget for strategy s1", "recompute:APPROVAL_BUDGET_MISSING:P"],
  ["approval refused: proposal % was already evaluated", "approval refused: proposal P was already evaluated", "recompute:APPROVAL_DUPLICATE_PROPOSAL:P"],
  ["approval refused: % already has a position or a pending entry", "approval refused: BTCUSDT already has a position or a pending entry", "recompute:APPROVAL_SYMBOL_BUSY:P"],
  ["approval refused: approvals are made at the candle close", "approval refused: approvals are made at the candle close", "halt_for_review:APPROVAL_INCONSISTENT"],
  ["approval refused: price is older than % ms", "approval refused: price is older than 5000 ms", "recompute:APPROVAL_PRICE_STALE:P"],
  ["approval refused: proposal age % ms is outside 0..% ms", "approval refused: proposal age 60001 ms is outside 0..60000 ms", "recompute:APPROVAL_PROPOSAL_STALE:P"],
  ["approval refused: index price missing or mark/index basis above %", "approval refused: index price missing or mark/index basis above 0.5", "recompute:APPROVAL_BASIS:P"],
  ["approval refused: stop is on the wrong side of the mark", "approval refused: stop is on the wrong side of the mark", "recompute:APPROVAL_STOP_SIDE:P"],
  ["approval refused: leverage % outside 1..%", "approval refused: leverage 11 outside 1..10", "recompute:APPROVAL_LEVERAGE:P"],
  ["approval refused: quantity % is not a lot-size multiple above the minimum notional", "approval refused: quantity 0.0005 is not a lot-size multiple above the minimum notional", "recompute:APPROVAL_LOT_SIZE:P"],
  ["approval refused: risk % exceeds the per-trade maximum %", "approval refused: risk 11.3 exceeds the per-trade maximum 10", "recompute:APPROVAL_RISK_PER_TRADE:P"],
  ["approval refused: margin % exceeds the per-trade maximum %", "approval refused: margin 250 exceeds the per-trade maximum 200", "recompute:APPROVAL_MARGIN_PER_TRADE:P"],
  ["approval refused: stop is % %% from estimated liquidation (minimum % %%)", "approval refused: stop is 4.6 % from estimated liquidation (minimum 5 %)", "recompute:APPROVAL_LIQUIDATION_BUFFER:P"],
  ["approval refused: daily loss limit reached", "approval refused: daily loss limit reached", "recompute:APPROVAL_DAILY_LOSS:P"],
  ["approval: proposal, strategy and side are required", "approval: proposal, strategy and side are required", "halt_for_review:APPROVAL_INCONSISTENT"],
  ["no paper account risk budget: % refused", "no paper account risk budget: approval refused", "recompute:APPROVAL_ACCOUNT_BUDGET_MISSING:P"],
  ["strategy % budget % would be exceeded at % (usage %)", "strategy s1 budget 12 would be exceeded at approval (usage 13)", "recompute:APPROVAL_STRATEGY_BUDGET:P"],
  ["strategy % budget %-sub-budget:% would be exceeded at % (usage %)", "strategy s1 budget scalping-sub-budget:15 would be exceeded at approval (usage 16)", "recompute:APPROVAL_SUB_BUDGET:P"],
  ["strategy % budget account:% would be exceeded at % (usage %)", "strategy s1 budget account:20 would be exceeded at approval (usage 21)", "recompute:APPROVAL_ACCOUNT_BUDGET:P"],
  ["exposure % would exceed % at %", "exposure 1300 would exceed 1200 at approval", "recompute:APPROVAL_EXPOSURE:P"],
  ["position limit % exceeded at %", "position limit 1 exceeded at approval", "recompute:APPROVAL_POSITION_LIMIT:P"],
  ["free margin would be negative at %", "free margin would be negative at approval", "recompute:APPROVAL_FREE_MARGIN:P"],
  ["no paper risk budget for strategy %: entry fill refused", "no paper risk budget for strategy s2: entry fill refused", "recompute:STRATEGY_BUDGET_MISSING:Q"],
  ["risk approval % expired at % (fill at %)", "risk approval Q expired at 1 (fill at 2)", "recompute:FILL_APPROVAL_EXPIRED:Q"],
  ["entry fill refused: price is older than % ms", "entry fill refused: price is older than 5000 ms", "recompute:FILL_PRICE_STALE:Q"],
  ["daily loss limit reached: entry fill refused", "daily loss limit reached: entry fill refused", "recompute:DAILY_LOSS_LIMIT:Q"],
  ["entry fill does not match the open % position", "entry fill does not match the open ETHUSDT position", "recompute:STRATEGY_IDENTITY_MISMATCH:Q"],
  ["entry fill without a valid risk approval (proposal %)", "entry fill without a valid risk approval (proposal Q)", "halt_for_review:FILL_INCONSISTENT"],
  ["risk approval % is % and cannot fill", "risk approval Q is cancelled and cannot fill", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill does not match the open % risk approval (symbol, side or strategy)", "entry fill does not match the open ETHUSDT risk approval (symbol, side or strategy)", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill precedes its risk approval", "entry fill precedes its risk approval", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill quantity % exceeds the approved remainder % or is not a lot-size multiple", "entry fill quantity 3 exceeds the approved remainder 2 or is not a lot-size multiple", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill price % differs from the taker price % of the recorded candle open", "entry fill price 99 differs from the taker price 100.015 of the recorded candle open", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill fee differs from the database computation", "entry fill fee differs from the database computation", "halt_for_review:FILL_INCONSISTENT"],
  ["entry fill margin differs from the approved leverage", "entry fill margin differs from the approved leverage", "halt_for_review:FILL_INCONSISTENT"],
  ["candle % was already committed with a different payload", "candle 5 was already committed with a different payload", "reload_account:CANDLE_ALREADY_COMMITTED"],
  ["futures paper sequence moved (expected %, found %)", "futures paper sequence moved (expected 1, found 2)", "reload_account:SEQUENCE_MOVED"],
  ["candle % is not after the cursor %", "candle 5 is not after the cursor 5", "reload_account:SEQUENCE_MOVED"],
  ["entries are refused while the account is not active or is halted", "entries are refused while the account is not active or is halted", "reload_account:ACCOUNT_STATE_CHANGED"],
  ["futures paper account is stopped", "futures paper account is stopped", "reload_account:ACCOUNT_STATE_CHANGED"],
  ["candle % has not closed yet", "candle 5 has not closed yet", "wait:CANDLE_NOT_CLOSED"],
];
const planOf = (msg: string, already = {}) => { const p = planLedgerRefusalV3(PREV, ATTEMPT, msg, already); return p.action === "recompute" ? `${p.action}:${p.code}:${[...Object.keys(p.rejected), ...Object.keys(p.refused)].join(",")}` : `${p.action}:${p.code}`; };

describe("E3 — bounded deterministic classification of every 0049 refusal", () => {
  it("every RAISE template in draft 0049 is either in the table or halts the account for review (never a retry)", () => {
    const listed = new Set(TABLE.map(([t]) => t));
    for (const t of TEMPLATES) {
      if (listed.has(t)) continue;
      const msg = t.replace(/%%/g, "%").replace(/%/g, "X");
      expect(planOf(msg), t).toBe("halt_for_review:UNCLASSIFIED_REFUSAL");
    }
    for (const [t] of TABLE) expect(TEMPLATES, t).toContain(t); // the table only names messages the draft really raises
  });
  it.each(TABLE)("%s", (_t, msg, want) => { expect(planOf(msg)).toBe(want); });
  it("every approval code reachable from the database is distinct; codes are bounded", () => {
    const fromDb = new Set(APPROVAL_REFUSALS.map(([, c]) => c));
    for (const c of fromDb) expect(V3_APPROVAL_CODES).toContain(c);
    expect(new Set(V3_APPROVAL_CODES).size).toBe(V3_APPROVAL_CODES.length);
  });
  it("the same approval refusal twice halts (REFUSAL_REPEATED); an approval refusal that cannot be attributed to one proposal halts (AMBIGUOUS_APPROVAL)", () => {
    expect(planOf("approval refused: daily loss limit reached", { rejected: { P: "APPROVAL_DAILY_LOSS" } })).toBe("halt_for_review:REFUSAL_REPEATED");
    const two = { events: [ev(1, "order_accepted", "BTCUSDT", "P"), ev(2, "order_accepted", "ETHUSDT", "R")], state: { ...initialFuturesPaperState(1000), pending: { BTCUSDT: pend("BTCUSDT", "P", "s1"), ETHUSDT: pend("ETHUSDT", "R", "s1") } } };
    expect(planLedgerRefusalV3(PREV, two, "exposure 1 would exceed 0 at approval").action).toBe("halt_for_review");
    expect((planLedgerRefusalV3(PREV, two, "exposure 1 would exceed 0 at approval") as { code: string }).code).toBe("AMBIGUOUS_APPROVAL");
    expect(planLedgerRefusalV3(PREV, two, "approval refused: ETHUSDT already has a position or a pending entry")).toMatchObject({ action: "recompute", rejected: { R: "APPROVAL_SYMBOL_BUSY" } });
    expect(planOf("something nobody wrote")).toBe("halt_for_review:UNCLASSIFIED_REFUSAL");
  });
  it("real database messages classify the same way (risk inflation, leverage, liquidation buffer, basis, proposal age)", async () => {
    const user = freshUser(); await accountBudget(db, user, 100, 40, 60); await strategyBudget(db, user, "s1", "scalping", 30);
    const id = await newAccount(db, user, T0 - M);
    const v = await loadView(db, id);
    const r = stepView(v, [bar("BTCUSDT", T0, M, FLAT), bar("ETHUSDT", T0, M, FLAT)], [intent("real", "BTCUSDT", T0 + M, "LONG", 99, 103)]);
    const tamper = (patch: Record<string, unknown>) => ({ ...r.payload, events: r.payload.events.map((e) => (e.kind === "order_accepted" ? { ...e, ...patch } : e)) });
    const q = r.payload.events.find((e) => e.kind === "order_accepted")!.qty;
    const cases: [unknown, string][] = [
      [tamper({ qty: Math.round(q * 1.5 * 1000) / 1000 }), "APPROVAL_RISK_PER_TRADE"], [tamper({ leverage: 11 }), "APPROVAL_LEVERAGE"],
      [tamper({ stop_price: 95, leverage: 10, qty: 0.05 }), "APPROVAL_LIQUIDATION_BUFFER"], [tamper({ proposal_created_t: T0 + M - 60_001 }), "APPROVAL_PROPOSAL_STALE"],
      [{ ...r.payload, candles: { ...r.payload.candles, BTCUSDT: { ...(r.payload.candles["BTCUSDT"] as object), index_c: 101 } } }, "APPROVAL_BASIS"],
    ];
    for (const [p, code] of cases) {
      const msg = await commitRaw(db, id, v.seq, T0, p).then(() => "committed", (e: Error) => e.message);
      const plan = planLedgerRefusalV3(r.prev, r, msg);
      expect(plan, msg).toMatchObject({ action: "recompute", code, rejected: { "v3prop-real": code } });
      // Applying the plan: the intent becomes a rejection with that code and the database accepts the candle.
      if (code === "APPROVAL_BASIS") {
        const again = stepView(v, [bar("BTCUSDT", T0, M, FLAT), bar("ETHUSDT", T0, M, FLAT)], [intent("real", "BTCUSDT", T0 + M, "LONG", 99, 103)], [], { rejected: (plan as { rejected: Record<string, never> }).rejected });
        expect(again.events.map((e) => e.kind)).toEqual(["order_rejected"]); expect(again.events[0]!.reason).toMatch(/^\[APPROVAL_BASIS\]/);
        expect(await commitRaw(db, id, v.seq, T0, again.payload)).toBe(again.state.seq);
      }
    }
    expect(await as(db, "service_role", `SELECT 1`)).toBeTruthy();
  });
});
