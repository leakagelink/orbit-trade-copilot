// Phase 4D — Futures paper fill-time risk re-validation. The engine re-checks every pending entry fill with the same
// definitions as draft migration 0046 (not applied), refuses unsafe fills with a reason code, and never stalls on a
// fill the database would refuse. Pure engine tests first, then real engine output committed to draft 0046 in PGlite.
// Nothing touches the real database, an exchange, or any order path.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  FuturesPaperDataError, initialFuturesPaperState, planCommitRefusal, reconcileFuturesPaper, stepFuturesPaper, stepFuturesPaperCandle,
  type FPBar, type FPCandleContext, type FPConfig, type FPEvent, type FPFillContext, type FPIntent, type FPState,
} from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV2 } from "@/lib/futures-paper-ledger-v2";

const M = 60_000, DAY = 86_400_000, COST = 0.13;
const spec = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: spec, ETHUSDT: spec },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 100, s2: 100 },
};
const withLimits = (l: Partial<FPConfig["limits"]>, x: Partial<FPConfig> = {}): FPConfig => ({ ...CFG, ...x, limits: { ...CFG.limits, ...l } });
// Candles in the past, all inside one UTC day (the daily-loss boundary is the UTC day of the candle).
let T0 = Math.floor(Date.now() / M) * M - 100 * M;
if (Math.floor(T0 / DAY) !== Math.floor((T0 + 20 * M) / DAY)) T0 -= 30 * M;
type OHLC = [number, number, number, number];
const FLAT: OHLC = [100, 100.2, 99.9, 100];
const bar = (sym: string, k: number, [o, h, l, c]: OHLC, v = 1e6): FPBar => ({ symbol: sym, t: T0 + k * M, tfMs: M, trade: { o, h, l, c, v }, mark: { o, h, l, c }, index: { c }, funding: [] });
const intent = (id: string, sym: string, k: number, side: "LONG" | "SHORT", stop: number, tp: number, strategyId = "s1"): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: id, engine: "scalp_intraday", strategyId, symbol: sym, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: stop, takeProfitPrice: tp, createdAt: T0 + (k + 1) * M } });
const ACTIVE = (x: Partial<FPCandleContext> = {}): FPCandleContext => ({ accountStatus: "active", accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 }, s2: { closedLoss: 0, reservedRisk: 0 } }, ...x });

/** Drives account-wide candles through the engine only. */
function sim(cfg = CFG, start = initialFuturesPaperState(cfg.startingBalance)) {
  const all: FPEvent[] = [];
  const api = {
    s: start, all,
    candle(k: number, px: Record<string, OHLC>, intents: FPIntent[] = [], ctx = ACTIVE(), vol?: number) {
      const r = stepFuturesPaperCandle(api.s, cfg, Object.entries(px).map(([sym, p]) => bar(sym, k, p, vol)), intents, ctx);
      api.s = r.state; all.push(...r.events); return r;
    },
  };
  return api;
}
const kinds = (es: FPEvent[]) => es.map((e) => `${e.symbol}:${e.kind}`);

