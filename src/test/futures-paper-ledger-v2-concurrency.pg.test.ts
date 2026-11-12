// Genuine multi-session PostgreSQL tests for DRAFT migration 0046 (reviewed successor of 0045). Needs a real server:
// run scripts/futures-paper/concurrency-check-0046.sh (throwaway local PostgreSQL). Skipped when FUTURES_PAPER_PG_URL
// is not set. Never touches the live database.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPState } from "@/lib/futures-paper-engine";
import { futuresPaperCommitPayloadV2 } from "@/lib/futures-paper-ledger-v2";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, COST = 0.13, USER = "00000000-0000-4000-8000-000000000001";
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 } },
  limits: { maxExposure: 5000, maxDailyLoss: 500, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: COST },
  strategyBudgets: { s1: 10_000 },
};
const N = 60, T0 = Math.floor(Date.now() / M) * M - (N + 5) * M;
const BARS: FPBar[] = Array.from({ length: N }, (_, k) => { const c = 100 + 2 * Math.sin(k / 2), o = 100 + 2 * Math.sin((k - 1) / 2); return { symbol: "BTCUSDT", t: T0 + k * M, tfMs: M, trade: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1e6 }, mark: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c }, index: { c }, funding: k % 20 === 10 ? [{ t: T0 + k * M, rate: 0.0001 }] : [] }; });
const intents = (k: number) => (k % 6 === 0 ? [{ maxHoldBars: 8, proposal: { proposalId: `cc-prop-${k}`, engine: "scalp_intraday" as const, strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures" as const, environment: "paper" as const, side: (k % 12 === 0 ? "LONG" : "SHORT") as "LONG" | "SHORT", referencePrice: null, stopPrice: BARS[k]!.mark!.c * (k % 12 === 0 ? 0.99 : 1.01), takeProfitPrice: BARS[k]!.mark!.c * (k % 12 === 0 ? 1.01 : 0.99), createdAt: T0 + (k + 1) * M } }] : []);
const stepK = (s: FPState, k: number, bars = BARS) => { const r = stepFuturesPaper(s, CFG, bars[k]!, intents(k)); return { ...r, payload: futuresPaperCommitPayloadV2(s, r.state, r.events, { BTCUSDT: bars[k]!.mark!.c }, COST) }; };
// Quiet candles: the position stays open, so its reserved risk stays reserved.
const QUIET: FPBar[] = BARS.slice(0, 3).map((b) => ({ ...b, trade: { o: 100, h: 100.2, l: 99.9, c: 100, v: 1e6 }, mark: { o: 100, h: 100.2, l: 99.9, c: 100 }, index: { c: 100 }, funding: [] }));

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!); const name = `fpaper2_cc_${process.pid}_${++dbn}`;
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
const setBudget = (owner: Sql, user: string, strategy: string, max: number) => owner.unsafe(`SET ROLE service_role; INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, max_loss) VALUES ('${user}', '${strategy}', 'paper', ${max}); RESET ROLE;`);
const commitTx = (sql: Sql, id: string, seq: number, barT: number, payload: unknown) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); const r = await tx.unsafe(`SELECT public.futures_paper_commit_bar_v2($1, $2, $3, $4::jsonb) AS seq`, [id, seq, barT, payload as never]); return Number(r[0]!["seq"]); });

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

