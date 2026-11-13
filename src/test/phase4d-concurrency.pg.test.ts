// Phase 4D — genuine multi-session PostgreSQL tests (needs a real server: scripts/futures-paper/concurrency-check-4d.sh
// starts a throwaway local PostgreSQL; skipped when FUTURES_PAPER_PG_URL is unset). Never touches the live database.
//  (a) Draft 0046 + engine fill re-validation: two workers of the same owner commit fills concurrently against one
//      strategy budget; the database serializes them, the loser's refusal is planned (planCommitRefusal) and recomputed
//      into a cancellation, and both accounts advance — no stall, no double reservation.
//  (b/c) Draft 0047 attribution: concurrent partial reductions cannot exceed the attributed fill; the same evidence
//      cannot be attributed twice even when inserted simultaneously.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, planCommitRefusal, stepFuturesPaperCandle, type FPBar, type FPCandleContext, type FPConfig, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV2 } from "@/lib/futures-paper-ledger-v2";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const M0046 = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const M0047 = readFileSync("docs/proposed-migrations/0047_futures_strategy_attribution.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const REAL_STANDINS = `
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text, idempotency_key text NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, idempotency_key));
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, entry_order_id uuid REFERENCES public.orders(id));
CREATE TABLE public.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, position_id uuid, order_id uuid, strategy_id uuid);
GRANT SELECT ON public.orders, public.positions, public.trades TO authenticated; GRANT ALL ON public.orders, public.positions, public.trades TO service_role;`;
const M = 60_000, COST = 0.13, USER = "00000000-0000-4000-8000-0000000004dd";
const spec = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: spec, ETHUSDT: spec },
  limits: { maxExposure: 5000, maxDailyLoss: 500, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 100 },
};
const T0 = Math.floor(Date.now() / M) * M - 50 * M;
const FLAT = { o: 100, h: 100.2, l: 99.9, c: 100 };
const bars = (k: number): FPBar[] => ["BTCUSDT", "ETHUSDT"].map((symbol) => ({ symbol, t: T0 + k * M, tfMs: M, trade: { ...FLAT, v: 1e6 }, mark: FLAT, index: { c: 100 }, funding: [] }));
const intent = (id: string): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: id, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 110, createdAt: T0 + M } });

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb(sql: string) {
  const admin = connect(URL!); const name = `phase4d_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(sql);
  return { url, owner };
}
const svcTx = <T>(s: Sql, f: (tx: postgres.TransactionSql) => Promise<T>) => s.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE service_role"); return f(tx); }) as Promise<T>;

