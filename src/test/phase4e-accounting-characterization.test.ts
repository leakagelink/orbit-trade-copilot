// Phase 4E Workstream C — CHARACTERIZATION tests: executable evidence for the accounting mismatches documented in
// docs/phase-4e/paper-engine-accounting-review.md. They pin CURRENT behaviour of the unchanged Phase 4D engine and the
// unchanged draft 0046 (PGlite, single session). They are NOT fixes and nothing here is policy: when an approved fix
// lands, the matching test must be rewritten to the new rule. No real database, exchange, credential or AI call.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState, stepFuturesPaperCandle, type FPBar, type FPCandleContext, type FPConfig, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV2 } from "@/lib/futures-paper-ledger-v2";

const M0046 = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const M = 60_000, COST = 0.13, USER = "00000000-0000-4000-8000-0000000004e1";
const spec = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: spec, ETHUSDT: spec },
  limits: { maxExposure: 5000, maxDailyLoss: 500, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 15 },
};
const T0 = Math.floor(Date.now() / M) * M - 50 * M;
const FLAT = { o: 100, h: 100.2, l: 99.9, c: 100 };
const bars = (k: number): FPBar[] => ["BTCUSDT", "ETHUSDT"].map((symbol) => ({ symbol, t: T0 + k * M, tfMs: M, trade: { ...FLAT, v: 1e6 }, mark: FLAT, index: { c: 100 }, funding: [] }));
const intent = (id: string, symbol: string, k: number): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: id, engine: "scalp_intraday", strategyId: "s1", symbol, market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 110, createdAt: T0 + (k + 1) * M } });
const CTX: FPCandleContext = { accountStatus: "active", accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 } } };

describe("finding C1 — acceptance sizes against closed losses only; fill re-checks reserved open risk", () => {
  it("a second same-strategy entry is ACCEPTED at candle close and then REFUSED at the next open (STRATEGY_BUDGET_EXCEEDED)", () => {
    let s: FPState = initialFuturesPaperState(1000);
    const r0 = stepFuturesPaperCandle(s, CFG, bars(0), [intent("prop-4e-c1-001", "BTCUSDT", 0)], CTX); s = r0.state;
    const r1 = stepFuturesPaperCandle(s, CFG, bars(1), [intent("prop-4e-c1-002", "ETHUSDT", 1)], CTX); s = r1.state;
    expect(r1.events.map((e) => `${e.symbol}:${e.kind}`)).toEqual(["BTCUSDT:entry_fill", "ETHUSDT:order_accepted"]);
    const r2 = stepFuturesPaperCandle(s, CFG, bars(2), [], CTX);
    expect(r2.refusals.map((x) => [x.proposalId, x.code])).toEqual([["prop-4e-c1-002", "STRATEGY_BUDGET_EXCEEDED"]]);
    expect(r2.events.map((e) => `${e.symbol}:${e.kind}`)).toEqual(["ETHUSDT:entry_cancelled"]);
  });
});

let db: PGlite;
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const svc = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => { await db.exec("SET ROLE service_role"); try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE"); } };
async function account(cfg: FPConfig = CFG) {
  const id = (await svc<{ id: string }>(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [USER, JSON.stringify(cfg), JSON.stringify(initialFuturesPaperState(1000))])).rows[0]!.id;
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const commit = (id: string, seq: number, k: number, payload: unknown) => svc(`SELECT public.futures_paper_commit_bar_v2($1, $2, $3, $4::jsonb) AS seq`, [id, seq, T0 + k * M, JSON.stringify(payload)]);
beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(M0046); await svc(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ($1, 's1', 'paper', 1)`, [USER]); }, 120_000);

describe("finding C6 — draft 0046 trusts the worker-supplied risk_amount of an entry fill", () => {
  it("a fill whose true reserved risk (~10 USDT) exceeds a 1 USDT table budget is ACCEPTED when the payload states risk 0", async () => {
    const id = await account();
    const p0 = initialFuturesPaperState(1000), r0 = stepFuturesPaperCandle(p0, CFG, bars(0), [intent("prop-4e-c6-001", "BTCUSDT", 0)], CTX);
    await commit(id, 0, 0, futuresPaperCommitPayloadV2(p0, r0.state, r0.events, r0.marks, COST));
    const r1 = stepFuturesPaperCandle(r0.state, CFG, bars(1), [], CTX);
    const honest = futuresPaperCommitPayloadV2(r0.state, r1.state, r1.events, r1.marks, COST);
    expect(honest.events.find((e) => e.kind === "entry_fill")!.risk_amount!).toBeGreaterThan(9);
    await expect(commit(id, r0.state.seq, 1, honest)).rejects.toThrow(/budget 1 would be exceeded at fill/);
    const understated = { ...honest, events: honest.events.map((e) => (e.kind === "entry_fill" ? { ...e, risk_amount: 0 } : e)) };
    await expect(commit(id, r0.state.seq, 1, understated)).resolves.toBeDefined(); // CURRENT behaviour (finding C6)
  });
});

describe("finding C7 — draft 0046 does not require a prior order_accepted event for an entry fill", () => {
  it("a pending entry injected into the state (never accepted by the Risk Engine) fills and commits", async () => {
    const id = await account({ ...CFG, strategyBudgets: { s1: 100 } });
    await svc(`UPDATE public.strategy_risk_budgets SET max_loss = 100 WHERE user_id = $1 AND strategy_id = 's1'`, [USER]);
    const injected: FPState = { ...initialFuturesPaperState(1000), pending: { BTCUSDT: { symbol: "BTCUSDT", side: "LONG", qtyTotal: 1, qtyFilled: 0, leverage: 5, stopDist: 1, targetDist: 10, strategyId: "s1", proposalId: "prop-4e-c7-never-accepted", maxHoldBars: 30, barsWaited: 0, ttlBars: 3, environment: "paper" } } };
    const r = stepFuturesPaperCandle(injected, { ...CFG, strategyBudgets: { s1: 100 } }, bars(0), [], CTX);
    expect(r.events.map((e) => e.kind)).toEqual(["entry_fill"]);
    await expect(commit(id, 0, 0, futuresPaperCommitPayloadV2(injected, r.state, r.events, r.marks, COST))).resolves.toBeDefined(); // CURRENT behaviour (finding C7)
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id = $1 AND kind = 'order_accepted'`, [id])).rows[0]!.n;
    expect(n).toBe(0);
  });
});
