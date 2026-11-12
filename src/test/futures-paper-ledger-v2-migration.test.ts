// DRAFT migration 0046 (reviewed successor of 0045) run verbatim in PGlite with real engine output. One test per
// corrected invariant plus the preserved 0045 controls. Nothing touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV2 } from "@/lib/futures-paper-ledger-v2";

export const MIGRATION_0046 = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
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
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: spec, ETHUSDT: spec },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 100, s2: 100 },
};
const T0 = Math.floor(Date.now() / M) * M - 100 * M;
type OHLC = [number, number, number, number];
const bar = (sym: string, k: number, [o, h, l, c]: OHLC): FPBar => ({ symbol: sym, t: T0 + k * M, tfMs: M, trade: { o, h, l, c, v: 1e6 }, mark: { o, h, l, c }, index: { c }, funding: [] });
const intent = (id: string, sym: string, k: number, side: "LONG" | "SHORT", stop: number, tp: number, strategyId = "s1"): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: id, engine: "scalp_intraday", strategyId, symbol: sym, market: "usdm_futures", environment: "paper", side, referencePrice: null, stopPrice: stop, takeProfitPrice: tp, createdAt: T0 + (k + 1) * M } });
const FLAT: OHLC = [100, 100.2, 99.9, 100];

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
const count = async (sql: string) => Number((await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)).rows[0]!.n);
async function newAccount(user: string, symbols = ["BTCUSDT", "ETHUSDT"], cfg: FPConfig = CFG) {
  const r = await as<{ id: string; wallet: string; limit_max_daily_loss: string }>("service_role", null, `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', $2, '1m', $3::jsonb, 1000, 0, $4::jsonb) RETURNING id, wallet, limit_max_daily_loss`, [user, symbols, JSON.stringify(cfg), JSON.stringify(initialFuturesPaperState(1000))]);
  const id = r.rows[0]!.id;
  // Test-only, as the table owner: move the cursor into the past so recorded candles can be replayed. API roles cannot.
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return { id, wallet: Number(r.rows[0]!.wallet), dailyLimit: Number(r.rows[0]!.limit_max_daily_loss) };
}
const budget = (user: string, strategy: string, max: number) => as("service_role", null, `INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ($1, $2, 'paper', $3)
  ON CONFLICT (user_id, strategy_id, environment) DO UPDATE SET max_loss = EXCLUDED.max_loss`, [user, strategy, max]);
const commit = (id: string, seq: number | null, barT: number, payload: unknown) => as<{ seq: string }>("service_role", null, `SELECT public.futures_paper_commit_bar_v2($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, payload === null ? null : JSON.stringify(payload)]);

/** One account-wide candle: steps every symbol of the account and builds ONE v2 payload. */
function step(prev: FPState, k: number, px: Record<string, OHLC>, intents: FPIntent[] = []) {
  let s = prev; const events: FPEvent[] = [];
  const marks = Object.fromEntries(Object.entries(px).map(([sym, p]) => [sym, p[3]]));
  for (const sym of Object.keys(px)) { const r = stepFuturesPaper(s, CFG, bar(sym, k, px[sym]!), intents.filter((i) => i.proposal.symbol === sym), marks); s = r.state; events.push(...r.events); }
  return { state: s, events, payload: futuresPaperCommitPayloadV2(prev, s, events, marks, COST) };
}
type Run = { id: string; state: FPState; all: FPEvent[] };
async function play(run: Run, k: number, px: Record<string, OHLC>, intents: FPIntent[] = []) {
  const r = step(run.state, k, px, intents);
  const seq = Number((await commit(run.id, run.state.seq, T0 + k * M, r.payload)).rows[0]!.seq);
  expect(seq).toBe(r.state.seq); run.state = r.state; run.all.push(...r.events); return r;
}

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION_0046); });

describe("draft 0046 — happy path with real engine output", () => {
  it("commits a two-symbol account candle by candle; the database book, ledger and state reconcile", async () => {
    const acc = await newAccount(A); await budget(A, "s1", 100);
    const run: Run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-ok-0001", "BTCUSDT", 0, "LONG", 99, 102)]);
    await play(run, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${acc.id}'`)).toBe(1);
    const fill = (await db.query<{ strategy_id: string; fill_id: string; risk_amount: string }>(`SELECT strategy_id, fill_id, risk_amount FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [acc.id])).rows[0]!;
    expect(fill.strategy_id).toBe("s1"); expect(fill.fill_id).toBe(`prop-ok-0001:entry:${T0 + M}`); expect(Number(fill.risk_amount)).toBeGreaterThan(0);
    await play(run, 2, { BTCUSDT: [100.2, 103, 100.1, 102.5], ETHUSDT: FLAT }); // target
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${acc.id}'`)).toBe(0);
    expect(reconcileFuturesPaper(run.state, run.all, 1000)).toEqual([]);
    const a = (await db.query<{ wallet: string; seq: string }>(`SELECT wallet, seq FROM public.futures_paper_accounts WHERE id=$1`, [acc.id])).rows[0]!;
    expect(Number(a.wallet)).toBeCloseTo(run.state.wallet, 6); expect(Number(a.seq)).toBe(run.state.seq);
    expect(await count(`SELECT count(*) FROM public.futures_paper_commits WHERE account_id='${acc.id}'`)).toBe(3);
  });
});

