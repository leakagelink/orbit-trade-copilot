// Phase 4H finalization — DRAFT 0053 (signed-in worker identity) over drafts 0049–0052 in PGlite; nothing is applied
// anywhere real and no auth user or credential is created. auth.uid() is stubbed by the session setting test.uid, and
// has_role/user_roles are stubbed with the app's definitions. Shows: only an admin registers a worker identity; only the
// account owner enrolls it for their own account; the worker reaches only enrolled accounts through the six 0053
// wrappers; the service role can no longer call the gateway; every mutation is audited; rollback order holds.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerPorts } from "@/lib/futures-paper-worker";
import { runHostedFuturesPaperWorkerTick, type HostedRpc } from "@/lib/futures-paper-worker-hosted";
import { IDENTITY_RPC, identityRpcName } from "@/lib/futures-paper-worker-identity";
import { M, accountBudget, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, callFn, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { ROLLBACK_0052, makeEntryDb } from "./helpers/fp-v5-harness";

const MIGRATION_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.sql", "utf8");
const ROLLBACK_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.rollback.sql", "utf8");
const ROLES = `CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
// FP_WITH_0054=1 (Phase 4H.1) also applies successor DRAFT 0054, so this suite re-runs against the corrected lifecycle.
async function makeIdentityDb() {
  const d = await makeEntryDb(); await d.exec(ROLES); await d.exec(MIGRATION_0053);
  if (process.env["FP_WITH_0054"] === "1") await d.exec(readFileSync("docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql", "utf8"));
  return d;
}

let db: PGlite;
const ADMIN = freshUser(), WORKER = freshUser();
beforeAll(async () => { db = await makeIdentityDb(); await db.query(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [ADMIN]); }, 120_000);
const asUser = async <T>(uid: string, f: () => Promise<T>) => { await db.exec(`SELECT set_config('test.uid', '${uid}', false)`); try { return await f(); } finally { await db.exec(`SELECT set_config('test.uid', '', false)`); } };
const call = (fn: string, args: Record<string, unknown>) => callFn(db, fn, args, "authenticated");
const N = 6, T0 = NOW - 3_000 - N * M;
async function ownedAccount() { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); return { user, id: await newAccount(db, user, T0 - M, CFG_H) }; }
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
const identityRpc = (): HostedRpc => async (fn, args) => callFn(db, identityRpcName(fn), args, "authenticated");
const tick = (id: string) => asUser(WORKER, () => runHostedFuturesPaperWorkerTick({ enabled: true, rpc: identityRpc(), holder: HOLDER_A, accounts: [id], maxCandlesPerAccount: 50, market: marketFrom(T0), intents: intentsFrom(T0, `id${Math.random().toString(36).slice(2, 7)}`), clock, hosted: { timeoutMs: 2_000 } }));

describe("registry: only a signed-in admin registers a plain worker identity", () => {
  it("non-admins are refused; admins, super_admins and paper account owners cannot be registered", async () => {
    const owner = await ownedAccount();
    expect((await asUser(freshUser(), () => call("fpw_admin_set_identity", { p_worker: WORKER, p_label: "paper-worker", p_enabled: true }))).error?.message).toMatch(/admin only/);
    expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: ADMIN, p_label: "paper-worker", p_enabled: true }))).error?.message).toMatch(/separate plain user/);
    expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: owner.user, p_label: "paper-worker", p_enabled: true }))).error?.message).toMatch(/separate plain user/);
    expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: WORKER, p_label: "Paper Worker!", p_enabled: true }))).error?.message).toMatch(/label/);
    expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: WORKER, p_label: "paper-worker", p_enabled: true }))).data).toBe(true);
  });
});

describe("explicit per-account authorization", () => {
  it("only the owner enrolls; the worker reaches only enrolled accounts; revocation and disabling cut access", async () => {
    const a = await ownedAccount(), b = await ownedAccount();
    expect((await asUser(b.user, () => call("fpw_owner_enroll", { p_account: a.id, p_worker: WORKER }))).error?.message).toMatch(/only the account owner/);
    expect((await asUser(a.user, () => call("fpw_owner_enroll", { p_account: a.id, p_worker: freshUser() }))).error?.message).toMatch(/not a registered, enabled worker identity/);
    expect((await asUser(a.user, () => call("fpw_owner_enroll", { p_account: a.id, p_worker: WORKER }))).data).toBe(true);
    const lease = (id: string, who = WORKER) => asUser(who, () => call("fpw_id_acquire_lease", { p_account: id, p_holder: HOLDER_A, p_ttl_seconds: 30 }));
    expect((await lease(b.id)).error?.message).toMatch(/account not enrolled for this worker identity/);
    expect((await lease(a.id, a.user)).error?.message).toMatch(/caller is not an enabled worker identity/); // the owner is not the worker
    const f = (await lease(a.id)).data; expect(Number(f)).toBeGreaterThan(0);
    expect((await asUser(WORKER, () => call("fpw_id_release_lease", { p_account: a.id, p_holder: HOLDER_A, p_fence: f }))).data).toBe(true);
    expect((await asUser(a.user, () => call("fpw_owner_revoke", { p_account: a.id, p_worker: WORKER }))).data).toBe(true);
    expect((await lease(a.id)).error?.message).toMatch(/not enrolled/);
    await asUser(a.user, () => call("fpw_owner_enroll", { p_account: a.id, p_worker: WORKER }));
    await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: WORKER, p_label: "paper-worker", p_enabled: false }));
    expect((await lease(a.id)).error?.message).toMatch(/not an enabled worker identity/);
    await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: WORKER, p_label: "paper-worker", p_enabled: true }));
    const audit = (await db.query<{ code: string; actor: string }>(`SELECT code, actor FROM public.futures_paper_worker_audit WHERE account_id=$1 ORDER BY id`, [a.id])).rows;
    expect(audit.map((x) => x.code)).toEqual(["ID:ENROLLED", "ID:LEASE_ACQUIRED", "ID:LEASE_RELEASED", "ID:REVOKED", "ID:ENROLLED"]);
    expect(audit[1]!.actor).toBe(`worker:${WORKER}`);
  });
});

describe("the hosted worker runs end to end as the signed-in identity; the service role is locked out", () => {
  it("a full hosted tick commits every candle through the 0053 wrappers and audits each commit", async () => {
    const a = await ownedAccount(); await asUser(a.user, () => call("fpw_owner_enroll", { p_account: a.id, p_worker: WORKER }));
    const r = await tick(a.id);
    expect(r.committed).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [a.id])).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE account_id=$1`, [a.id])).toBeGreaterThan(0); // through v5
  });
  it("the service role can no longer call any gateway function; browser roles cannot call the 0050 functions directly", async () => {
    const a = await ownedAccount();
    for (const fn of Object.keys(IDENTITY_RPC)) {
      const ok = (await db.query<{ s: boolean; a: boolean }>(`SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') s, has_function_privilege('authenticated', p.oid, 'EXECUTE') a FROM pg_proc p WHERE proname=$1`, [fn])).rows[0]!;
      expect([fn, ok.s, ok.a]).toEqual([fn, false, false]);
    }
    expect((await callFn(db, "fpw_acquire_lease", { p_account: a.id, p_holder: HOLDER_A, p_ttl_seconds: 30 }, "service_role")).error?.message).toMatch(/permission denied/);
    for (const w of Object.values(IDENTITY_RPC)) {
      const ok = (await db.query<{ s: boolean; a: boolean; n: boolean }>(`SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') s, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE proname=$1`, [w])).rows[0]!;
      expect([w, ok.s, ok.a, ok.n]).toEqual([w, false, true, false]);
    }
    expect(() => identityRpcName("fpw_admin_set_identity")).toThrow(/not allowlisted/);
  });
});

describe("migration order and rollback", () => {
  it("0053 needs 0052; 0052's rollback is blocked while 0053 exists; 0053's rollback restores the service-role gateway grants", async () => {
    const d = await makeEntryDb();
    await expect(d.exec(MIGRATION_0053)).rejects.toThrow(/0053 requires drafts 0049–0052 and the app's has_role/);
    await d.exec(ROLES); await d.exec(MIGRATION_0053);
    await expect(d.exec(ROLLBACK_0052)).rejects.toThrow(/cannot drop|depends on/);
    await d.exec(ROLLBACK_0053);
    const g = (await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname = ANY($1::text[]) AND has_function_privilege('service_role', oid, 'EXECUTE')`, [Object.keys(IDENTITY_RPC)])).rows[0]!;
    expect(g.n).toBe(6);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'fpw\\_id\\_%' OR proname IN ('fpw_admin_set_identity','fpw_owner_enroll','fpw_owner_revoke')`)).rows[0]!.n).toBe(0);
    await d.exec(ROLLBACK_0052); // now permitted
  });
});
