// Phase 4H.1 — DRAFT 0054 (worker identity lifecycle) over drafts 0049–0053 in PGlite; nothing is applied anywhere
// real and no auth user, credential or secret is created. auth.uid() is stubbed by the session setting test.uid, MFA by
// test.mfa, and has_role/user_roles use the app's definitions. Shows: (A) an authorized admin can always DISABLE an
// identity, whatever the worker has become, while ENABLING still needs a separate plain user; (B) every worker RPC
// re-checks the CURRENT status (enabled, not admin/super_admin, owns no paper account, enrolled and not revoked);
// legitimate work continues; privileges, fixed search_path, immutable history and rollback order hold.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerPorts } from "@/lib/futures-paper-worker";
import { runHostedFuturesPaperWorkerTick, type HostedRpc } from "@/lib/futures-paper-worker-hosted";
import { IDENTITY_RPC, identityRpcName } from "@/lib/futures-paper-worker-identity";
import { M, accountBudget, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, callFn, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { makeEntryDb } from "./helpers/fp-v5-harness";

const MIG_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.sql", "utf8");
const RB_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.rollback.sql", "utf8");
const MIG_0054 = readFileSync(process.env["FP_0054_FILE"] ?? "docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql", "utf8");
const RB_0054 = readFileSync("docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.rollback.sql", "utf8");
const ROLES = `CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
const MFA_STUB = `CREATE OR REPLACE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.mfa', true), ''), 'on') = 'on' $$;`;
async function chain(upTo: "0053" | "0054") { const d = await makeEntryDb(); await d.exec(ROLES); await d.exec(MIG_0053); if (upTo === "0054") await d.exec(MIG_0054); await d.exec(MFA_STUB); return d; }

let db: PGlite;
const ADMIN = freshUser();
beforeAll(async () => { db = await chain("0054"); await db.query(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [ADMIN]); }, 120_000);
const asUser = async <T>(uid: string, f: () => Promise<T>, mfa = true) => {
  await db.exec(`SELECT set_config('test.uid', '${uid}', false), set_config('test.mfa', '${mfa ? "on" : "off"}', false)`);
  try { return await f(); } finally { await db.exec(`SELECT set_config('test.uid', '', false), set_config('test.mfa', 'on', false)`); }
};
const call = (fn: string, args: Record<string, unknown>) => callFn(db, fn, args, "authenticated");
const setIdentity = (who: string, worker: string, enabled: boolean, label: string | null = "paper-worker", mfa = true) => asUser(who, () => call("fpw_admin_set_identity", { p_worker: worker, p_label: label, p_enabled: enabled }), mfa);
const grant = (u: string, role: "admin" | "super_admin") => db.query(`INSERT INTO public.user_roles VALUES ($1, $2::public.app_role)`, [u, role]);
const ungrant = (u: string, role: "admin" | "super_admin") => db.query(`DELETE FROM public.user_roles WHERE user_id = $1 AND role = $2::public.app_role`, [u, role]);
const N = 6, T0 = NOW - 3_000 - N * M;
async function ownedAccount() { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); return { user, id: await newAccount(db, user, T0 - M, CFG_H) }; }
/** A registered, enabled worker enrolled for one fresh account. */
async function enrolledWorker() {
  const worker = freshUser(), acct = await ownedAccount();
  expect((await setIdentity(ADMIN, worker, true)).data).toBe(true);
  expect((await asUser(acct.user, () => call("fpw_owner_enroll", { p_account: acct.id, p_worker: worker }))).data).toBe(true);
  return { worker, acct };
}
/** Every one of the six worker RPCs, as the worker; returns the error message of each (null = allowed). */
async function allSix(worker: string, acct: { user: string; id: string }) {
  const base = { p_account: acct.id, p_holder: HOLDER_A };
  const calls: [string, Record<string, unknown>][] = [
    ["fpw_id_acquire_lease", { ...base, p_ttl_seconds: 30 }],
    ["fpw_id_snapshot", { ...base, p_fence: 1 }],
    ["fpw_id_evaluated", { ...base, p_fence: 1, p_user: acct.user, p_ids: [] }],
    ["fpw_id_commit", { ...base, p_fence: 1, p_expected_seq: 0, p_bar_t: 0, p_payload: {}, p_provenance: [] }],
    ["fpw_id_mark_review", { ...base, p_fence: 1, p_code: "X" }],
    ["fpw_id_release_lease", { ...base, p_fence: 1 }],
  ];
  const out: Record<string, string | null> = {};
  for (const [fn, args] of calls) out[fn] = (await asUser(worker, () => call(fn, args))).error?.message ?? null;
  return out;
}
const allMatch = (r: Record<string, string | null>, re: RegExp) => { expect(Object.keys(r)).toHaveLength(6); for (const [fn, m] of Object.entries(r)) expect([fn, m ?? "ALLOWED"]).toEqual([fn, expect.stringMatching(re)]); };
const history = (w: string) => db.query<{ old_enabled: boolean | null; new_enabled: boolean; actor: string }>(`SELECT old_enabled, new_enabled, actor FROM public.futures_paper_worker_identity_changes WHERE worker_user_id = $1 ORDER BY id`, [w]).then((r) => r.rows);
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
const identityRpc = (): HostedRpc => async (fn, args) => callFn(db, identityRpcName(fn), args, "authenticated");
const tick = (worker: string, id: string) => asUser(worker, () => runHostedFuturesPaperWorkerTick({ enabled: true, rpc: identityRpc(), holder: HOLDER_A, accounts: [id], maxCandlesPerAccount: 50, market: marketFrom(T0), intents: intentsFrom(T0, `l${Math.random().toString(36).slice(2, 7)}`), clock, hosted: { timeoutMs: 2_000 } }));