describe("draft 0046 — corrected invariant 1: null inputs", () => {
  it("refuses a NULL expected sequence, NULL candle and NULL payload (0045 accepted a NULL sequence)", async () => {
    const acc = await newAccount(A); const r = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    await expect(commit(acc.id, null, T0, r.payload)).rejects.toThrow(/all required/);
    await expect(as("service_role", null, `SELECT public.futures_paper_commit_bar_v2($1, 0, NULL, '{}'::jsonb)`, [acc.id])).rejects.toThrow(/all required/);
    await expect(commit(acc.id, 0, T0, null)).rejects.toThrow(/all required/);
    expect(await count(`SELECT seq FROM public.futures_paper_accounts WHERE id='${acc.id}'`)).toBe(0);
  });
});

describe("draft 0046 — corrected invariant 2: wallet and state validation", () => {
  it("refuses the 0045 probe payload {events:[], state:{}} and every mistyped wallet/state field", async () => {
    const acc = await newAccount(A); const good = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }).payload;
    await expect(commit(acc.id, 0, T0, { events: [], state: {} })).rejects.toThrow(/events\[\], state\{\} and marks\{\}/);
    await expect(commit(acc.id, 0, T0, { ...good, state: {} })).rejects.toThrow(/version, positions/);
    await expect(commit(acc.id, 0, T0, { ...good, wallet: "1000" })).rejects.toThrow(/wallet must be a JSON number/);
    await expect(commit(acc.id, 0, T0, { ...good, state: { ...good.state, wallet: null } })).rejects.toThrow(/wallet must be a JSON number/);
    await expect(commit(acc.id, 0, T0, { ...good, state: { ...good.state, seq: "0" } })).rejects.toThrow(/seq must be a JSON number/);
    await expect(commit(acc.id, 0, T0, { ...good, marks: { BTCUSDT: -1 } })).rejects.toThrow(/positive number/);
    await expect(commit(acc.id, 0, T0, { ...good, marks: { DOGEUSDT: 1 } })).rejects.toThrow(/positive number/);
    expect(await count(`SELECT cursor_t = ${T0 - M} FROM public.futures_paper_accounts WHERE id='${acc.id}'`)).toBe(1);
  });
  it("refuses an account whose state misses keys, whose config lacks limits, or whose balance is NaN", async () => {
    const ins = (cfg: unknown, state: unknown, bal: string | number = 1000) => as("service_role", null, `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
      VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT'], '1m', $2::jsonb, $3::numeric, 0, $4::jsonb)`, [A, JSON.stringify(cfg), bal, JSON.stringify(state)]);
    const s0 = initialFuturesPaperState(1000);
    const { positions: _p, ...noPositions } = s0;
    await expect(ins(CFG, noPositions)).rejects.toThrow(/start flat/);
    const { seq: _s, ...noSeq } = s0;
    await expect(ins(CFG, noSeq)).rejects.toThrow(/seq must be a JSON number/);
    await expect(ins({ ...CFG, limits: undefined }, s0)).rejects.toThrow(/limits/);
    await expect(ins({ ...CFG, limits: { ...CFG.limits, maxDailyLoss: null } }, s0)).rejects.toThrow(/maxDailyLoss/);
    await expect(ins(CFG, s0, "NaN")).rejects.toThrow();
  });
});

