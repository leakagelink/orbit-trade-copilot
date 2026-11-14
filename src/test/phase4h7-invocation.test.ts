// Phase 4H.7 — Task 1/2/3: the disabled bounded invocation (`runBoundedIdentityInvocation`) end to end over DRAFTS
// 0049–0057 in PGlite with a FAKE auth service and data API (helpers/fake-backend-4h7.ts). Real timers: every elapsed
// time below is measured, not simulated. Nothing real is contacted; no auth user, credential or secret is created.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runBoundedIdentityInvocation, type BoundedIntents, type BoundedMarket, type InvocationReport } from "@/lib/futures-paper-worker-identity.server";
import { PROPOSED_INVOCATION_LIMITS, type InvocationLimits } from "@/lib/worker-invocation";
import { reconcileRefusals } from "@/lib/worker-refusal-audit";
import { M, accountBudget, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_B, expireLease, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { callAs, liveSession, type Ctx } from "./helpers/fp-0055-harness";
import { addAuthUser, changePassword, make0057Db, requestEmailChange } from "./helpers/fp-0057-harness";
import { KEY, URL_, fakeBackend, type BackendOptions } from "./helpers/fake-backend-4h7";

const L: InvocationLimits = { ...PROPOSED_INVOCATION_LIMITS };
const SLACK_MS = 150; // event-loop / clock granularity allowance on top of the internal budget (still far below 5,000 ms)
let db: PGlite; const ADMIN = freshUser(); let admin: Ctx;
beforeAll(async () => {
  db = await make0057Db();
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  admin = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
}, 120_000);
afterEach(() => { vi.unstubAllEnvs(); });

// One price path for every account (the database refuses two accounts recording different data for one public candle),
// and setups start early in a minute so no further candle closes while a test runs.
const BASE = Math.floor(Date.now() / M) * M - 600 * M;
async function freshMinute() { const into = Date.now() % M; if (into > 30_000) await new Promise((r) => setTimeout(r, M - into + 3_100)); else if (into < 3_100) await new Promise((r) => setTimeout(r, 3_100 - into)); }
async function setup(closed: number) {
  await freshMinute();
  const worker = freshUser(), owner = freshUser(), email = `w-${worker.slice(-6)}@algovirt.test`, password = `pw-${worker.slice(-4)}`;
  await addAuthUser(db, worker, email, password);
  await accountBudget(db, owner, 1000, 400, 600); await strategyBudget(db, owner, "s1", "scalping", 500);
  const t0 = Math.floor(Date.now() / M) * M - closed * M;
  const acct = await newAccount(db, owner, t0 - M, CFG_H);
  expect((await callAs(db, admin, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
  const ownerCtx: Ctx = { uid: owner, sid: await liveSession(db, owner) };
  expect((await callAs(db, ownerCtx, "fpw_owner_enroll", { p_account: acct, p_worker: worker })).data).toBe(true);
  vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled"); vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
  vi.stubEnv("SUPABASE_URL", URL_); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
  vi.stubEnv("FUTURES_PAPER_WORKER_EMAIL", email); vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", password); vi.stubEnv("FUTURES_PAPER_WORKER_USER_ID", worker);
  const m = marketFrom(BASE, undefined, () => Date.now()), i = intentsFrom(t0, `i${Math.random().toString(36).slice(2, 7)}`);
  const market: BoundedMarket = { candles: (s, tf, b) => m.candles(s, tf, b) };
  const intents: BoundedIntents = { forCandle: (a, b) => i.forCandle(a, b) };
  return { worker, owner, ownerCtx, acct, email, market, intents, t0 };
}
type S = Awaited<ReturnType<typeof setup>>;
const invoke = (s: S, be: ReturnType<typeof fakeBackend>, o: { limits?: InvocationLimits; journal?: unknown[] } = {}) =>
  runBoundedIdentityInvocation({ enabled: true, accounts: [s.acct], limits: o.limits ?? L, market: s.market, intents: s.intents, clock: { now: () => Date.now() }, fetchImpl: be.fetchImpl as never, ...(o.journal ? { journal: (e: unknown) => { o.journal!.push(e); } } : {}) });
const seq = async (acct: string) => n(db, `SELECT seq::int n FROM public.futures_paper_accounts WHERE id=$1`, [acct]);
const cursorBars = async (s: S) => (await n(db, `SELECT ((cursor_t - $2::bigint) / ${M})::int n FROM public.futures_paper_accounts WHERE id=$1`, [s.acct, s.t0 - M]));
const sessionsLeft = (w: string) => n(db, `SELECT count(*)::int n FROM auth.sessions WHERE user_id=$1`, [w]);
const inBudget = (r: InvocationReport) => { expect(r.elapsedMs).toBeLessThanOrEqual(L.budgetMs + SLACK_MS); expect(r.elapsedMs + L.safetyMarginMs).toBeLessThanOrEqual(5_000 + SLACK_MS); };

describe("Task 1 — bounded, resumable invocations under the measured 5,000 ms limit", () => {
  it("commits at most maxCandles per invocation, resumes from the database next time; only CAUGHT_UP is completed", async () => {
    const s = await setup(8), be = fakeBackend(db);
    const a = await invoke(s, be);
    inBudget(a);
    expect([a.status, a.completed, a.committed, a.signOut]).toEqual(["PROGRESS", false, 6, "SIGNED_OUT"]);
    const b = await invoke(s, be);
    inBudget(b);
    expect([b.status, b.completed, b.committed]).toEqual(["CAUGHT_UP", true, 2]);
    expect(await cursorBars(s)).toBe(8);
    expect(await sessionsLeft(s.worker)).toBe(0);
    expect(new Set(be.paths.filter((p) => p.startsWith("/rest/")).map((p) => p.replace("/rest/v1/rpc/", "")))).toEqual(new Set(["fpw_id2_acquire_lease", "fpw_id2_snapshot", "fpw_id2_evaluated", "fpw_id2_commit", "fpw_id2_release_lease"]));
  }, 120_000);
  it("timeout BEFORE the database ran the commit: nothing written, invocation ends in budget, the next commits the candle once", async () => {
    const s = await setup(2); let hang = true;
    const be = fakeBackend(db, { hang: (p) => (hang && p.endsWith("fpw_id2_commit") ? "before" : null) });
    const before = await seq(s.acct);
    const a = await invoke(s, be); inBudget(a);
    expect([a.status, a.completed, a.committed]).toEqual(["INCOMPLETE", false, 0]);
    expect(a.reasons).toEqual(expect.arrayContaining(["RPC_TIMEOUT", "UNKNOWN_OUTCOME"]));
    expect(await seq(s.acct)).toBe(before);
    hang = false;
    const b = await invoke(s, be); inBudget(b);
    expect([b.status, b.committed]).toEqual(["CAUGHT_UP", 2]);
    expect(await cursorBars(s)).toBe(2);
  }, 120_000);
  it("timeout AFTER the database committed: outcome unknown, never reported complete, the next invocation never repeats the candle", async () => {
    const s = await setup(3); let hang = true;
    const be = fakeBackend(db, { hang: (p) => (hang && p.endsWith("fpw_id2_commit") ? "after" : null) });
    const a = await invoke(s, be); inBudget(a);
    expect(a.completed).toBe(false);
    expect(a.status).toBe("INCOMPLETE");
    const afterA = await cursorBars(s);
    expect(afterA).toBe(1); // the first commit ran in the database; its identical resend returned the same sequence or was not answered
    hang = false;
    const b = await invoke(s, be); inBudget(b);
    expect([b.status, b.committed]).toEqual(["CAUGHT_UP", 2]);
    expect(await cursorBars(s)).toBe(3); // 3 candles, each committed exactly once
  }, 120_000);
  it("restart: a dead invocation's lease leaves no partial state; the next is SKIPPED_BUSY until the TTL ends, then resumes", async () => {
    const s = await setup(2), be = fakeBackend(db);
    const dead: Ctx = { uid: s.worker, sid: await liveSession(db, s.worker, { ageSec: 0 }) };
    expect(((await callAs(db, dead, "fpw_id2_acquire_lease", { p_account: s.acct, p_holder: HOLDER_B, p_ttl_seconds: L.leaseTtlSeconds })).data as { ok: boolean }).ok).toBe(true);
    const a = await invoke(s, be); inBudget(a);
    expect([a.status, a.completed, a.committed]).toEqual(["SKIPPED_BUSY", false, 0]);
    expect(await cursorBars(s)).toBe(0);
    await expireLease(db, s.acct); // what the 15 s TTL does on its own
    const b = await invoke(s, be); inBudget(b);
    expect([b.status, b.committed]).toEqual(["CAUGHT_UP", 2]);
  }, 120_000);
  it("duplicate invocation of the same slot: the second commits nothing already committed", async () => {
    const s = await setup(3), be = fakeBackend(db);
    const a = await invoke(s, be), b = await invoke(s, be);
    expect([a.status, a.committed, b.status, b.committed]).toEqual(["CAUGHT_UP", 3, "CAUGHT_UP", 0]);
    expect(await cursorBars(s)).toBe(3);
  }, 120_000);
  it("overlapping invocations: exactly one holds the lease, the other is SKIPPED_BUSY; each candle commits once", async () => {
    const s = await setup(4), be = fakeBackend(db, { latencyMs: () => 20 });
    const rs = await Promise.all([invoke(s, be), invoke(s, be)]);
    rs.forEach(inBudget);
    expect(rs.map((r) => r.status).sort()).toEqual(["CAUGHT_UP", "SKIPPED_BUSY"]);
    expect(rs.reduce((x, r) => x + r.committed, 0)).toBe(4);
    expect(await cursorBars(s)).toBe(4);
  }, 120_000);
  it("partial completion under slow calls (250 ms each): the budget ends the invocation in time; durable progress, never completed", async () => {
    const s = await setup(8), be = fakeBackend(db, { latencyMs: () => 250 });
    const a = await invoke(s, be); inBudget(a);
    expect(a.completed).toBe(false);
    expect(["PROGRESS", "INCOMPLETE"]).toContain(a.status);
    expect(a.committed).toBeGreaterThanOrEqual(1);
    expect(a.signOut).toBe("SIGNED_OUT");
    expect(await cursorBars(s)).toBe(a.committed);
    let total = a.committed;
    for (let k = 0; k < 8 && total < 8; k++) { const r = await invoke(s, be); inBudget(r); total += r.committed; }
    expect(await cursorBars(s)).toBe(8);
    expect(total).toBe(8);
  }, 120_000);
  it("every data call slower than its own limit: nothing commits, the invocation still ends in budget and signs out", async () => {
    const s = await setup(2), be = fakeBackend(db, { latencyMs: (p) => (p.startsWith("/rest/") ? L.rpcTimeoutMs + 200 : 0) });
    const a = await invoke(s, be); inBudget(a);
    expect([a.status, a.completed, a.committed, a.signOut]).toEqual(["INCOMPLETE", false, 0, "SIGNED_OUT"]);
    expect(await cursorBars(s)).toBe(0);
  }, 120_000);
  it("statement timeout (57014): nothing commits and the journal files it as platform-log evidence (category B)", async () => {
    const s = await setup(1), journal: unknown[] = [];
    const be = fakeBackend(db, { statementTimeout: (p) => p.endsWith("fpw_id2_commit") });
    const a = await invoke(s, be, { journal }); inBudget(a);
    expect([a.status, a.committed]).toEqual(["INCOMPLETE", 0]);
    expect(a.journal.filter((e) => e.type === "CALL").map((e) => [e.fn, e.kind, e.pgCode, e.category])).toEqual([["commit", "DB_TIMEOUT", "57014", "B"]]);
    expect(journal).toHaveLength(a.journal.length);
    expect(a.journal.at(0)!.type).toBe("INVOCATION_START"); expect(a.journal.at(-1)).toMatchObject({ type: "INVOCATION_END", status: "INCOMPLETE" });
  }, 120_000);
  it("limit profiles that cannot fit the 5,000 ms scheduler limit, or a full step, are refused before any request", async () => {
    const s = await setup(1), be = fakeBackend(db);
    for (const bad of [{ ...L, budgetMs: 4_000 }, { ...L, rpcTimeoutMs: 8_000 }, { ...L, safetyMarginMs: 2_000 }, { ...L, leaseTtlSeconds: 90 }]) {
      const r = await invoke(s, be, { limits: bad });
      expect([r.status, r.completed]).toEqual(["CONFIG_INVALID", false]);
    }
    expect(be.paths).toEqual([]);
  }, 120_000);
});

describe("Task 2 — server-side early stop on changed sign-in details (the database check is authoritative)", () => {
  it("a pending email change in the sign-in reply stops before any data call and signs the session out", async () => {
    const s = await setup(1), be = fakeBackend(db);
    await requestEmailChange(db, s.worker, "next@evil.test");
    const r = await invoke(s, be);
    expect([r.status, r.sessionOutcome, r.signOut]).toEqual(["SESSION_FAILED", "TOKEN_USER_REFUSED", "SIGNED_OUT"]);
    expect(be.paths.filter((p) => p.startsWith("/rest/"))).toEqual([]);
    expect(await sessionsLeft(s.worker)).toBe(0);
  }, 120_000);
  it("a changed password makes the worker's own sign-in fail closed: no session, no data call", async () => {
    const s = await setup(1), be = fakeBackend(db);
    await changePassword(db, s.worker, "attacker");
    const r = await invoke(s, be);
    expect([r.status, r.sessionOutcome, r.signOut]).toEqual(["SESSION_FAILED", "AUTH_INVALID_CREDENTIALS", "NOT_REQUIRED"]);
    expect(be.paths.filter((p) => p.startsWith("/rest/"))).toEqual([]);
  }, 120_000);
  it("a linked sign-in provider stops the invocation (IDENTITY_LINKED)", async () => {
    const s = await setup(1), be = fakeBackend(db);
    await db.query(`INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES ($1, $2, '{"email":"x@gmail.test"}', 'google')`, [`g-${s.worker}`, s.worker]);
    const r = await invoke(s, be);
    expect([r.status, r.sessionOutcome]).toEqual(["SESSION_FAILED", "TOKEN_USER_REFUSED"]);
  }, 120_000);
});

describe("Task 3 — journal reconciled with the database refusal rows and tally", () => {
  const rows = async (w: string) => (await db.query<{ id: number; fn: string; sqlstate: string; session_id: string | null; created_at: Date }>(`SELECT id::int, fn, sqlstate, session_id::text, created_at FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1 ORDER BY id`, [w])).rows.map((r) => ({ ...r, created_at: new Date(r.created_at).getTime() }));
  const tally = async (w: string) => (await db.query<{ baseline_rows: number; recorded_total: number; dropped_total: number }>(`SELECT baseline_rows::int, recorded_total::int, dropped_total::int FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id=$1`, [w])).rows[0] ?? null;
  it("a database refusal seen by the worker matches its row; a deleted row and a foreign refusal are both reported", async () => {
    const s = await setup(1), be = fakeBackend(db);
    expect((await callAs(db, s.ownerCtx, "fpw_owner_revoke", { p_account: s.acct, p_worker: s.worker })).data).toBe(true);
    const a = await invoke(s, be);
    expect(a.journal.filter((e) => e.type === "CALL").map((e) => [e.fn, e.kind, e.category])).toEqual([["acquire_lease", "REFUSED_IN_DB", "A"]]);
    const ok = reconcileRefusals({ journal: a.journal, rows: await rows(s.worker), tally: await tally(s.worker) });
    expect([ok.matched, ok.complete, ok.findings]).toEqual([1, true, []]);
    // A refusal produced with a stolen token (not by this worker) inside the window is a DB-only row.
    const thief: Ctx = { uid: s.worker, sid: await liveSession(db, s.worker, { ageSec: 0 }) };
    await callAs(db, thief, "fpw_id2_snapshot", { p_account: s.acct, p_holder: HOLDER_B, p_fence: 1 });
    const foreign = reconcileRefusals({ journal: a.journal, rows: await rows(s.worker), tally: await tally(s.worker), toleranceMs: 60_000 });
    expect(foreign.findings).toEqual([{ code: "DB_ONLY_REFUSAL", count: 1 }]);
    // The database owner deletes the worker-observed row (triggers bypassed).
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`DELETE FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1 AND fn='acquire_lease'`, [s.worker]);
    await db.exec(`RESET session_replication_role`);
    const gone = reconcileRefusals({ journal: a.journal, rows: await rows(s.worker), tally: await tally(s.worker), toleranceMs: 60_000 });
    expect(gone.complete).toBe(false);
    expect(gone.findings).toEqual(expect.arrayContaining([{ code: "MISSING_IN_DB", count: 1 }, { code: "ROWS_DELETED", count: 1 }]));
  }, 120_000);
});