describe("1 + 10. normal registration and legitimate worker functionality", () => {
  it("an admin registers a separate plain user; the owner enrolls it; a full hosted tick commits every candle; history records the registration", async () => {
    const { worker, acct } = await enrolledWorker();
    expect(await history(worker)).toEqual([{ old_enabled: null, new_enabled: true, actor: ADMIN }]);
    const r = await tick(worker, acct.id);
    expect(r.committed).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [acct.id])).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE account_id=$1`, [acct.id])).toBeGreaterThan(0);
    // A second tick on the same account finds nothing new and stays consistent.
    expect((await tick(worker, acct.id)).committed).toBe(0);
  });
  it("registration still refuses non-admins, admins without MFA, self, admins, super_admins, owners and bad labels", async () => {
    const w = freshUser(), sa = freshUser(), owner = await ownedAccount(); await grant(sa, "super_admin");
    expect((await setIdentity(freshUser(), w, true)).error?.message).toMatch(/admin only/);
    expect((await setIdentity(ADMIN, w, true, "paper-worker", false)).error?.message).toMatch(/admin only/);
    for (const x of [ADMIN, sa, owner.user]) expect((await setIdentity(ADMIN, x, true)).error?.message).toMatch(/separate plain user/);
    expect((await setIdentity(ADMIN, w, true, "Bad Label!")).error?.message).toMatch(/label/);
    expect((await setIdentity(ADMIN, w, true, null)).error?.message).toMatch(/label/);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_identities WHERE worker_user_id = ANY($1::uuid[])`, [[w, sa, owner.user, ADMIN]])).toBe(0);
  });
});

