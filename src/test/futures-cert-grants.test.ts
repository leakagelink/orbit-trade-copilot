// Runs the PROPOSED 0040 least-privilege migration (after 0039) in PGlite and exercises it with real database roles
// (SET ROLE anon / authenticated / service_role), proving only the backend can write certification records.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const M0039 = readFileSync("docs/proposed-migrations/0039_futures_pass_certification_and_autopilot_fencing.sql", "utf8");
const M0040 = readFileSync("docs/proposed-migrations/0040_futures_certifications_least_privilege.sql", "utf8");
const U = "00000000-0000-4000-8000-000000000001", PROD = "00000000-0000-4000-8000-0000000000a1", TEST = "00000000-0000-4000-8000-0000000000b1";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE public.exchange_connections (id uuid PRIMARY KEY, user_id uuid, exchange text, status text, is_testnet boolean);
CREATE TABLE public.futures_settings (user_id uuid PRIMARY KEY, connection_id uuid, live_enabled boolean NOT NULL, testnet_certified_at timestamptz);
CREATE TABLE public.risk_settings (user_id uuid PRIMARY KEY, trading_halted boolean NOT NULL DEFAULT false);
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, market_type text, is_open boolean, futures_details jsonb);
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, exchange_connection_id uuid, market_type text, idempotency_key text, status text DEFAULT 'pending');
CREATE TABLE public.autopilot_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, lease_until timestamptz);
CREATE FUNCTION public.prevent_evaluation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Evaluation evidence is append-only'; END $$;
CREATE FUNCTION public.guard_futures_live_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER futures_live_intent_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_futures_live_intent();
-- Reproduce the platform's schema-wide default grants that gave browser roles full table privileges.
GRANT ALL ON public.exchange_connections TO anon, authenticated, service_role;
`;
const INSERT = `INSERT INTO public.futures_certifications(user_id,connection_id,testnet_connection_id,result,revision,recorded_by)
  VALUES ('${U}','${PROD}','${TEST}','FAIL','futures-exec-2026-11-r1','grant-test')`;
let db: PGlite;
const as = async (role: string, sql: string) => {
  await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${U}', false); SET ROLE ${role};`);
  try { return await db.query(sql); } finally { await db.exec("RESET ROLE"); }
};
const privileges = async (role: string) => (await db.query<{ p: string }>(
  `SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = 'public.futures_certifications'::regclass AND a.grantee = $1::regrole`, [role])).rows[0]?.p ?? null;

beforeAll(async () => {
  db = new PGlite(); await db.exec(STUB); await db.exec(M0039);
  // Before 0040: mirror production, where schema defaults granted every privilege to anon and authenticated.
  await db.exec("GRANT ALL ON public.futures_certifications TO anon, authenticated");
  await db.query(`INSERT INTO public.exchange_connections VALUES ($1,$3,'binance','connected',false),($2,$3,'binance','connected',true)`, [PROD, TEST, U]);
  await db.exec(M0040);
}, 60_000);

describe("certification table privileges after 0040", () => {
  it("leaves anon with no privileges and authenticated with SELECT only", async () => {
    expect(await privileges("anon")).toBeNull();
    expect(await privileges("authenticated")).toBe("SELECT");
  });
  for (const role of ["anon", "authenticated"]) {
    it(`denies ${role} INSERT, UPDATE, DELETE and TRUNCATE by privilege`, async () => {
      for (const sql of [INSERT, "UPDATE public.futures_certifications SET result='PASS'", "DELETE FROM public.futures_certifications", "TRUNCATE public.futures_certifications"]) {
        await expect(as(role, sql)).rejects.toThrow(/permission denied/);
      }
    });
  }
  it("denies anon reads and limits authenticated reads to the owner's rows", async () => {
    await expect(as("anon", "SELECT * FROM public.futures_certifications")).rejects.toThrow(/permission denied/);
    await as("service_role", INSERT);
    expect((await as("authenticated", "SELECT id FROM public.futures_certifications")).rows.length).toBe(1);
    await db.exec(`SELECT set_config('test.uid', '00000000-0000-4000-8000-000000000999', false); SET ROLE authenticated;`);
    expect((await db.query("SELECT id FROM public.futures_certifications")).rows.length).toBe(0);
    await db.exec("RESET ROLE");
  });
  it("lets the backend insert but keeps every record append-only, including TRUNCATE", async () => {
    await expect(as("service_role", INSERT)).resolves.toBeTruthy();
    await expect(as("service_role", "UPDATE public.futures_certifications SET result='PASS'")).rejects.toThrow(/append-only/);
    await expect(as("service_role", "DELETE FROM public.futures_certifications")).rejects.toThrow(/append-only/);
    await expect(as("service_role", "TRUNCATE public.futures_certifications")).rejects.toThrow(/append-only/);
  });
  it("still rejects backend certifications that are not bound to the owner's production account", async () => {
    await expect(as("service_role", INSERT.replace(`'${PROD}','${TEST}'`, `'${TEST}','${TEST}'`))).rejects.toThrow(/production Binance account/);
  });
});