async function ctxFor(s: Sql, account: string, refused?: FPCandleContext["refused"]): Promise<FPCandleContext> {
  const [a] = await s`SELECT status, halted, user_id FROM public.futures_paper_accounts WHERE id = ${account}`;
  const [l] = await s`SELECT coalesce(sum(greatest(0, -net)), 0) v FROM (SELECT sum(wallet_delta) net FROM public.futures_paper_events WHERE user_id = ${a!["user_id"]} AND strategy_id = 's1' AND account_id <> ${account} AND proposal_id IS NOT NULL GROUP BY account_id, proposal_id HAVING bool_or(kind IN ('exit_fill','liquidation'))) q`;
  const [r] = await s`SELECT coalesce(sum(risk_reserved), 0) v FROM public.futures_paper_positions WHERE user_id = ${a!["user_id"]} AND strategy_id = 's1' AND account_id <> ${account}`;
  return { accountStatus: a!["status"] as FPCandleContext["accountStatus"], accountHalted: a!["halted"] as boolean, externalStrategy: { s1: { closedLoss: Number(l!["v"]), reservedRisk: Number(r!["v"]) } }, ...(refused ? { refused } : {}) };
}
async function newAccount(owner: Sql) {
  const id = await svcTx(owner, async (tx) => (await tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ('${USER}', 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', '${JSON.stringify(CFG)}'::jsonb, 1000, 0, '${JSON.stringify(initialFuturesPaperState(1000))}'::jsonb) RETURNING id`))[0]!["id"] as string);
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const commit = (s: Sql, id: string, prev: FPState, k: number, payload: unknown) => svcTx(s, async (tx) => Number((await tx.unsafe(`SELECT public.futures_paper_commit_bar_v2($1, $2, $3, $4::jsonb) AS seq`, [id, prev.seq, T0 + k * M, payload as never]))[0]!["seq"]));

describe.skipIf(!URL)("(a) draft 0046 + engine: concurrent fills against one strategy budget (real PostgreSQL, separate sessions)", () => {
  it("one fill wins, the other is refused by the ledger, planned and recomputed into a cancellation; both accounts advance", async () => {
    const { url, owner } = await freshDb(M0046);
    await svcTx(owner, (tx) => tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ('${USER}', 's1', 'paper', 12)`));
    const ids = [await newAccount(owner), await newAccount(owner)];
    const workers = ids.map(() => connect(url));
    // Candle 0: both accounts accept one proposal each.
    const states: FPState[] = [];
    for (const [i, id] of ids.entries()) {
      const prev = initialFuturesPaperState(1000), r = stepFuturesPaperCandle(prev, CFG, bars(0), [intent(`cc4d-prop-${i}`)], await ctxFor(workers[i]!, id));
      await commit(workers[i]!, id, prev, 0, futuresPaperCommitPayloadV2(prev, r.state, r.events, r.marks, COST)); states.push(r.state);
    }
    // Candle 1: both read the ledger view BEFORE either reserves, then commit simultaneously from separate sessions.
    const ctxs = await Promise.all(ids.map((id, i) => ctxFor(workers[i]!, id)));
    const outcomes = await Promise.all(ids.map(async (id, i) => {
      const sql = workers[i]!, prev = states[i]!; let refused: FPCandleContext["refused"] = {}, ctx = ctxs[i]!; const plans: string[] = [];
      for (let n = 0; n < 3; n++) {
        const r = stepFuturesPaperCandle(prev, CFG, bars(1), [], { ...ctx, refused });
        try { await commit(sql, id, prev, 1, futuresPaperCommitPayloadV2(prev, r.state, r.events, r.marks, COST)); return { plans, kinds: r.events.map((e) => e.kind) }; }
        catch (e) {
          const p = planCommitRefusal(prev, r, (e as Error).message, refused); plans.push(`${p.action}:${p.code}`);
          if (p.action !== "recompute") return { plans, kinds: [] as string[] };
          refused = p.refused; ctx = await ctxFor(sql, id);
        }
      }
      return { plans, kinds: [] as string[] };
    }));
    const kinds = outcomes.map((o) => o.kinds.join(",")).sort();
    expect(kinds).toEqual(["entry_cancelled", "entry_fill"]);
    expect(outcomes.map((o) => o.plans.join(",")).sort()).toEqual(["", "recompute:STRATEGY_BUDGET_EXCEEDED"]);
    const [pos] = await owner`SELECT count(*)::int n, coalesce(sum(risk_reserved), 0)::float8 r FROM public.futures_paper_positions`;
    expect(pos!["n"]).toBe(1); expect(pos!["r"] as number).toBeLessThanOrEqual(12);
    const cursors = await owner`SELECT cursor_t::text c FROM public.futures_paper_accounts ORDER BY id`;
    expect(cursors.map((c) => Number(c["c"]))).toEqual([T0 + M, T0 + M]);
  }, 60_000);
});

describe.skipIf(!URL)("(b/c) draft 0047: concurrent attribution writes (real PostgreSQL, separate sessions)", () => {
  async function setup() {
    const { url, owner } = await freshDb(`${REAL_STANDINS}\n${M0047}`);
    const order = await svcTx(owner, async (tx) => {
      const o = (await tx.unsafe(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ('${USER}', 'usd_m_futures', 'production', 'futures:cc4d-0001') RETURNING id`))[0]!["id"] as string;
      await tx.unsafe(`SELECT public.claim_futures_order_strategy_identity('${o}', 'ema-50-200', 1, '${"c".repeat(64)}')`); return o;
    });
    const pos = await svcTx(owner, async (tx) => (await tx.unsafe(`INSERT INTO public.positions(user_id, market_type, execution_environment, entry_order_id) VALUES ('${USER}', 'usd_m_futures', 'production', '${order}') RETURNING id`))[0]!["id"] as string);
    await svcTx(owner, (tx) => tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref) VALUES ('${USER}', 'production', '${order}', 'entry_fill', 1, 'fill-cc')`));
    return { url, owner, order, pos };
  }
  const insert = (s: Sql, order: string, pos: string, qty: number, ref: string, holdMs: number) => svcTx(s, async (tx) => {
    await tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, kind, qty, amount, evidence_ref) VALUES ('${USER}', 'production', '${order}', '${pos}', 'reduction', ${qty}, -1, '${ref}')`);
    await tx.unsafe(`SELECT pg_sleep(${holdMs / 1000})`); return "ok";
  }).catch((e: Error) => e.message);
  it("two simultaneous partial reductions of 0.6 against a 1.0 fill: exactly one commits", async () => {
    const { url, owner, order, pos } = await setup();
    const [s1, s2] = [connect(url), connect(url)];
    const out = await Promise.all([insert(s1, order, pos, 0.6, "red-a", 400), new Promise((r) => setTimeout(r, 100)).then(() => insert(s2, order, pos, 0.6, "red-b", 0))]);
    expect(out.filter((o) => o === "ok")).toHaveLength(1);
    expect(out.find((o) => o !== "ok")).toMatch(/would exceed the attributed filled quantity/);
    const [t] = await owner`SELECT sum(qty)::float8 q FROM public.futures_strategy_attribution_events WHERE kind = 'reduction'`;
    expect(t!["q"]).toBeCloseTo(0.6, 12);
  }, 60_000);
  it("the same evidence inserted simultaneously from two sessions is attributed once", async () => {
    const { url, owner, order, pos } = await setup();
    const [s1, s2] = [connect(url), connect(url)];
    const out = await Promise.all([insert(s1, order, pos, 0.1, "exch-fill-same", 300), new Promise((r) => setTimeout(r, 50)).then(() => insert(s2, order, pos, 0.1, "exch-fill-same", 0))]);
    expect(out.filter((o) => o === "ok")).toHaveLength(1);
    expect(out.find((o) => o !== "ok")).toMatch(/duplicate key|unique/);
    const [t] = await owner`SELECT count(*)::int n FROM public.futures_strategy_attribution_events WHERE evidence_ref = 'exch-fill-same'`;
    expect(t!["n"]).toBe(1);
  }, 60_000);
});