describe("draft 0046 — corrected invariants 3–5: commit-time risk re-validation of pending fills", () => {
  it("refuses an entry fill without a paper budget for the strategy, writing nothing", async () => {
    const acc = await newAccount(B); const run: Run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-nob-0001", "BTCUSDT", 0, "LONG", 99, 102, "s2")]);
    const before = await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${acc.id}'`);
    const r = step(run.state, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    expect(r.events.some((e) => e.kind === "entry_fill")).toBe(true);
    await expect(commit(acc.id, run.state.seq, T0 + M, r.payload)).rejects.toThrow(/no paper risk budget/);
    expect(await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${acc.id}'`)).toBe(before);
    expect(await count(`SELECT count(*) FROM public.futures_paper_commits WHERE account_id='${acc.id}'`)).toBe(1);
  });
  it("re-checks the strategy budget at fill time across all of the owner's paper accounts", async () => {
    const U = "00000000-0000-4000-8000-0000000000c1"; await budget(U, "s2", 12);
    const a1 = await newAccount(U), a2 = await newAccount(U);
    const r1: Run = { id: a1.id, state: initialFuturesPaperState(1000), all: [] }, r2: Run = { id: a2.id, state: initialFuturesPaperState(1000), all: [] };
    await play(r1, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-bud-0001", "BTCUSDT", 0, "LONG", 99, 102, "s2")]);
    await play(r2, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-bud-0002", "BTCUSDT", 0, "LONG", 99, 102, "s2")]);
    await play(r1, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT }); // reserves ≈ 10 of 12
    const reserved = Number((await db.query<{ r: string }>(`SELECT risk_reserved r FROM public.futures_paper_positions WHERE account_id=$1`, [a1.id])).rows[0]!.r);
    expect(reserved).toBeGreaterThan(6); expect(reserved).toBeLessThan(12);
    const second = step(r2.state, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    await expect(commit(a2.id, r2.state.seq, T0 + M, second.payload)).rejects.toThrow(/budget .* would be exceeded at fill/);
  });
  it("refuses a pending fill once the account is halted (stale worker), and commits the engine's cancellation instead", async () => {
    const acc = await newAccount(A); const run: Run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-halt-001", "BTCUSDT", 0, "LONG", 99, 102)]);
    await as("service_role", null, `UPDATE public.futures_paper_accounts SET halted = true WHERE id='${acc.id}'`);
    const stale = step(run.state, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    await expect(commit(acc.id, run.state.seq, T0 + M, stale.payload)).rejects.toThrow(/entries are refused/);
    run.state = { ...run.state, halted: true };
    const r = await play(run, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    expect(r.events.map((e) => e.kind)).toEqual(["entry_cancelled"]);
  });
  it("refuses a fill when the daily loss (incl. negative unrealized at the supplied marks) is used up, when exposure would exceed the cap, or when a mark is missing", async () => {
    const acc = await newAccount(A); await budget(A, "s1", 100); const run: Run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-dl-00001", "BTCUSDT", 0, "LONG", 99, 102)]);
    await play(run, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT }, [intent("prop-dl-00002", "ETHUSDT", 1, "LONG", 99, 102)]);
    const r = step(run.state, 2, { BTCUSDT: [100.2, 100.4, 99.95, 100.1], ETHUSDT: [100, 100.5, 99.8, 100.2] });
    expect(r.events.some((e) => e.kind === "entry_fill" && e.symbol === "ETHUSDT")).toBe(true);
    const btcQty = run.state.positions["BTCUSDT"]!.qty;
    const crash = 100 - (CFG.limits.maxDailyLoss! + 5) / btcQty; // BTC mark that leaves no daily allowance
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...r.payload, marks: { ...r.payload.marks, BTCUSDT: crash } })).rejects.toThrow(/daily loss limit reached/);
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...r.payload, marks: { ...r.payload.marks, BTCUSDT: 100 * (5000 / (btcQty * 100)) } })).rejects.toThrow(/exposure .* would exceed/);
    const { BTCUSDT: _b, ...noBtc } = r.payload.marks;
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...r.payload, marks: noBtc })).rejects.toThrow(/BTCUSDT must be a JSON number/);
    expect(await count(`SELECT seq FROM public.futures_paper_accounts WHERE id='${acc.id}'`)).toBe(run.state.seq);
    await commit(acc.id, run.state.seq, T0 + 2 * M, r.payload); // the honest payload passes
  });
});

