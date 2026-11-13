// Phase 4H finalization — DRAFT 0052 (entry-fill completeness, stopped-account exit-only, configuration audit trail) on
// a real, throwaway PostgreSQL with genuinely concurrent sessions (drafts 0049 → 0052; never the live database). Each
// commit is its own READ COMMITTED transaction calling v5 as the function owner. Run via
// scripts/futures-paper/concurrency-check-4h-final.sh; skipped without FUTURES_PAPER_PG_URL.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, type FPBar, type FPConfig, type FPIntent } from "@/lib/futures-paper-engine";
import { viewFromRows } from "@/lib/futures-paper-worker";
import { FP_SQL } from "@/lib/futures-paper-worker-queries";
import { CFG, stepView } from "./helpers/fp-v3-harness";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIG = ["0049_futures_paper_ledger_v3", "0050_futures_paper_worker_gateway", "0051_futures_paper_event_completeness", "0052_futures_paper_entry_completeness_and_exit_only"].map((f) => readFileSync(`docs/proposed-migrations/${f}.sql`, "utf8"));
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, H8 = 8 * 3_600_000, T0 = Math.floor(Date.now() / H8) * H8 - H8 + 10 * M;
const CAP: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 10 } };
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string, max = 2) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!, 1), name = `fpaper4hf_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  // Configuration writes need a reason under 0052; every test session gets a fixture reason.
  await admin.unsafe(`ALTER DATABASE ${name} SET futures_paper.change_reason = 'pg test fixture'`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); for (const m of MIG) await owner.unsafe(m);
  return { url, owner };
}
const num = async (sql: Sql, q: string, p: unknown[] = []) => Number((await sql.unsafe(q, p as never[]))[0]!["n"]);
async function setup(owner: Sql, user: string) {
  await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`);
    await tx.unsafe(`INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',1000,400,600) ON CONFLICT DO NOTHING`, [user]);
    await tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,'s1','paper','scalping',500) ON CONFLICT DO NOTHING`, [user]); });
}
async function account(owner: Sql, user: string, cfg: FPConfig = CFG) {
  const r = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, cfg, initialFuturesPaperState(1000)] as never[]); });
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
const QUIET: OHLC = [100, 100.3, 99.8, 100.05], CROSS: OHLC = [100, 100.3, 98.5, 99.2];
const bar = (s: string, t: number, tr: OHLC = s === "BTCUSDT" ? QUIET : [50, 50.2, 49.9, 50.1], v = 1e6): FPBar => ({ symbol: s, t, tfMs: M, trade: { o: tr[0], h: tr[1], l: tr[2], c: tr[3], v }, mark: { o: tr[0], h: tr[1], l: tr[2], c: tr[3] }, index: { c: tr[3] }, funding: [] });
const commit = (sql: Sql, id: string, seq: number, t: number, payload: unknown) => sql.begin(async (tx) => Number((await tx.unsafe(`SELECT public.futures_paper_commit_bar_v5($1, $2, $3, $4::jsonb) AS s`, [id, seq, t, payload] as never[]))[0]!["s"]));
async function payloadFor(sql: Sql, id: string, t: number, o: { btc?: OHLC; v?: number; recordedV?: number; recordedBtc?: OHLC; intents?: FPIntent[] } = {}) {
  const v = await view(sql, id), s = stepView(v, [bar("BTCUSDT", t, o.btc ?? QUIET, o.v ?? 1e6), bar("ETHUSDT", t)], o.intents ?? []);
  const c = (s.payload as { candles: Record<string, { trade: { o: number; h: number; l: number; c: number; v: number }; mark: object }> }).candles["BTCUSDT"]!;
  if (o.recordedV !== undefined) c.trade.v = o.recordedV;
  if (o.recordedBtc) { const b = bar("BTCUSDT", t, o.recordedBtc); c.trade = { ...b.trade }; c.mark = { ...b.mark! }; }
  return { seq: v.seq, payload: s.payload, events: s.events };
}
const intent = (id: string): FPIntent => ({ maxHoldBars: 30, proposal: { proposalId: `pg52-${id.slice(-8)}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 103, createdAt: T0 + M } });
async function acceptAt(owner: Sql, id: string) { const x = await payloadFor(owner, id, T0, { intents: [intent(id)] }); await commit(owner, id, x.seq, T0, x.payload); }
async function openLong(owner: Sql, id: string) {
  await acceptAt(owner, id); const x = await payloadFor(owner, id, T0 + M); await commit(owner, id, x.seq, T0 + M, x.payload);
  expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).toBe(1);
}
const stop = (sql: Sql, id: string) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(`UPDATE public.futures_paper_accounts SET status='stopped', status_reason='owner stop (pg test)' WHERE id=$1`, [id]); });
const T1 = T0 + M, T2 = T0 + 2 * M;

