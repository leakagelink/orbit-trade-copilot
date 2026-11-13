// DRAFT migration 0049 (replacement successor of 0046, not applied) run verbatim in PGlite with real engine output.
// One test per owner requirement of 13 Nov 2026: database-recomputed risk (never the worker's), fills only against a
// valid matching unexpired approval, quantity/price/identity constraints, account budget with Research and Scalping
// sub-budgets including open + pending exposure, per-instrument/strategy costs, idempotency, RLS and rollback.
// Nothing touches the real database. Policy values here are TEST INPUTS (the owner's proposals), NOT approved policy.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaperCandle, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV3 } from "@/lib/futures-paper-ledger-v3";

export const MIGRATION_0049 = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql", "utf8");
const MIGRATION_0046 = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;
const M = 60_000, COST = 0.13;
const spec = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
// Owner's PROPOSED paper values (13 Nov 2026): 5% liquidation buffer, 5 s price age, 60 s proposal expiry, 0.13% cost.
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 5,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: spec, ETHUSDT: spec },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 30, s2: 30, r1: 40 },
};
const T0 = Math.floor(Date.now() / M) * M - 100 * M;
type OHLC = [number, number, number, number];
const FLAT: OHLC = [100, 100.2, 99.9, 100];
const bar = (sym: string, k: number, [o, h, l, c]: OHLC, v = 1e6, funding: FPBar["funding"] = []): FPBar => ({ symbol: sym, t: T0 + k * M, tfMs: M, trade: { o, h, l, c, v }, mark: { o, h, l, c }, index: { c }, funding });
const intent = (id: string, sym: string, k: number, side: "LONG" | "SHORT", stop: number, tp: number, strategyId = "s1"): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: id, engine: "scalp_intraday", strategyId, symbol: sym, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: stop, takeProfitPrice: tp, createdAt: T0 + (k + 1) * M } });
const CTX = { accountStatus: "active" as const, accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 }, s2: { closedLoss: 0, reservedRisk: 0 }, r1: { closedLoss: 0, reservedRisk: 0 } } };
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
let uidN = 0x100;
const freshUser = () => `00000000-0000-4000-8000-${(uidN++).toString(16).padStart(12, "0")}`;

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
const num = async (sql: string) => Number((await db.query<{ n: string }>(`SELECT (${sql})::numeric AS n`)).rows[0]!.n);
async function newAccount(user: string, cfg: FPConfig = CFG, symbols = ["BTCUSDT", "ETHUSDT"]) {
  const r = await as<{ id: string }>("service_role", null, `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', $2, '1m', $3::jsonb, 1000, 0, $4::jsonb) RETURNING id`, [user, symbols, JSON.stringify(cfg), JSON.stringify(initialFuturesPaperState(1000))]);
  const id = r.rows[0]!.id;
  // Test-only, as the table owner: move the cursor into the past so recorded candles can be replayed. API roles cannot.
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const accountBudget = (user: string, total: number, research: number, scalping: number) => as("service_role", null, `INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',$2,$3,$4)
  ON CONFLICT (user_id, environment) DO UPDATE SET max_loss=EXCLUDED.max_loss, research_max_loss=EXCLUDED.research_max_loss, scalping_max_loss=EXCLUDED.scalping_max_loss`, [user, total, research, scalping]);
const strategyBudget = (user: string, strategy: string, engine: "research" | "scalping", max: number) => as("service_role", null, `INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,$2,'paper',$3,$4)
  ON CONFLICT (user_id, strategy_id, environment) DO UPDATE SET max_loss = EXCLUDED.max_loss`, [user, strategy, engine, max]);
async function standardBudgets(user: string) { await accountBudget(user, 100, 40, 60); await strategyBudget(user, "s1", "scalping", 30); await strategyBudget(user, "s2", "scalping", 30); await strategyBudget(user, "r1", "research", 40); }
const commit = (id: string, seq: number, barT: number, payload: unknown) => as<{ seq: string }>("service_role", null, `SELECT public.futures_paper_commit_bar_v3($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, JSON.stringify(payload)]);

type Px = Record<string, OHLC | { px: OHLC; v?: number; funding?: FPBar["funding"] }>;
function step(prev: FPState, k: number, px: Px, intents: FPIntent[] = [], cfg: FPConfig = CFG) {
  const bars = Object.entries(px).map(([sym, p]) => (Array.isArray(p) ? bar(sym, k, p) : bar(sym, k, p.px, p.v, p.funding)));
  const r = stepFuturesPaperCandle(prev, cfg, bars, intents, CTX);
  return { ...r, payload: futuresPaperCommitPayloadV3(prev, r.state, r.events, bars, intents) };
}
type Run = { id: string; state: FPState; all: FPEvent[] };
async function play(run: Run, k: number, px: Px, intents: FPIntent[] = [], cfg: FPConfig = CFG) {
  const r = step(run.state, k, px, intents, cfg);
  const seq = Number((await commit(run.id, run.state.seq, T0 + k * M, r.payload)).rows[0]!.seq);
  expect(seq).toBe(r.state.seq); run.state = r.state; run.all.push(...r.events); return r;
}
type Payload = ReturnType<typeof step>["payload"];
const tamper = (p: Payload, kind: string, patch: Record<string, unknown>): Payload => ({ ...p, events: p.events.map((e) => (e.kind === kind ? { ...e, ...patch } : e)) });
const seqOf = async (id: string) => num(`SELECT seq FROM public.futures_paper_accounts WHERE id='${id}'`);

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION_0049); }, 120_000);

describe("draft 0049 — happy path with real engine output", () => {
  it("approval → fill → exit: the database recomputes approval and fill risk itself and everything reconciles", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const run: Run = { id, state: initialFuturesPaperState(1000), all: [] };
    const r0 = await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("ok-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    const acc = r0.events.find((e) => e.kind === "order_accepted")!;
    const ap = (await db.query<{ risk_amount: string; cost_pct: string; status: string; expires_t: string; leverage: number; budget_engine: string }>(`SELECT * FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).rows[0]!;
    expect(Number(ap.risk_amount)).toBeCloseTo(acc.qty * (1 + 100 * COST / 100), 9); // qty × (stop distance + cost)
    expect(Number(ap.risk_amount)).toBeLessThanOrEqual(10); expect(ap.status).toBe("open"); expect(ap.budget_engine).toBe("scalping");
    expect(Number(ap.expires_t)).toBe(T0 + M + 60_000);
    await play(run, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    const fill = run.all.find((e) => e.kind === "entry_fill")!;
    const row = (await db.query<{ risk_amount: string; fill_id: string }>(`SELECT risk_amount, fill_id FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [id])).rows[0]!;
    expect(Number(row.risk_amount)).toBeCloseTo(fill.qty * 1 + fill.qty * fill.price! * COST / 100, 9);
    expect(row.fill_id).toBe(`ok-1:entry:${T0 + M}`);
    expect((await db.query<{ status: string }>(`SELECT status FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).rows[0]!.status).toBe("filled");
    await play(run, 2, { BTCUSDT: [100.2, 103, 100.1, 102.5], ETHUSDT: FLAT }); // target
    expect(await num(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${id}'`)).toBe(0);
    expect(await num(`SELECT count(*) FROM public.futures_paper_candles WHERE account_id='${id}'`)).toBe(6);
    expect(reconcileFuturesPaper(run.state, run.all, 1000)).toEqual([]);
    expect(await num(`SELECT wallet FROM public.futures_paper_accounts WHERE id='${id}'`)).toBeCloseTo(run.state.wallet, 6);
  });
});

