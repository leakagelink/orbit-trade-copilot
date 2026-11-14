// Phase 4H.7 — DRAFT 0057 over drafts 0049–0056 in PGlite (PGLITE evidence: single connection, stand-in auth tables;
// nothing real is contacted or applied). Credential-change protection (Task 2) and refusal completeness (Task 3).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { accountBudget, as, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, n } from "./helpers/fp-gateway-harness";
import { MIG_0055, MIG_0056, RB_0055, RB_0056, as0055, callAs, liveSession, make0055Db, type Ctx } from "./helpers/fp-0055-harness";
import { AUTH_USERS_STANDIN, MIG_0057, RB_0057, addAuthUser, changeEmail, changePassword, make0057Db, ordinarySignInTouch, requestEmailChange } from "./helpers/fp-0057-harness";
import { M } from "./helpers/fp-v3-harness";

const CHANGED = "futures paper worker: worker sign-in details changed since registration (an admin must re-register the identity)";
let db: PGlite; const ADMIN = freshUser(); let admin: Ctx;
beforeAll(async () => {
  db = await make0057Db();
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  admin = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
}, 120_000);

async function setup(d: PGlite = db, adm: Ctx = admin) {
  const worker = freshUser(), owner = freshUser(), email = `w-${worker.slice(-6)}@algovirt.test`;
  await addAuthUser(d, worker, email, "pw-1");
  await accountBudget(d, owner, 1000, 400, 600); await strategyBudget(d, owner, "s1", "scalping", 500);
  const acct = await newAccount(d, owner, NOW - 10 * M, CFG_H);
  expect((await callAs(d, adm, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
  const ownerCtx: Ctx = { uid: owner, sid: await liveSession(d, owner) };
  expect((await callAs(d, ownerCtx, "fpw_owner_enroll", { p_account: acct, p_worker: worker })).data).toBe(true);
  // Sessions are created at sign-in, i.e. after registration (age 0 s).
  const w: Ctx = { uid: worker, sid: await liveSession(d, worker, { ageSec: 0 }) };
  return { worker, owner, acct, email, w, ownerCtx };
}
const env = (r: { data: unknown; error: unknown }) => { expect(r.error).toBeNull(); return r.data as { ok: boolean; data?: unknown; sqlstate?: string; message?: string }; };
const acquire = (d: PGlite, c: Ctx, acct: string) => callAs(d, c, "fpw_id2_acquire_lease", { p_account: acct, p_holder: HOLDER_A, p_ttl_seconds: 30 }).then(env);
const snapshot = (d: PGlite, c: Ctx, acct: string, fence = 1) => callAs(d, c, "fpw_id2_snapshot", { p_account: acct, p_holder: HOLDER_A, p_fence: fence }).then(env);
const enabled = async (d: PGlite, w: string) => (await d.query<{ enabled: boolean }>(`SELECT enabled FROM public.futures_paper_worker_identities WHERE worker_user_id=$1`, [w])).rows[0]!.enabled;

describe("Task 2 — credential change removes worker authority (draft 0057)", () => {
  it("registration pins the sign-in details; a fresh session works; an ordinary sign-in does not change the pin", async () => {
    const s = await setup();
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_credential_events WHERE worker_user_id=$1 AND event='PINNED'`, [s.worker])).toBe(1);
    expect((await acquire(db, s.w, s.acct)).ok).toBe(true);
    await ordinarySignInTouch(db, s.worker);
    expect((await snapshot(db, s.w, s.acct)).ok).toBe(true);
  });
  it("password change: the next call is refused; identity disabled, enrollments revoked, lease ended, all recorded", async () => {
    const s = await setup();
    expect((await acquire(db, s.w, s.acct)).ok).toBe(true);
    await changePassword(db, s.worker, "attacker-pw");
    const r = await snapshot(db, s.w, s.acct);
    expect([r.ok, r.sqlstate, r.message]).toEqual([false, "P0001", CHANGED]);
    expect(await enabled(db, s.worker)).toBe(false);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_enrollments WHERE worker_user_id=$1 AND revoked_at IS NULL`, [s.worker])).toBe(0);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE account_id=$1 AND expires_at > clock_timestamp()`, [s.acct])).toBe(0);
    expect((await db.query(`SELECT event, enrollments_revoked, actor::text, session_id::text FROM public.futures_paper_worker_credential_events WHERE worker_user_id=$1 ORDER BY id`, [s.worker])).rows)
      .toEqual([{ event: "PINNED", enrollments_revoked: 0, actor: ADMIN, session_id: null }, { event: "CHANGE_DETECTED", enrollments_revoked: 1, actor: s.worker, session_id: s.w.sid }]);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:REVOKED_CREDENTIALS_CHANGED' AND actor='system:0057'`, [s.acct])).toBe(1);
    expect((await db.query(`SELECT new_enabled, actor::text FROM public.futures_paper_worker_identity_changes WHERE worker_user_id=$1 ORDER BY id DESC LIMIT 1`, [s.worker])).rows[0]).toEqual({ new_enabled: false, actor: s.worker });
    expect((await db.query(`SELECT fn, reason FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1`, [s.worker])).rows).toEqual([{ fn: "snapshot", reason: CHANGED }]);
    expect((await acquire(db, s.w, s.acct)).message).toBe("futures paper worker: caller is not an enabled worker identity");
  });
  it("email change: refused and sticky — changing the email back restores nothing", async () => {
    const s = await setup();
    await changeEmail(db, s.worker, "attacker@evil.test");
    expect((await acquire(db, s.w, s.acct)).message).toBe(CHANGED);
    await changeEmail(db, s.worker, s.email);
    expect((await acquire(db, s.w, s.acct)).message).toBe("futures paper worker: caller is not an enabled worker identity");
    expect(await enabled(db, s.worker)).toBe(false);
  });
  it("a requested (unconfirmed) email change and a newly linked sign-in provider each refuse", async () => {
    const a = await setup();
    await requestEmailChange(db, a.worker, "next@evil.test");
    expect((await acquire(db, a.w, a.acct)).message).toBe(CHANGED);
    const b = await setup();
    await db.query(`INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES ('g-1', $1, '{"email":"x@gmail.test"}', 'google')`, [b.worker]);
    expect((await acquire(db, b.w, b.acct)).message).toBe(CHANGED);
  });
  it("stolen token: refused after the change; after re-registration and re-enrollment a session from BEFORE re-registration stays refused; a new one works", async () => {
    const s = await setup();
    await changePassword(db, s.worker, "attacker-pw");
    expect((await acquire(db, s.w, s.acct)).message).toBe(CHANGED);              // the stolen live token
    // Recovery: the owner resets the password, an admin re-registers (re-pin), the account owner re-enrolls.
    await changePassword(db, s.worker, "owner-reset-pw");
    expect((await callAs(db, admin, "fpw_admin_set_identity", { p_worker: s.worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
    expect((await callAs(db, s.ownerCtx, "fpw_owner_enroll", { p_account: s.acct, p_worker: s.worker })).data).toBe(true);
    expect((await acquire(db, s.w, s.acct)).message).toBe("futures paper worker: worker session predates the current registration");
    const fresh: Ctx = { uid: s.worker, sid: await liveSession(db, s.worker, { ageSec: 0 }) };
    expect((await acquire(db, fresh, s.acct)).ok).toBe(true);
  });
  it("an expired token (exp in the past) and a stale session (older than the worker maximum) are still refused under 0057", async () => {
    const s = await setup();
    expect((await acquire(db, { ...s.w, exp: Math.floor(Date.now() / 1000) - 5 }, s.acct)).message).toBe("futures paper worker: worker session is not active (token expired)");
    await db.query(`UPDATE auth.sessions SET created_at = now() - interval '601 seconds' WHERE id = $1`, [s.w.sid]);
    expect((await acquire(db, s.w, s.acct)).message).toMatch(/older than the worker maximum session age/);
    expect(await enabled(db, s.worker)).toBe(true); // neither is a credential change: nothing sticky happens
  });
  it("registration refuses an id that is not a sign-in user", async () => {
    const r = await callAs(db, admin, "fpw_admin_set_identity", { p_worker: freshUser(), p_label: "paper-worker", p_enabled: true });
    expect(r.error?.message).toBe("futures paper worker identity: the worker must be an existing sign-in user");
  });
  it("ordinary users are unaffected: their own password change leaves their table access and API requests unchanged", async () => {
    const u = freshUser(); await addAuthUser(db, u, `u-${u.slice(-6)}@algovirt.test`, "pw");
    await as(db, "service_role", `INSERT INTO public.exchange_connections (user_id, label) VALUES ($1, 'mine')`, [u]);
    await changePassword(db, u, "pw-2"); await changeEmail(db, u, "new@algovirt.test");
    const c: Ctx = { uid: u, sid: await liveSession(db, u) };
    expect((await as0055(db, c, () => as(db, "authenticated", `SELECT label FROM public.exchange_connections`))).rows).toEqual([{ label: "mine" }]);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_credential_events WHERE worker_user_id=$1`, [u])).toBe(0);
  });
  it("API roles can neither read the 0057 tables nor run the fingerprint", async () => {
    for (const role of ["authenticated", "service_role", "anon"] as const) for (const t of ["futures_paper_worker_credential_pins", "futures_paper_worker_credential_events", "futures_paper_worker_refusal_tally"])
      await expect(as(db, role, `SELECT 1 FROM public.${t}`), `${role} ${t}`).rejects.toThrow(/permission denied/);
    await expect(as(db, "authenticated", `SELECT public.fpw_credential_pin($1)`, [ADMIN])).rejects.toThrow(/permission denied/);
  });
});

describe("Task 2 — identities registered before 0057", () => {
  it("have no pin: refused (not disabled) until an admin re-registers them", async () => {
    const d = await make0057Db({ with0057: false });
    const A = freshUser(); await d.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [A]);
    const adm: Ctx = { uid: A, sid: await liveSession(d, A) };
    const worker = freshUser(), owner = freshUser(); await addAuthUser(d, worker, "old@algovirt.test", "pw");
    await accountBudget(d, owner, 1000, 400, 600); const acct = await newAccount(d, owner, NOW - 10 * M, CFG_H);
    expect((await callAs(d, adm, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
    expect((await callAs(d, { uid: owner, sid: await liveSession(d, owner) }, "fpw_owner_enroll", { p_account: acct, p_worker: worker })).data).toBe(true);
    await d.exec(MIG_0057);
    const w: Ctx = { uid: worker, sid: await liveSession(d, worker, { ageSec: 0 }) };
    expect((await acquire(d, w, acct)).message).toBe("futures paper worker: worker identity has no credential pin (an admin must re-register it)");
    expect(await enabled(d, worker)).toBe(true);
    expect((await callAs(d, adm, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
    expect((await acquire(d, { uid: worker, sid: await liveSession(d, worker, { ageSec: 0 }) }, acct)).ok).toBe(true);
  }, 120_000);
});

describe("Task 3 — refusal completeness (draft 0057 tally)", () => {
  const report = async (d: PGlite, adm: Ctx) => (await callAs(d, adm, "fpw_audit_refusal_completeness", {})).data as Record<string, unknown>[];
  it("every refusal row is counted; above the cap an explicit dropped counter is kept — never a silent drop", async () => {
    const s = await setup(), none: Ctx = { uid: s.worker, sid: null };
    for (let i = 0; i < 125; i++) await acquire(db, none, s.acct);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1`, [s.worker])).toBe(120);
    const t = (await db.query<Record<string, unknown>>(`SELECT baseline_rows::int b, recorded_total::int r, dropped_total::int d, first_dropped_at IS NOT NULL f, last_dropped_at >= first_dropped_at l FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id=$1`, [s.worker])).rows[0];
    expect(t).toEqual({ b: 0, r: 120, d: 5, f: true, l: true });
    const mine = (await report(db, admin)).find((x) => x["worker_user_id"] === s.worker)!;
    expect([mine["rows"], mine["recorded_total"], mine["missing"], mine["dropped_total"], mine["tallied"]]).toEqual([120, 120, 0, 5, true]);
  }, 60_000);
  it("a refusal row deleted by the database owner (triggers bypassed) is reported as missing; an inserted one as negative", async () => {
    const s = await setup(), none: Ctx = { uid: s.worker, sid: null };
    for (let i = 0; i < 3; i++) await acquire(db, none, s.acct);
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`DELETE FROM public.futures_paper_worker_refusals WHERE id = (SELECT max(id) FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1)`, [s.worker]);
    await db.exec(`RESET session_replication_role`);
    expect((await report(db, admin)).find((x) => x["worker_user_id"] === s.worker)!["missing"]).toBe(1);
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`INSERT INTO public.futures_paper_worker_refusals (worker_user_id, fn, sqlstate, reason) VALUES ($1, 'snapshot', 'P0001', 'forged'), ($1, 'snapshot', 'P0001', 'forged')`, [s.worker]);
    await db.exec(`RESET session_replication_role`);
    expect((await report(db, admin)).find((x) => x["worker_user_id"] === s.worker)!["missing"]).toBe(-1);
  });
  it("the counters only increase and are never deleted or truncated; the report is admin-only", async () => {
    const s = await setup(); await acquire(db, { uid: s.worker, sid: null }, s.acct);
    await expect(db.query(`UPDATE public.futures_paper_worker_refusal_tally SET recorded_total = 0 WHERE worker_user_id=$1`, [s.worker])).rejects.toThrow(/counters only increase/);
    await expect(db.query(`UPDATE public.futures_paper_worker_refusal_tally SET dropped_total = dropped_total - 1 WHERE worker_user_id=$1 AND dropped_total > 0 OR worker_user_id=$1`, [s.worker])).rejects.toThrow(/./);
    await expect(db.query(`DELETE FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id=$1`, [s.worker])).rejects.toThrow(/never deleted/);
    await expect(db.exec(`TRUNCATE public.futures_paper_worker_refusal_tally`)).rejects.toThrow(/./);
    expect((await callAs(db, s.ownerCtx, "fpw_audit_refusal_completeness", {})).error?.message).toBe("futures paper audit completeness: admin only");
  });
  it("refusals recorded before 0057 become the tally baseline", async () => {
    const d = await make0057Db({ with0057: false });
    const A = freshUser(); await d.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [A]);
    const adm: Ctx = { uid: A, sid: await liveSession(d, A) };
    const worker = freshUser(); await addAuthUser(d, worker, "b@algovirt.test", "pw");
    expect((await callAs(d, adm, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
    const acct = "00000000-0000-4000-9046-000000000001";
    for (let i = 0; i < 3; i++) await acquire(d, { uid: worker, sid: null }, acct);
    await d.exec(MIG_0057);
    await acquire(d, { uid: worker, sid: null }, acct);
    expect((await d.query(`SELECT baseline_rows::int b, recorded_total::int r FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id=$1`, [worker])).rows[0]).toEqual({ b: 3, r: 4 });
  }, 120_000);
});

describe("Task 4 — rollback order and history preservation (PGlite)", () => {
  const bodies = (d: PGlite) => d.query<{ proname: string; h: string }>(`SELECT proname, md5(prosrc) h FROM pg_proc WHERE proname IN ('fpw_admin_set_identity','fpw_id_check','fpw_record_refusal','account_mfa_allowed') ORDER BY proname`).then((r) => r.rows);
  it("0056 cannot be rolled back while 0057 is applied; 0057's rollback restores the 0055 bodies exactly and keeps all history", async () => {
    const d = await make0057Db({ with0057: false });
    const before = await bodies(d);
    await d.exec(MIG_0057);
    const A = freshUser(); await d.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [A]);
    const adm: Ctx = { uid: A, sid: await liveSession(d, A) };
    const worker = freshUser(); await addAuthUser(d, worker, "r@algovirt.test", "pw");
    expect((await callAs(d, adm, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
    await acquire(d, { uid: worker, sid: null }, "00000000-0000-4000-9046-000000000001");
    await expect(d.exec(RB_0056)).rejects.toThrow(/depend/);
    await d.exec(RB_0057);
    expect(await bodies(d)).toEqual(before);
    expect(await n(d, `SELECT count(*)::int n FROM public.futures_paper_worker_credential_events_0057_retired`)).toBe(1);
    expect(await n(d, `SELECT count(*)::int n FROM public.futures_paper_worker_refusal_tally_0057_retired`)).toBe(1);
    expect(await n(d, `SELECT count(*)::int n FROM public.futures_paper_worker_credential_pins_0057_retired`)).toBe(1);
    await expect(d.query(`DELETE FROM public.futures_paper_worker_credential_events_0057_retired`)).rejects.toThrow(/./);
    await expect(as(d, "authenticated", `SELECT 1 FROM public.futures_paper_worker_refusal_tally_0057_retired`)).rejects.toThrow(/permission denied/);
    await expect(d.exec(MIG_0057)).rejects.toThrow(/tables from an earlier 0057 application exist/);
    await d.exec(RB_0056); await d.exec(RB_0055);
    expect(await n(d, `SELECT count(*)::int n FROM pg_proc WHERE proname IN ('fpw_credential_pin','fpw_audit_refusal_completeness','fpw_0057_requires_0056','fpw_api_pre_request','fpw_record_refusal')`)).toBe(0);
  }, 120_000);
  it("0057 refuses without 0056 and without the auth sign-in tables", async () => {
    const a = await make0055Db({ with0056: false }); await a.exec(AUTH_USERS_STANDIN);
    await expect(a.exec(MIG_0057)).rejects.toThrow(/0057 requires draft 0056/);
    const b = await make0055Db({ with0056: true });
    await expect(b.exec(MIG_0057)).rejects.toThrow(/0057 requires auth.users and auth.identities/);
    void MIG_0055; void MIG_0056;
  }, 120_000);
});
