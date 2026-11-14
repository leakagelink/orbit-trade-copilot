// Phase 4H.5 — the disabled signed-in binding (`runIdentityFuturesPaperTick`, default gateway "0055") end to end over
// DRAFTS 0049–0056 in PGlite, with a FAKE auth service and data API served from fetch. Nothing real is contacted; no
// auth user, credential or secret is created. The fake auth service MODELS the documented behaviour (sign-in creates a
// session row, local sign-out deletes it, refresh keeps the session id); the hosted behaviour is NOT VERIFIED.
// The fake data API runs the 0056 request hook first (as the data API documents), then the function as the token's user.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { identityTransports, runIdentityFuturesPaperTick, type IdentityTickOptions } from "@/lib/futures-paper-worker-identity.server";
import { decodeIdentityEnvelope } from "@/lib/futures-paper-worker-identity";
import { readTokenClaims } from "@/lib/worker-auth-session";
import { M, accountBudget, as, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, NOW, callFn, intentsFrom, marketFrom, n } from "./helpers/fp-gateway-harness";
import { as0055, callAs, freshSession, liveSession, make0055Db, type Ctx } from "./helpers/fp-0055-harness";
import { fakeJwt } from "./helpers/fake-auth";

const URL_ = "https://backend.test", KEY = "sb_publishable_TESTKEYxxxxxxxxxxxxxxxx", PASSWORD = "Worker-Pass-Do-Not-Log-45", EMAIL = "paper-worker@algovirt.test";
let db: PGlite; const ADMIN = freshUser(); let adminCtx: Ctx;
beforeAll(async () => {
  db = await make0055Db({ with0056: true });
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  adminCtx = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
}, 120_000);
afterEach(() => { vi.unstubAllEnvs(); });
const N = 6, T0 = NOW - 3_000 - N * M;
async function enrolledWorker() {
  const worker = freshUser(), user = freshUser();
  await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
  const id = await newAccount(db, user, T0 - M, CFG_H);
  expect((await callAs(db, adminCtx, "fpw_admin_set_identity", { p_worker: worker, p_label: "paper-worker", p_enabled: true })).error).toBeNull();
  expect((await callAs(db, { uid: user, sid: await liveSession(db, user) }, "fpw_owner_enroll", { p_account: id, p_worker: worker })).data).toBe(true);
  return { worker, acct: { user, id } };
}
function backend(worker: string, o: { logoutStatus?: number } = {}) {
  const paths: string[] = [], issuedTokens: string[] = [];
  const rpc = async (path: string, token: string, body: string): Promise<Response> => {
    const c = readTokenClaims(token);
    if (!c || c.exp * 1000 < Date.now()) return new Response(JSON.stringify({ code: "PGRST301", message: "JWT expired" }), { status: 401 });
    const ctx: Ctx = { uid: c.sub, sid: c.sid, exp: c.exp };
    return as0055(db, ctx, async () => {
      await db.query(`SELECT set_config('request.method', 'POST', false), set_config('request.path', $1, false)`, [path]);
      try {
        try { await as(db, "authenticated", `SELECT public.fpw_api_pre_request()`); } catch (e) { return new Response(JSON.stringify({ code: (e as { code?: string }).code, message: (e as Error).message }), { status: 403 }); }
        const r = await callFn(db, path.slice("/rpc/".length), JSON.parse(body) as Record<string, unknown>, "authenticated");
        return r.error ? new Response(JSON.stringify({ code: r.error.code, message: r.error.message }), { status: 400 }) : new Response(JSON.stringify(r.data), { status: 200 });
      } finally { await db.exec(`SELECT set_config('request.method', '', false), set_config('request.path', '', false)`); }
    });
  };
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace(URL_, ""), h = new Headers(init.headers), body = String(init.body ?? "");
    paths.push(path); expect(init.redirect).toBe("error");
    if (path === "/auth/v1/token?grant_type=password") {
      const b = JSON.parse(body) as { email: string; password: string };
      if (b.email !== EMAIL || b.password !== PASSWORD) return new Response(JSON.stringify({ error_code: "invalid_credentials" }), { status: 400 });
      const sid = freshSession(), now = Math.floor(Date.now() / 1000);
      await db.query(`INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)`, [sid, worker]);
      const access = fakeJwt({ sub: worker, role: "authenticated", exp: now + 3600, iat: now, session_id: sid }); issuedTokens.push(access);
      return new Response(JSON.stringify({ access_token: access, refresh_token: `rt-${Math.random()}`, expires_in: 3600, user: { id: worker } }), { status: 200 });
    }
    if (path === "/auth/v1/logout?scope=local") {
      const c = readTokenClaims((h.get("authorization") ?? "").replace(/^Bearer /, ""));
      if ((o.logoutStatus ?? 204) >= 300) return new Response(null, { status: o.logoutStatus! });
      await db.query(`DELETE FROM auth.sessions WHERE id = $1`, [c!.sid]);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/rest/v1/")) return rpc(path.slice("/rest/v1".length), (h.get("authorization") ?? "").replace(/^Bearer /, ""), body);
    throw new Error(`unexpected request ${path}`);
  };
  return { fetchImpl, paths, issuedTokens, rpc };
}
function enable(worker: string) {
  vi.stubEnv("FUTURES_PAPER_WORKER_HOSTED", "enabled"); vi.stubEnv("FUTURES_PAPER_WORKER_IDENTITY", "signed-in");
  vi.stubEnv("SUPABASE_URL", URL_); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
  vi.stubEnv("FUTURES_PAPER_WORKER_EMAIL", EMAIL); vi.stubEnv("FUTURES_PAPER_WORKER_PASSWORD", PASSWORD); vi.stubEnv("FUTURES_PAPER_WORKER_USER_ID", worker);
}
const run = (id: string, fetchImpl: IdentityTickOptions["fetchImpl"]) => runIdentityFuturesPaperTick({ enabled: true, holder: HOLDER_A, accounts: [id], maxCandlesPerAccount: 50, market: marketFrom(T0),
  intents: intentsFrom(T0, `l${Math.random().toString(36).slice(2, 7)}`), clock: { now: () => Date.now(), sleep: async () => {} }, hosted: { timeoutMs: 5_000 }, session: { tickBudgetMs: 60_000 }, fetchImpl } as IdentityTickOptions);
