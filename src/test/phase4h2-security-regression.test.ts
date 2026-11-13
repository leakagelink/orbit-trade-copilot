// Phase 4H.2 — security regression over DRAFTS 0049–0054 in PGlite, driven end to end through the signed-in identity
// binding (`runIdentityFuturesPaperTick`) with a FAKE auth service and data API served from fetch: nothing is applied
// anywhere real, no auth user, credential or secret is created and no network is used. auth.uid() is stubbed by the
// session setting test.uid, set from the (unsigned, test-only) token subject for each data call.
// Layers: (A) database authorization — the six wrappers re-check the CURRENT identity status on every call; (B) code
// allowlisting — only the six wrapper endpoints and the three auth endpoints are ever requested. Runtime isolation
// (layer C) cannot be tested here; see docs/phase-4h2/runtime-isolation-feasibility.md.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerPorts } from "@/lib/futures-paper-worker";
import { IDENTITY_RPC } from "@/lib/futures-paper-worker-identity";
import { identityTransports, runIdentityFuturesPaperTick, type IdentityTickOptions } from "@/lib/futures-paper-worker-identity.server";
import { readTokenClaims } from "@/lib/worker-auth-session";
import { M, accountBudget, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, callFn, expireLease, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { makeEntryDb } from "./helpers/fp-v5-harness";
import { fakeJwt } from "./helpers/fake-auth";

const MIG_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.sql", "utf8");
const MIG_0054 = readFileSync("docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql", "utf8");
const ROLES = `CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
const MFA_STUB = `CREATE OR REPLACE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.mfa', true), ''), 'on') = 'on' $$;`;
const URL_ = "https://backend.test", KEY = "sb_publishable_TESTKEYxxxxxxxxxxxxxxxx", PASSWORD = "Worker-Pass-Do-Not-Log-91", EMAIL = "paper-worker@algovirt.test";

let db: PGlite;
const ADMIN = freshUser();
beforeAll(async () => {
  db = await makeEntryDb(); await db.exec(ROLES); await db.exec(MIG_0053); await db.exec(MIG_0054); await db.exec(MFA_STUB);
  await db.query(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [ADMIN]);
}, 120_000);
afterEach(() => { vi.unstubAllEnvs(); });

const asUser = async <T>(uid: string, f: () => Promise<T>) => {
  await db.exec(`SELECT set_config('test.uid', '${uid}', false), set_config('test.mfa', 'on', false)`);
  try { return await f(); } finally { await db.exec(`SELECT set_config('test.uid', '', false)`); }
};
const call = (fn: string, args: Record<string, unknown>) => callFn(db, fn, args, "authenticated");
const grant = (u: string, role: "admin" | "super_admin") => db.query(`INSERT INTO public.user_roles VALUES ($1, $2::public.app_role)`, [u, role]);
const ungrant = (u: string, role: "admin" | "super_admin") => db.query(`DELETE FROM public.user_roles WHERE user_id = $1 AND role = $2::public.app_role`, [u, role]);
const N = 6, T0 = NOW - 3_000 - N * M;
async function ownedAccount() { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); return { user, id: await newAccount(db, user, T0 - M, CFG_H) }; }
async function enrolledWorker() {
  const worker = freshUser(), acct = await ownedAccount();
  expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true }))).data).toBe(true);
  expect((await asUser(acct.user, () => call("fpw_owner_enroll", { p_account: acct.id, p_worker: worker }))).data).toBe(true);
  return { worker, acct };
}
const commits = (id: string) => n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_audit WHERE account_id=$1 AND code='ID:COMMIT'`, [id]);

/** Fake auth service + data API. Every request is recorded; anything outside the expected endpoints fails the test. */
function fakeBackend(worker: string, hooks: { beforeRpc?: (fn: string) => Promise<void> | void; signIn?: () => Response | null } = {}) {
  const requests: { url: string; auth: string | null; apikey: string | null; body: string }[] = [], tokens = new Map<string, string>();
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const h = new Headers(init.headers), body = typeof init.body === "string" ? init.body : "";
    requests.push({ url, auth: h.get("authorization"), apikey: h.get("apikey"), body });
    expect(init.redirect).toBe("error");
    if (h.get("apikey") !== KEY) return new Response(JSON.stringify({ message: "no api key" }), { status: 401 });
    if (url === `${URL_}/auth/v1/token?grant_type=password`) {
      const pre = hooks.signIn?.(); if (pre) return pre;
      const b = JSON.parse(body) as { email: string; password: string };
      if (b.email !== EMAIL || b.password !== PASSWORD) return new Response(JSON.stringify({ error_code: "invalid_credentials" }), { status: 400 });
      const now = Math.floor(Date.now() / 1000), access = fakeJwt({ sub: worker, role: "authenticated", exp: now + 3600, iat: now });
      tokens.set(access, worker);
      return new Response(JSON.stringify({ access_token: access, refresh_token: `rt-${Math.random()}`, expires_in: 3600, user: { id: worker } }), { status: 200 });
    }
    if (url === `${URL_}/auth/v1/logout?scope=local`) return new Response(null, { status: 204 });
    const m = /^https:\/\/backend\.test\/rest\/v1\/rpc\/(fpw_id_[a-z_]+)$/.exec(url);
    if (m) {
      const tok = (h.get("authorization") ?? "").replace(/^Bearer /, ""), uid = tokens.get(tok), claims = readTokenClaims(tok);
      if (!uid || !claims || claims.exp * 1000 < Date.now()) return new Response(JSON.stringify({ code: "PGRST301", message: "JWT invalid" }), { status: 401 });
      await hooks.beforeRpc?.(m[1]!);
      const r = await asUser(uid, () => call(m[1]!, JSON.parse(body) as Record<string, unknown>));
      return r.error ? new Response(JSON.stringify({ code: r.error.code, message: r.error.message }), { status: 400 }) : new Response(JSON.stringify(r.data), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, requests };
}
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
function enableFlags() {
  vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled"); vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
  vi.stubEnv("SUPABASE_URL", URL_); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
  vi.stubEnv("FUTURES_PAPER_WORKER_EMAIL", EMAIL); vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", PASSWORD);
}
const tickOpts = (id: string, fetchImpl: IdentityTickOptions["fetchImpl"] | undefined): IdentityTickOptions => ({
  enabled: true, holder: HOLDER_A, accounts: [id], maxCandlesPerAccount: 50, market: marketFrom(T0), intents: intentsFrom(T0, `l${Math.random().toString(36).slice(2, 7)}`),
  clock: { now: () => NOW, sleep: async () => {} }, hosted: { timeoutMs: 5_000 }, session: { tickBudgetMs: 60_000 }, ...(fetchImpl ? { fetchImpl } : {}),
});
// The session clock is the real clock (token timing); the worker's candle clock stays at NOW.
const run = (id: string, fetchImpl: IdentityTickOptions["fetchImpl"]) => runIdentityFuturesPaperTick({ ...tickOpts(id, fetchImpl), clock: { now: () => Date.now(), sleep: async () => {} } } as IdentityTickOptions);

describe("B. the signed-in binding: disabled by default, allowlisted requests only, no credential leaks", () => {
  it("refuses without both flags and without credentials", async () => {
    await expect(runIdentityFuturesPaperTick(tickOpts("x", undefined))).rejects.toThrow(/IDENTITY_DISABLED/);
    vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled");
    await expect(runIdentityFuturesPaperTick(tickOpts("x", undefined))).rejects.toThrow(/IDENTITY_DISABLED/);
    vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
    await expect(runIdentityFuturesPaperTick(tickOpts("x", undefined))).rejects.toThrow(/IDENTITY_NOT_CONFIGURED/);
    enableFlags(); vi.stubEnv("SUPABASE_URL", "http://backend.test");
    await expect(runIdentityFuturesPaperTick(tickOpts("x", undefined))).rejects.toThrow(/IDENTITY_NOT_CONFIGURED/); // https only
  });
  it("a full signed-in tick commits every candle, signs in and out once, and only ever requests allowlisted endpoints", async () => {
    enableFlags();
    const { worker, acct } = await enrolledWorker(), be = fakeBackend(worker);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const r = await run(acct.id, be.fetchImpl);
    expect(r).toMatchObject({ outcome: "TICK_COMPLETED", signedIn: true, signedOut: true, refreshes: 0 });
    expect(r.result!.committed).toBe(N);
    expect(await commits(acct.id)).toBe(N);
    const paths = be.requests.map((q) => q.url.replace(URL_, ""));
    expect(paths[0]).toBe("/auth/v1/token?grant_type=password");
    expect(paths.at(-1)).toBe("/auth/v1/logout?scope=local");
    expect(paths.filter((p) => p.startsWith("/auth/"))).toHaveLength(2);
    const rpcs = new Set(paths.filter((p) => p.startsWith("/rest/")).map((p) => p.replace("/rest/v1/rpc/", "")));
    for (const fn of rpcs) expect(Object.values(IDENTITY_RPC)).toContain(fn);
    // The publishable key is only an apikey header, never a bearer; the password only goes to the password endpoint.
    for (const q of be.requests) { expect(q.auth ?? "").not.toContain(KEY); if (!q.url.endsWith("grant_type=password")) expect(q.body).not.toContain(PASSWORD); }
    const text = JSON.stringify(r);
    for (const s of [PASSWORD, EMAIL, KEY, "rt-", "eyJ"]) expect(text).not.toContain(s);
    for (const sp of spies) { expect(sp).not.toHaveBeenCalled(); sp.mockRestore(); }
  });
  it("the data transport itself refuses anything but the six wrappers (defence in depth behind the session allowlist)", async () => {
    const seen: string[] = [];
    const { data } = identityTransports({ url: URL_, key: KEY, email: EMAIL, password: PASSWORD }, async (u) => { seen.push(u); return new Response("1", { status: 200 }); });
    for (const fn of ["fpw_commit", "fpw_admin_set_identity", "fpw_owner_enroll", "wallet_apply", "fpw_id_commit; drop"]) await expect(data(fn, {}, "t", new AbortController().signal), fn).rejects.toThrow(/IDENTITY_DISABLED/);
    expect(seen).toEqual([]);
    for (const fn of Object.values(IDENTITY_RPC)) expect((await data(fn, {}, "t", new AbortController().signal)).data).toBe(1);
    expect(seen).toHaveLength(6);
  });
  it("wrong credentials and auth rate limits end the tick before any data call", async () => {
    enableFlags();
    const { worker, acct } = await enrolledWorker();
    vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", "wrong");
    const bad = fakeBackend(worker);
    expect((await run(acct.id, bad.fetchImpl)).outcome).toBe("AUTH_INVALID_CREDENTIALS");
    expect(bad.requests).toHaveLength(1);
    enableFlags();
    const limited = fakeBackend(worker, { signIn: () => new Response(JSON.stringify({ error_code: "over_request_rate_limit" }), { status: 429, headers: { "retry-after": "120" } }) });
    const r = await run(acct.id, limited.fetchImpl);
    expect([r.outcome, r.retryAfterMs, limited.requests.length]).toEqual(["AUTH_RATE_LIMITED", 120_000, 1]);
    expect(await commits(acct.id)).toBe(0);
  });
});

describe("A. all six wrappers re-check the CURRENT identity on every call", () => {
  it("each of the six mapped wrappers exists, is reachable only by authenticated callers and calls the current-status check", async () => {
    const rows = (await db.query<{ proname: string; src: string; auth: boolean; anon: boolean; svc: boolean; pub: boolean }>(`
      SELECT p.proname, p.prosrc AS src,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
        coalesce(EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), p.proacl IS NULL) AS pub
      FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = ANY($1)`, [Object.values(IDENTITY_RPC)])).rows;
    expect(rows.map((r) => r.proname).sort()).toEqual(Object.values(IDENTITY_RPC).sort());
    for (const r of rows) {
      expect([r.proname, r.auth, r.anon, r.svc, r.pub]).toEqual([r.proname, true, false, false, false]);
      expect(r.src, r.proname).toMatch(/fpw_id_check\(p_account, true\)|fpw_id_authorize\(p_account\)/);
    }
  });
  it("disabling the identity between ticks: the next tick writes nothing, is refused by the database and still signs out", async () => {
    enableFlags();
    const { worker, acct } = await enrolledWorker();
    expect((await asUser(ADMIN, () => call("fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: false }))).data).toBe(true);
    const be = fakeBackend(worker), r = await run(acct.id, be.fetchImpl);
    expect([r.outcome, r.signedOut, r.result!.committed]).toEqual(["TICK_COMPLETED", true, 0]);
    expect(r.result!.hosted.filter((m) => m.code === "RPC_REFUSED").length).toBeGreaterThan(0);
    expect(await commits(acct.id)).toBe(0);
  });
  it("revoking the enrollment between ticks has the same effect; re-enrolling resumes without duplicates", async () => {
    enableFlags();
    const { worker, acct } = await enrolledWorker();
    await db.query(`UPDATE public.futures_paper_worker_enrollments SET revoked_at = now() WHERE account_id = $1 AND worker_user_id = $2`, [acct.id, worker]);
    expect((await run(acct.id, fakeBackend(worker).fetchImpl)).result!.committed).toBe(0);
    expect((await asUser(acct.user, () => call("fpw_owner_enroll", { p_account: acct.id, p_worker: worker }))).data).toBe(true);
    expect((await run(acct.id, fakeBackend(worker).fetchImpl)).result!.committed).toBe(N);
    expect((await run(acct.id, fakeBackend(worker).fetchImpl)).result!.committed).toBe(0);
    expect(await commits(acct.id)).toBe(N);
  });
  for (const role of ["admin", "super_admin"] as const) {
    it(`promotion to ${role} in the MIDDLE of a tick refuses every later call of that tick; demotion resumes without duplicates`, async () => {
      enableFlags();
      const { worker, acct } = await enrolledWorker();
      let promoted = false, refusedAfter = 0;
      const be = fakeBackend(worker, { beforeRpc: async (fn) => { if (fn === "fpw_id_snapshot" && !promoted) { promoted = true; await grant(worker, role); } else if (promoted) refusedAfter++; } });
      const r = await run(acct.id, be.fetchImpl);
      expect([r.signedOut, r.result!.committed]).toEqual([true, 0]);
      expect(refusedAfter).toBeGreaterThan(0); // later calls reached the database and were refused there (not skipped)
      expect(await commits(acct.id)).toBe(0);
      await ungrant(worker, role);
      // The lease taken before the promotion could not be released (release was refused too): it simply expires.
      const busy = await run(acct.id, fakeBackend(worker).fetchImpl);
      expect([busy.result!.committed, busy.result!.hosted.some((m) => m.code === "LEASE_BUSY")]).toEqual([0, true]);
      await expireLease(db, acct.id);
      expect((await run(acct.id, fakeBackend(worker).fetchImpl)).result!.committed).toBe(N);
      expect(await commits(acct.id)).toBe(N);
    });
  }
  it("account ownership cannot change; if a table-owner bypass changes it anyway, the old owner's enrollment stops working on all six", async () => {
    const { worker, acct } = await enrolledWorker(), other = freshUser();
    await expect(db.query(`UPDATE public.futures_paper_accounts SET user_id = $2 WHERE id = $1`, [acct.id, other])).rejects.toThrow();
    // Residual risk F13: the database owner can bypass triggers. Simulate it and show layer A still refuses.
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`UPDATE public.futures_paper_accounts SET user_id = $2 WHERE id = $1`, [acct.id, other]);
    await db.exec(`SET session_replication_role = origin`);
    const base = { p_account: acct.id, p_holder: HOLDER_A };
    const six: [string, Record<string, unknown>][] = [
      ["fpw_id_acquire_lease", { ...base, p_ttl_seconds: 30 }], ["fpw_id_snapshot", { ...base, p_fence: 1 }],
      ["fpw_id_evaluated", { ...base, p_fence: 1, p_user: other, p_ids: [] }],
      ["fpw_id_commit", { ...base, p_fence: 1, p_expected_seq: 0, p_bar_t: 0, p_payload: {}, p_provenance: [] }],
      ["fpw_id_mark_review", { ...base, p_fence: 1, p_code: "X" }], ["fpw_id_release_lease", { ...base, p_fence: 1 }],
    ];
    for (const [fn, args] of six) expect((await asUser(worker, () => call(fn, args))).error?.message, fn).toMatch(/not enrolled for this worker identity/);
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`UPDATE public.futures_paper_accounts SET user_id = $2 WHERE id = $1`, [acct.id, acct.user]);
    await db.exec(`SET session_replication_role = origin`);
    expect((await asUser(worker, () => call("fpw_id_acquire_lease", { ...base, p_ttl_seconds: 30 }))).error).toBeNull();
  });
  it("a worker that becomes a paper account owner is refused on every account through the signed-in path", async () => {
    enableFlags();
    const { worker, acct } = await enrolledWorker();
    await accountBudget(db, worker, 1000, 400, 600);
    await newAccount(db, worker, T0 - M, CFG_H);
    const r = await run(acct.id, fakeBackend(worker).fetchImpl);
    expect([r.signedOut, r.result!.committed]).toEqual([true, 0]);
  });
});