describe("fill-time re-validation (pure engine)", () => {
  it("1. daily loss breached immediately before the fill: a stop-out earlier in the same candle refuses the pending fill", () => {
    const cfg = withLimits({ maxDailyLoss: 20 });
    const x = sim(cfg);
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-dl-btc", "BTCUSDT", 0, "LONG", 99, 110)]);
    x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-dl-eth", "ETHUSDT", 1, "LONG", 99, 110)]);
    expect(x.s.pending["ETHUSDT"]).toBeDefined(); // accepted while the daily allowance was intact
    const r = x.candle(2, { BTCUSDT: [97, 97.2, 96.8, 97], ETHUSDT: FLAT }); // BTC gaps through its stop first
    expect(kinds(r.events)).toEqual(["BTCUSDT:exit_fill", "ETHUSDT:entry_cancelled"]);
    expect(r.refusals).toMatchObject([{ symbol: "ETHUSDT", proposalId: "p-dl-eth", code: "DAILY_LOSS_LIMIT", source: "engine" }]);
    expect(r.events[1]!.reason).toMatch(/^fill refused \[DAILY_LOSS_LIMIT\]/);
    expect([r.events[1]!.walletDelta, r.events[1]!.marginDelta, r.events[1]!.fee]).toEqual([0, 0, 0]);
    expect(x.s.positions).toEqual({}); expect(x.s.pending).toEqual({});
    expect(reconcileFuturesPaper(x.s, x.all, 1000)).toEqual([]);
  });
  it("2. strategy budget exhausted immediately before the fill (another paper account consumed it after acceptance)", () => {
    const x = sim();
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-bud", "BTCUSDT", 0, "LONG", 99, 110)]);
    const r = x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ACTIVE({ externalStrategy: { s1: { closedLoss: 85, reservedRisk: 6 } } }));
    expect(r.refusals.map((f) => f.code)).toEqual(["STRATEGY_BUDGET_EXCEEDED"]);
    expect(r.events.some((e) => e.kind === "entry_fill")).toBe(false);
    // Unknown usage is never treated as zero.
    const y = sim(); y.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-bud2", "BTCUSDT", 0, "LONG", 99, 110)]);
    expect(y.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ACTIVE({ externalStrategy: {} })).refusals[0]!.code).toBe("STRATEGY_USAGE_UNKNOWN");
    // Budget missing from the configuration → refused.
    const z = sim(); z.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-bud3", "BTCUSDT", 0, "LONG", 99, 110)]);
    const noBudget = stepFuturesPaperCandle(z.s, { ...CFG, strategyBudgets: {} }, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE());
    expect(noBudget.refusals[0]!.code).toBe("STRATEGY_BUDGET_MISSING");
  });
  it("3. account exposure limit reached immediately before the fill (the held position's mark rose)", () => {
    const x = sim(withLimits({ maxExposure: 1000 }));
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-ex-btc", "BTCUSDT", 0, "LONG", 99, 110)]);
    x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-ex-eth", "ETHUSDT", 1, "LONG", 99, 110)]);
    expect(x.s.pending["ETHUSDT"]!.qtyTotal).toBeGreaterThan(0);
    const r = x.candle(2, { BTCUSDT: [101, 101.2, 100.9, 101], ETHUSDT: FLAT });
    expect(r.refusals.map((f) => [f.symbol, f.code])).toEqual([["ETHUSDT", "EXPOSURE_LIMIT"]]);
    expect(Object.keys(x.s.positions)).toEqual(["BTCUSDT"]);
  });
  it("4. position count limit reached immediately before the fill (state reloaded with a position acceptance did not see)", () => {
    const x = sim(withLimits({ maxPositions: 1 }));
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-pc", "BTCUSDT", 0, "LONG", 99, 110)]);
    const s: FPState = structuredClone(x.s);
    s.positions["ETHUSDT"] = { symbol: "ETHUSDT", side: "LONG", qty: 0.5, entryPrice: 100, leverage: 5, margin: 10, stop: 99, target: 110, stopDist: 1, targetDist: 10, openedAt: T0, bars: 1, maxHoldBars: 30, strategyId: "s2", proposalId: "p-other", fees: 0, funding: 0 };
    const r = stepFuturesPaperCandle(s, withLimits({ maxPositions: 1 }), [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE());
    expect(r.refusals.map((f) => f.code)).toEqual(["POSITION_LIMIT"]);
    expect(r.state.positions["BTCUSDT"]).toBeUndefined();
  });
  it("5. free margin insufficient immediately before the fill (price gapped up): refused and cancelled, no margin consumed", () => {
    const cfg = { ...CFG, startingBalance: 200 };
    const x = sim(cfg);
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-fm", "BTCUSDT", 0, "LONG", 99, 110)]);
    const r = x.candle(1, { BTCUSDT: [125, 125.2, 124.9, 125], ETHUSDT: [125, 125.2, 124.9, 125] });
    expect(r.refusals.map((f) => f.code)).toEqual(["FREE_MARGIN"]);
    expect(x.s.positions).toEqual({}); expect(x.s.pending).toEqual({}); expect(x.s.wallet).toBe(200);
    expect(reconcileFuturesPaper(x.s, x.all, 200)).toEqual([]);
  });
  it("6. account halted (or paused) after order creation but before the fill: the pending entry never fills", () => {
    const x = sim();
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-h", "BTCUSDT", 0, "LONG", 99, 110)]);
    const halted = stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [intent("p-h2", "ETHUSDT", 1, "LONG", 99, 110)], ACTIVE({ accountHalted: true }));
    expect(halted.refusals.map((f) => f.code)).toEqual(["ACCOUNT_HALTED"]);
    expect(halted.state.halted).toBe(true); expect(halted.state.pending).toEqual({});
    expect(halted.events.filter((e) => e.kind === "order_accepted")).toEqual([]);
    const paused = stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [intent("p-h3", "ETHUSDT", 1, "LONG", 99, 110)], ACTIVE({ accountStatus: "paused" }));
    expect(paused.refusals.map((f) => f.code)).toEqual(["ACCOUNT_NOT_ACTIVE"]);
    expect(paused.events.map((e) => e.kind)).toEqual(["entry_cancelled", "order_rejected"]);
  });
  const twoOpen = () => {
    const x = sim();
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-m-eth", "ETHUSDT", 0, "LONG", 99, 110, "s2")]);
    x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-m-btc", "BTCUSDT", 1, "LONG", 99, 110)]);
    expect(Object.keys(x.s.positions)).toEqual(["ETHUSDT"]); expect(x.s.pending["BTCUSDT"]).toBeDefined();
    return x;
  };
  const ctx = (marks: FPFillContext["marks"], maxMarkAgeMs = M): FPFillContext => ({ ...ACTIVE(), marks, maxMarkAgeMs });
  it("7. missing mark for an existing position: the fill is refused (single step), or the whole candle is refused (account candle)", () => {
    const x = twoOpen();
    const r = stepFuturesPaper(x.s, CFG, bar("BTCUSDT", 2, FLAT), [], {}, ctx({ BTCUSDT: { price: 100, t: T0 + 2 * M } }));
    expect(r.refusals.map((f) => f.code)).toEqual(["MARK_MISSING"]);
    expect(r.state.positions["BTCUSDT"]).toBeUndefined();
    const before = JSON.stringify(x.s);
    expect(() => stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 2, FLAT)], [], ACTIVE())).toThrow(/no candle for held symbol ETHUSDT/);
    expect(JSON.stringify(x.s)).toBe(before);
  });
  it("8. stale or future-dated mark refuses the fill; a fresh one passes", () => {
    const x = twoOpen(), t = T0 + 2 * M;
    const stale = stepFuturesPaper(x.s, CFG, bar("BTCUSDT", 2, FLAT), [], {}, ctx({ BTCUSDT: { price: 100, t }, ETHUSDT: { price: 100, t: t - 2 * M } }));
    expect(stale.refusals.map((f) => f.code)).toEqual(["MARK_STALE"]);
    const future = stepFuturesPaper(x.s, CFG, bar("BTCUSDT", 2, FLAT), [], {}, ctx({ BTCUSDT: { price: 100, t }, ETHUSDT: { price: 100, t: t + 1 } }));
    expect(future.refusals.map((f) => f.code)).toEqual(["MARK_INVALID"]);
    const fresh = stepFuturesPaper(x.s, CFG, bar("BTCUSDT", 2, FLAT), [], {}, ctx({ BTCUSDT: { price: 100, t }, ETHUSDT: { price: 100, t: t - M } }));
    expect(fresh.refusals).toEqual([]); expect(fresh.events.map((e) => e.kind)).toEqual(["entry_fill"]);
  });
  it("9. partial fill within limits: each slice is re-validated on its ACTUAL quantity and the remainder keeps filling", () => {
    const cfg = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const x = sim(cfg);
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-pf", "BTCUSDT", 0, "LONG", 99, 110)]);
    const total = x.s.pending["BTCUSDT"]!.qtyTotal;
    const a = x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ACTIVE(), 500); // cap 5 units
    expect(a.events.find((e) => e.kind === "entry_fill")!.qty).toBeCloseTo(5, 9);
    const b = x.candle(2, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ACTIVE(), 500);
    expect(b.events.find((e) => e.kind === "entry_fill")!.qty).toBeCloseTo(total - 5, 9);
    expect([...a.refusals, ...b.refusals]).toEqual([]);
    expect(x.s.positions["BTCUSDT"]!.qty).toBeCloseTo(total, 9); expect(x.s.pending).toEqual({});
  });
  it("10. partial fill exceeding limits: the next slice is refused; the filled part stays open and protected", () => {
    const cfg = { ...withLimits({ maxExposure: 1000 }), costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const x = sim(cfg);
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-pfx", "BTCUSDT", 0, "LONG", 99, 130)]);
    x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ACTIVE(), 450);
    const held = x.s.positions["BTCUSDT"]!.qty;
    expect(held).toBeCloseTo(4.5, 9);
    const r = x.candle(2, { BTCUSDT: [115, 115.2, 114.9, 115], ETHUSDT: FLAT }, [], ACTIVE(), 450);
    expect(r.refusals.map((f) => f.code)).toEqual(["EXPOSURE_LIMIT"]);
    expect(r.events.filter((e) => e.kind === "entry_fill")).toEqual([]);
    const p = x.s.positions["BTCUSDT"]!;
    expect(p.qty).toBeCloseTo(held, 9); expect(p.stop).toBeLessThan(p.entryPrice); expect(x.s.pending).toEqual({});
    expect(reconcileFuturesPaper(x.s, x.all, 1000)).toEqual([]);
  });
  it("11/12. duplicate and out-of-order account candles are refused with nothing applied", () => {
    const x = sim();
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }); x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    expect(x.s.accountCursor).toBe(T0 + M);
    expect(() => x.candle(1, { BTCUSDT: FLAT, ETHUSDT: FLAT })).toThrow(FuturesPaperDataError);
    expect(() => x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT })).toThrow(/duplicate or out-of-order/);
    expect(() => stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 2, FLAT), bar("ETHUSDT", 3, FLAT)], [], ACTIVE())).toThrow(/not the same candle/);
    expect(() => stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 2, FLAT), bar("BTCUSDT", 2, FLAT)], [], ACTIVE())).toThrow(/appears twice/);
  });
  it("15. multiple symbols under one account-wide cursor: an invalid second candle refuses the whole candle (no partial snapshot)", () => {
    const x = sim();
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-ms-b", "BTCUSDT", 0, "LONG", 99, 110), intent("p-ms-e", "ETHUSDT", 0, "SHORT", 101, 90, "s2")]);
    const before = JSON.stringify(x.s);
    const broken = { ...bar("ETHUSDT", 1, FLAT), mark: null };
    expect(() => stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 1, FLAT), broken], [], ACTIVE())).toThrow(/mark price candle missing/);
    expect(JSON.stringify(x.s)).toBe(before);
    const r = x.candle(1, { ETHUSDT: FLAT, BTCUSDT: FLAT });
    expect(kinds(r.events)).toEqual(["BTCUSDT:entry_fill", "ETHUSDT:entry_fill"]); // fixed symbol order
    expect(r.marks).toEqual({ BTCUSDT: 100, ETHUSDT: 100 });
    expect(r.state.cursors).toEqual({ BTCUSDT: T0 + M, ETHUSDT: T0 + M }); expect(r.state.accountCursor).toBe(T0 + M);
  });
  it("16. a valid pending fill after a previous invalid fill was safely cancelled", () => {
    const x = sim({ ...CFG, startingBalance: 200 });
    x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-v1", "BTCUSDT", 0, "LONG", 99, 110)]);
    x.candle(1, { BTCUSDT: [125, 125.2, 124.9, 125], ETHUSDT: FLAT }, [intent("p-v2", "BTCUSDT", 1, "LONG", 124, 135)]);
    expect(x.s.pending["BTCUSDT"]!.proposalId).toBe("p-v2");
    const r = x.candle(2, { BTCUSDT: [125, 125.2, 124.9, 125], ETHUSDT: FLAT });
    expect(r.refusals).toEqual([]); expect(r.events.map((e) => e.kind)).toEqual(["entry_fill"]);
    expect(reconcileFuturesPaper(x.s, x.all, 200)).toEqual([]);
  });
  it("a malformed ledger context or an invalid pending entry fails closed", () => {
    const x = sim(); x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-mf", "BTCUSDT", 0, "LONG", 99, 110)]);
    expect(() => stepFuturesPaperCandle(x.s, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], { accountStatus: "active" } as unknown as FPCandleContext)).toThrow(/malformed/);
    const s = structuredClone(x.s); s.pending["BTCUSDT"]!.stopDist = Number.NaN;
    expect(stepFuturesPaperCandle(s, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE()).refusals[0]!.code).toBe("PENDING_INVALID");
    const e = structuredClone(x.s); (e.pending["BTCUSDT"] as { environment: string }).environment = "live";
    expect(stepFuturesPaperCandle(e, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE()).refusals[0]!.code).toBe("ENVIRONMENT_MISMATCH");
  });
});

