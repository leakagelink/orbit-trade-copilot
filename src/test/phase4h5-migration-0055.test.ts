// Phase 4H.5 — DRAFT 0055 (worker security remediation) over drafts 0049–0054 in PGlite. Nothing is applied anywhere
// real; no auth user, session, credential or secret is created (auth tables are local stand-ins, see the harness).
// SYNTHETIC/LOCAL evidence: single-session PGlite. Genuine concurrency is in phase4h5-worker-security.pg.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerPorts } from "@/lib/futures-paper-worker";
import { runHostedFuturesPaperWorkerTick, type HostedRpc } from "@/lib/futures-paper-worker-hosted";
import { decodeIdentityEnvelope, identityRpcNameV2 } from "@/lib/futures-paper-worker-identity";
import { AUDIT_TABLES, exportQuery, makeRecord, verifyAuditTable, type AuditTable, type CheckpointRecord, type DbCheckpoint, type ExportedRow } from "@/lib/audit-checkpoint";
import { M, accountBudget, as, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, callFn, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { setStatus } from "./helpers/fp-v5-harness";
import { MFA_0011, MIG_0055, RB_0054, RB_0055, as0055, callAs, liveSession, make0055Db, type Ctx } from "./helpers/fp-0055-harness";

let db: PGlite;
const ADMIN = freshUser();
let adminCtx: Ctx;
beforeAll(async () => {
  db = await make0055Db();
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  adminCtx = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
}, 120_000);
const N = 6, T0 = NOW - 3_000 - N * M;
async function ownedAccount() { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); return { user, id: await newAccount(db, user, T0 - M, CFG_H), ctx: { uid: user, sid: await liveSession(db, user) } as Ctx }; }
async function enrolledWorker() {
  const worker = freshUser(), acct = await ownedAccount();
  expect((await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
  expect((await callAs(db, acct.ctx, "fpw_owner_enroll", { p_account: acct.id, p_worker: worker })).data).toBe(true);
  return { worker, acct, ctx: { uid: worker, sid: await liveSession(db, worker) } as Ctx };
}
const SIX = (acct: { user: string; id: string }): [string, Record<string, unknown>][] => {
  const base = { p_account: acct.id, p_holder: HOLDER_A };
  return [["fpw_id2_acquire_lease", { ...base, p_ttl_seconds: 30 }], ["fpw_id2_snapshot", { ...base, p_fence: 1 }], ["fpw_id2_evaluated", { ...base, p_fence: 1, p_user: acct.user, p_ids: [] }],
    ["fpw_id2_commit", { ...base, p_fence: 1, p_expected_seq: 0, p_bar_t: 0, p_payload: {}, p_provenance: [] }], ["fpw_id2_mark_review", { ...base, p_fence: 1, p_code: "X" }], ["fpw_id2_release_lease", { ...base, p_fence: 1 }]];
};
/** Each of the six as `ctx`; returns the decoded refusal message (null = allowed) per wrapper. */
async function allSix(ctx: Ctx, acct: { user: string; id: string }) {
  const out: Record<string, string | null> = {};
  for (const [fn, args] of SIX(acct)) { const r = await callAs(db, ctx, fn, args); const d = r.error ? r : decodeIdentityEnvelope(r.data); out[fn] = d.error?.message ?? null; }
  return out;
}
const allMatch = (r: Record<string, string | null>, re: RegExp) => { expect(Object.keys(r)).toHaveLength(6); for (const [fn, m] of Object.entries(r)) expect([fn, m ?? "ALLOWED"]).toEqual([fn, expect.stringMatching(re)]); };
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
const v2Rpc = (ctx: Ctx): HostedRpc => async (fn, args) => { const r = await callAs(db, ctx, identityRpcNameV2(fn), args); return r.error ? r : decodeIdentityEnvelope(r.data); };
const tick = (ctx: Ctx, id: string) => runHostedFuturesPaperWorkerTick({ enabled: true, rpc: v2Rpc(ctx), holder: HOLDER_A, accounts: [id], maxCandlesPerAccount: 50, market: marketFrom(T0), intents: intentsFrom(T0, `l${Math.random().toString(36).slice(2, 7)}`), clock, hosted: { timeoutMs: 2_000 } });
const refusals = (w: string) => db.query<{ fn: string; sqlstate: string; reason: string; session_id: string | null; account_id: string | null }>(`SELECT fn, sqlstate, reason, session_id, account_id FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1 ORDER BY id`, [w]).then((r) => r.rows);
const errOf = async (p: Promise<unknown>) => p.then(() => "ALLOWED", (e: Error) => e.message);

describe("1. legitimate work through the six 0055 envelope wrappers", () => {
  it("a full hosted tick over fpw_id2_* commits every candle; a second tick finds nothing new; no refusal is recorded", async () => {
    const { acct, ctx, worker } = await enrolledWorker();
    expect((await tick(ctx, acct.id)).committed).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [acct.id])).toBe(N);
    expect((await tick(ctx, acct.id)).committed).toBe(0);
    expect(await refusals(worker)).toEqual([]);
  });
  it("the 0053/0054 wrappers are no longer reachable by signed-in callers (only fpw_id2_* are)", async () => {
    const { acct, ctx } = await enrolledWorker();
    for (const fn of ["fpw_id_acquire_lease", "fpw_id_snapshot", "fpw_id_evaluated", "fpw_id_commit", "fpw_id_mark_review", "fpw_id_release_lease"]) {
      const args = SIX(acct).find(([f]) => f === fn.replace("fpw_id_", "fpw_id2_"))![1];
      expect((await callAs(db, ctx, fn, args)).error?.message, fn).toMatch(/permission denied/);
    }
  });
});

