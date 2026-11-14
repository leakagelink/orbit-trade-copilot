// Phase 4H.7 — DRAFTS 0049 → 0057 on a REAL, throwaway local PostgreSQL (never the live database). REAL POSTGRESQL
// evidence: genuinely parallel invocations on separate connections, concurrent refusal recording against the 0057 tally,
// and the invocation timing measurement (fake auth/data API over real SQL with injected network latency). Run via
// scripts/futures-paper/concurrency-check-4h7.sh; skipped without FUTURES_PAPER_PG_URL.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState } from "@/lib/futures-paper-engine";
import { runBoundedIdentityInvocation, type InvocationReport } from "@/lib/futures-paper-worker-identity.server";
import { PROPOSED_INVOCATION_LIMITS } from "@/lib/worker-invocation";
import { M, accountBudget, freshUser, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, intentsFrom, marketFrom } from "./helpers/fp-gateway-harness";
import { AUTH_AND_APP, MIG_0053, MIG_0054, MIG_0055, MIG_0056, ROLES, callAs, liveSession, type Ctx } from "./helpers/fp-0055-harness";
import { AUTH_USERS_STANDIN, MIG_0057, addAuthUser } from "./helpers/fp-0057-harness";
import { KEY, URL_, fakeBackend } from "./helpers/fake-backend-4h7";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const LEDGER = ["0049_futures_paper_ledger_v3", "0050_futures_paper_worker_gateway", "0051_futures_paper_event_completeness", "0052_futures_paper_entry_completeness_and_exit_only"].map((f) => readFileSync(`docs/proposed-migrations/${f}.sql`, "utf8"));
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
afterEach(() => { vi.unstubAllEnvs(); });
let dbn = 0;
/** PGlite-shaped adapter over ONE reserved connection (one database session, like PGlite). */
async function session(sql: Sql): Promise<PGlite> {
  const c = await sql.reserve();
  // Harness SQL passes JSON text to `$n::jsonb`; postgres.js would JSON-encode that text again, so it is cast through text.
  const fix = (q: string) => q.replace(/(\$\d+)::jsonb/g, "$1::text::jsonb");
  return { query: async (q: string, p: unknown[] = []) => ({ rows: await c.unsafe(fix(q), p as never[]) }), exec: async (q: string) => { await c.unsafe(q); return []; } } as unknown as PGlite;
}
async function freshDb() {
  const admin = postgres(URL!, { max: 1, onnotice: () => {} }); opened.push(admin);
  const name = `fpaper4h7_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.unsafe(`ALTER DATABASE ${name} SET futures_paper.change_reason = 'pg test fixture'`);
  const sql = postgres(URL!.replace(/\/[^/]*$/, `/${name}`), { max: 12, onnotice: () => {}, idle_timeout: 5 }); opened.push(sql);
  await sql.unsafe(STUB); for (const m of LEDGER) await sql.unsafe(m);
  await sql.unsafe(ROLES); await sql.unsafe(MIG_0053); await sql.unsafe(MIG_0054); await sql.unsafe(AUTH_AND_APP); await sql.unsafe(MIG_0055);
  await sql.unsafe(`ALTER ROLE authenticator RESET pgrst.db_pre_request`); await sql.unsafe(MIG_0056);
  await sql.unsafe(AUTH_USERS_STANDIN); await sql.unsafe(MIG_0057);
  return sql;
}
const BASE = Math.floor(Date.now() / M) * M - 600 * M;
async function world(sql: Sql, closed: number) {
  const db = await session(sql);
  const ADMIN = freshUser(), worker = freshUser(), owner = freshUser(), email = `w-${worker.slice(-6)}@algovirt.test`, password = "pw-real-pg";
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  const admin: Ctx = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
  await addAuthUser(db, worker, email, password);
  await accountBudget(db, owner, 1000, 400, 600); await strategyBudget(db, owner, "s1", "scalping", 500);
  const t0 = Math.floor(Date.now() / M) * M - closed * M;
  const acct = String((await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [owner, CFG_H, initialFuturesPaperState(1000)] as never[]); }))[0]!["id"]);
  await sql.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${t0 - M} WHERE id='${acct}'`);
  expect((await callAs(db, admin, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
  expect((await callAs(db, { uid: owner, sid: await liveSession(db, owner) }, "fpw_owner_enroll", { p_account: acct, p_worker: worker })).data).toBe(true);
  vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled"); vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
  vi.stubEnv("SUPABASE_URL", URL_); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
  vi.stubEnv("FUTURES_PAPER_WORKER_EMAIL", email); vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", password); vi.stubEnv("FUTURES_PAPER_WORKER_USER_ID", worker);
  const m = marketFrom(BASE, undefined, () => Date.now()), i = intentsFrom(t0, `r${Math.random().toString(36).slice(2, 7)}`);
  const run = (be: ReturnType<typeof fakeBackend>) => runBoundedIdentityInvocation({ enabled: true, accounts: [acct], limits: PROPOSED_INVOCATION_LIMITS, clock: { now: () => Date.now() },
    market: { candles: (s, tf, b) => m.candles(s, tf, b) }, intents: { forCandle: (a, b) => i.forCandle(a, b) }, fetchImpl: be.fetchImpl as never });
  const bars = async () => Number((await sql.unsafe(`SELECT ((cursor_t - $2::bigint) / ${M})::int n FROM public.futures_paper_accounts WHERE id=$1`, [acct, t0 - M]))[0]!["n"]);
  return { db, worker, acct, run, bars, t0 };
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };

describe.skipIf(!URL)("Phase 4H.7 on real PostgreSQL", () => {
  it("parallel invocations on separate connections: one lease holder at a time; every candle commits exactly once", async () => {
    const sql = await freshDb(), w = await world(sql, 10);
    const reports: InvocationReport[] = [], conns = await Promise.all([0, 1, 2].map(() => session(sql)));
    for (let round = 0; round < 6 && (await w.bars()) < 10; round++) {
      const rs = await Promise.all(conns.map((c) => w.run(fakeBackend(c, { latencyMs: () => 15 }))));
      reports.push(...rs);
      expect(rs.filter((r) => r.committed > 0).length).toBeLessThanOrEqual(1);
      for (const r of rs) expect(r.elapsedMs).toBeLessThanOrEqual(PROPOSED_INVOCATION_LIMITS.budgetMs + 150);
    }
    expect(await w.bars()).toBe(10);
    expect(reports.reduce((x, r) => x + r.committed, 0)).toBe(10);
    expect(reports.filter((r) => r.status === "SKIPPED_BUSY").length).toBeGreaterThan(0);
    expect(Number((await sql.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [w.acct]))[0]!["n"])).toBe(10);
  }, 180_000);
  it("concurrent refusals on 4 connections: rows + dropped equals refusals; rows equal recorded_total; nothing silent", async () => {
    const sql = await freshDb(), w = await world(sql, 1);
    const conns = await Promise.all([0, 1, 2, 3].map(() => session(sql)));
    await Promise.all(conns.map(async (c) => { for (let k = 0; k < 35; k++) await callAs(c, { uid: w.worker, sid: null }, "fpw_id2_snapshot", { p_account: w.acct, p_holder: HOLDER_A, p_fence: 1 }); }));
    const t = (await sql.unsafe(`SELECT recorded_total::int r, dropped_total::int d FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id=$1`, [w.worker]))[0]!;
    const rows = Number((await sql.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1`, [w.worker]))[0]!["n"]);
    expect([rows, t["r"], t["d"]]).toEqual([120, 120, 20]);
  }, 180_000);
  it("TIMING: elapsed time per invocation under injected network latency (written to FP_TIMING_OUT)", async () => {
    const sql = await freshDb();
    const out: Record<string, unknown>[] = [], conn = await session(sql);
    for (const lat of [0, 25, 75, 150, 300]) {
      const w = await world(sql, 60); // its own backlog: every invocation below has work to do
      const el: number[] = [], com: number[] = [], st: Record<string, number> = {};
      for (let k = 0; k < 8; k++) {
        const r = await w.run(fakeBackend(conn, { latencyMs: () => lat }));
        el.push(r.elapsedMs); com.push(r.committed); st[r.status] = (st[r.status] ?? 0) + 1;
        expect(r.elapsedMs).toBeLessThanOrEqual(PROPOSED_INVOCATION_LIMITS.budgetMs + 150);
        expect(r.signOut === "SIGNED_OUT" || r.signOut === "NOT_REQUIRED").toBe(true);
      }
      out.push({ latencyMsPerRequest: lat, invocations: el.length, elapsedMs: { min: Math.min(...el), p50: pct(el, 50), p95: pct(el, 95), max: Math.max(...el) }, committedPerInvocation: { min: Math.min(...com), max: Math.max(...com), total: com.reduce((a, b) => a + b, 0) }, statuses: st });
    }
    const res = { measuredAt: new Date().toISOString(), postgres: String((await sql.unsafe(`SHOW server_version`))[0]!["server_version"]), limits: PROPOSED_INVOCATION_LIMITS, schedulerLimitMs: 5_000, profiles: out };
    if (process.env["FP_TIMING_OUT"]) writeFileSync(process.env["FP_TIMING_OUT"], JSON.stringify(res, null, 2));
    expect(Math.max(...out.map((p) => (p["elapsedMs"] as { max: number }).max))).toBeLessThanOrEqual(PROPOSED_INVOCATION_LIMITS.budgetMs + 150);
  }, 600_000);
});
