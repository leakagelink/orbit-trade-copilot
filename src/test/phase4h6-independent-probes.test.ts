// Phase 4H.6 — independent probes of the Phase 4H.5 drafts (0055/0056 over 0049–0054) in PGlite. Each probe pins a
// property the Phase 4H.5 report states or implies, in the direction the reviewer would try to break it. Nothing real
// is contacted; drafts are read, never modified. PGLITE evidence only (single connection, stand-in auth tables).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshUser } from "./helpers/fp-v3-harness";
import { HOLDER_A } from "./helpers/fp-gateway-harness";
import { as0055, callAs, liveSession, make0055Db, type Ctx } from "./helpers/fp-0055-harness";

let db: PGlite;
const ADMIN = freshUser(), WORKER = freshUser(), OTHER_ADMIN = freshUser(), ACCOUNT = "00000000-0000-4000-9046-000000000001";
let w: Ctx;
beforeAll(async () => {
  db = await make0055Db({ with0056: true });
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'admin')`, [ADMIN, OTHER_ADMIN]);
  const a = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
  await as0055(db, a, () => as(db, "authenticated", `SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [WORKER]));
  w = { uid: WORKER, sid: await liveSession(db, WORKER) };
}, 120_000);
const refusalCount = async (fn?: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.futures_paper_worker_refusals WHERE worker_user_id=$1 AND ($2::text IS NULL OR fn=$2)`, [WORKER, fn ?? null])).rows[0]!.n);
async function request(c: Ctx, method: string, path: string) {
  return as0055(db, c, async () => {
    await db.query(`SELECT set_config('request.method', $1, false), set_config('request.path', $2, false)`, [method, path]);
    try { await as(db, "authenticated", `SELECT public.fpw_api_pre_request()`); return "PASS"; } catch (e) { return `REFUSED ${(e as { code?: string }).code}`; }
    finally { await db.exec(`SELECT set_config('request.method', '', false), set_config('request.path', '', false)`); }
  });
}

describe("F13(a) — which refusals leave a record", () => {
  it("GAP: a request refused by the 0056 data-API hook leaves NO refusal record (the hook aborts the request)", async () => {
    const before = await refusalCount();
    expect(await request(w, "POST", "/rpc/claim_referral")).toBe("REFUSED 42501");
    expect(await request(w, "GET", "/exchange_connections")).toBe("REFUSED 42501");
    expect(await refusalCount()).toBe(before);
  });
  it("GAP: a call to a retired 0053/0054 wrapper is refused by privileges before any body runs — no record", async () => {
    const before = await refusalCount();
    const r = await callAs(db, w, "fpw_id_snapshot", { p_account: ACCOUNT, p_holder: HOLDER_A, p_fence: 1 });
    expect(r.error?.message).toMatch(/permission denied/);
    expect(await refusalCount()).toBe(before);
  });
  it("GAP: after the per-identity cap, a different refused operation is dropped silently — no marker row says records were dropped", async () => {
    const noSession = { uid: WORKER, sid: null };
    for (let i = 0; i < 125; i++) await callAs(db, noSession, "fpw_id2_snapshot", { p_account: ACCOUNT, p_holder: HOLDER_A, p_fence: 1 });
    const r = await callAs(db, noSession, "fpw_id2_mark_review", { p_account: ACCOUNT, p_holder: HOLDER_A, p_fence: 1, p_code: "PROBE" });
    expect(r.error).toBeNull(); // the envelope still reports the refusal to the caller
    expect((r.data as { ok: boolean }).ok).toBe(false);
    expect(await refusalCount("mark_review")).toBe(0);
    expect(await refusalCount()).toBe(120);
  }, 60_000);
});

describe("F4 — role paths the 4H.5 tests name only in summary", () => {
  it("moving an existing admin role row onto the worker (UPDATE user_id) is refused", async () => {
    await expect(db.query(`UPDATE public.user_roles SET user_id=$1 WHERE user_id=$2 AND role='admin'`, [WORKER, OTHER_ADMIN])).rejects.toThrow(/cannot receive the admin role/);
  });
  it("turning the worker's own plain role row into admin or super_admin (UPDATE role) is refused", async () => {
    await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'user') ON CONFLICT DO NOTHING`, [WORKER]);
    for (const role of ["admin", "super_admin"]) await expect(db.query(`UPDATE public.user_roles SET role=$1::public.app_role WHERE user_id=$2 AND role='user'`, [role, WORKER])).rejects.toThrow(/cannot receive the/);
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.user_roles WHERE user_id=$1 AND role<>'user'`, [WORKER])).rows[0]!.n)).toBe(0);
  });
});

describe("F15 / 0056 — request-path assumptions", () => {
  it("UNVERIFIED ASSUMPTION: the hook only accepts paths WITHOUT a gateway prefix; a prefixed path refuses the worker (fails closed, availability risk)", async () => {
    expect(await request(w, "POST", "/rpc/fpw_id2_snapshot")).toBe("PASS");
    expect(await request(w, "POST", "/rest/v1/rpc/fpw_id2_snapshot")).toBe("REFUSED 42501");
  });
  it("an ordinary user is never affected by the hook, whatever the path", async () => {
    const u = { uid: freshUser(), sid: null };
    for (const p of ["/rpc/claim_referral", "/rest/v1/rpc/x", "", "/exchange_connections"]) expect(await request(u, "POST", p), p).toBe("PASS");
  });
});