describe("2. F4 — no elevated role and no paper account for a registered worker identity (sequential; concurrency in the .pg suite)", () => {
  it("promotion to admin or super_admin is refused for an enabled AND for a disabled identity, by any path; ordinary roles and other users are unaffected", async () => {
    const { worker } = await enrolledWorker();
    for (const role of ["admin", "super_admin"]) expect(await errOf(db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2::public.app_role)`, [worker, role]))).toMatch(/cannot receive the (admin|super_admin) role/);
    const SUPER = freshUser(); await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'super_admin')`, [SUPER]);
    const superCtx = { uid: SUPER, sid: await liveSession(db, SUPER) };
    expect(await as0055(db, superCtx, () => errOf(as(db, "authenticated", `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [worker])))).toMatch(/cannot receive the admin role/);
    expect(await errOf(db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'user')`, [worker]))).toBe("ALLOWED");
    expect(await errOf(db.query(`UPDATE public.user_roles SET role = 'admin' WHERE user_id = $1 AND role = 'user'`, [worker]))).toMatch(/cannot receive the admin role/);
    expect((await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: worker, p_label: null, p_enabled: false })).error).toBeNull();
    expect(await errOf(db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [worker]))).toMatch(/cannot receive the admin role/);
    const plain = freshUser();
    expect(await errOf(db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [plain]))).toBe("ALLOWED");
    expect(await n(db, `SELECT count(*)::int n FROM public.user_roles WHERE user_id=$1 AND role IN ('admin','super_admin')`, [worker])).toBe(0);
  });
  it("a Futures paper account owned by a registered worker identity cannot be created (enabled or disabled); other owners can", async () => {
    const { worker } = await enrolledWorker();
    await expect(newAccount(db, worker, T0 - M, CFG_H)).rejects.toThrow(/cannot own a Futures paper account/);
    await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: worker, p_label: null, p_enabled: false });
    await expect(newAccount(db, worker, T0 - M, CFG_H)).rejects.toThrow(/cannot own a Futures paper account/);
    await expect(newAccount(db, freshUser(), T0 - M, CFG_H)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
  it("account ownership stays immutable (0049) and registration still refuses admins and account owners", async () => {
    const { acct } = await enrolledWorker();
    expect(await errOf(as(db, "service_role", `UPDATE public.futures_paper_accounts SET user_id = $2 WHERE id = $1`, [acct.id, freshUser()]))).not.toBe("ALLOWED");
    const admin2 = freshUser(); await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin2]);
    expect((await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: admin2, p_label: "paper-worker", p_enabled: true })).error?.message).toMatch(/separate plain user/);
    expect((await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: acct.user, p_label: "paper-worker", p_enabled: true })).error?.message).toMatch(/separate plain user/);
  });
});

