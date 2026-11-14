// Phase 4H.7 test-only fake auth service + data API served from fetch, over a PGlite (or a PGlite-shaped adapter of one
// reserved real PostgreSQL connection). It MODELS the documented hosted behaviour (sign-in creates a session row and
// returns the user object, local sign-out deletes it, the data API runs the 0056 request hook before the function as the
// token's user). Nothing real is contacted. Requests are serialized per backend (one database session), with optional
// latency, hangs (before or after the database ran the call) and statement-timeout simulation.
import type { PGlite } from "@electric-sql/pglite";
import { readTokenClaims } from "@/lib/worker-auth-session";
import { as } from "./fp-v3-harness";
import { callFn } from "./fp-gateway-harness";
import { as0055, freshSession, type Ctx } from "./fp-0055-harness";
import { authUserJson } from "./fp-0057-harness";
import { fakeJwt } from "./fake-auth";

export const URL_ = "https://backend.test", KEY = "sb_publishable_TESTKEYxxxxxxxxxxxxxxxx";
export interface BackendOptions {
  /** Latency before each request is processed (real timers); honours the request's abort signal. */
  latencyMs?: (path: string, n: number) => number;
  /** "before": never answers and never runs; "after": runs the call, then never answers. */
  hang?: (path: string, n: number) => "before" | "after" | null;
  /** Simulates a statement timeout: the call is not run and the data API answers 57014. */
  statementTimeout?: (path: string, n: number) => boolean;
  logoutStatus?: number;
}
const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new DOMException("aborted", "AbortError"));
  const h = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(h); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});
const never = (signal?: AbortSignal | null) => new Promise<never>((_r, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));

export function fakeBackend(db: PGlite, o: BackendOptions = {}) {
  const paths: string[] = [], issuedTokens: string[] = [];
  let n = 0, chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.then(() => undefined, () => undefined); return p; };
  const rpc = (path: string, token: string, body: string): Promise<Response> => serial(async () => {
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
  });
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace(URL_, ""), h = new Headers(init.headers), body = String(init.body ?? ""), k = ++n, signal = init.signal;
    paths.push(path);
    if (init.redirect !== "error") throw new Error("redirects must be refused");
    const lat = o.latencyMs?.(path, k) ?? 0;
    if (lat > 0) await sleep(lat, signal);
    if (path === "/auth/v1/token?grant_type=password") {
      return serial(async () => {
        const b = JSON.parse(body) as { email: string; password: string };
        const u = (await db.query<{ id: string; encrypted_password: string }>(`SELECT id::text, encrypted_password FROM auth.users WHERE lower(email) = lower($1)`, [b.email])).rows[0];
        if (!u || u.encrypted_password !== `fake-hash:${b.password}`) return new Response(JSON.stringify({ error_code: "invalid_credentials" }), { status: 400 });
        const sid = freshSession(), now = Math.floor(Date.now() / 1000);
        await db.query(`INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)`, [sid, u.id]);
        const access = fakeJwt({ sub: u.id, role: "authenticated", exp: now + 3600, iat: now, session_id: sid }); issuedTokens.push(access);
        return new Response(JSON.stringify({ access_token: access, refresh_token: `rt-${Math.random()}`, expires_in: 3600, user: await authUserJson(db, u.id) }), { status: 200 });
      });
    }
    if (path === "/auth/v1/logout?scope=local") {
      const c = readTokenClaims((h.get("authorization") ?? "").replace(/^Bearer /, ""));
      if ((o.logoutStatus ?? 204) >= 300) return new Response(null, { status: o.logoutStatus! });
      await serial(() => db.query(`DELETE FROM auth.sessions WHERE id = $1`, [c!.sid]));
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/rest/v1/")) {
      const p = path.slice("/rest/v1".length), token = (h.get("authorization") ?? "").replace(/^Bearer /, "");
      if (o.statementTimeout?.(p, k)) return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500 });
      const mode = o.hang?.(p, k) ?? null;
      if (mode === "before") return never(signal);
      const r = await rpc(p, token, body);
      if (mode === "after") return never(signal);
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return r;
    }
    throw new Error(`unexpected request ${path}`);
  };
  return { fetchImpl, paths, issuedTokens, rpc };
}
