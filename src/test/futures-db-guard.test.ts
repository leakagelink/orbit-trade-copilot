// Runs the PROPOSED Futures/Autopilot migration verbatim in an in-memory Postgres (PGlite) on a minimal schema stub,
// proving the database rejects production Futures entries on its own (independent of app code).
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync("docs/proposed-migrations/0039_futures_pass_certification_and_autopilot_fencing.sql", "utf8");
const U = "00000000-0000-4000-8000-000000000001", PROD = "00000000-0000-4000-8000-0000000000a1", TEST = "00000000-0000-4000-8000-0000000000b1", OTHER = "00000000-0000-4000-8000-0000000000c1";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TABLE public.exchange_connections (id uuid PRIMARY KEY, user_id uuid, exchange text, status text, is_testnet boolean);
CREATE TABLE public.futures_settings (user_id uuid PRIMARY KEY, connection_id uuid, live_enabled boolean NOT NULL, testnet_certified_at timestamptz);
CREATE TABLE public.risk_settings (user_id uuid PRIMARY KEY, trading_halted boolean NOT NULL DEFAULT false);
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, market_type text, is_open boolean, futures_details jsonb);
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, exchange_connection_id uuid, market_type text, idempotency_key text, status text DEFAULT 'pending');
CREATE TABLE public.autopilot_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, lease_until timestamptz);
CREATE FUNCTION public.prevent_evaluation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Evaluation evidence is append-only'; END $$;
CREATE FUNCTION public.guard_futures_live_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER futures_live_intent_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_futures_live_intent();
`;
let db: PGlite;
const entry = (conn = PROD, key = `futures:${crypto.randomUUID()}`) =>
  db.query("INSERT INTO public.orders(user_id,exchange_connection_id,market_type,idempotency_key) VALUES($1,$2,'usd_m_futures',$3)", [U, conn, key]);
const cert = (result: string, revision = "futures-exec-2026-11-r1", conn = PROD) =>
  db.query("INSERT INTO public.futures_certifications(user_id,connection_id,testnet_connection_id,result,revision,recorded_by) VALUES($1,$2,$3,$4,$5,'test')", [U, conn, TEST, result, revision]);

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION); }, 60_000);
beforeEach(async () => {
  await db.exec(`ALTER TABLE public.futures_certifications DISABLE TRIGGER futures_certifications_immutable; DELETE FROM public.futures_certifications; ALTER TABLE public.futures_certifications ENABLE TRIGGER futures_certifications_immutable;
    DELETE FROM public.orders; DELETE FROM public.positions; DELETE FROM public.futures_settings; DELETE FROM public.risk_settings; DELETE FROM public.exchange_connections;`);
  await db.query(`INSERT INTO public.exchange_connections VALUES ($1,$4,'binance','connected',false),($2,$4,'binance','connected',true),($3,$4,'binance','connected',false)`, [PROD, TEST, OTHER, U]);
  // Production state as observed: Live ON, bound to the production account, legacy timestamp set, not halted.
  await db.query("INSERT INTO public.futures_settings VALUES ($1,$2,true,'2026-11-11 17:26:58+00')", [U, PROD]);
  await db.query("INSERT INTO public.risk_settings VALUES ($1,false)", [U]);
});

describe("database gate for production Futures entries", () => {
  it("rejects a stale legacy timestamp with no certification record", async () => {
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("rejects when the latest certification is FAIL, even after an earlier PASS", async () => {
    await cert("PASS"); await cert("FAIL");
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("rejects a PASS for an older execution revision", async () => {
    await cert("PASS", "futures-exec-2026-10-r0");
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("rejects when Live Futures is disabled despite a current PASS", async () => {
    await cert("PASS"); await db.query("UPDATE public.futures_settings SET live_enabled=false");
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("rejects a PASS bound to a different production account", async () => {
    await cert("PASS", undefined, OTHER);
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("rejects when the account is halted", async () => {
    await cert("PASS"); await db.query("UPDATE public.risk_settings SET trading_halted=true");
    await expect(entry()).rejects.toThrow(/current PASS certification/);
  });
  it("accepts only a current PASS on the bound, live-enabled, unhalted account", async () => {
    await cert("PASS");
    await expect(entry()).resolves.toBeTruthy();
  });
  it("keeps exits and Testnet entries available while production is locked", async () => {
    await expect(entry(PROD, `futures:exit:${crypto.randomUUID()}`)).resolves.toBeTruthy();
    await db.exec("DELETE FROM public.orders");
    await expect(entry(TEST)).resolves.toBeTruthy();
  });
  it("refuses certifications bound to a Testnet account and edits to existing records", async () => {
    await expect(cert("PASS", undefined, TEST)).rejects.toThrow(/production Binance account/);
    await cert("FAIL");
    await expect(db.exec("UPDATE public.futures_certifications SET result='PASS'")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM public.futures_certifications")).rejects.toThrow(/append-only/);
  });
  it("does not let ordinary or anonymous roles call the authority function", async () => {
    const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege('authenticated','public.futures_live_authorized(uuid,uuid)','EXECUTE') AS ok");
    expect(r.rows[0]!.ok).toBe(false);
  });
});

describe("database guard against resurrecting finished Autopilot runs", () => {
  it("allows active → stopped but rejects any later update of the stopped run", async () => {
    const r = await db.query<{ id: string }>("INSERT INTO public.autopilot_runs(user_id,status) VALUES($1,'executing') RETURNING id", [U]);
    const id = r.rows[0]!.id;
    await db.query("UPDATE public.autopilot_runs SET status='stopped' WHERE id=$1", [id]);
    await expect(db.query("UPDATE public.autopilot_runs SET status='executing', lease_holder=gen_random_uuid() WHERE id=$1", [id])).rejects.toThrow(/immutable/);
  });
});