describe.skipIf(!URL)("draft 0046 under real concurrent sessions", () => {
  it("racing workers commit every candle exactly once; the ledger and the database book reconcile with a single-threaded replay", async () => {
    const { url, owner } = await freshDb(); const id = await account(owner); await setBudget(owner, USER, "s1", 10_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => worker(connect(url), id)));
    // They really raced: more commit attempts succeeded or lost than there are candles. A loser that computed the same
    // candle from the same state gets the idempotent replay answer (same payload hash) instead of an error.
    expect(results.reduce((a, r) => a + r.wins + r.losses, 0)).toBeGreaterThan(N);
    const commits = await owner`SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id = ${id}`;
    expect(commits[0]!["n"]).toBe(N);
    const rows = await owner`SELECT * FROM public.futures_paper_events WHERE account_id = ${id} ORDER BY seq`;
    const seqs = rows.map((r) => Number(r["seq"])); expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    let s = initialFuturesPaperState(1000); const ev: FPEvent[] = [];
    for (let k = 0; k < N; k++) { const r = stepK(s, k); s = r.state; ev.push(...r.events); }
    expect(rows.length).toBe(ev.length);
    const fills = rows.filter((r) => r["kind"] === "entry_fill"); expect(new Set(fills.map((r) => r["fill_id"])).size).toBe(fills.length);
    expect(reconcileFuturesPaper(s, ev, 1000)).toEqual([]);
    const [acc] = await owner`SELECT wallet FROM public.futures_paper_accounts WHERE id = ${id}`;
    expect(Number(acc!["wallet"])).toBeCloseTo(s.wallet, 6);
    const book = await owner`SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id = ${id}`;
    expect(book[0]!["n"]).toBe(Object.keys(s.positions).length);
  }, 90_000);

  it("two accounts of one owner filling at the same moment cannot jointly exceed one strategy budget", async () => {
    const { url, owner } = await freshDb();
    for (let round = 0; round < 3; round++) {
      const user = `00000000-0000-4000-8000-00000000010${round}`; await setBudget(owner, user, "s1", 12); // one fill (~10 reserved) fits, two do not
      const ids = [await account(owner, user), await account(owner, user)];
      const pend = await Promise.all(ids.map(async (id) => { const r = stepK(initialFuturesPaperState(1000), 0, QUIET); await commitTx(owner, id, 0, BARS[0]!.t, r.payload); return r.state; }));
      const fills = pend.map((s) => stepK(s, 1, QUIET));
      expect(fills.every((f) => f.events.some((e) => e.kind === "entry_fill"))).toBe(true);
      const out = await Promise.allSettled(ids.map((id, i) => commitTx(connect(url), id, pend[i]!.seq, BARS[1]!.t, fills[i]!.payload)));
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(String((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/budget .* would be exceeded at fill/);
      const reserved = await owner`SELECT coalesce(sum(risk_reserved),0) r FROM public.futures_paper_positions WHERE user_id = ${user} AND strategy_id = 's1'`;
      expect(Number(reserved[0]!["r"])).toBeLessThanOrEqual(12);
    }
  }, 90_000);

  it("a worker killed before COMMIT leaves nothing behind; the retry commits exactly once; a lost response replays idempotently", async () => {
    const { url, owner, admin } = await freshDb(); const id = await account(owner); await setBudget(owner, USER, "s1", 10_000);
    const r0 = stepK(initialFuturesPaperState(1000), 0);
    const victim = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); let pid = 0; // not pooled with the others: it is killed
    pid = Number((await victim`SELECT pg_backend_pid() AS p`)[0]!["p"]);
    const lit = JSON.stringify(r0.payload).replace(/'/g, "''");
    // One simple-protocol batch: the commit function runs, then the process dies before COMMIT.
    const doomed = victim.unsafe(`BEGIN; SET LOCAL ROLE service_role; SELECT public.futures_paper_commit_bar_v2('${id}', 0, ${BARS[0]!.t}, '${lit}'::jsonb); SELECT pg_sleep(30); COMMIT;`);
    for (let i = 0; i < 100 && !pid; i++) await new Promise((ok) => setTimeout(ok, 20));
    await new Promise((ok) => setTimeout(ok, 200));
    await admin.unsafe(`SELECT pg_terminate_backend(${pid})`);
    await expect(doomed).rejects.toThrow();
    await victim.end({ timeout: 0 }).catch(() => {});
    const nothing = await owner`SELECT (SELECT count(*) FROM public.futures_paper_events WHERE account_id = ${id})::int e, (SELECT seq FROM public.futures_paper_accounts WHERE id = ${id})::int s, (SELECT count(*) FROM public.futures_paper_commits WHERE account_id = ${id})::int c`;
    expect(nothing[0]).toEqual({ e: 0, s: 0, c: 0 });
    const retry = connect(url);
    expect(await commitTx(retry, id, 0, BARS[0]!.t, r0.payload)).toBe(r0.state.seq);
    expect(await commitTx(connect(url), id, 0, BARS[0]!.t, r0.payload)).toBe(r0.state.seq); // response lost → same answer
    const once = await owner`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id = ${id}`;
    expect(once[0]!["n"]).toBe(r0.events.length);
  }, 60_000);
});