describe("draft 0049 — R1: worker-supplied risk figures are never trusted", () => {
  async function pendingRun() {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const run: Run = { id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent(`r1-${user.slice(-4)}`, "BTCUSDT", 0, "LONG", 99, 102)]);
    return { id, run, fill: step(run.state, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT }) };
  }
  it("refuses a payload carrying risk_amount (even an honest one) or fill_id", async () => {
    const { id, run, fill } = await pendingRun();
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { risk_amount: 0 }))).rejects.toThrow(/computed by the database/);
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { risk_amount: 9.99 }))).rejects.toThrow(/computed by the database/);
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { fill_id: "x" }))).rejects.toThrow(/computed by the database/);
    expect(await seqOf(id)).toBe(run.state.seq);
  });
  it("refuses an understated fee, a margin implying higher leverage, and a fill price that is not the candle's taker price", async () => {
    const { id, run, fill } = await pendingRun(); const e = fill.payload.events.find((x) => x.kind === "entry_fill")!;
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { fee: 0, wallet_delta: 0 }))).rejects.toThrow(/fee differs/);
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { margin_delta: e.margin_delta / 2 }))).rejects.toThrow(/margin differs from the approved leverage/);
    await expect(commit(id, run.state.seq, T0 + M, tamper(fill.payload, "entry_fill", { price: e.price! * 0.99 }))).rejects.toThrow(/differs from the taker price/);
  });
  it("refuses an approval whose quantity was inflated past the per-trade risk the database computes", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("inflate-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    const q = r.payload.events.find((e) => e.kind === "order_accepted")!.qty;
    await expect(commit(id, 0, T0, tamper(r.payload, "order_accepted", { qty: Math.round(q * 1.5 * 1000) / 1000 }))).rejects.toThrow(/risk .* exceeds the per-trade maximum/);
  });
  it("re-runs stop side, leverage, liquidation buffer, proposal age and basis checks itself", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("checks-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    await expect(commit(id, 0, T0, tamper(r.payload, "order_accepted", { stop_price: 100.5 }))).rejects.toThrow(/wrong side/);
    await expect(commit(id, 0, T0, tamper(r.payload, "order_accepted", { leverage: 11 }))).rejects.toThrow(/leverage 11 outside 1\.\.10/);
    // 10×: liquidation ≈ 90.4, stop 99 is 8.6% away — passes 5%; a stop at 95 is 4.6% from liquidation at 10× → refused.
    await expect(commit(id, 0, T0, tamper(r.payload, "order_accepted", { stop_price: 95, leverage: 10, qty: 0.05 }))).rejects.toThrow(/from estimated liquidation/);
    await expect(commit(id, 0, T0, tamper(r.payload, "order_accepted", { proposal_created_t: T0 + M - 60_001 }))).rejects.toThrow(/proposal age/);
    const noIndex = { ...r.payload, candles: { ...r.payload.candles, BTCUSDT: { ...(r.payload.candles["BTCUSDT"] as object), index_c: 101 } } };
    await expect(commit(id, 0, T0, noIndex)).rejects.toThrow(/basis/);
    expect(await num(`SELECT count(*) FROM public.futures_paper_risk_approvals WHERE account_id='${id}'`)).toBe(0);
  });
});