describe("3. L2–L5 — every worker call needs a live, young session of the caller", () => {
  it("no session id, an unknown (signed-out) session, another user's session, an old session, an expired session or an expired token: all six refused", async () => {
    const { acct, ctx, worker } = await enrolledWorker();
    allMatch(await allSix({ uid: worker, sid: null }, acct), /no session id/);
    allMatch(await allSix({ uid: worker, sid: "00000000-0000-4000-a055-00000000dead" }, acct), /signed out or unknown/);
    const other = freshUser();
    allMatch(await allSix({ uid: worker, sid: await liveSession(db, other) }, acct), /signed out or unknown/);
    allMatch(await allSix({ uid: worker, sid: await liveSession(db, worker, { ageSec: 601 }) }, acct), /older than the worker maximum session age/);
    allMatch(await allSix({ uid: worker, sid: await liveSession(db, worker, { notAfterSec: -1 }) }, acct), /session expired/);
    allMatch(await allSix({ ...ctx, exp: Math.floor(Date.now() / 1000) - 1 }, acct), /token expired/);
    // Sign-out removes the session row: the same token is refused at once.
    expect((await callAs(db, ctx, "fpw_id2_acquire_lease", SIX(acct)[0]![1])).error).toBeNull();
    await db.query(`DELETE FROM auth.sessions WHERE id = $1`, [ctx.sid]);
    allMatch(await allSix(ctx, acct), /signed out or unknown/);
    expect((await refusals(worker)).length).toBeGreaterThanOrEqual(42);
  });
  it("ordinary users: account_mfa_allowed() gives exactly the 0011 answer in every case (no auth setting changed)", async () => {
    const before = await make0055Db({ with0055: false });
    const cases = async (d: PGlite) => {
      const out: boolean[] = [];
      const u1 = "00000000-0000-4000-8000-00000000aa01", u2 = "00000000-0000-4000-8000-00000000aa02", u3 = "00000000-0000-4000-8000-00000000aa03";
      await d.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [u2]);
      await d.query(`INSERT INTO public.workspace_sessions (id, user_id, device, revoked_at) VALUES ('00000000-0000-4000-a000-0000000000a3', $1, 'x', now())`, [u3]);
      for (const c of [{ uid: u1 }, { uid: u2 }, { uid: u2, aal: "aal2" }, { uid: u3, sid: "00000000-0000-4000-a000-0000000000a3" }, { uid: u3 }] as Ctx[])
        out.push((await as0055(d, c, () => as<{ r: boolean }>(d, "authenticated", `SELECT public.account_mfa_allowed() AS r`))).rows[0]!.r);
      out.push((await as<{ r: boolean }>(d, "authenticated", `SELECT public.account_mfa_allowed() AS r`)).rows[0]!.r);
      return out;
    };
    const a = await cases(before), b = await cases(db);
    expect(a).toEqual([true, false, true, false, true, false]);
    expect(b).toEqual(a);
  });
});