describe.skipIf(!URL)("0052 on real PostgreSQL sessions", () => {
  it("six sessions commit the same stop-out of a STOPPED account at once: one commit, one exit; the account stays stopped", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000e01"; await setup(owner, user); const id = await account(owner, user); await openLong(owner, id);
    await stop(owner, id);
    const x = await payloadFor(owner, id, T2, { btc: CROSS });
    const seqs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => commit(connect(url, 1), id, x.seq, T2, x.payload)));
    expect(new Set(seqs).size).toBe(1);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='exit_fill'`, [id])).toBe(1);
    expect(String((await owner.unsafe(`SELECT status FROM public.futures_paper_accounts WHERE id=$1`, [id]))[0]!["status"])).toBe("stopped");
  }, 120_000);

  it("an omitted entry fill racing the correct writer (5 accounts): the omission never commits; each entry fills exactly once", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000e02"; await setup(owner, user);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await account(owner, user, CAP); await acceptAt(owner, id);
      const good = await payloadFor(owner, id, T1), bad = await payloadFor(owner, id, T1, { v: 0, recordedV: 1e6 });
      const [rb, rg] = await Promise.allSettled([commit(connect(url, 1), id, bad.seq, T1, bad.payload), commit(connect(url, 1), id, good.seq, T1, good.payload)]);
      expect(rg.status).toBe("fulfilled"); expect(rb.status).toBe("rejected");
      const why = String((rb as PromiseRejectedResult).reason);
      outcomes.push(/requires an entry fill of/.test(why) ? "omission-refused" : /already committed with a different payload/.test(why) ? "lost-race" : why);
      expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [id])).toBe(1);
      expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE account_id=$1 AND outcome='filled'`, [id])).toBe(1);
    }
    expect(outcomes.every((o) => o === "omission-refused" || o === "lost-race")).toBe(true);
  }, 120_000);

  it("a stop request racing a commit that fills: either the fill commits before the stop, or the stopped account refuses the fill — never a fill after the stop", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000e03"; await setup(owner, user);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await account(owner, user); await acceptAt(owner, id);
      const x = await payloadFor(owner, id, T1);
      const [rc, rs] = await Promise.allSettled([commit(connect(url, 1), id, x.seq, T1, x.payload), stop(connect(url, 1), id)]);
      expect(rs.status).toBe("fulfilled");
      const fills = await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [id]);
      if (rc.status === "fulfilled") { expect(fills).toBe(1); seen.push("fill-then-stop"); }
      else { expect(String(rc.reason)).toMatch(/entries are refused while the account is not active or is halted/); expect(fills).toBe(0); seen.push("stop-then-refused"); }
      const st = (await owner.unsafe(`SELECT status FROM public.futures_paper_accounts WHERE id=$1`, [id]))[0]!;
      expect(st["status"]).toBe("stopped");
    }
    expect(seen.length).toBe(5);
  }, 120_000);

  it("eight sessions change one strategy budget at once: versions 1..9 without gaps or forks, one unbroken hash chain", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000e04"; await setup(owner, user);
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((k) => connect(url, 1).begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(`SELECT set_config('futures_paper.change_reason', $1, true)`, [`owner change ${k}`]);
      await tx.unsafe(`UPDATE public.strategy_risk_budgets SET max_loss = $2 WHERE user_id=$1 AND strategy_id='s1'`, [user, 100 + k]);
    })));
    const rows = await owner.unsafe(`SELECT version, operation, reason, value_sha256, prev_sha256, chain_sha256 FROM public.futures_paper_config_changes WHERE user_id=$1 AND entity='strategy_budget' ORDER BY version`, [user]);
    expect(rows.map((r) => Number(r["version"]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!, p = rows[i - 1]!;
      expect(r["prev_sha256"]).toBe(p["chain_sha256"]);
      expect(r["chain_sha256"]).toBe(sha([p["chain_sha256"], "strategy_budget", user, "paper:s1", String(r["version"]), "UPDATE", r["value_sha256"], r["reason"]].join("|")));
    }
  }, 120_000);

  it("a backend killed while its stopped-account exit waits on the account lock writes nothing; the retried candle commits once", async () => {
    const { url, owner } = await freshDb(), user = "00000000-0000-4000-8000-000000000e05"; await setup(owner, user); const id = await account(owner, user); await openLong(owner, id);
    await stop(owner, id);
    const x = await payloadFor(owner, id, T2, { btc: CROSS });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let locked!: () => void; const ready = new Promise<void>((r) => { locked = r; });
    const holder = owner.begin(async (tx) => { await tx.unsafe(`SELECT id FROM public.futures_paper_accounts WHERE id=$1 FOR UPDATE`, [id]); locked(); await gate; });
    await ready;
    const victim = connect(url, 1), pid = Number((await victim.unsafe(`SELECT pg_backend_pid() AS p`))[0]!["p"]);
    const pending = victim.unsafe(`SELECT public.futures_paper_commit_bar_v5($1, $2, $3, $4::jsonb) AS s`, [id, x.seq, T2, x.payload] as never[]).then(() => "committed", (e) => String(e));
    for (let i = 0; i < 100 && (await num(owner, `SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pid])) === 0; i++) await new Promise((r) => setTimeout(r, 30));
    await owner.unsafe(`SELECT pg_terminate_backend($1)`, [pid]);
    expect(await pending).not.toBe("committed");
    release(); await holder;
    for (const tbl of ["futures_paper_commits", "futures_paper_events", "futures_paper_candles", "futures_paper_candle_checks"]) expect(await num(owner, `SELECT count(*)::int n FROM public.${tbl} WHERE account_id=$1 AND bar_t=$2`, [id, T2]), tbl).toBe(0);
    expect(await commit(connect(url, 1), id, x.seq, T2, x.payload)).toBeGreaterThan(x.seq);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='exit_fill'`, [id])).toBe(1);
  }, 120_000);
});