describe("B. every worker RPC re-checks the worker's CURRENT status", () => {
  it("2. admin promotion after registration blocks all six RPCs and new enrollments; removing the role restores access", async () => {
    const { worker, acct } = await enrolledWorker();
    expect((await allSix(worker, acct))["fpw_id_acquire_lease"]).toBeNull();
    await grant(worker, "admin");
    allMatch(await allSix(worker, acct), /no longer eligible \(it has an admin role\)/);
    const other = await ownedAccount();
    expect((await asUser(other.user, () => call("fpw_owner_enroll", { p_account: other.id, p_worker: worker }))).error?.message).toMatch(/no longer eligible/);
    await ungrant(worker, "admin");
    expect((await asUser(worker, () => call("fpw_id_snapshot", { p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 }))).error?.message ?? "").not.toMatch(/eligible|not an enabled|not enrolled/);
  });
  it("3. super_admin promotion after registration blocks all six RPCs", async () => {
    const { worker, acct } = await enrolledWorker();
    await grant(worker, "super_admin");
    allMatch(await allSix(worker, acct), /no longer eligible \(it has an admin role\)/);
  });
  it("4. the worker becoming a paper account owner after registration blocks all six RPCs (even on its own new account)", async () => {
    const { worker, acct } = await enrolledWorker();
    const own = await newAccount(db, worker, T0 - M, CFG_H);
    allMatch(await allSix(worker, acct), /no longer eligible \(it owns a paper account\)/);
    allMatch(await allSix(worker, { user: worker, id: own }), /no longer eligible \(it owns a paper account\)/);
  });
  it("8. a revoked enrollment blocks all six RPCs; other enrolled accounts keep working; re-enrolling restores access", async () => {
    const { worker, acct } = await enrolledWorker();
    const b = await ownedAccount(); await asUser(b.user, () => call("fpw_owner_enroll", { p_account: b.id, p_worker: worker }));
    expect((await asUser(acct.user, () => call("fpw_owner_revoke", { p_account: acct.id, p_worker: worker }))).data).toBe(true);
    allMatch(await allSix(worker, acct), /account not enrolled for this worker identity/);
    expect((await allSix(worker, b))["fpw_id_acquire_lease"]).toBeNull();
    await asUser(acct.user, () => call("fpw_owner_enroll", { p_account: acct.id, p_worker: worker }));
    expect((await tick(worker, acct.id)).committed).toBe(N);
  });
  it("9. a disabled identity blocks all six RPCs on every account", async () => {
    const { worker, acct } = await enrolledWorker();
    expect((await setIdentity(ADMIN, worker, false)).data).toBe(true);
    allMatch(await allSix(worker, acct), /caller is not an enabled worker identity/);
    expect((await tick(worker, acct.id)).committed).toBe(0);
  });
  it("a signed-out caller and the account owner itself are refused", async () => {
    const { acct } = await enrolledWorker();
    expect((await callFn(db, "fpw_id_snapshot", { p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 }, "authenticated")).error?.message).toMatch(/not an enabled worker identity/);
    allMatch(await allSix(acct.user, acct), /not an enabled worker identity/);
  });
});