describe("4. F15 — a worker identity gets nothing from ordinary app access", () => {
  it("account_mfa_allowed() is false for an enabled or disabled worker identity, so the shared server checks refuse it", async () => {
    const { ctx, worker } = await enrolledWorker();
    const allowed = () => as0055(db, ctx, () => as<{ r: boolean }>(db, "authenticated", `SELECT public.account_mfa_allowed() AS r, public.fpw_caller_is_worker() AS w`)).then((r) => r.rows[0] as unknown as { r: boolean; w: boolean });
    expect(await allowed()).toEqual({ r: false, w: true });
    await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: worker, p_label: null, p_enabled: false });
    expect(await allowed()).toEqual({ r: false, w: true });
    expect((await as0055(db, adminCtx, () => as<{ w: boolean }>(db, "authenticated", `SELECT public.fpw_caller_is_worker() AS w`))).rows[0]!.w).toBe(false);
  });
  it("ordinary tables: the worker reads 0 rows and cannot write — also on tables whose own policy does not call account_mfa_allowed(); a normal user is unaffected", async () => {
    const { ctx, worker } = await enrolledWorker();
    await db.query(`INSERT INTO public.exchange_connections (user_id, label) VALUES ($1, 'k')`, [worker]);
    await db.query(`INSERT INTO public.watchlist_items (user_id, symbol) VALUES ($1, 'BTC')`, [worker]);
    for (const t of ["exchange_connections", "watchlist_items", "user_roles", "futures_paper_worker_enrollments"])
      expect(await as0055(db, ctx, () => as<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.${t}`)).then((r) => r.rows[0]!.n), t).toBe(0);
    for (const t of ["exchange_connections", "watchlist_items"])
      expect(await as0055(db, ctx, () => errOf(as(db, "authenticated", `INSERT INTO public.${t} (user_id, ${t === "watchlist_items" ? "symbol" : "label"}) VALUES ($1, 'x')`, [worker]))), t).toMatch(/row-level security/);
    const u = freshUser(), uctx = { uid: u, sid: await liveSession(db, u) };
    expect(await as0055(db, uctx, () => errOf(as(db, "authenticated", `INSERT INTO public.watchlist_items (user_id, symbol) VALUES ($1, 'ETH')`, [u])))).toBe("ALLOWED");
    expect(await as0055(db, uctx, () => as<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.watchlist_items`)).then((r) => r.rows[0]!.n)).toBe(1);
  });
  it("every public table with row-level security carries the restrictive worker guard (the refusal table has no policy and no grant at all)", async () => {
    const r = await db.query<{ t: string; g: boolean; p: number }>(`SELECT c.relname t, EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='fpw_worker_identity_guard' AND NOT p.polpermissive) g,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) p FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity ORDER BY 1`);
    expect(r.rows.length).toBeGreaterThan(20);
    for (const x of r.rows) expect([x.t, x.g], x.t).toEqual([x.t, x.t !== "futures_paper_worker_refusals"]);
    expect(r.rows.find((x) => x.t === "futures_paper_worker_refusals")!.p).toBe(0);
  });
  it("RESIDUAL without 0056: an owner-rights function executable by every signed-in user still answers the worker (closed by 0056)", async () => {
    const { ctx } = await enrolledWorker();
    expect((await callAs(db, ctx, "claim_referral", { _code: "abc" })).data).toBe("claimed:abc");
  });
});

