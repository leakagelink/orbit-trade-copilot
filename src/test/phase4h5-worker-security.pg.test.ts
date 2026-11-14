// Phase 4H.5 — DRAFTS 0055/0056 on a real, throwaway PostgreSQL with genuinely concurrent sessions (drafts 0049 → 0056;
// never the live database). REAL POSTGRESQL evidence. auth.uid()/auth.jwt() read transaction-local settings; auth
// tables are local stand-ins. Shows that the Phase 4H.4 F4 reproduction now flips: a promotion or worker-owned account
// created while a worker call is in flight WAITS for that call and is then REFUSED; registration and promotion cannot
// interleave; worker reads also block disable/revoke; and owner-level tampering (disabled triggers, replica role) is
// detected against stored checkpoints. Run via scripts/futures-paper/concurrency-check-4h5.sh; skipped without
// FUTURES_PAPER_PG_URL.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState } from "@/lib/futures-paper-engine";
import { exportQuery, makeRecord, verifyAuditTable, type AuditTable, type DbCheckpoint, type ExportedRow } from "@/lib/audit-checkpoint";
import { CFG } from "./helpers/fp-v3-harness";
import { AUTH_AND_APP, MIG_0053, MIG_0054, MIG_0055, MIG_0056, ROLES } from "./helpers/fp-0055-harness";

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
const connect = (url: string, max = 2) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0, un = 0;
const uid = () => `00000000-0000-4000-9455-${(++un).toString(16).padStart(12, "0")}`;
const HOLDER = "00000000-0000-4000-8000-00000000aaaa";
async function freshDb(with0056 = true) {
  const admin = connect(URL!, 1), name = `fpaper4h5_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.unsafe(`ALTER DATABASE ${name} SET futures_paper.change_reason = 'pg test fixture'`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); for (const m of LEDGER) await owner.unsafe(m);
  await owner.unsafe(ROLES); await owner.unsafe(MIG_0053); await owner.unsafe(MIG_0054); await owner.unsafe(AUTH_AND_APP); await owner.unsafe(MIG_0055);
  // Roles are cluster-wide: the hook set by an earlier throwaway database is reset first (test cluster only).
  if (with0056) { await owner.unsafe(`ALTER ROLE authenticator RESET pgrst.db_pre_request`); await owner.unsafe(MIG_0056); }
  return { url, owner };
}
const jwt = (who: string, sid: string | null) => JSON.stringify({ sub: who, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...(sid ? { session_id: sid } : {}) });
/** One transaction as a signed-in user with a live session (role authenticated). */
const asUser = <T>(sql: Sql, who: string, sid: string | null, f: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx.unsafe(`SET LOCAL ROLE authenticated`); await tx.unsafe(`SELECT set_config('test.uid', $1, true), set_config('test.jwt', $2, true)`, [who, jwt(who, sid)]); return f(tx);
}) as Promise<T>;
async function session(owner: Sql, who: string) { const sid = uid(); await owner.unsafe(`INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)`, [sid, who]); return sid; }
async function newAccount(sql: Sql, user: string) {
  const r = await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, CFG, initialFuturesPaperState(1000)] as never[]); });
  return String(r[0]!["id"]);
}
async function world(owner: Sql) {
  const ADMIN = uid(), WORKER = uid(), OWNER = uid();
  await owner.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  const ACCOUNT = await newAccount(owner, OWNER);
  const s = { ADMIN: await session(owner, ADMIN), WORKER: await session(owner, WORKER), OWNER: await session(owner, OWNER) };
  await asUser(owner, ADMIN, s.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [WORKER]));
  await asUser(owner, OWNER, s.OWNER, (tx) => tx.unsafe(`SELECT public.fpw_owner_enroll($1, $2)`, [ACCOUNT, WORKER]));
  return { ADMIN, WORKER, OWNER, ACCOUNT, s };
}
const lockWaiters = async (sql: Sql) => Number((await sql.unsafe(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!["n"]);
async function waitFor(f: () => Promise<boolean>, ms = 5_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; }
const idleInTx = (mon: Sql) => waitFor(async () => (await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length > 0);
const env = (r: postgres.RowList<postgres.Row[]>) => r[0]!["r"] as { ok: boolean; data?: unknown; message?: string };

/** The Phase 4H.4 reproduction, re-run against 0055: the worker holds a writing (or reading) call open, then a change arrives. */
async function inFlight(kind: "admin_promotion" | "super_admin_promotion" | "worker_owned_account" | "disable" | "revoke", call: "acquire" | "snapshot") {
  const { url, owner } = await freshDb(); const w = await world(owner);
  const a = connect(url, 1), b = connect(url, 1), mon = connect(url, 1);
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  let changeAt = 0, workerDoneAt = 0;
  const worker = asUser(a, w.WORKER, w.s.WORKER, async (tx) => {
    const r = call === "acquire" ? await tx.unsafe(`SELECT public.fpw_id2_acquire_lease($1, $2, 30) AS r`, [w.ACCOUNT, HOLDER]) : await tx.unsafe(`SELECT public.fpw_id2_snapshot($1, $2, 1) AS r`, [w.ACCOUNT, HOLDER]);
    await hold; workerDoneAt = Date.now(); return env(r);
  });
  expect(await idleInTx(mon)).toBe(true);
  const change = (kind === "admin_promotion" || kind === "super_admin_promotion" ? b.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2::public.app_role)`, [w.WORKER, kind === "admin_promotion" ? "admin" : "super_admin"])
    : kind === "worker_owned_account" ? newAccount(b, w.WORKER)
    : kind === "disable" ? asUser(b, w.ADMIN, w.s.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, NULL, false)`, [w.WORKER]))
    : asUser(b, w.OWNER, w.s.OWNER, (tx) => tx.unsafe(`SELECT public.fpw_owner_revoke($1, $2)`, [w.ACCOUNT, w.WORKER]))).then(() => { changeAt = Date.now(); return "committed"; }, (e: Error) => { changeAt = Date.now(); return `refused: ${e.message}`; });
  const waited = await waitFor(async () => (await lockWaiters(mon)) === 1);
  release();
  const workerReply = await worker, outcome = await change;
  const next = await asUser(a, w.WORKER, w.s.WORKER, (tx) => tx.unsafe(`SELECT public.fpw_id2_snapshot($1, $2, 1) AS r`, [w.ACCOUNT, HOLDER])).then(env);
  const roles = Number((await owner.unsafe(`SELECT count(*)::int n FROM public.user_roles WHERE user_id=$1 AND role IN ('admin','super_admin')`, [w.WORKER]))[0]!["n"]);
  const owned = Number((await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_accounts WHERE user_id=$1`, [w.WORKER]))[0]!["n"]);
  return { waited, workerOk: workerReply.ok, changeAfterWorker: changeAt >= workerDoneAt, outcome, next, roles, owned };
}

