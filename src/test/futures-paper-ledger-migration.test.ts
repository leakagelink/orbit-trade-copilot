// Runs DRAFT migration 0045 (Futures paper ledger + strategy budgets) verbatim in PGlite and commits real engine output.
// Nothing touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { futuresPaperCommitPayload, initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPState } from "@/lib/futures-paper-engine";

const MIGRATION = readFileSync("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;
const M = 60_000;
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 } },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: { s1: 100 },
};
const T0 = Math.floor(Date.now() / M) * M - 50 * M;
const bar = (k: number, o: number, h: number, l: number, c: number): FPBar => ({ symbol: "BTCUSDT", t: T0 + k * M, tfMs: M, trade: { o, h, l, c, v: 1e6 }, mark: { o, h, l, c }, index: { c }, funding: [] });

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
async function newAccount(user: string) {
  const r = await as<{ id: string; wallet: string; cursor_t: string }>("service_role", null, `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id, wallet, cursor_t`, [user, JSON.stringify(CFG), JSON.stringify(initialFuturesPaperState(1000))]);
  const id = r.rows[0]!.id;
  // Test-only, as the table owner: move the cursor into the past so recorded candles can be replayed. Backend roles cannot.
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return { id, wallet: Number(r.rows[0]!.wallet) };
}
const commit = (id: string, seq: number, barT: number, payload: unknown) => as("service_role", null, `SELECT public.futures_paper_commit_bar($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, JSON.stringify(payload)]);

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION); }, 120_000);

describe("draft migration 0045 — Futures paper ledger", () => {
  let acct: string; let state: FPState = initialFuturesPaperState(1000); const all: FPEvent[] = [];

  it("creates a flat account whose wallet is set by the database", async () => {
    const a = await newAccount(A); acct = a.id; expect(a.wallet).toBe(1000);
  });

  it("commits real engine candles atomically with consecutive sequences and a reconciled wallet", async () => {
    const steps: [FPBar, boolean][] = [[bar(0, 100, 100, 100, 100), true], [bar(1, 100, 100.5, 99.8, 100.2), false], [bar(2, 100.2, 103, 100.1, 102.5), false]];
    for (const [b, withIntent] of steps) {
      const intents = withIntent ? [{ maxHoldBars: 30, proposal: { proposalId: "prop-db-0001", engine: "scalp_intraday" as const, strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures" as const, environment: "paper" as const, side: "LONG" as const, referencePrice: null, stopPrice: 99, takeProfitPrice: 102, createdAt: b.t + M } }] : [];
      const r = stepFuturesPaper(state, CFG, b, intents);
      const seq = (await commit(acct, state.seq, b.t, futuresPaperCommitPayload(r.state, r.events))).rows[0] as { seq: number };
      expect(Number(seq.seq)).toBe(r.state.seq);
      state = r.state; all.push(...r.events);
    }
    const rows = (await db.query<{ seq: number; wallet_after: string }>(`SELECT seq, wallet_after FROM public.futures_paper_events WHERE account_id=$1 ORDER BY seq`, [acct])).rows;
    expect(rows.map((r) => Number(r.seq))).toEqual(all.map((e) => e.seq));
    expect(Number(rows.at(-1)!.wallet_after)).toBeCloseTo(state.wallet, 6);
    expect(reconcileFuturesPaper(state, all, 1000)).toEqual([]);
    const acc = (await db.query<{ wallet: string; seq: string }>(`SELECT wallet, seq FROM public.futures_paper_accounts WHERE id=$1`, [acct])).rows[0]!;
    expect(Number(acc.wallet)).toBeCloseTo(state.wallet, 6); expect(Number(acc.seq)).toBe(state.seq);
  });

  it("refuses a stale sequence, a repeated or future candle, and a wallet that does not reconcile — writing nothing", async () => {
    const before = Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_events`)).rows[0]!.n);
    const r = stepFuturesPaper(state, CFG, bar(3, 102.5, 102.6, 102.4, 102.5), []);
    await expect(commit(acct, state.seq - 1, T0 + 3 * M, futuresPaperCommitPayload(r.state, r.events))).rejects.toThrow(/sequence moved/);
    await expect(commit(acct, state.seq, T0 + 2 * M, futuresPaperCommitPayload(r.state, r.events))).rejects.toThrow(/not after the cursor/);
    await expect(commit(acct, state.seq, Math.floor(Date.now() / M) * M + 5 * M, futuresPaperCommitPayload(r.state, r.events))).rejects.toThrow(/not closed|not after/);
    const funding = { ...futuresPaperCommitPayload(state, []), events: [{ seq: state.seq + 1, t: T0 + 3 * M, symbol: "BTCUSDT", kind: "funding", side: "LONG", qty: 1, price: 100, fee: 0, pnl: 0, wallet_delta: -1, margin_delta: -1, reason: "x", proposal_id: null }] };
    await expect(commit(acct, state.seq, T0 + 3 * M, funding)).rejects.toThrow(/reconcile/);
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_events`)).rows[0]!.n)).toBe(before);
  });

  it("history is append-only and ledger columns cannot be edited, even by the backend setting the flag", async () => {
    for (const role of ["service_role", "authenticated"] as const) {
      await expect(as(role, A, `UPDATE public.futures_paper_events SET pnl = 1 WHERE account_id='${acct}'`)).rejects.toThrow();
      await expect(as(role, A, `DELETE FROM public.futures_paper_events WHERE account_id='${acct}'`)).rejects.toThrow();
    }
    await expect(db.exec(`TRUNCATE public.futures_paper_events`)).rejects.toThrow(/append-only/);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET wallet = 5000 WHERE id='${acct}' AND set_config('futures_paper.commit','on',false) = 'on'`)).rejects.toThrow(/only through futures_paper_commit_bar/);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET starting_balance = 5000 WHERE id='${acct}'`)).rejects.toThrow(/frozen/);
    await expect(as("service_role", null, `DELETE FROM public.futures_paper_accounts WHERE id='${acct}'`)).rejects.toThrow();
  });

  it("refuses entries while halted but still records exits; a stopped account stays stopped", async () => {
    const b = await newAccount(B);
    await as("service_role", null, `UPDATE public.futures_paper_accounts SET halted = true WHERE id='${b.id}'`);
    const r = stepFuturesPaper(initialFuturesPaperState(1000), CFG, bar(0, 100, 100, 100, 100), [{ maxHoldBars: 30, proposal: { proposalId: "prop-db-0002", engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 102, createdAt: T0 + M } }]);
    await expect(commit(b.id, 0, T0, futuresPaperCommitPayload(r.state, r.events))).rejects.toThrow(/entries are refused/);
    await as("service_role", null, `UPDATE public.futures_paper_accounts SET status = 'stopped' WHERE id='${b.id}'`);
    await expect(as("service_role", null, `UPDATE public.futures_paper_accounts SET status = 'active' WHERE id='${b.id}'`)).rejects.toThrow(/stays stopped/);
  });

  it("browser roles read only their own rows and cannot write or commit", async () => {
    expect((await as("authenticated", A, `SELECT id FROM public.futures_paper_accounts`)).rows.map((r) => (r as { id: string }).id)).toEqual([acct]);
    expect((await as("authenticated", B, `SELECT * FROM public.futures_paper_events`)).rows).toHaveLength(0);
    await expect(as("authenticated", A, `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state) VALUES ('${A}','futures-paper-v1','binance-public-usdm',ARRAY['BTCUSDT'],'1m','{}',1000,0,'{}')`)).rejects.toThrow(/permission/);
    await expect(as("authenticated", A, `SELECT public.futures_paper_commit_bar('${acct}', 0, 0, '{}'::jsonb)`)).rejects.toThrow(/permission/);
    await expect(as("anon", null, `SELECT * FROM public.futures_paper_accounts`)).rejects.toThrow(/permission/);
  });

  it("strategy risk budgets: backend writes, owners read their own, nobody deletes", async () => {
    await as("service_role", null, `INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ($1, 'futures-scalp-intraday', 'paper', 25)`, [A]);
    expect((await as("authenticated", A, `SELECT max_loss FROM public.strategy_risk_budgets`)).rows).toHaveLength(1);
    expect((await as("authenticated", B, `SELECT max_loss FROM public.strategy_risk_budgets`)).rows).toHaveLength(0);
    await expect(as("authenticated", A, `UPDATE public.strategy_risk_budgets SET max_loss = 1000`)).rejects.toThrow(/permission/);
    await expect(as("service_role", null, `DELETE FROM public.strategy_risk_budgets`)).rejects.toThrow();
  });

  it("touches no real-trading, wallet, Spot paper or credential object, and rolls back cleanly", async () => {
    expect(MIGRATION).not.toMatch(/public\.(orders|positions|trades|risk_settings|futures_settings|wallets?|wallet_apply|paper_(accounts|strategies|bars|order_events|trades)|exchange_connections|connection_credentials)\b/);
    await db.exec(ROLLBACK);
    expect((await db.query(`SELECT to_regclass('public.futures_paper_events') AS t`)).rows[0]).toEqual({ t: null });
  });
});