describe("5. F13 (a) — refused calls leave a durable record", () => {
  it("an authorization refusal returns the original SQLSTATE and message, commits a refusal row and writes nothing else", async () => {
    const { acct, ctx, worker } = await enrolledWorker();
    const other = await ownedAccount(); // not enrolled for this worker
    const before = await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit`);
    const r = await callAs(db, ctx, "fpw_id2_acquire_lease", { p_account: other.id, p_holder: HOLDER_A, p_ttl_seconds: 30 });
    expect(r.error).toBeNull();
    expect(decodeIdentityEnvelope(r.data)).toEqual({ data: null, error: { code: "P0001", message: "futures paper worker: account not enrolled for this worker identity" }, status: 400 });
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit`)).toBe(before);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE account_id=$1`, [other.id])).toBe(0);
    expect(await refusals(worker)).toEqual([{ fn: "acquire_lease", sqlstate: "P0001", reason: "futures paper worker: account not enrolled for this worker identity", session_id: ctx.sid, account_id: other.id }]);
    void acct;
  });
  it("a ledger refusal inside the commit rolls back only the sub-transaction (no commit row) and is recorded", async () => {
    const { acct, ctx, worker } = await enrolledWorker();
    const f = decodeIdentityEnvelope((await callAs(db, ctx, "fpw_id2_acquire_lease", { p_account: acct.id, p_holder: HOLDER_A, p_ttl_seconds: 30 })).data).data as number;
    const r = decodeIdentityEnvelope((await callAs(db, ctx, "fpw_id2_commit", { p_account: acct.id, p_holder: HOLDER_A, p_fence: f, p_expected_seq: 99, p_bar_t: T0, p_payload: {}, p_provenance: [] })).data);
    expect(r.status).toBe(400);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [acct.id])).toBe(0);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [acct.id])).toBe(0);
    expect((await refusals(worker)).map((x) => x.fn)).toEqual(["commit"]);
  });
  it("callers that are not registered identities get the envelope but no record; recording is capped per identity", async () => {
    const acct = await ownedAccount(), stranger = freshUser();
    const r = await callAs(db, { uid: stranger, sid: await liveSession(db, stranger) }, "fpw_id2_snapshot", { p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 });
    expect(decodeIdentityEnvelope(r.data).error?.message).toMatch(/not an enabled worker identity/);
    expect(await refusals(stranger)).toEqual([]);
    const { worker } = await enrolledWorker();
    const wctx = { uid: worker, sid: null };
    for (let i = 0; i < 125; i++) await callAs(db, wctx, "fpw_id2_snapshot", { p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 });
    expect((await refusals(worker)).length).toBe(120);
  }, 60_000);
  it("the refusal table is append-only and closed to every API role", async () => {
    const { ctx, worker } = await enrolledWorker();
    await callAs(db, { ...ctx, sid: null }, "fpw_id2_snapshot", { p_account: (await ownedAccount()).id, p_holder: HOLDER_A, p_fence: 1 });
    expect(await errOf(db.query(`DELETE FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1`, [worker]))).toMatch(/append-only/);
    expect(await errOf(db.query(`UPDATE public.futures_paper_worker_refusals SET reason='x' WHERE worker_user_id=$1`, [worker]))).toMatch(/append-only/);
    expect(await errOf(db.query(`TRUNCATE public.futures_paper_worker_refusals`))).toMatch(/append-only/);
    for (const role of ["anon", "authenticated", "service_role"] as const) expect(await errOf(as(db, role, `SELECT 1 FROM public.futures_paper_worker_refusals`)), role).toMatch(/permission denied/);
  });
});

describe("6. F13 (b) — checkpoints stored outside the database detect every change to covered rows", () => {
  const cp = async (table: AuditTable, prev: CheckpointRecord | null) => {
    const r = await callAs(db, adminCtx, "fpw_audit_checkpoint", { p_table: table, p_after_id: prev?.toId ?? 0, p_prev_head: prev?.head ?? null, p_settle_seconds: 0 });
    expect(r.error, table).toBeNull();
    return makeRecord(r.data as DbCheckpoint, prev);
  };
  const exported = async (t: AuditTable) => (await db.query<ExportedRow>(exportQuery(t))).rows;
  const tamper = async (t: string, sql: string) => { await db.exec(`ALTER TABLE public.${t} DISABLE TRIGGER USER; ${sql}; ALTER TABLE public.${t} ENABLE TRIGGER USER;`); };
  it("only an MFA-verified admin may take a checkpoint; a worker or plain user may not", async () => {
    const { ctx } = await enrolledWorker();
    for (const c of [ctx, (await ownedAccount()).ctx]) expect((await callAs(db, c, "fpw_audit_checkpoint", { p_table: "futures_paper_worker_audit", p_after_id: 0, p_prev_head: null, p_settle_seconds: 0 })).error?.message).toMatch(/admin only/);
  });
  it("for all four audit tables the database head equals the independent TypeScript recomputation; untouched data verifies clean", async () => {
    const { acct, ctx } = await enrolledWorker();
    await tick(ctx, acct.id); await setStatus(db, acct.id, { status: "paused", reason: "pause for test" });
    await callAs(db, { ...ctx, sid: null }, "fpw_id2_snapshot", { p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 });
    for (const t of Object.keys(AUDIT_TABLES) as AuditTable[]) {
      const rec = await cp(t, null), rows = await exported(t);
      expect(rec.count, t).toBe(rows.length); expect(rows.length, t).toBeGreaterThan(0);
      const v = await verifyAuditTable(t, rows, [rec]);
      expect([t, v.ok, v.findings]).toEqual([t, true, []]);
      expect(Object.values(rec.triggers).every((s) => s === "O"), t).toBe(true);
    }
  });
  it("deleting the NEWEST row, a middle row, modifying, inserting or swapping rows (as the owner, triggers disabled) is detected; a later incremental checkpoint stays chained", async () => {
    const T: AuditTable = "futures_paper_worker_audit";
    const { acct, ctx } = await enrolledWorker(); await tick(ctx, acct.id);
    // Consume one id without a row (as a rolled-back insert does) so an id INSIDE the covered range is free.
    const gap = (await db.query<{ g: string }>(`SELECT nextval(pg_get_serial_sequence('public.futures_paper_worker_audit', 'id'))::text g`)).rows[0]!.g;
    const r1 = await cp(T, null);
    const { acct: a2, ctx: c2 } = await enrolledWorker(); await tick(c2, a2.id);
    const r2 = await cp(T, r1);
    const clean = await exported(T);
    expect((await verifyAuditTable(T, clean, [r1, r2])).ok).toBe(true);
    expect(clean.some((x) => x.id === gap)).toBe(false);
    const newest = clean.at(-1)!.id!, middle = clean[Math.floor(clean.length / 2)]!.id!, first = clean[0]!.id!;
    const check = async (sql: string) => { await tamper("futures_paper_worker_audit", sql); const v = await verifyAuditTable(T, await exported(T), [r1, r2]); return { codes: v.findings.map((f) => f.code), uncovered: v.uncheckpointedRows }; };
    // Each tamper is undone by restoring the exact original rows from the clean export (owner rights, test only).
    const restore = async () => { await tamper("futures_paper_worker_audit", `DELETE FROM public.futures_paper_worker_audit`); for (const row of clean) await db.query(`INSERT INTO public.futures_paper_worker_audit (id, account_id, user_id, code, actor, holder, fence, created_at) OVERRIDING SYSTEM VALUE VALUES ($1::bigint, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::bigint, to_timestamp($8::bigint / 1e6))`, [row["id"], row["account_id"], row["user_id"], row["code"], row["actor"], row["holder"], row["fence"], row["created_at_us"]]); expect((await verifyAuditTable(T, await exported(T), [r1, r2])).ok).toBe(true); };
    const ins = (id: string) => `INSERT INTO public.futures_paper_worker_audit (id, account_id, user_id, code, actor) OVERRIDING SYSTEM VALUE VALUES (${id}, '${acct.id}', '${acct.user}', 'ID:COMMIT', 'x')`;
    expect(await check(`DELETE FROM public.futures_paper_worker_audit WHERE id = ${newest}`)).toEqual({ codes: ["ROW_MISSING"], uncovered: 0 }); await restore();
    expect(await check(`DELETE FROM public.futures_paper_worker_audit WHERE id = ${middle}`)).toEqual({ codes: ["ROW_MISSING"], uncovered: 0 }); await restore();
    expect(await check(`UPDATE public.futures_paper_worker_audit SET code = 'ID:COMMIT' WHERE id = ${first}`)).toEqual({ codes: ["ROW_CHANGED"], uncovered: 0 }); await restore();
    expect(await check(`UPDATE public.futures_paper_worker_audit SET created_at = created_at + interval '1 microsecond' WHERE id = ${newest}`)).toEqual({ codes: ["ROW_CHANGED"], uncovered: 0 }); await restore();
    expect(await check(ins(gap))).toEqual({ codes: ["ROW_ADDED"], uncovered: 0 }); await restore();
    // swap the content of two covered rows (a reorder that keeps every id and the row count)
    expect(await check(`WITH a AS (SELECT * FROM public.futures_paper_worker_audit WHERE id = ${first}), b AS (SELECT * FROM public.futures_paper_worker_audit WHERE id = ${newest})
      UPDATE public.futures_paper_worker_audit x SET code = CASE WHEN x.id = ${first} THEN (SELECT code FROM b) ELSE (SELECT code FROM a) END, account_id = CASE WHEN x.id = ${first} THEN (SELECT account_id FROM b) ELSE (SELECT account_id FROM a) END WHERE x.id IN (${first}, ${newest})`)).toEqual({ codes: ["ROW_CHANGED", "ROW_CHANGED"], uncovered: 0 });
    await restore();
    // RESIDUAL: a row beyond the latest stored checkpoint is not covered — reported as uncheckpointed, not as verified.
    expect(await check(ins(String(BigInt(newest) + 1_000_000n)))).toEqual({ codes: [], uncovered: 1 }); await restore();
  }, 60_000);
  it("rewriting the 0052 configuration hash chain consistently (owner rights) still fails the stored checkpoint; a disabled trigger is visible in the checkpoint", async () => {
    const T: AuditTable = "futures_paper_config_changes";
    const { acct } = await enrolledWorker();
    await setStatus(db, acct.id, { status: "paused", reason: "pause one" }); await setStatus(db, acct.id, { status: "active", reason: "resume one" });
    const rec = await cp(T, null);
    expect((await verifyAuditTable(T, await exported(T), [rec])).ok).toBe(true);
    // Delete the newest status change and rewrite nothing else: the chain inside the database stays consistent.
    await tamper(T, `DELETE FROM public.futures_paper_config_changes WHERE id = (SELECT max(id) FROM public.futures_paper_config_changes)`);
    expect((await verifyAuditTable(T, await exported(T), [rec])).findings.map((f) => f.code)).toEqual(["ROW_MISSING"]);
    // Rewrite a reason and recompute that row's chain hash exactly as 0052 would.
    await tamper(T, `UPDATE public.futures_paper_config_changes SET reason = 'rewritten', chain_sha256 = encode(sha256(convert_to(concat_ws('|', coalesce(prev_sha256, 'genesis'), entity, user_id::text, entity_key, version::text, operation, value_sha256, 'rewritten'), 'UTF8')), 'hex') WHERE id = (SELECT max(id) FROM public.futures_paper_config_changes)`);
    expect((await verifyAuditTable(T, await exported(T), [rec])).findings.map((f) => f.code)).toEqual(["ROW_MISSING"]);
    await db.exec(`ALTER TABLE public.futures_paper_config_changes DISABLE TRIGGER futures_paper_config_changes_immutable`);
    const rec2 = await cp(T, rec);
    await db.exec(`ALTER TABLE public.futures_paper_config_changes ENABLE TRIGGER futures_paper_config_changes_immutable`);
    expect(rec2.triggers["futures_paper_config_changes_immutable"]).toBe("D");
    expect((await verifyAuditTable(T, await exported(T), [rec, rec2])).findings.map((f) => f.code)).toContain("TRIGGER_DISABLED_AT_CHECKPOINT");
  });
});

describe("7. privileges, fixed search paths, atomic application and safe rollback", () => {
  it("every 0055 function fixes its search_path; only fpw_caller_is_worker is executable by anon; the wrappers and checkpoint only by authenticated", async () => {
    const r = await db.query<{ f: string; cfg: string[] | null; def: boolean; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(`SELECT p.proname f, p.proconfig cfg, p.prosecdef def,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'fpw_id2_%' OR p.proname IN ('fpw_identity_lock_key','fpw_worker_session_max_age','fpw_refusal_record_cap','fpw_caller_is_worker','fpw_guard_worker_role','fpw_guard_worker_account','fpw_record_refusal','fpw_cp_field','fpw_cp_us','fpw_audit_checkpoint')) ORDER BY 1`);
    expect(r.rows).toHaveLength(16);
    for (const x of r.rows) {
      expect(x.cfg?.some((c) => c.startsWith("search_path=")), x.f).toBe(true);
      expect(x.pub, x.f).toBe(false);
      const exposedToAuth = x.f.startsWith("fpw_id2_") || x.f === "fpw_audit_checkpoint" || x.f === "fpw_caller_is_worker";
      expect([x.f, x.anon, x.auth, x.svc]).toEqual([x.f, x.f === "fpw_caller_is_worker", exposedToAuth, x.f === "fpw_caller_is_worker"]);
    }
  });
  it("is all-or-nothing: a failure late in the file leaves no 0055 object behind; a changed account_mfa_allowed() body refuses the whole draft", async () => {
    const d = await make0055Db({ with0055: false });
    await d.exec(`CREATE FUNCTION public.fpw_audit_checkpoint(p_table text, p_after_id bigint, p_prev_head text, p_settle_seconds integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`);
    await expect(d.exec(MIG_0055)).rejects.toThrow(/already exists/);
    const left = await d.query<{ n: number }>(`SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('fpw_identity_lock_key','fpw_guard_worker_role','fpw_id2_commit'))::int + (SELECT count(*) FROM pg_trigger WHERE tgname IN ('fpw_worker_role_guard','fpw_worker_account_guard'))::int + (SELECT count(*) FROM pg_policy WHERE polname='fpw_worker_identity_guard')::int AS n`);
    expect(left.rows[0]!.n).toBe(0);
    const d2 = await make0055Db({ with0055: false });
    await d2.exec(`CREATE OR REPLACE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$`);
    await expect(d2.exec(MIG_0055)).rejects.toThrow(/differs from the reviewed applied migration 0011/);
  });
  it("rollback order is enforced; the 0055 rollback restores 0011 and 0054 byte-for-byte, re-opens the 0054 wrappers and KEEPS the refusal history", async () => {
    const d = await make0055Db();
    await expect(d.exec(RB_0054)).rejects.toThrow();
    const ref = await make0055Db({ with0055: false });
    const src = (x: PGlite) => x.query<{ f: string; s: string; c: string[] | null }>(`SELECT proname f, prosrc s, proconfig c FROM pg_proc WHERE proname IN ('account_mfa_allowed','fpw_admin_set_identity','fpw_id_check') ORDER BY 1`).then((r) => r.rows);
    await d.query(`INSERT INTO public.futures_paper_worker_refusals (worker_user_id, fn, sqlstate, reason) VALUES ($1, 'snapshot', 'P0001', 'kept')`, [freshUser()]);
    await d.exec(RB_0055);
    expect(await src(d)).toEqual(await src(ref));
    expect(MFA_0011).toContain((await src(d)).find((x) => x.f === "account_mfa_allowed")!.s);
    expect((await d.query<{ reason: string }>(`SELECT reason FROM public.futures_paper_worker_refusals_0055_retired`)).rows).toEqual([{ reason: "kept" }]);
    expect(await errOf(d.query(`DELETE FROM public.futures_paper_worker_refusals_0055_retired`))).toMatch(/append-only/);
    const g = await d.query<{ a: boolean }>(`SELECT has_function_privilege('authenticated', 'public.fpw_id_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)', 'EXECUTE') a`);
    expect(g.rows[0]!.a).toBe(true);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'fpw_id2_%' OR proname IN ('fpw_caller_is_worker','fpw_audit_checkpoint')`)).rows[0]!.n).toBe(0);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_policy WHERE polname='fpw_worker_identity_guard'`)).rows[0]!.n).toBe(0);
    await d.exec(RB_0054); // then 0054 rolls back normally
  }, 60_000);
});