describe("draft 0049 — R2/R3: no fill without a valid, matching, unexpired approval", () => {
  it("refuses a fill whose pending entry was injected into the state with no approval (finding C7)", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const s0 = initialFuturesPaperState(1000);
    const injected: FPState = { ...s0, pending: { BTCUSDT: { symbol: "BTCUSDT", side: "LONG", qtyTotal: 5, qtyFilled: 0, leverage: 5, stopDist: 1, targetDist: 2, strategyId: "s1", proposalId: "ghost-1", maxHoldBars: 30, barsWaited: 0, ttlBars: 5, environment: "paper" } } };
    const r = step(injected, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    expect(r.events.some((e) => e.kind === "entry_fill")).toBe(true);
    await expect(commit(id, 0, T0, r.payload)).rejects.toThrow(/entry fill without a valid risk approval/);
    expect(await seqOf(id)).toBe(0);
  });
  it("refuses a fill in the same candle as its approval, after a cancellation, and above the approved quantity", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const r0 = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("same-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    const acc = r0.payload.events.find((e) => e.kind === "order_accepted")!;
    const sameCandle = { ...r0.payload, events: [...r0.payload.events, { ...acc, seq: acc.seq + 1, kind: "entry_fill", t: T0 + M, price: 100.015, fee: 100.015 * acc.qty * 0.0005, wallet_delta: -100.015 * acc.qty * 0.0005, margin_delta: 100.015 * acc.qty / 5, strategy_id: "s1" }] };
    await expect(commit(id, 0, T0, sameCandle)).rejects.toThrow(/precedes its risk approval/);
    const run: Run = { id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("same-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    const f1 = step(run.state, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    const over = tamper(f1.payload, "entry_fill", { qty: acc.qty + 0.001, fee: f1.payload.events[0]!.fee * (acc.qty + 0.001) / acc.qty, wallet_delta: -f1.payload.events[0]!.fee * (acc.qty + 0.001) / acc.qty, margin_delta: f1.payload.events[0]!.margin_delta * (acc.qty + 0.001) / acc.qty });
    await expect(commit(id, run.state.seq, T0 + M, over)).rejects.toThrow(/exceeds the approved remainder/);
  });
  it("an approval past its expiry (approval time + 60 s) can no longer fill; partial fills before it are kept", async () => {
    const user = freshUser(); await standardBudgets(user);
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } }; const id = await newAccount(user, cfg);
    const run: Run = { id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("exp-1", "BTCUSDT", 0, "LONG", 99, 102)], cfg);
    const thin = { px: FLAT, v: 200 }; // 1% of 200 = 2 units per candle
    await play(run, 1, { BTCUSDT: thin, ETHUSDT: FLAT }, [], cfg); // t = approval time (age 0)
    await play(run, 2, { BTCUSDT: thin, ETHUSDT: FLAT }, [], cfg); // t = approval + 60 s (= expiry, still valid)
    const r3 = step(run.state, 3, { BTCUSDT: thin, ETHUSDT: FLAT }, [], cfg);
    expect(r3.events.some((e) => e.kind === "entry_fill")).toBe(true);
    await expect(commit(id, run.state.seq, T0 + 3 * M, r3.payload)).rejects.toThrow(/risk approval exp-1 expired/);
    expect(await num(`SELECT filled_qty FROM public.futures_paper_risk_approvals WHERE account_id='${id}'`)).toBeCloseTo(4, 9);
  });
  it("the submitted state may carry exactly the open approvals: a missing or altered pending entry is refused", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const r0 = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("st-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    await expect(commit(id, 0, T0, { ...r0.payload, state: { ...r0.payload.state, pending: {} } })).rejects.toThrow(/open risk approval is missing from the state/);
    const p = r0.payload.state.pending["BTCUSDT"]!;
    await expect(commit(id, 0, T0, { ...r0.payload, state: { ...r0.payload.state, pending: { BTCUSDT: { ...p, qtyTotal: p.qtyTotal * 2 } } } })).rejects.toThrow(/does not match its risk approval/);
    await expect(commit(id, 0, T0, { ...r0.payload, state: { ...r0.payload.state, pending: { BTCUSDT: { ...p, stopDist: 0.1 } } } })).rejects.toThrow(/does not match its risk approval/);
  });
  it("a proposal id is approved once per owner, across all accounts", async () => {
    const user = freshUser(); await standardBudgets(user); const id1 = await newAccount(user), id2 = await newAccount(user);
    const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dup-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    await commit(id1, 0, T0, r.payload);
    await expect(commit(id2, 0, T0, r.payload)).rejects.toThrow(/already evaluated/);
  });
});

