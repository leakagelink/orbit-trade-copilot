// Phase 4H — DRAFT 0051 completeness checks on a real, throwaway PostgreSQL with genuinely concurrent sessions (drafts
// 0049 + 0050 + 0051; never the live database). Each commit is its own READ COMMITTED transaction calling the v4
// commit as the function owner. Run via scripts/futures-paper/concurrency-check-4h.sh; skipped without FUTURES_PAPER_PG_URL.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, type FPBar, type FPIntent } from "@/lib/futures-paper-engine";
import { viewFromRows } from "@/lib/futures-paper-worker";
import { FP_SQL } from "@/lib/futures-paper-worker-queries";
import { CFG, stepView } from "./helpers/fp-v3-harness";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIG = ["0049_futures_paper_ledger_v3", "0050_futures_paper_worker_gateway", "0051_futures_paper_event_completeness"].map((f) => readFileSync(`docs/proposed-migrations/${f}.sql`, "utf8"));
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, H8 = 8 * 3_600_000, T0 = Math.floor(Date.now() / H8) * H8 - H8 + 10 * M;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string, max = 2) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!, 1), name = `fpaper4h_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); for (const m of MIG) await owner.unsafe(m);
  return { url, owner };
}
const num = async (sql: Sql, q: string, p: unknown[] = []) => Number((await sql.unsafe(q, p as never[]))[0]!["n"]);
async function setup(owner: Sql, user: string, s1 = 500) {
  await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`);
    await tx.unsafe(`INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',1000,400,600) ON CONFLICT DO NOTHING`, [user]);
    await tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,'s1','paper','scalping',$2) ON CONFLICT DO NOTHING`, [user, s1]); });
}
async function account(owner: Sql, user: string) {
  const r = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, CFG, initialFuturesPaperState(1000)] as never[]); });
  const id = String(r[0]!["id"]);
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
async function view(sql: Sql, id: string) {
  const a = (await sql.unsafe(FP_SQL.account, [id]))[0]!, user = String(a["user_id"]);
  const [ab, u, c, ap, p] = await Promise.all([sql.unsafe(FP_SQL.accountBudget, [user]), sql.unsafe(FP_SQL.usage, [user]), sql.unsafe(FP_SQL.costs, [user]), sql.unsafe(FP_SQL.approvals, [id]), sql.unsafe(FP_SQL.positions, [id])]);
  return viewFromRows(a as Record<string, unknown>, (ab[0] ?? null) as Record<string, unknown> | null, u as unknown as Record<string, unknown>[], c as unknown as Record<string, unknown>[], ap as unknown as Record<string, unknown>[], p as unknown as Record<string, unknown>[]);
}
type OHLC = [number, number, number, number];
const bar = (s: string, t: number, tr: OHLC = s === "BTCUSDT" ? [100, 100.3, 99.8, 100.05] : [50, 50.2, 49.9, 50.1]): FPBar => ({ symbol: s, t, tfMs: M, trade: { o: tr[0], h: tr[1], l: tr[2], c: tr[3], v: 1e6 }, mark: { o: tr[0], h: tr[1], l: tr[2], c: tr[3] }, index: { c: tr[3] }, funding: [] });
const CROSS: OHLC = [100, 100.3, 98.5, 99.2];
const commit = (sql: Sql, id: string, seq: number, t: number, payload: unknown) => sql.begin(async (tx) => Number((await tx.unsafe(`SELECT public.futures_paper_commit_bar_v4($1, $2, $3, $4::jsonb) AS s`, [id, seq, t, payload] as never[]))[0]!["s"]));
async function payloadFor(sql: Sql, id: string, t: number, btc: OHLC, intents: FPIntent[] = [], recorded?: OHLC) {
  const v = await view(sql, id), s = stepView(v, [bar("BTCUSDT", t, btc), bar("ETHUSDT", t)], intents);
  if (recorded) { const c = (s.payload as { candles: Record<string, { trade: object; mark: object }> }).candles["BTCUSDT"]!; c.trade = { ...bar("BTCUSDT", t, recorded).trade }; c.mark = { ...bar("BTCUSDT", t, recorded).mark! }; }
  return { seq: v.seq, payload: s.payload, events: s.events };
}
async function openLong(owner: Sql, id: string) {
  const it: FPIntent = { maxHoldBars: 30, proposal: { proposalId: `pg51-${id.slice(-8)}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 103, createdAt: T0 + M } };
  let x = await payloadFor(owner, id, T0, [100, 100.3, 99.8, 100.05], [it]); await commit(owner, id, x.seq, T0, x.payload);
  x = await payloadFor(owner, id, T0 + M, [100, 100.3, 99.8, 100.05]); await commit(owner, id, x.seq, T0 + M, x.payload);
  expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).toBe(1);
}
const T2 = T0 + 2 * M;