describe("A. an authorized admin can always disable; enabling still needs a separate plain user", () => {
  it("5. an admin disables a worker that was promoted to admin; the history records it", async () => {
    const { worker, acct } = await enrolledWorker(); await grant(worker, "admin");
    expect((await setIdentity(ADMIN, worker, false)).data).toBe(true);
    expect((await db.query<{ enabled: boolean }>(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [worker])).rows[0]!.enabled).toBe(false);
    expect(await history(worker)).toEqual([{ old_enabled: null, new_enabled: true, actor: ADMIN }, { old_enabled: true, new_enabled: false, actor: ADMIN }]);
    await ungrant(worker, "admin");
    allMatch(await allSix(worker, acct), /not an enabled worker identity/); // disabled stays disabled after demotion
  });
  it("5b. a worker promoted to super_admin can be disabled too (label may be NULL); a second disable is a recorded no-op", async () => {
    const { worker } = await enrolledWorker(); await grant(worker, "super_admin");
    expect((await setIdentity(ADMIN, worker, false, null)).data).toBe(true);
    expect((await setIdentity(ADMIN, worker, false)).data).toBe(true);
    expect((await history(worker)).length).toBe(2);
  });
  it("6. an admin disables a worker that became a paper account owner", async () => {
    const { worker } = await enrolledWorker(); await newAccount(db, worker, T0 - M, CFG_H);
    expect((await setIdentity(ADMIN, worker, false)).data).toBe(true);
    expect((await db.query<{ enabled: boolean }>(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [worker])).rows[0]!.enabled).toBe(false);
  });
  it("disabling still requires a signed-in admin with MFA; unknown identities and label changes are refused", async () => {
    const { worker, acct } = await enrolledWorker();
    expect((await setIdentity(freshUser(), worker, false)).error?.message).toMatch(/admin only/);
    expect((await setIdentity(acct.user, worker, false)).error?.message).toMatch(/admin only/);
    expect((await setIdentity(worker, worker, false)).error?.message).toMatch(/admin only/);       // the worker itself
    expect((await setIdentity(ADMIN, worker, false, "paper-worker", false)).error?.message).toMatch(/admin only/); // no MFA
    expect((await callFn(db, "fpw_admin_set_identity", { p_worker: worker, p_label: null, p_enabled: false }, "authenticated")).error?.message).toMatch(/admin only/); // signed out
    expect((await setIdentity(ADMIN, freshUser(), false)).error?.message).toMatch(/not a registered worker identity/);
    expect((await setIdentity(ADMIN, worker, false, "renamed")).error?.message).toMatch(/keeps the label/);
    expect((await db.query<{ enabled: boolean }>(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [worker])).rows[0]!.enabled).toBe(true);
    expect((await allSix(worker, acct))["fpw_id_acquire_lease"]).toBeNull();
  });
  it("7. re-enabling an ineligible identity is refused (admin, super_admin, owner); re-enabling an eligible one works", async () => {
    for (const make of [async (w: string) => grant(w, "admin"), async (w: string) => grant(w, "super_admin"), async (w: string) => { await newAccount(db, w, T0 - M, CFG_H); }]) {
      const { worker } = await enrolledWorker();
      await setIdentity(ADMIN, worker, false); await make(worker);
      expect((await setIdentity(ADMIN, worker, true)).error?.message).toMatch(/separate plain user/);
      expect((await db.query<{ enabled: boolean }>(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [worker])).rows[0]!.enabled).toBe(false);
    }
    const { worker, acct } = await enrolledWorker();
    await setIdentity(ADMIN, worker, false);
    expect((await setIdentity(ADMIN, worker, true)).data).toBe(true);
    expect((await allSix(worker, acct))["fpw_id_acquire_lease"]).toBeNull();
    expect((await history(worker)).map((h) => h.new_enabled)).toEqual([true, false, true]);
  });
});