describe("draft 0049 — R4: account budget with Research and Scalping sub-budgets (open + pending included)", () => {
  it("static nesting: sub-budgets cannot exceed the account budget; strategy budgets cannot exceed their sub-budget", async () => {
    const user = freshUser();
    await expect(strategyBudget(user, "s1", "scalping", 10)).rejects.toThrow(/create the account risk budget/);
    await expect(accountBudget(user, 100, 60, 50)).rejects.toThrow(/sub_budgets_fit/);
    await accountBudget(user, 100, 40, 60);
    await strategyBudget(user, "s1", "scalping", 30); await strategyBudget(user, "s2", "scalping", 30);
    await expect(strategyBudget(user, "s3", "scalping", 1)).rejects.toThrow(/scalping sub-budget would total 61/);
    await expect(strategyBudget(user, "s1", "scalping", 31)).rejects.toThrow(/would total 61/);
    await expect(accountBudget(user, 100, 40, 50)).rejects.toThrow(/sub-budget below the sum of its strategy budgets/);
    await expect(as("service_role", null, `UPDATE public.strategy_risk_budgets SET engine='research' WHERE user_id=$1 AND strategy_id='s1'`, [user])).rejects.toThrow(/frozen/);
    await expect(as("service_role", null, `DELETE FROM public.strategy_risk_budgets WHERE user_id=$1`, [user])).rejects.toThrow();
  });
  it("pending approval risk counts: a second account of the same owner cannot approve past one shared strategy budget", async () => {
    const user = freshUser(); await accountBudget(user, 100, 40, 60); await strategyBudget(user, "s1", "scalping", 12);
    const id1 = await newAccount(user), id2 = await newAccount(user);
    await commit(id1, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("pa-1", "BTCUSDT", 0, "LONG", 99, 102)]).payload);
    const second = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("pa-2", "BTCUSDT", 0, "LONG", 99, 102)]).payload;
    await expect(commit(id2, 0, T0, second)).rejects.toThrow(/strategy s1 budget 12 would be exceeded at approval/);
    expect(await num(`SELECT public.fp3_usage('${user}', 's1', NULL)`)).toBeLessThanOrEqual(12);
  });
  it("defence in depth: even with a corrupted (non-nested) configuration, sub-budget and account usage stay capped", async () => {
    const user = freshUser(); await accountBudget(user, 100, 15, 60); await strategyBudget(user, "r1", "research", 15);
    // Test-only, as the table owner: bypass the static guard to simulate a corrupted configuration.
    await db.exec(`ALTER TABLE public.strategy_risk_budgets DISABLE TRIGGER strategy_risk_budgets_guard; INSERT INTO public.strategy_risk_budgets(user_id,strategy_id,environment,engine,max_loss) VALUES ('${user}','r2','paper','research',15); ALTER TABLE public.strategy_risk_budgets ENABLE TRIGGER strategy_risk_budgets_guard;`);
    const id = await newAccount(user);
    await commit(id, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dd-1", "BTCUSDT", 0, "LONG", 99, 102, "r1")]).payload);
    const run = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dd-1", "BTCUSDT", 0, "LONG", 99, 102, "r1")]);
    const id2 = await newAccount(user);
    const r2 = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("dd-2", "ETHUSDT", 0, "LONG", 99, 102, "r2")]);
    await expect(commit(id2, 0, T0, r2.payload)).rejects.toThrow(/strategy r2 budget research-sub-budget:15 would be exceeded at approval/);
    expect(run.events.length).toBeGreaterThan(0);
  });
  it("pending exposure and pending positions count at approval", async () => {
    const user = freshUser(); await standardBudgets(user);
    const cfgE: FPConfig = { ...CFG, limits: { ...CFG.limits, maxExposure: 1200 } }; const idE = await newAccount(user, cfgE);
    const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("ex-1", "BTCUSDT", 0, "LONG", 99, 102), intent("ex-2", "ETHUSDT", 0, "LONG", 99, 102, "s2")], cfgE);
    const eth = r.payload.events.find((e) => e.kind === "order_accepted" && e.symbol === "ETHUSDT")!;
    expect(eth.qty * 100).toBeLessThanOrEqual(1200 - 885 + 1); // the engine sized ETH into the remaining room
    const inflated = { ...r.payload, events: r.payload.events.map((e) => (e === eth ? { ...e, qty: 5 } : e)) };
    await expect(commit(idE, 0, T0, inflated)).rejects.toThrow(/exposure .* would exceed 1200 at approval/);
    const user2 = freshUser(); await standardBudgets(user2);
    const cfgP: FPConfig = { ...CFG, limits: { ...CFG.limits, maxPositions: 1 } }; const idP = await newAccount(user2, cfgP);
    const one = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("pp-1", "BTCUSDT", 0, "LONG", 99, 102)], cfgP);
    const btc = one.payload.events.find((e) => e.kind === "order_accepted")!;
    const forged = { ...one.payload, events: [...one.payload.events, { ...btc, seq: btc.seq + 1, symbol: "ETHUSDT", proposal_id: "pp-2", qty: 1, strategy_id: "s2" }] };
    await expect(commit(idP, 0, T0, forged)).rejects.toThrow(/position limit 1 exceeded at approval/);
  });
});