describe("commit-refusal planning (pure)", () => {
  const x = sim(); x.candle(0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("p-pl-b", "BTCUSDT", 0, "LONG", 99, 110), intent("p-pl-e", "ETHUSDT", 0, "LONG", 99, 110, "s2")]);
  const prev = x.s, attempt = stepFuturesPaperCandle(prev, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE());
  it("maps each 0046 refusal to a bounded code, targets only the named strategy, and never loops", () => {
    const p = planCommitRefusal(prev, attempt, "strategy s2 budget 12 would be exceeded at fill (used 0, reserved 10, fill risk 9)");
    expect(p).toEqual({ action: "recompute", refused: { "p-pl-e": "STRATEGY_BUDGET_EXCEEDED" }, code: "STRATEGY_BUDGET_EXCEEDED" });
    expect(planCommitRefusal(prev, attempt, "exposure 6000 would exceed 5000 at fill")).toMatchObject({ action: "recompute", refused: { "p-pl-b": "EXPOSURE_LIMIT", "p-pl-e": "EXPOSURE_LIMIT" } });
    const again = stepFuturesPaperCandle(prev, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ACTIVE({ refused: { "p-pl-e": "STRATEGY_BUDGET_EXCEEDED" } }));
    expect(again.refusals).toMatchObject([{ proposalId: "p-pl-e", source: "ledger", code: "STRATEGY_BUDGET_EXCEEDED" }]);
    expect(planCommitRefusal(prev, again, "strategy s2 budget 12 would be exceeded at fill", { "p-pl-e": "STRATEGY_BUDGET_EXCEEDED" })).toEqual({ action: "halt_for_review", code: "REFUSAL_REPEATED" });
    expect(planCommitRefusal(prev, attempt, "futures paper sequence moved (expected 3, found 4)")).toEqual({ action: "reload_account", code: "SEQUENCE_MOVED" });
    expect(planCommitRefusal(prev, attempt, "entries are refused while the account is not active or is halted")).toEqual({ action: "reload_account", code: "ACCOUNT_STATE_CHANGED" });
    expect(planCommitRefusal(prev, attempt, "candle 1 was already committed with a different payload")).toEqual({ action: "reload_account", code: "CANDLE_ALREADY_COMMITTED" });
    expect(planCommitRefusal(prev, attempt, "wallet does not reconcile with the event ledger")).toEqual({ action: "halt_for_review", code: "UNCLASSIFIED_REFUSAL" });
    expect(JSON.stringify(planCommitRefusal(prev, attempt, "password=hunter2 secret"))).not.toMatch(/hunter2|secret/);
  });
});