describe.skipIf(!URL)("0055/0056 on real PostgreSQL (throwaway, local)", () => {
  for (const call of ["acquire", "snapshot"] as const) {
    for (const kind of ["admin_promotion", "super_admin_promotion", "worker_owned_account"] as const) {
      it(`F4 flipped (${kind}, in-flight ${call}): the change WAITS for the in-flight call, then is REFUSED; the worker never holds the privilege`, async () => {
        const r = await inFlight(kind, call);
        expect([r.waited, r.workerOk, r.changeAfterWorker]).toEqual([true, true, true]);
        expect(r.outcome).toMatch(kind === "worker_owned_account" ? /^refused: .*cannot own a Futures paper account/ : /^refused: .*cannot receive the (super_)?admin role/);
        expect([r.next.ok, r.roles, r.owned]).toEqual([true, 0, 0]); // still a plain worker: the next call is allowed
      }, 60_000);
    }
    for (const kind of ["disable", "revoke"] as const) {
      it(`a ${kind} waits for an in-flight ${call} (reads lock too under 0055), then every later call is refused`, async () => {
        const r = await inFlight(kind, call);
        expect([r.waited, r.workerOk, r.changeAfterWorker, r.outcome]).toEqual([true, true, true, "committed"]);
        expect(r.next.ok).toBe(false);
        expect(r.next.message).toMatch(kind === "disable" ? /not an enabled worker identity/ : /not enrolled/);
      }, 60_000);
    }
  }
  it("registration and promotion of the same user never interleave: 24 concurrent pairs end as worker XOR admin, never both", async () => {
    const { url, owner } = await freshDb(false); const w = await world(owner);
    const pool = connect(url, 16);
    const users = Array.from({ length: 24 }, () => uid());
    const results = await Promise.all(users.flatMap((u) => [
      asUser(pool, w.ADMIN, w.s.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [u])).then(() => "registered", () => "reg-refused"),
      pool.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [u]).then(() => "promoted", () => "promo-refused"),
    ]));
    for (const u of users) {
      const isWorker = Number((await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [u]))[0]!["n"]);
      const isAdmin = Number((await owner.unsafe(`SELECT count(*)::int n FROM public.user_roles WHERE user_id=$1 AND role='admin'`, [u]))[0]!["n"]);
      expect([u, isWorker + isAdmin]).toEqual([u, 1]);
    }
    expect(results.filter((x) => x === "registered").length + results.filter((x) => x === "promoted").length).toBe(24);
  }, 120_000);
  for (const first of ["registration", "promotion"] as const) {
    it(`deterministic write-skew check: a ${first === "registration" ? "promotion" : "registration"} arriving while a ${first} of the same user is still uncommitted WAITS, then is refused`, async () => {
      const { url, owner } = await freshDb(false); const w = await world(owner);
      const a = connect(url, 1), b = connect(url, 1), mon = connect(url, 1), u = uid();
      let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
      const firstTx = first === "registration"
        ? asUser(a, w.ADMIN, w.s.ADMIN, async (tx) => { await tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [u]); await hold; return "registered"; })
        : a.begin(async (tx) => { await tx.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [u]); await hold; return "promoted"; });
      expect(await idleInTx(mon)).toBe(true);
      const second = (first === "registration"
        ? b.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [u])
        : asUser(b, w.ADMIN, w.s.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [u]))).then(() => "committed", (e: Error) => `refused: ${e.message}`);
      expect(await waitFor(async () => (await lockWaiters(mon)) === 1)).toBe(true);
      release();
      expect(await firstTx).toBe(first === "registration" ? "registered" : "promoted");
      expect(await second).toMatch(first === "registration" ? /^refused: .*cannot receive the admin role/ : /^refused: .*separate plain user/);
    }, 60_000);
  }
  it("two worker calls on the same identity do not block each other (shared lock); a promotion waits for both, then is refused", async () => {
    const { url, owner } = await freshDb(false); const w = await world(owner);
    const a = connect(url, 1), b = connect(url, 1), c = connect(url, 1), mon = connect(url, 1);
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    const w1 = asUser(a, w.WORKER, w.s.WORKER, async (tx) => { const r = await tx.unsafe(`SELECT public.fpw_id2_snapshot($1, $2, 1) AS r`, [w.ACCOUNT, HOLDER]); await hold; return env(r).ok; });
    const w2 = asUser(b, w.WORKER, w.s.WORKER, async (tx) => { const r = await tx.unsafe(`SELECT public.fpw_id2_snapshot($1, $2, 1) AS r`, [w.ACCOUNT, HOLDER]); await hold; return env(r).ok; });
    expect(await waitFor(async () => (await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length === 2)).toBe(true);
    expect(await lockWaiters(mon)).toBe(0);
    const promo = c.unsafe(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [w.WORKER]).then(() => "committed", (e: Error) => e.message);
    expect(await waitFor(async () => (await lockWaiters(mon)) === 1)).toBe(true);
    release();
    expect([await w1, await w2]).toEqual([true, true]);
    expect(await promo).toMatch(/cannot receive the admin role/);
  }, 60_000);
  it("F13 on real PostgreSQL: owner trigger-disable and superuser replica-role deletions (newest and middle) are detected against stored checkpoints; SQL head = TypeScript head", async () => {
    const { owner } = await freshDb(false); const w = await world(owner);
    for (let i = 0; i < 4; i++) {
      const r = env(await asUser(owner, w.WORKER, w.s.WORKER, (tx) => tx.unsafe(`SELECT public.fpw_id2_acquire_lease($1, $2, 30) AS r`, [w.ACCOUNT, HOLDER])));
      await asUser(owner, w.WORKER, w.s.WORKER, (tx) => tx.unsafe(`SELECT public.fpw_id2_release_lease($1, $2, $3) AS r`, [w.ACCOUNT, HOLDER, r.data as number]));
    }
    await asUser(owner, w.WORKER, null, (tx) => tx.unsafe(`SELECT public.fpw_id2_snapshot($1, $2, 1) AS r`, [w.ACCOUNT, HOLDER])); // refused → recorded
    const cp = async (t: AuditTable) => makeRecord(((await asUser(owner, w.ADMIN, w.s.ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_audit_checkpoint($1, 0, NULL, 0) AS r`, [t])))[0]!["r"]) as DbCheckpoint, null);
    const rows = async (t: AuditTable) => (await owner.unsafe(exportQuery(t))) as unknown as ExportedRow[];
    for (const t of ["futures_paper_worker_audit", "futures_paper_worker_refusals", "futures_paper_worker_identity_changes", "futures_paper_config_changes"] as AuditTable[]) {
      const rec = await cp(t); expect([t, (await verifyAuditTable(t, await rows(t), [rec])).ok]).toEqual([t, true]);
    }
    const T: AuditTable = "futures_paper_worker_audit", rec = await cp(T), clean = await rows(T);
    expect(rec.count).toBe(clean.length); expect(clean.length).toBeGreaterThan(5);
    await owner.unsafe(`ALTER TABLE public.futures_paper_worker_audit DISABLE TRIGGER USER`);
    await owner.unsafe(`DELETE FROM public.futures_paper_worker_audit WHERE id = $1`, [clean.at(-1)!["id"]!]);
    await owner.unsafe(`ALTER TABLE public.futures_paper_worker_audit ENABLE TRIGGER USER`);
    expect((await verifyAuditTable(T, await rows(T), [rec])).findings.map((f) => f.code)).toEqual(["ROW_MISSING"]);
    await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL session_replication_role = replica`); await tx.unsafe(`DELETE FROM public.futures_paper_worker_audit WHERE id = $1`, [clean[2]!["id"]!]); });
    const v = await verifyAuditTable(T, await rows(T), [rec]);
    expect([v.ok, v.findings[0]!.code, (v.findings[0] as { actualCount: number }).actualCount]).toEqual([false, "ROW_MISSING", clean.length - 2]);
    expect(Number((await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_refusals`))[0]!["n"])).toBe(1);
  }, 60_000);
});