describe("draft 0049 — R5: cost assumption per instrument / strategy", () => {
  it("resolves exact → strategy-wide → symbol-wide → account default and freezes the value on the approval", async () => {
    const user = freshUser(); await standardBudgets(user);
    expect(await num(`SELECT public.fp3_cost('${user}', 's1', 'BTCUSDT', 0.13)`)).toBe(0.13);
    await as("service_role", null, `INSERT INTO public.futures_paper_cost_assumptions(user_id, strategy_id, symbol, round_trip_cost_pct) VALUES ($1,'*','BTCUSDT',0.15)`, [user]);
    expect(await num(`SELECT public.fp3_cost('${user}', 's1', 'BTCUSDT', 0.13)`)).toBe(0.15);
    await as("service_role", null, `INSERT INTO public.futures_paper_cost_assumptions(user_id, strategy_id, symbol, round_trip_cost_pct) VALUES ($1,'s1','*',0.11)`, [user]);
    expect(await num(`SELECT public.fp3_cost('${user}', 's1', 'BTCUSDT', 0.13)`)).toBe(0.11);
    await as("service_role", null, `INSERT INTO public.futures_paper_cost_assumptions(user_id, strategy_id, symbol, round_trip_cost_pct) VALUES ($1,'s1','BTCUSDT',0.10)`, [user]);
    expect(await num(`SELECT public.fp3_cost('${user}', 's1', 'BTCUSDT', 0.13)`)).toBe(0.1);
    expect(await num(`SELECT public.fp3_cost('${user}', 's2', 'ETHUSDT', 0.13)`)).toBe(0.13);
    const id = await newAccount(user);
    await commit(id, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("cost-1", "BTCUSDT", 0, "LONG", 99, 102)]).payload);
    expect(await num(`SELECT cost_pct FROM public.futures_paper_risk_approvals WHERE account_id='${id}'`)).toBe(0.1);
  });
  it("a higher cost for the instrument makes the database refuse an approval the engine sized at the account default", async () => {
    const user = freshUser(); await standardBudgets(user);
    await as("service_role", null, `INSERT INTO public.futures_paper_cost_assumptions(user_id, strategy_id, symbol, round_trip_cost_pct) VALUES ($1,'s1','BTCUSDT',0.2)`, [user]);
    const id = await newAccount(user);
    await expect(commit(id, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("cost-2", "BTCUSDT", 0, "LONG", 99, 102)]).payload)).rejects.toThrow(/exceeds the per-trade maximum/);
  });
});

