// Phase 4H.1 — DRAFT 0054 (worker identity lifecycle) on a real, throwaway PostgreSQL with genuinely concurrent
// sessions (drafts 0049 → 0054; never the live database). auth.uid() is stubbed by a transaction-local setting; roles
// use the app's user_roles/has_role definitions. Shows that a disable or a revocation WAITS for an in-flight writing
// worker call (FOR SHARE on the identity/enrollment rows) and that every later call is refused, and that many sessions
// racing enable/disable leave one consistent state and a complete history. Run via
// scripts/futures-paper/concurrency-check-4h1.sh; skipped without FUTURES_PAPER_PG_URL.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState } from "@/lib/futures-paper-engine";
import { CFG } from "./helpers/fp-v3-harness";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIG = ["0049_futures_paper_ledger_v3", "0050_futures_paper_worker_gateway", "0051_futures_paper_event_completeness", "0052_futures_paper_entry_completeness_and_exit_only", "0053_futures_paper_worker_identity", "0054_futures_paper_worker_identity_lifecycle"].map((f) => readFileSync(f.startsWith("0054") && process.env["FP_0054_FILE"] ? process.env["FP_0054_FILE"] : `docs/proposed-migrations/${f}.sql`, "utf8"));
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string, max = 2) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0, un = 0;
const uid = () => `00000000-0000-4000-9054-${(++un).toString(16).padStart(12, "0")}`;
const HOLDER = "00000000-0000-4000-8000-00000000aaaa";
async function freshDb() {
  const admin = connect(URL!, 1), name = `fpaper4h1_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.unsafe(`ALTER DATABASE ${name} SET futures_paper.change_reason = 'pg test fixture'`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); for (const m of MIG) await owner.unsafe(m);
  return { url, owner };
}
/** One transaction as a signed-in user (role authenticated, auth.uid() = who). */
const asUser = <T>(sql: Sql, who: string, f: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE authenticated`); await tx.unsafe(`SELECT set_config('test.uid', $1, true)`, [who]); return f(tx); }) as Promise<T>;
async function world(owner: Sql) {
  const ADMIN = uid(), WORKER = uid(), OWNER = uid();
  await owner.unsafe(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [ADMIN]);
  const r = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [OWNER, CFG, initialFuturesPaperState(1000)] as never[]); });
  const ACCOUNT = String(r[0]!["id"]);
  await asUser(owner, ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [WORKER]));
  await asUser(owner, OWNER, (tx) => tx.unsafe(`SELECT public.fpw_owner_enroll($1, $2)`, [ACCOUNT, WORKER]));
  return { ADMIN, WORKER, OWNER, ACCOUNT };
}
const lockWaiters = async (sql: Sql) => Number((await sql.unsafe(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!["n"]);
async function waitFor(f: () => Promise<boolean>, ms = 5_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; }
const acquire = (tx: postgres.TransactionSql, account: string) => tx.unsafe(`SELECT public.fpw_id_acquire_lease($1, $2, 30) AS f`, [account, HOLDER]);

describe.skipIf(!URL)("0054 on real PostgreSQL (throwaway, local)", () => {
  it("a disable waits for an in-flight writing worker call, then every later call is refused", async () => {
    const { url, owner } = await freshDb(); const w = await world(owner);
    const a = connect(url, 1), b = connect(url, 1), mon = connect(url, 1);
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    let disabledAt = 0, workerDoneAt = 0;
    const worker = asUser(a, w.WORKER, async (tx) => { const f = await acquire(tx, w.ACCOUNT); await hold; workerDoneAt = Date.now(); return Number(f[0]!["f"]); });
    expect(await waitFor(async () => (await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length > 0)).toBe(true);
    const disable = asUser(b, w.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, NULL, false) AS ok`, [w.WORKER])).then((r) => { disabledAt = Date.now(); return r[0]!["ok"]; });
    expect(await waitFor(async () => (await lockWaiters(mon)) === 1)).toBe(true); // the disable is blocked by the worker's FOR SHARE lock
    release();
    expect(await worker).toBeGreaterThan(0);
    expect(await disable).toBe(true);
    expect(disabledAt).toBeGreaterThanOrEqual(workerDoneAt);
    await expect(asUser(a, w.WORKER, (tx) => acquire(tx, w.ACCOUNT))).rejects.toThrow(/not an enabled worker identity/);
    const codes = (await owner.unsafe(`SELECT code FROM public.futures_paper_worker_audit WHERE account_id=$1 ORDER BY id`, [w.ACCOUNT])).map((x) => x["code"]);
    expect(codes).toEqual(["ID:ENROLLED", "ID:LEASE_ACQUIRED"]);
    expect((await owner.unsafe(`SELECT new_enabled FROM public.futures_paper_worker_identity_changes WHERE worker_user_id=$1 ORDER BY id`, [w.WORKER])).map((x) => x["new_enabled"])).toEqual([true, false]);
  }, 60_000);
  it("an owner revocation waits for an in-flight writing worker call, then the account is unreachable", async () => {
    const { url, owner } = await freshDb(); const w = await world(owner);
    const a = connect(url, 1), b = connect(url, 1), mon = connect(url, 1);
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    const worker = asUser(a, w.WORKER, async (tx) => { const f = await acquire(tx, w.ACCOUNT); await hold; return Number(f[0]!["f"]); });
    expect(await waitFor(async () => (await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length > 0)).toBe(true);
    const revoke = asUser(b, w.OWNER, (tx) => tx.unsafe(`SELECT public.fpw_owner_revoke($1, $2) AS ok`, [w.ACCOUNT, w.WORKER])).then((r) => r[0]!["ok"]);
    expect(await waitFor(async () => (await lockWaiters(mon)) === 1)).toBe(true);
    release();
    expect(await worker).toBeGreaterThan(0);
    expect(await revoke).toBe(true);
    await expect(asUser(a, w.WORKER, (tx) => tx.unsafe(`SELECT public.fpw_id_snapshot($1, $2, 1)`, [w.ACCOUNT, HOLDER]))).rejects.toThrow(/account not enrolled/);
  }, 60_000);
  it("a disable committed first refuses a worker call that was waiting for it (the worker re-reads the row)", async () => {
    const { url, owner } = await freshDb(); const w = await world(owner);
    const a = connect(url, 1), b = connect(url, 1), mon = connect(url, 1);
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    const disable = asUser(b, w.ADMIN, async (tx) => { const r = await tx.unsafe(`SELECT public.fpw_admin_set_identity($1, NULL, false) AS ok`, [w.WORKER]); await hold; return r[0]!["ok"]; });
    expect(await waitFor(async () => (await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length > 0)).toBe(true);
    const worker = asUser(a, w.WORKER, (tx) => acquire(tx, w.ACCOUNT)).then(() => "ALLOWED", (e: Error) => e.message);
    expect(await waitFor(async () => (await lockWaiters(mon)) === 1)).toBe(true); // the worker's FOR SHARE waits for the disable
    release();
    expect(await disable).toBe(true);
    expect(await worker).toMatch(/not an enabled worker identity/);
    expect(Number((await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_leases`))[0]!["n"])).toBe(0);
  }, 60_000);
  it("twelve sessions racing enable/disable leave one consistent state and a gap-free, alternating history", async () => {
    const { url, owner } = await freshDb(); const w = await world(owner);
    const pool = connect(url, 12);
    await Promise.all(Array.from({ length: 12 }, (_, i) => asUser(pool, w.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', $2)`, [w.WORKER, i % 2 === 0]))));
    const h = (await owner.unsafe(`SELECT old_enabled, new_enabled FROM public.futures_paper_worker_identity_changes WHERE worker_user_id=$1 ORDER BY id`, [w.WORKER])).map((x) => [x["old_enabled"], x["new_enabled"]]);
    for (let i = 1; i < h.length; i++) expect(h[i]![0]).toBe(h[i - 1]![1]); // each change starts where the previous one ended
    const now = (await owner.unsafe(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [w.WORKER]))[0]!["enabled"];
    expect(h.at(-1)![1]).toBe(now);
  }, 60_000);
});