const refusals = (w: string) => db.query<{ fn: string; reason: string; session_id: string }>(`SELECT fn, reason, session_id::text FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1 ORDER BY id`, [w]).then((r) => r.rows);

describe("the signed-in binding over 0055 + 0056", () => {
  it("one tick: sign-in, only the six fpw_id2_* operations, every candle committed, sign-out removes the session; nothing refused", async () => {
    const { worker, acct } = await enrolledWorker(); enable(worker);
    const be = backend(worker);
    const r = await run(acct.id, be.fetchImpl);
    expect([r.outcome, r.signOut, r.result?.committed]).toEqual(["TICK_COMPLETED", "SIGNED_OUT", N]);
    const rpcs = be.paths.filter((p) => p.startsWith("/rest/")).map((p) => p.replace("/rest/v1/rpc/", ""));
    expect(new Set(rpcs)).toEqual(new Set(["fpw_id2_acquire_lease", "fpw_id2_snapshot", "fpw_id2_evaluated", "fpw_id2_commit", "fpw_id2_release_lease"]));
    expect(await n(db, `SELECT count(*)::int n FROM auth.sessions WHERE user_id=$1`, [worker])).toBe(0);
    expect(await refusals(worker)).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/Worker-Pass|paper-worker@|eyJ/);
  });
  it("L2/L3: the access token of a finished tick is refused by the database at once (session gone) and the attempt is recorded", async () => {
    const { worker, acct } = await enrolledWorker(); enable(worker);
    const be = backend(worker);
    await run(acct.id, be.fetchImpl);
    const old = be.issuedTokens[0]!, sid = readTokenClaims(old)!.sid;
    const reply = await be.rpc("/rpc/fpw_id2_snapshot", old, JSON.stringify({ p_account: acct.id, p_holder: HOLDER_A, p_fence: 1 }));
    expect(decodeIdentityEnvelope(await reply.json()).error?.message).toBe("futures paper worker: worker session is not active (signed out or unknown)");
    expect(await refusals(worker)).toEqual([{ fn: "snapshot", reason: "futures paper worker: worker session is not active (signed out or unknown)", session_id: sid }]);
  });
  it("L4/L5: when sign-out is not acknowledged the leftover session is usable for worker calls only until the worker maximum session age", async () => {
    const { worker, acct } = await enrolledWorker(); enable(worker);
    const be = backend(worker, { logoutStatus: 500 });
    const r = await run(acct.id, be.fetchImpl);
    expect([r.outcome, r.signOut, typeof r.residualTokenUntil]).toEqual(["TICK_COMPLETED", "SIGN_OUT_FAILED", "number"]);
    const old = be.issuedTokens[0]!, sid = readTokenClaims(old)!.sid;
    await db.query(`UPDATE auth.sessions SET created_at = now() - interval '601 seconds' WHERE id = $1`, [sid]);
    const reply = await be.rpc("/rpc/fpw_id2_acquire_lease", old, JSON.stringify({ p_account: acct.id, p_holder: HOLDER_A, p_ttl_seconds: 30 }));
    expect(decodeIdentityEnvelope(await reply.json()).error?.message).toMatch(/older than the worker maximum session age/);
  });
  it("F15: with the worker's token, every other data-API request is refused by the request hook, and the binding itself requests nothing else", async () => {
    const { worker } = await enrolledWorker(); enable(worker);
    const be = backend(worker);
    const now = Math.floor(Date.now() / 1000), sid = await liveSession(db, worker);
    const tok = fakeJwt({ sub: worker, role: "authenticated", exp: now + 3600, iat: now, session_id: sid });
    for (const p of ["/rpc/claim_referral", "/rpc/fpw_id_commit", "/rpc/fpw_audit_checkpoint", "/rpc/fpw_admin_set_identity"])
      expect([(await be.rpc(p, tok, JSON.stringify({}))).status, p]).toEqual([403, p]);
    const { data } = identityTransports({ url: URL_, key: KEY, email: EMAIL, password: PASSWORD }, be.fetchImpl as never);
    for (const fn of ["claim_referral", "fpw_id_commit", "wallet_apply", "fpw_id2_commit; drop"]) await expect(data(fn, {}, tok, new AbortController().signal), fn).rejects.toThrow(/IDENTITY_DISABLED/);
  });
});