describe("draft 0049 — recomputed funding, exits and liquidations", () => {
  it("refuses fabricated funding cash, an exit P&L that differs, and a liquidation the recorded mark never reached", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const run: Run = { id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("fx-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    await play(run, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    const fund = step(run.state, 2, { BTCUSDT: { px: FLAT, funding: [{ t: T0 + 2 * M, rate: 0.0001 }] }, ETHUSDT: FLAT });
    const fe = fund.payload.events.find((e) => e.kind === "funding")!;
    await expect(commit(id, run.state.seq, T0 + 2 * M, tamper(fund.payload, "funding", { wallet_delta: fe.wallet_delta / 10, margin_delta: fe.wallet_delta / 10 }))).rejects.toThrow(/funding cash differs/);
    await play(run, 2, { BTCUSDT: { px: FLAT, funding: [{ t: T0 + 2 * M, rate: 0.0001 }] }, ETHUSDT: FLAT });
    const exit = step(run.state, 3, { BTCUSDT: [100.2, 103, 100.1, 102.5], ETHUSDT: FLAT });
    const xe = exit.payload.events.find((e) => e.kind === "exit_fill")!;
    await expect(commit(id, run.state.seq, T0 + 3 * M, tamper(exit.payload, "exit_fill", { pnl: xe.pnl + 5, wallet_delta: xe.wallet_delta + 5 }))).rejects.toThrow(/differs from the database computation|reconcile/);
    const pos = run.state.positions["BTCUSDT"]!;
    const liq = (pos.qty * pos.entryPrice - pos.margin) / (pos.qty * (1 - 0.004));
    const fake = { ...exit.payload, events: [{ ...xe, kind: "liquidation", price: liq, fee: 0, pnl: -pos.margin, wallet_delta: -pos.margin, margin_delta: -pos.margin }] };
    await expect(commit(id, run.state.seq, T0 + 3 * M, fake)).rejects.toThrow(/mark never reached/);
  });
});

describe("draft 0049 — R6: idempotency, privileges, RLS, coexistence and rollback", () => {
  it("an identical retried payload returns the original result and writes nothing; a different payload is refused", async () => {
    const user = freshUser(); await standardBudgets(user); const id = await newAccount(user);
    const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("idem-1", "BTCUSDT", 0, "LONG", 99, 102)]);
    const a = Number((await commit(id, 0, T0, r.payload)).rows[0]!.seq), b = Number((await commit(id, 0, T0, r.payload)).rows[0]!.seq);
    expect(a).toBe(b);
    expect(await num(`SELECT count(*) FROM public.futures_paper_risk_approvals WHERE account_id='${id}'`)).toBe(1);
    expect(await num(`SELECT count(*) FROM public.futures_paper_candles WHERE account_id='${id}'`)).toBe(2);
    await expect(commit(id, 0, T0, { ...r.payload, wallet: r.payload.wallet + 0 , state: { ...r.payload.state, seen: [] } })).rejects.toThrow(/different payload/);
  });
  it("owners read only their own rows; no API role can write approvals, candles, positions or events; only service_role may commit", async () => {
    await standardBudgets(A); const id = await newAccount(A);
    await commit(id, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("rls-1", "BTCUSDT", 0, "LONG", 99, 102)]).payload);
    expect((await as("authenticated", A, `SELECT * FROM public.futures_paper_risk_approvals`)).rows.length).toBeGreaterThan(0);
    expect((await as("authenticated", B, `SELECT * FROM public.futures_paper_risk_approvals`)).rows).toHaveLength(0);
    expect((await as("authenticated", B, `SELECT * FROM public.account_risk_budgets`)).rows).toHaveLength(0);
    await expect(as("anon", null, `SELECT * FROM public.futures_paper_risk_approvals`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',1,0,0)`, [A])).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `UPDATE public.futures_paper_risk_approvals SET filled_qty = 0`)).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, `UPDATE public.futures_paper_risk_approvals SET status='cancelled', closed_seq=1`)).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, `INSERT INTO public.futures_paper_candles SELECT * FROM public.futures_paper_candles LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `SELECT public.futures_paper_commit_bar_v3($1, 1, ${T0 + M}, '{}'::jsonb)`, [id])).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `SELECT public.fp3_usage($1, NULL, NULL)`, [A])).rejects.toThrow(/permission denied/);
    // Owner-level bypass of the commit flag is impossible for API roles (the flag check also requires a non-API role).
    await expect(as("service_role", null, `SELECT set_config('futures_paper.commit','on',true); UPDATE public.futures_paper_accounts SET wallet = 1e6`)).rejects.toThrow();
  });
  it("cannot be applied on top of 0046 (same objects); the rollback removes every object it created", async () => {
    const other = new PGlite(); await other.exec(STUB); await other.exec(MIGRATION_0046);
    await expect(other.exec(MIGRATION_0049)).rejects.toThrow(/already exists/);
    await other.close();
    const clean = new PGlite(); await clean.exec(STUB);
    const before = (await clean.query<{ n: number }>(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS n`)).rows[0]!.n;
    await clean.exec(MIGRATION_0049); await clean.exec(ROLLBACK);
    const after = (await clean.query<{ n: number }>(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS n`)).rows[0]!.n;
    expect(Number(after)).toBe(Number(before));
    await clean.close();
  });
});
