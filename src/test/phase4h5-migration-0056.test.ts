// Phase 4H.5 — DRAFT 0056 (data-API request boundary) over drafts 0049–0055 in PGlite. The data API is SIMULATED: a
// request is modelled as the role switch + request.path/request.method settings + a call of the configured hook, as
// the data API documents it; nothing real is contacted and no setting outside this throwaway database changes.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshUser } from "./helpers/fp-v3-harness";
import { MIG_0056, RB_0055, RB_0056, as0055, liveSession, make0055Db, type Ctx } from "./helpers/fp-0055-harness";

let db: PGlite;
const ADMIN = freshUser(), WORKER = freshUser(), USER = freshUser();
let w: Ctx, u: Ctx;
beforeAll(async () => {
  db = await make0055Db({ with0056: true });
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
  const a = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
  await as0055(db, a, () => as(db, "authenticated", `SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [WORKER]));
  w = { uid: WORKER, sid: await liveSession(db, WORKER) }; u = { uid: USER, sid: await liveSession(db, USER) };
}, 120_000);
/** One simulated data-API request: the hook runs as the request role with the request settings. */
async function request(c: Ctx | null, method: string, path: string, role: "authenticated" | "anon" | "service_role" = "authenticated") {
  const run = async () => {
    await db.query(`SELECT set_config('request.method', $1, false), set_config('request.path', $2, false)`, [method, path]);
    try { await as(db, role, `SELECT public.fpw_api_pre_request()`); return "PASS"; } catch (e) { return `REFUSED ${(e as { code?: string }).code}`; }
    finally { await db.exec(`SELECT set_config('request.method', '', false), set_config('request.path', '', false)`); }
  };
  return c ? as0055(db, c, run) : run();
}
const SIX = ["acquire_lease", "release_lease", "snapshot", "evaluated", "commit", "mark_review"].map((x) => `/rpc/fpw_id2_${x}`);
const OTHER = ["/rpc/claim_referral", "/rpc/mailbox_send", "/rpc/fpw_id_commit", "/rpc/fpw_audit_checkpoint", "/rpc/graphql", "/exchange_connections", "/user_roles", "/wallets", "/profiles", "/", "/rpc/fpw_id2_commit/x", "/RPC/FPW_ID2_COMMIT"];

describe("0056 — a worker identity may make only the six worker requests", () => {
  it("the hook is configured on the data-API role (and nowhere else)", async () => {
    const r = await db.query<{ v: string }>(`SELECT c.v FROM pg_db_role_setting s, unnest(s.setconfig) c(v) WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname='authenticator')`);
    expect(r.rows.map((x) => x.v)).toEqual(["pgrst.db_pre_request=public.fpw_api_pre_request"]);
  });
  it("worker: POST to each of the six passes; every other path, every other method, a missing path and a lookalike are refused (42501)", async () => {
    for (const p of SIX) expect(await request(w, "POST", p), p).toBe("PASS");
    for (const p of SIX) for (const m of ["GET", "PATCH", "DELETE", "HEAD"]) expect(await request(w, m, p), `${m} ${p}`).toBe("REFUSED 42501");
    for (const p of OTHER) expect(await request(w, "POST", p), p).toBe("REFUSED 42501");
    for (const p of OTHER) expect(await request(w, "GET", p), p).toBe("REFUSED 42501");
    expect(await request(w, "", "")).toBe("REFUSED 42501"); // request settings missing → fails closed for the worker
  });
  it("a DISABLED identity is refused everywhere except the six (which the database then refuses itself)", async () => {
    const d = freshUser(); const a = { uid: ADMIN, sid: await liveSession(db, ADMIN) };
    await as0055(db, a, () => as(db, "authenticated", `SELECT public.fpw_admin_set_identity($1, 'paper-worker-b', true)`, [d]));
    await as0055(db, a, () => as(db, "authenticated", `SELECT public.fpw_admin_set_identity($1, NULL, false)`, [d]));
    const dc = { uid: d, sid: await liveSession(db, d) };
    expect(await request(dc, "GET", "/exchange_connections")).toBe("REFUSED 42501");
    expect(await request(dc, "POST", "/rpc/claim_referral")).toBe("REFUSED 42501");
  });
  it("ordinary users, anonymous callers and the service role are never affected", async () => {
    for (const p of [...OTHER, ...SIX]) for (const m of ["GET", "POST"]) {
      expect(await request(u, m, p), `user ${m} ${p}`).toBe("PASS");
      expect(await request(null, m, p, "anon"), `anon ${m} ${p}`).toBe("PASS");
      expect(await request(null, m, p, "service_role"), `service ${m} ${p}`).toBe("PASS");
    }
    expect(await request({ uid: "not-a-uuid" } as Ctx, "GET", "/profiles")).toBe("PASS"); // an unparsable subject is not a worker identity
  });
  it("refuses to replace an existing hook; rollback removes only its own hook; 0055 cannot roll back first", async () => {
    const d = await make0055Db();
    await d.exec(`ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.someone_elses_hook'`);
    await expect(d.exec(MIG_0056)).rejects.toThrow(/already configured/);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname='fpw_api_pre_request'`)).rows[0]!.n).toBe(0);
    await expect(d.exec(RB_0056)).rejects.toThrow(/not applied/);
    await d.exec(`ALTER ROLE authenticator RESET pgrst.db_pre_request`); await d.exec(MIG_0056);
    await expect(d.exec(RB_0055)).rejects.toThrow(/roll back draft 0056 before 0055/);
    await d.exec(`ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.someone_elses_hook'`);
    await expect(d.exec(RB_0056)).rejects.toThrow(/not the one set by draft 0056/);
    await d.exec(`ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.fpw_api_pre_request'`);
    await d.exec(RB_0056);
    expect((await d.query<{ n: number }>(`SELECT count(*)::int n FROM pg_db_role_setting s, unnest(s.setconfig) c(v) WHERE c.v LIKE 'pgrst.%'`)).rows[0]!.n).toBe(0);
    await d.exec(RB_0055);
  }, 60_000);
  it("the hook fixes its search_path, is owner-rights and is not executable by PUBLIC", async () => {
    const r = await db.query<{ c: string[]; d: boolean; pub: boolean }>(`SELECT proconfig c, prosecdef d, EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0) pub FROM pg_proc WHERE proname='fpw_api_pre_request'`);
    expect(r.rows[0]).toEqual({ c: ["search_path=public, pg_temp"], d: true, pub: false });
  });
});