describe("draft 0046 — corrected invariants 6–8: atomic valid state, reconciliation, crash recovery", () => {
  let run: Run;
  it("refuses tampered per-kind arithmetic, a state that disagrees with the database book, and a partial close — atomically", async () => {
    const acc = await newAccount(A); await budget(A, "s1", 100); run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }, [intent("prop-rec-0001", "BTCUSDT", 0, "LONG", 99, 102)]);
    await play(run, 1, { BTCUSDT: [100, 100.5, 99.8, 100.2], ETHUSDT: FLAT });
    const r = step(run.state, 2, { BTCUSDT: [100.2, 103, 100.1, 102.5], ETHUSDT: FLAT });
    const exitIdx = r.payload.events.findIndex((e) => e.kind === "exit_fill");
    const tamper = (f: (e: Record<string, unknown>) => Record<string, unknown>) => ({ ...r.payload, events: r.payload.events.map((e, i) => (i === exitIdx ? f(e) : e)) });
    const before = await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${acc.id}'`);
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, tamper((e) => ({ ...e, wallet_delta: (e.wallet_delta as number) + 5 })))).rejects.toThrow(/kind_shape/);
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, tamper((e) => ({ ...e, qty: (e.qty as number) / 2 })))).rejects.toThrow(/close quantity/);
    const kept = step(run.state, 2, { BTCUSDT: [100.2, 100.4, 100.1, 100.3], ETHUSDT: FLAT }); // position stays open
    const p = kept.state.positions["BTCUSDT"]!;
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...kept.payload, state: { ...kept.state, positions: { BTCUSDT: { ...p, qty: p.qty * 2 } } } })).rejects.toThrow(/does not reconcile/);
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...kept.payload, state: { ...kept.state, positions: {} } })).rejects.toThrow(/position the state does not/);
    await expect(commit(acc.id, run.state.seq, T0 + 2 * M, { ...kept.payload, wallet: kept.state.wallet + 1 })).rejects.toThrow(/reconcile/);
    expect(await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${acc.id}'`)).toBe(before);
    expect(await count(`SELECT count(*) FROM public.futures_paper_positions WHERE account_id='${acc.id}'`)).toBe(1);
  });
  it("replaying a committed candle with the same payload returns the original result and writes nothing; a different payload is refused", async () => {
    const prev = run.state, r = await play(run, 2, { BTCUSDT: [100.2, 100.4, 100.1, 100.3], ETHUSDT: FLAT });
    const n = await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${run.id}'`);
    const again = Number((await commit(run.id, prev.seq, T0 + 2 * M, r.payload)).rows[0]!.seq);
    expect(again).toBe(r.state.seq);
    expect(await count(`SELECT count(*) FROM public.futures_paper_events WHERE account_id='${run.id}'`)).toBe(n);
    await expect(commit(run.id, prev.seq, T0 + 2 * M, { ...r.payload, marks: { BTCUSDT: 100.31, ETHUSDT: 100 } })).rejects.toThrow(/already committed with a different payload/);
  });
  it("a fill id can never be recorded twice", async () => {
    const fill = (await db.query<Record<string, unknown>>(`SELECT * FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [run.id])).rows[0]!;
    const dup = { seq: run.state.seq + 1, t: T0 + 3 * M, symbol: "BTCUSDT", kind: "entry_fill", side: "LONG", qty: Number(fill["qty"]), price: Number(fill["price"]), fee: Number(fill["fee"]), pnl: 0, wallet_delta: -Number(fill["fee"]), margin_delta: Number(fill["margin_delta"]), reason: "replayed", proposal_id: fill["proposal_id"], strategy_id: "s1", fill_id: fill["fill_id"], risk_amount: 0 };
    const r = step(run.state, 3, { BTCUSDT: [100.3, 100.4, 100.2, 100.3], ETHUSDT: FLAT });
    await expect(commit(run.id, run.state.seq, T0 + 3 * M, { ...r.payload, events: [dup] })).rejects.toThrow(/fill_once/);
  });
});

describe("draft 0046 — preserved 0045 controls", () => {
  it("refuses a stale sequence, a repeated or future candle", async () => {
    const acc = await newAccount(A); const run: Run = { id: acc.id, state: initialFuturesPaperState(1000), all: [] };
    await play(run, 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }); await play(run, 1, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    const r = step(run.state, 2, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    await expect(commit(acc.id, run.state.seq + 1, T0 + 2 * M, r.payload)).rejects.toThrow(/sequence moved/);
    const older = step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT });
    await expect(commit(acc.id, run.state.seq, T0 - M, older.payload)).rejects.toThrow(/not after the cursor/);
    await expect(commit(acc.id, run.state.seq, Math.floor(Date.now() / M) * M + 5 * M, r.payload)).rejects.toThrow(/not closed|not after/);
  });
  it("history, commits and the book are append-only / function-only, even for the backend setting the flag", async () => {
    for (const role of ["service_role", "authenticated"] as const) {
      await expect(as(role, A, `UPDATE public.futures_paper_events SET pnl = 1`)).rejects.toThrow();
      await expect(as(role, A, `DELETE FROM public.futures_paper_commits`)).rejects.toThrow();
      await expect(as(role, A, `INSERT INTO public.futures_paper_positions(account_id,user_id,symbol,side,qty,entry_price,margin,risk_reserved,strategy_id,proposal_id,opened_bar_t,updated_seq) SELECT id,user_id,'BTCUSDT','LONG',1,1,1,0,'s','p',0,0 FROM public.futures_paper_accounts LIMIT 1`)).rejects.toThrow();
    }
    await expect(db.exec(`TRUNCATE public.futures_paper_events`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.strategy_risk_budgets`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.futures_paper_positions`)).rejects.toThrow(/only through futures_paper_commit_bar_v2/);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET wallet = 5000 WHERE set_config('futures_paper.commit','on',false) = 'on'`)).rejects.toThrow(/only through futures_paper_commit_bar_v2/);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET limit_max_daily_loss = 5000`)).rejects.toThrow(/frozen/);
  });
  it("browser roles read only their own rows and cannot write or commit; a stopped account stays stopped", async () => {
    const own = (await as<{ user_id: string }>("authenticated", B, `SELECT user_id FROM public.futures_paper_accounts`)).rows;
    expect(own.length).toBeGreaterThan(0); expect(own.every((r) => r.user_id === B)).toBe(true);
    expect((await as("authenticated", B, `SELECT * FROM public.futures_paper_positions WHERE user_id <> '${B}'`)).rows).toHaveLength(0);
    await expect(as("authenticated", A, `SELECT public.futures_paper_commit_bar_v2(gen_random_uuid(), 0, 0, '{}'::jsonb)`)).rejects.toThrow(/permission/);
    await expect(as("anon", null, `SELECT * FROM public.futures_paper_events`)).rejects.toThrow(/permission/);
    await expect(as("authenticated", A, `UPDATE public.strategy_risk_budgets SET max_loss = 1000`)).rejects.toThrow(/permission/);
    const acc = await newAccount(A);
    await as("service_role", null, `UPDATE public.futures_paper_accounts SET status = 'stopped' WHERE id='${acc.id}'`);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET status = 'active' WHERE id='${acc.id}'`)).rejects.toThrow(/stays stopped/);
    await expect(commit(acc.id, 0, T0, step(initialFuturesPaperState(1000), 0, { BTCUSDT: FLAT, ETHUSDT: FLAT }).payload)).rejects.toThrow(/stopped/);
  });
  it("references no real-trading, wallet, Spot paper or credential object, has no CASCADE, and rolls back to nothing", async () => {
    expect(MIGRATION_0046).not.toMatch(/public\.(orders|positions|trades|risk_settings|futures_settings|wallets?|wallet_apply|paper_(accounts|strategies|bars|order_events|trades)|exchange_connections|connection_credentials)\b/);
    expect(ROLLBACK.replace(/--.*$/gm, "")).not.toMatch(/CASCADE/i);
    expect(MIGRATION_0046.replace(/--.*$/gm, "")).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/);
    await db.exec(ROLLBACK);
    const left = await db.query<{ n: string }>(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (relname LIKE 'futures_paper%' OR relname LIKE 'strategy_risk%'))
      + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (proname LIKE 'fp2_%' OR proname LIKE '%futures_paper%' OR proname = 'guard_strategy_risk_budget')) AS n`);
    expect(Number(left.rows[0]!.n)).toBe(0);
    await db.exec(MIGRATION_0046); // re-applies cleanly after rollback
  });
});
