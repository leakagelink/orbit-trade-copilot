// Genuine multi-session PostgreSQL tests for DRAFT migration 0049 (replacement of 0046). Needs a real server: run
// scripts/futures-paper/concurrency-check-4f.sh (throwaway local PostgreSQL in /tmp). Skipped when FUTURES_PAPER_PG_URL
// is not set. Never touches the live database. Policy values are TEST INPUTS (the owner's proposals), NOT approved.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaperCandle, type FPBar, type FPConfig, type FPEvent, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV3 } from "@/lib/futures-paper-ledger-v3";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, USER = "00000000-0000-4000-8000-000000000001";
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 } },
  limits: { maxExposure: 5000, maxDailyLoss: 500, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: { s1: 10_000 },
};
const CTX = { accountStatus: "active" as const, accountHalted: false, externalStrategy: { s1: { closedLoss: 0, reservedRisk: 0 } } };
const N = 60, T0 = Math.floor(Date.now() / M) * M - (N + 5) * M;
const BARS: FPBar[] = Array.from({ length: N }, (_, k) => { const c = 100 + 2 * Math.sin(k / 2), o = 100 + 2 * Math.sin((k - 1) / 2); return { symbol: "BTCUSDT", t: T0 + k * M, tfMs: M, trade: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1e6 }, mark: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c }, index: { c }, funding: k % 20 === 10 ? [{ t: T0 + k * M, rate: 0.0001 }] : [] }; });
const QUIET: FPBar[] = BARS.slice(0, 3).map((b) => ({ ...b, trade: { o: 100, h: 100.2, l: 99.9, c: 100, v: 1e6 }, mark: { o: 100, h: 100.2, l: 99.9, c: 100 }, index: { c: 100 }, funding: [] }));
const intents = (k: number, bars = BARS, tag = "cc"): FPIntent[] => (k % 6 === 0 ? [{ maxHoldBars: 8, proposal: { proposalId: `${tag}-prop-${k}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: k % 12 === 0 ? "LONG" : "SHORT", referencePrice: null, stopPrice: bars[k]!.mark!.c * (k % 12 === 0 ? 0.99 : 1.01), takeProfitPrice: bars[k]!.mark!.c * (k % 12 === 0 ? 1.01 : 0.99), createdAt: T0 + (k + 1) * M } }] : []);
const stepK = (s: FPState, k: number, bars = BARS, tag = "cc") => { const its = intents(k, bars, tag); const r = stepFuturesPaperCandle(s, CFG, [bars[k]!], its, CTX); return { ...r, payload: futuresPaperCommitPayloadV3(s, r.state, r.events, [bars[k]!], its) }; };

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!); const name = `fpaper3_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(MIGRATION);
  return { url, owner, admin };
}
async function account(owner: Sql, user = USER) {
  const r = await owner.unsafe(`SET ROLE service_role; INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ('${user}', 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT'], '1m', '${JSON.stringify(CFG)}'::jsonb, 1000, 0, '${JSON.stringify(initialFuturesPaperState(1000))}'::jsonb) RETURNING id; RESET ROLE;`);
  const id = (r as unknown as { id: string }[][]).flat().find((x) => x?.id)!.id;
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const budgets = (owner: Sql, user: string, strategyMax: number, total = 20_000) => owner.unsafe(`SET ROLE service_role;
  INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ('${user}', 'paper', ${total}, 0, ${total});
  INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ('${user}', 's1', 'paper', 'scalping', ${strategyMax}); RESET ROLE;`);
const commitTx = (sql: Sql, id: string, seq: number, barT: number, payload: unknown) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); const r = await tx.unsafe(`SELECT public.futures_paper_commit_bar_v3($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, payload as never]); return Number(r[0]!["seq"]); });

async function worker(sql: Sql, id: string) {
  let wins = 0, losses = 0;
  for (let guard = 0; guard < N * 3; guard++) {
    const [a] = await sql`SELECT seq, cursor_t, state FROM public.futures_paper_accounts WHERE id = ${id}`;
    const cursor = Number(a!["cursor_t"]), k = BARS.findIndex((b) => b.t > cursor); if (k < 0) break;
    const r = stepK(a!["state"] as FPState, k);
    try { const seq = await commitTx(sql, id, Number(a!["seq"]), BARS[k]!.t, r.payload); if (seq === r.state.seq) wins++; }
    catch (e) { if (/sequence moved|not after the cursor|already committed/.test(String(e))) losses++; else throw e; }
  }
  return { wins, losses };
}

describe.skipIf(!URL)("draft 0049 under real concurrent sessions", () => {
  it("racing workers commit every candle exactly once; approvals, fills, ledger and book reconcile with a single-threaded replay", async () => {
    const { url, owner } = await freshDb(); const id = await account(owner); await budgets(owner, USER, 10_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => worker(connect(url), id)));
    expect(results.reduce((a, r) => a + r.wins + r.losses, 0)).toBeGreaterThan(N);
    expect((await owner`SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id = ${id}`)[0]!["n"]).toBe(N);
    const rows = await owner`SELECT * FROM public.futures_paper_events WHERE account_id = ${id} ORDER BY seq`;
    let s = initialFuturesPaperState(1000); const ev: FPEvent[] = [];
    for (let k = 0; k < N; k++) { const r = stepK(s, k); s = r.state; ev.push(...r.events); }
    expect(rows.length).toBe(ev.length);
    expect(reconcileFuturesPaper(s, ev, 1000)).toEqual([]);
    const accepted = ev.filter((e) => e.kind === "order_accepted").length;
    expect(accepted).toBeGreaterThan(3);
    const ap = await owner`SELECT status, count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id = ${id} GROUP BY status`;
    expect(ap.reduce((a, r) => a + Number(r["n"]), 0)).toBe(accepted); // one approval per accepted order, never duplicated
    const fills = rows.filter((r) => r["kind"] === "entry_fill");
    expect(new Set(fills.map((r) => r["fill_id"])).size).toBe(fills.length);
    for (const f of fills) expect(Number(f["risk_amount"])).toBeGreaterThan(0); // database-computed on every fill
    expect(Number((await owner`SELECT wallet FROM public.futures_paper_accounts WHERE id = ${id}`)[0]!["wallet"])).toBeCloseTo(s.wallet, 6);
  }, 120_000);

  it("two accounts of one owner approving at the same moment cannot jointly exceed one strategy budget (pending risk counts)", async () => {
    const { url, owner } = await freshDb();
    for (let round = 0; round < 3; round++) {
      const user = `00000000-0000-4000-8000-00000000020${round}`; await budgets(owner, user, 12); // one approval (~10) fits, two do not
      const ids = [await account(owner, user), await account(owner, user)];
      const tries = ids.map((_, i) => stepK(initialFuturesPaperState(1000), 0, QUIET, `r${round}a${i}`));
      expect(tries.every((t) => t.events.some((e) => e.kind === "order_accepted"))).toBe(true);
      const out = await Promise.allSettled(ids.map((id, i) => commitTx(connect(url), id, 0, QUIET[0]!.t, tries[i]!.payload)));
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(String((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/strategy s1 budget 12 would be exceeded at approval/);
      const used = await owner`SELECT public.fp3_usage(${user}::uuid, 's1', NULL) u`;
      expect(Number(used[0]!["u"])).toBeLessThanOrEqual(12);
    }
  }, 90_000);

  it("one approval can be consumed only once: a racing fill and cancellation of the same candle — exactly one commits", async () => {
    const { url, owner } = await freshDb(); const id = await account(owner); await budgets(owner, USER, 10_000);
    const r0 = stepK(initialFuturesPaperState(1000), 0, QUIET, "once"); await commitTx(owner, id, 0, QUIET[0]!.t, r0.payload);
    const fill = stepK(r0.state, 1, QUIET, "once");
    const cancelRun = stepFuturesPaperCandle(r0.state, CFG, [QUIET[1]!], [], { ...CTX, refused: { "once-prop-0": "STRATEGY_BUDGET_EXCEEDED" } });
    const cancel = futuresPaperCommitPayloadV3(r0.state, cancelRun.state, cancelRun.events, [QUIET[1]!], []);
    const out = await Promise.allSettled([commitTx(connect(url), id, r0.state.seq, QUIET[1]!.t, fill.payload), commitTx(connect(url), id, r0.state.seq, QUIET[1]!.t, cancel)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(String((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/sequence moved|different payload|not after the cursor/);
    const [ap] = await owner`SELECT status, filled_qty FROM public.futures_paper_risk_approvals WHERE account_id = ${id}`;
    const filled = (await owner`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id = ${id} AND kind = 'entry_fill'`)[0]!["n"];
    expect(filled).toBe(ap!["status"] === "filled" ? 1 : 0);
    expect(["filled", "cancelled"]).toContain(ap!["status"]);
  }, 60_000);

  it("concurrent budget configuration writes cannot over-allocate a sub-budget (serialized on the account budget row)", async () => {
    const { url, owner } = await freshDb();
    for (let round = 0; round < 3; round++) {
      const user = `00000000-0000-4000-8000-00000000030${round}`;
      await owner.unsafe(`SET ROLE service_role; INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ('${user}', 'paper', 100, 40, 60); RESET ROLE;`);
      const ins = (s: string) => connect(url).begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ('${user}', '${s}', 'paper', 'scalping', 35)`); await tx.unsafe(`SELECT pg_sleep(0.2)`); });
      const out = await Promise.allSettled([ins("a1"), ins("a2"), ins("a3")]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const [sum] = await owner`SELECT coalesce(sum(max_loss),0) s FROM public.strategy_risk_budgets WHERE user_id = ${user} AND engine = 'scalping'`;
      expect(Number(sum!["s"])).toBeLessThanOrEqual(60);
    }
  }, 60_000);

  it("a worker killed before COMMIT leaves nothing behind (no approval, candle or event); the retry commits once; a lost response replays", async () => {
    const { url, owner, admin } = await freshDb(); const id = await account(owner); await budgets(owner, USER, 10_000);
    const r0 = stepK(initialFuturesPaperState(1000), 0);
    const victim = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 });
    const pid = Number((await victim`SELECT pg_backend_pid() AS p`)[0]!["p"]);
    const lit = JSON.stringify(r0.payload).replace(/'/g, "''");
    const doomed = victim.unsafe(`BEGIN; SET LOCAL ROLE service_role; SELECT public.futures_paper_commit_bar_v3('${id}', 0, ${BARS[0]!.t}, '${lit}'::jsonb); SELECT pg_sleep(30); COMMIT;`);
    await new Promise((ok) => setTimeout(ok, 300));
    await admin.unsafe(`SELECT pg_terminate_backend(${pid})`);
    await expect(doomed).rejects.toThrow();
    await victim.end({ timeout: 0 }).catch(() => {});
    const [n] = await owner`SELECT (SELECT count(*) FROM public.futures_paper_events WHERE account_id = ${id})::int e, (SELECT count(*) FROM public.futures_paper_risk_approvals WHERE account_id = ${id})::int a, (SELECT count(*) FROM public.futures_paper_candles WHERE account_id = ${id})::int c, (SELECT seq FROM public.futures_paper_accounts WHERE id = ${id})::int s`;
    expect(n).toEqual({ e: 0, a: 0, c: 0, s: 0 });
    expect(await commitTx(connect(url), id, 0, BARS[0]!.t, r0.payload)).toBe(r0.state.seq);
    expect(await commitTx(connect(url), id, 0, BARS[0]!.t, r0.payload)).toBe(r0.state.seq);
    expect((await owner`SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id = ${id}`)[0]!["n"]).toBe(1);
  }, 60_000);
});