// ---------------- Real engine output committed to draft 0046 in PGlite ----------------
const MIGRATION_0046 = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
let db: PGlite;
const svc = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
  await db.exec("SET ROLE service_role;");
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE;"); }
};
const count = async (sql: string) => Number((await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)).rows[0]!.n);
async function newAccount(user: string, cfg = CFG) {
  const r = await svc<{ id: string }>(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, $3, 0, $4::jsonb) RETURNING id`, [user, JSON.stringify(cfg), cfg.startingBalance, JSON.stringify(initialFuturesPaperState(cfg.startingBalance))]);
  const id = r.rows[0]!.id;
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const budget = (user: string, strategy: string, max: number) => svc(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ($1, $2, 'paper', $3) ON CONFLICT (user_id, strategy_id, environment) DO UPDATE SET max_loss = EXCLUDED.max_loss`, [user, strategy, max]);
/** The ledger view a future worker reads: account status/halt plus each strategy's usage in the owner's OTHER accounts. */
async function ledgerContext(account: string, refused?: FPCandleContext["refused"]): Promise<FPCandleContext> {
  const a = (await db.query<{ status: string; halted: boolean; user_id: string }>(`SELECT status, halted, user_id FROM public.futures_paper_accounts WHERE id=$1`, [account])).rows[0]!;
  const ext: FPCandleContext["externalStrategy"] = {};
  for (const sid of ["s1", "s2"]) {
    const loss = await db.query<{ v: string }>(`SELECT coalesce(sum(greatest(0, -net)), 0) v FROM (SELECT sum(wallet_delta) net FROM public.futures_paper_events WHERE user_id=$1 AND strategy_id=$2 AND account_id<>$3 AND proposal_id IS NOT NULL GROUP BY account_id, proposal_id HAVING bool_or(kind IN ('exit_fill','liquidation'))) q`, [a.user_id, sid, account]);
    const res = await db.query<{ v: string }>(`SELECT coalesce(sum(risk_reserved), 0) v FROM public.futures_paper_positions WHERE user_id=$1 AND strategy_id=$2 AND account_id<>$3`, [a.user_id, sid, account]);
    ext[sid] = { closedLoss: Number(loss.rows[0]!.v), reservedRisk: Number(res.rows[0]!.v) };
  }
  return { accountStatus: a.status as FPCandleContext["accountStatus"], accountHalted: a.halted, externalStrategy: ext, ...(refused ? { refused } : {}) };
}
const commit = (id: string, seq: number, barT: number, payload: unknown) => svc<{ seq: string }>(`SELECT public.futures_paper_commit_bar_v2($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, JSON.stringify(payload)]).then((r) => Number(r.rows[0]!.seq));
const attemptCandle = (prev: FPState, cfg: FPConfig, k: number, px: Record<string, OHLC>, intents: FPIntent[], ctx: FPCandleContext) => {
  const r = stepFuturesPaperCandle(prev, cfg, Object.entries(px).map(([s, p]) => bar(s, k, p)), intents, ctx);
  return { r, payload: futuresPaperCommitPayloadV2(prev, r.state, r.events, r.marks, cfg.limits.roundTripCostPct!) };
};
/** Worker loop for one candle: commit; on refusal follow planCommitRefusal (bounded); returns the committed result. */
async function workerCandle(id: string, prev: FPState, cfg: FPConfig, k: number, px: Record<string, OHLC>, intents: FPIntent[] = [], staleCtx?: FPCandleContext) {
  let refused: FPCandleContext["refused"] = {}, ctx = staleCtx ?? (await ledgerContext(id)); const plans: string[] = [];
  for (let i = 0; i < 4; i++) {
    const a = attemptCandle(prev, cfg, k, px, intents, { ...ctx, refused });
    try { await commit(id, prev.seq, T0 + k * M, a.payload); return { ...a, plans }; }
    catch (e) {
      const plan = planCommitRefusal(prev, a.r, (e as Error).message, refused); plans.push(`${plan.action}:${plan.code}`);
      if (plan.action !== "recompute") throw new Error(`stopped: ${plan.action} ${plan.code}`);
      refused = plan.refused; ctx = await ledgerContext(id);
    }
  }
  throw new Error("refusal loop bound reached");
}

describe("engine ↔ draft 0046 consistency (PGlite, real engine output)", () => {
  beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION_0046); }, 120_000);
  const U = "00000000-0000-4000-8000-0000000004d1";

  it("engine refusals (daily loss, exposure, free margin) commit as cancellations — the database never stalls the account", async () => {
    await budget(U, "s1", 100); await budget(U, "s2", 100);
    for (const [cfg, px2] of [[withLimits({ maxDailyLoss: 20 }), { BTCUSDT: [97, 97.2, 96.8, 97], ETHUSDT: FLAT }], [withLimits({ maxExposure: 1000 }), { BTCUSDT: [101, 101.2, 100.9, 101], ETHUSDT: FLAT }]] as [FPConfig, Record<string, OHLC>][]) {
      const id = await newAccount(U, cfg); let s = initialFuturesPaperState(1000);
      s = (await workerCandle(id, s, cfg, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent(`db-b-${cfg.limits.maxExposure}`, "BTCUSDT", 0, "LONG", 99, 110)])).r.state;
      s = (await workerCandle(id, s, cfg, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent(`db-e-${cfg.limits.maxExposure}`, "ETHUSDT", 1, "LONG", 99, 110)])).r.state;
      const w = await workerCandle(id, s, cfg, 2, px2);
      expect(w.plans).toEqual([]); expect(w.r.refusals).toHaveLength(1);
      expect(await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${id}' AND kind='entry_cancelled' AND reason LIKE 'fill refused [%'`)).toBe(1);
    }
    const cfg = { ...CFG, startingBalance: 200 }; const id = await newAccount(U, cfg); let s = initialFuturesPaperState(200);
    s = (await workerCandle(id, s, cfg, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("db-fm", "BTCUSDT", 0, "LONG", 99, 110)])).r.state;
    const w = await workerCandle(id, s, cfg, 1, { BTCUSDT: [125, 125.2, 124.9, 125], ETHUSDT: FLAT }, [intent("db-fm-2", "BTCUSDT", 1, "LONG", 124, 135)]);
    expect(w.plans).toEqual([]); expect(w.r.refusals.map((f) => f.code)).toEqual(["FREE_MARGIN"]);
    // 16 (with the database): the next valid proposal fills and commits.
    const v = await workerCandle(id, w.r.state, cfg, 2, { BTCUSDT: [125, 125.2, 124.9, 125], ETHUSDT: FLAT });
    expect(v.r.events.map((e) => e.kind)).toEqual(["entry_fill"]);
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${id}'`)).toBe(1);
  });

  it("13. database commit refusal (cross-account budget race with a stale context) → deterministic cancellation, then the account continues", async () => {
    const V = "00000000-0000-4000-8000-0000000004d2"; await budget(V, "s1", 12); await budget(V, "s2", 100);
    const a1 = await newAccount(V), a2 = await newAccount(V);
    let s1 = initialFuturesPaperState(1000), s2 = initialFuturesPaperState(1000);
    s1 = (await workerCandle(a1, s1, CFG, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("race-1", "BTCUSDT", 0, "LONG", 99, 110)])).r.state;
    s2 = (await workerCandle(a2, s2, CFG, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("race-2", "BTCUSDT", 0, "LONG", 99, 110)])).r.state;
    const stale = await ledgerContext(a2); // read BEFORE account 1 reserves its risk
    s1 = (await workerCandle(a1, s1, CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT })).r.state;
    expect(Object.keys(s1.positions)).toEqual(["BTCUSDT"]);
    const w = await workerCandle(a2, s2, CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], stale);
    expect(w.plans).toEqual(["recompute:STRATEGY_BUDGET_EXCEEDED"]);
    expect(w.r.refusals).toMatchObject([{ proposalId: "race-2", code: "STRATEGY_BUDGET_EXCEEDED", source: "ledger" }]);
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${a2}'`)).toBe(0);
    s2 = w.r.state;
    const next = await workerCandle(a2, s2, CFG, 2, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("race-3", "ETHUSDT", 2, "LONG", 99, 110, "s2")]);
    expect(next.plans).toEqual([]); expect(next.r.events.map((e) => e.kind)).toEqual(["order_accepted"]);
  });

  it("14. crash / lost response: recomputing from the same state gives a byte-identical payload (idempotent), a reloaded state never reprocesses the candle", async () => {
    const W = "00000000-0000-4000-8000-0000000004d3"; await budget(W, "s1", 100);
    const id = await newAccount(W); let s = initialFuturesPaperState(1000);
    s = (await workerCandle(id, s, CFG, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("lost-1", "BTCUSDT", 0, "LONG", 99, 110)])).r.state;
    const ctx = await ledgerContext(id);
    const first = attemptCandle(s, CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ctx);
    const seq = await commit(id, s.seq, T0 + M, first.payload); // response "lost" here
    const n = await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${id}'`);
    const again = attemptCandle(structuredClone(s), CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], ctx);
    expect(JSON.stringify(again.payload)).toBe(JSON.stringify(first.payload));
    expect(await commit(id, s.seq, T0 + M, again.payload)).toBe(seq);
    expect(await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${id}'`)).toBe(n);
    // A recompute with a different ledger view after the commit is refused and planned as a reload, not a retry.
    const diff = attemptCandle(s, CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [], { ...ctx, accountHalted: true });
    const err = await commit(id, s.seq, T0 + M, diff.payload).then(() => "", (e: Error) => e.message);
    expect(planCommitRefusal(s, diff.r, err)).toEqual({ action: "reload_account", code: "CANDLE_ALREADY_COMMITTED" });
    // Reloaded state (as the database holds it) refuses the same candle again.
    const reloaded = (await db.query<{ state: FPState }>(`SELECT state FROM public.futures_paper_accounts WHERE id=$1`, [id])).rows[0]!.state;
    expect(reloaded.accountCursor).toBe(T0 + M);
    expect(() => stepFuturesPaperCandle(reloaded, CFG, [bar("BTCUSDT", 1, FLAT), bar("ETHUSDT", 1, FLAT)], [], ctx)).toThrow(/duplicate or out-of-order/);
  });

  it("15 (with the database). a two-symbol candle commits as ONE record with both symbols' events", async () => {
    const X = "00000000-0000-4000-8000-0000000004d4"; await budget(X, "s1", 100); await budget(X, "s2", 100);
    const id = await newAccount(X); let s = initialFuturesPaperState(1000);
    s = (await workerCandle(id, s, CFG, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("ms-b", "BTCUSDT", 0, "LONG", 99, 110), intent("ms-e", "ETHUSDT", 0, "SHORT", 101, 90, "s2")])).r.state;
    const w = await workerCandle(id, s, CFG, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    expect(kinds(w.r.events)).toEqual(["BTCUSDT:entry_fill", "ETHUSDT:entry_fill"]);
    expect(await count(`SELECT count(*) FROM public.futures_paper_commits WHERE account_id='${id}' AND bar_t=${T0 + M}`)).toBe(1);
    expect(await count(`SELECT count(DISTINCT symbol) FROM public.futures_paper_events WHERE account_id='${id}' AND bar_t=${T0 + M}`)).toBe(2);
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${id}'`)).toBe(2);
  });
});
