// Test harness for DRAFTS 0055/0056 (Phase 4H.5) over drafts 0049–0054 in PGlite — nothing is applied anywhere real
// and no auth user, session, credential or secret is created. Stand-ins: auth.uid() ← session setting test.uid,
// auth.jwt() ← test.jwt, auth.sessions / auth.mfa_factors / workspace_sessions are plain local tables, and
// account_mfa_allowed() is created from the APPLIED migration 0011 text byte-for-byte (0055 verifies that body).
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { callFn } from "./fp-gateway-harness";
import { makeEntryDb } from "./fp-v5-harness";

export const MIG_0053 = readFileSync("docs/proposed-migrations/0053_futures_paper_worker_identity.sql", "utf8");
export const MIG_0054 = readFileSync("docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql", "utf8");
export const RB_0054 = readFileSync("docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.rollback.sql", "utf8");
export const MIG_0055 = readFileSync(process.env["FP_0055_FILE"] ?? "docs/proposed-migrations/0055_futures_paper_worker_security_remediation.sql", "utf8");
export const RB_0055 = readFileSync("docs/proposed-migrations/0055_futures_paper_worker_security_remediation.rollback.sql", "utf8");
export const MIG_0056 = readFileSync("docs/proposed-migrations/0056_worker_identity_api_boundary.sql", "utf8");
export const RB_0056 = readFileSync("docs/proposed-migrations/0056_worker_identity_api_boundary.rollback.sql", "utf8");
const M0010 = readFileSync("drizzle/migrations/0010_optional_mfa_security.sql", "utf8").split("\n");
export const MFA_0011 = readFileSync("drizzle/migrations/0011_security_session_notifications.sql", "utf8").split("\n")[0]!;

export const ROLES = `CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
/** Platform stand-ins plus the app's own applied definitions (0000 role policies, 0010 grants/table, 0011 body). */
export const AUTH_AND_APP = `
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.jwt', true), '')::jsonb $$;
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text NOT NULL);
${M0010[3]}
${M0010[4]}
${M0010[5]}
${M0010[6]}
${MFA_0011}
${M0010[1]}
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated; GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles read" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "super admin manage roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'super_admin')) WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
-- Ordinary app tables (shapes of the applied ones): one whose policy calls account_mfa_allowed(), one whose policy does not.
CREATE TABLE public.exchange_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, label text NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exchange_connections TO authenticated; GRANT ALL ON public.exchange_connections TO service_role;
ALTER TABLE public.exchange_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_connections ON public.exchange_connections FOR ALL TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed()) WITH CHECK (user_id = auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.watchlist_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, symbol text NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlist_items TO authenticated; GRANT ALL ON public.watchlist_items TO service_role;
ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_watchlist ON public.watchlist_items FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- An owner-rights function every signed-in user may call (shape of the applied growth/support RPCs) — closed only by 0056.
CREATE FUNCTION public.claim_referral(_code text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 'claimed:' || _code $$;
GRANT EXECUTE ON FUNCTION public.claim_referral(text) TO authenticated;
DO $$ BEGIN CREATE ROLE authenticator NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;

/** 0049 → 0054, the app's applied auth-related definitions, then (optionally) 0055 and 0056. */
export async function make0055Db(o: { with0055?: boolean; with0056?: boolean } = {}) {
  const d = await makeEntryDb();
  await d.exec(ROLES); await d.exec(MIG_0053); await d.exec(MIG_0054); await d.exec(AUTH_AND_APP);
  if (o.with0055 !== false) await d.exec(MIG_0055);
  if (o.with0056) await d.exec(MIG_0056);
  return d;
}
let sidN = 0x5500;
export const freshSession = () => `00000000-0000-4000-a055-${(sidN++).toString(16).padStart(12, "0")}`;
/** Creates a live auth session for `uid` (stand-in table) and returns its id. */
export async function liveSession(db: PGlite, uid: string, o: { ageSec?: number; notAfterSec?: number | null } = {}) {
  const sid = freshSession();
  await db.query(`INSERT INTO auth.sessions (id, user_id, created_at, not_after) VALUES ($1, $2, now() - make_interval(secs => $3), CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END)`, [sid, uid, o.ageSec ?? 1, o.notAfterSec ?? null]);
  return sid;
}
export type Ctx = { uid: string; sid?: string | null; exp?: number; aal?: string; extra?: Record<string, unknown> };
export async function as0055<T>(db: PGlite, c: Ctx, f: () => Promise<T>): Promise<T> {
  const jwt = { sub: c.uid, role: "authenticated", exp: c.exp ?? Math.floor(Date.now() / 1000) + 3600, aal: c.aal ?? "aal1", ...(c.sid ? { session_id: c.sid } : {}), ...(c.extra ?? {}) };
  await db.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', $2, false)`, [c.uid, JSON.stringify(jwt)]);
  try { return await f(); } finally { await db.exec(`SELECT set_config('test.uid', '', false), set_config('test.jwt', '', false)`); }
}
export const callAs = (db: PGlite, c: Ctx, fn: string, args: Record<string, unknown>) => as0055(db, c, () => callFn(db, fn, args, "authenticated"));