describe("privileges, fixed search_path and immutable history", () => {
  const priv = (fn: string) => db.query<{ pub: boolean; anon: boolean; auth: boolean; svc: boolean; def: boolean; cfg: string[] | null }>(
    `SELECT has_function_privilege('public', p.oid, 'EXECUTE') pub, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
            has_function_privilege('service_role', p.oid, 'EXECUTE') svc, p.prosecdef def, p.proconfig cfg FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname=$1`, [fn]).then((r) => r.rows[0]!);
  it("PUBLIC/anon/service_role reach nothing; authenticated reaches only the admin, owner and six wrapper functions", async () => {
    for (const fn of ["fpw_admin_set_identity", "fpw_owner_enroll", "fpw_owner_revoke", ...Object.values(IDENTITY_RPC)]) {
      const p = await priv(fn); expect([fn, p.pub, p.anon, p.auth, p.svc]).toEqual([fn, false, false, true, false]);
    }
    for (const fn of ["fpw_id_authorize", "fpw_id_check"]) { const p = await priv(fn); expect([fn, p.pub, p.anon, p.auth, p.svc]).toEqual([fn, false, false, false, false]); }
    for (const fn of Object.keys(IDENTITY_RPC)) { const p = await priv(fn); expect([fn, p.svc, p.auth, p.anon]).toEqual([fn, false, false, false]); } // 0050 gateway stays service-role-free
    for (const t of ["futures_paper_worker_identity_changes", "futures_paper_0054_requires_0053", "futures_paper_worker_identities"]) {
      const r = (await db.query<{ a: boolean; s: boolean; n: boolean }>(`SELECT has_table_privilege('authenticated', $1, 'SELECT') a, has_table_privilege('service_role', $1, 'INSERT') s, has_table_privilege('anon', $1, 'SELECT') n`, [`public.${t}`])).rows[0]!;
      expect([t, r.a, r.s, r.n]).toEqual([t, false, false, false]);
    }
  });
  it("every SECURITY DEFINER paper function has a fixed search_path; every 0054 function puts pg_temp last", async () => {
    const r = (await db.query<{ proname: string; cfg: string[] | null }>(`SELECT p.proname, p.proconfig cfg FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.prosecdef AND (p.proname ~ '^(fp|fpw|futures_paper)')`)).rows;
    expect(r.length).toBeGreaterThan(20);
    expect(r.filter((x) => !(x.cfg ?? []).some((c) => /^search_path=/.test(c))).map((x) => x.proname)).toEqual([]);
    for (const fn of ["fpw_admin_set_identity", "fpw_id_check", "fpw_id_authorize", "fpw_owner_enroll", "fpw_id_acquire_lease", "fpw_id_release_lease", "fpw_id_commit", "fpw_id_mark_review"]) {
      const p = await priv(fn); expect([fn, p.def, p.cfg]).toEqual([fn, true, ["search_path=public, pg_temp"]]);
    }
  });
  it("identity history cannot be updated, deleted or truncated, even by the table owner", async () => {
    const { worker } = await enrolledWorker();
    await expect(db.query(`UPDATE public.futures_paper_worker_identity_changes SET new_enabled = false WHERE worker_user_id = $1`, [worker])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM public.futures_paper_worker_identity_changes WHERE worker_user_id = $1`, [worker])).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.futures_paper_worker_identity_changes`)).rejects.toThrow(/append-only/);
  });
});

describe("migration order and rollback", () => {
  const defs = (d: PGlite) => d.query<{ proname: string; def: string; acl: string | null }>(`SELECT p.proname, pg_get_functiondef(p.oid) def, p.proacl::text acl FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND (p.proname ~ '^fpw_' OR p.proname ~ '^fp[0-9]_' OR p.proname ~ '^futures_paper_') ORDER BY p.proname, p.oid`).then((r) => r.rows);
  it("0054 needs 0053; 0053's rollback fails as a whole while 0054 exists; 0054's rollback restores every 0053 body and grant exactly", async () => {
    const bare = await makeEntryDb(); await bare.exec(ROLES);
    await expect(bare.exec(MIG_0054)).rejects.toThrow(/0054 requires draft 0053/);
    const ref = await chain("0053"), d = await chain("0054");
    await expect(d.exec(RB_0053)).rejects.toThrow(/cannot drop|depends on/);
    // the failed rollback changed nothing: in particular the service role did NOT regain the gateway
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname = ANY($1::text[]) AND has_function_privilege('service_role', oid, 'EXECUTE')`, [Object.keys(IDENTITY_RPC)])).rows[0]!.n).toBe(0);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'fpw_id_check'`)).rows[0]!.n).toBe(1);
    await d.exec(RB_0054);
    expect(await defs(d)).toEqual(await defs(ref));
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_class WHERE relname IN ('futures_paper_worker_identity_changes','futures_paper_0054_requires_0053')`)).rows[0]!.n).toBe(0);
    await d.exec(RB_0053); // now permitted
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname = ANY($1::text[]) AND has_function_privilege('service_role', oid, 'EXECUTE')`, [Object.keys(IDENTITY_RPC)])).rows[0]!.n).toBe(6);
  });
});