describe.skipIf(!URL)("0051 completeness on real PostgreSQL sessions", () => {
  it("six sessions commit the same stop-out candle at once: one commit, one exit, one completeness record; all return the same sequence", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000d01"; await setup(owner, user); const id = await account(owner, user); await openLong(owner, id);
    const x = await payloadFor(owner, id, T2, CROSS);
    const seqs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => commit(connect(url, 1), id, x.seq, T2, x.payload)));
    expect(new Set(seqs).size).toBe(1);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1 AND bar_t=$2`, [id, T2])).toBe(1);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='exit_fill'`, [id])).toBe(1);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_candle_checks WHERE account_id=$1 AND bar_t=$2 AND outcome='stop'`, [id, T2])).toBe(1);
  }, 120_000);

  it("an omitting writer racing a correct writer (5 accounts): the omission never commits; every account ends stopped out", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000d02"; await setup(owner, user);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await account(owner, user); await openLong(owner, id);
      const good = await payloadFor(owner, id, T2, CROSS), bad = await payloadFor(owner, id, T2, [100, 100.3, 99.8, 100.05], [], CROSS);
      const [rb, rg] = await Promise.allSettled([commit(connect(url, 1), id, bad.seq, T2, bad.payload), commit(connect(url, 1), id, good.seq, T2, good.payload)]);
      expect(rb.status).toBe("rejected"); expect(rg.status).toBe("fulfilled");
      outcomes.push(/completeness: the recorded candle requires/.test(String((rb as PromiseRejectedResult).reason)) ? "omission-refused" : /already committed with a different payload/.test(String((rb as PromiseRejectedResult).reason)) ? "lost-race" : String((rb as PromiseRejectedResult).reason));
      expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).toBe(0);
    }
    expect(outcomes.every((o) => o === "omission-refused" || o === "lost-race")).toBe(true);
  }, 120_000);

  it("two accounts of one owner stop out concurrently: both commit; strategy usage equals the closed losses in the ledger", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000d03"; await setup(owner, user);
    const ids = [await account(owner, user), await account(owner, user)]; for (const id of ids) await openLong(owner, id);
    const xs = await Promise.all(ids.map((id) => payloadFor(owner, id, T2, CROSS)));
    await Promise.all(ids.map((id, i) => commit(connect(url, 1), id, xs[i]!.seq, T2, xs[i]!.payload)));
    const closed = await num(owner, `SELECT coalesce(sum(greatest(0,-net)),0)::float8 n FROM (SELECT sum(wallet_delta) net FROM public.futures_paper_events WHERE user_id=$1 AND proposal_id IS NOT NULL GROUP BY account_id, proposal_id) q`, [user]);
    expect(closed).toBeGreaterThan(0);
    expect(await num(owner, `SELECT public.fp3_usage($1,'s1',NULL)::float8 n`, [user])).toBeCloseTo(closed, 9);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_candle_checks WHERE user_id=$1 AND outcome='stop'`, [user])).toBe(2);
  }, 120_000);

  it("a backend killed while its commit waits on the account lock writes nothing; the retried candle commits once", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000d04"; await setup(owner, user); const id = await account(owner, user); await openLong(owner, id);
    const x = await payloadFor(owner, id, T2, CROSS);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let locked!: () => void; const ready = new Promise<void>((r) => { locked = r; });
    const holder = owner.begin(async (tx) => { await tx.unsafe(`SELECT id FROM public.futures_paper_accounts WHERE id=$1 FOR UPDATE`, [id]); locked(); await gate; });
    await ready;
    const victim = connect(url, 1), pid = Number((await victim.unsafe(`SELECT pg_backend_pid() AS p`))[0]!["p"]);
    const pending = victim.unsafe(`SELECT public.futures_paper_commit_bar_v4($1, $2, $3, $4::jsonb) AS s`, [id, x.seq, T2, x.payload] as never[]).then(() => "committed", (e) => String(e));
    for (let i = 0; i < 100 && (await num(owner, `SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pid])) === 0; i++) await new Promise((r) => setTimeout(r, 30));
    await owner.unsafe(`SELECT pg_terminate_backend($1)`, [pid]);
    expect(await pending).not.toBe("committed");
    release(); await holder;
    for (const tbl of ["futures_paper_commits", "futures_paper_events", "futures_paper_candles", "futures_paper_candle_checks"]) expect(await num(owner, `SELECT count(*)::int n FROM public.${tbl} WHERE account_id=$1 AND bar_t=$2`, [id, T2]), tbl).toBe(0);
    expect(await commit(connect(url, 1), id, x.seq, T2, x.payload)).toBeGreaterThan(x.seq);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='exit_fill'`, [id])).toBe(1);
  }, 120_000);
});
