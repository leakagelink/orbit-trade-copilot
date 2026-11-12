// Runs DRAFT migration 0042 (and its rollback) verbatim in an in-memory Postgres (PGlite) on a schema stub that
// carries today's live guard functions. Nothing here touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { TESTNET_FUTURES_LIMITS } from "@/lib/futures-testnet-limits";

const MIGRATION = readFileSync("docs/proposed-migrations/0042_testnet_emergency_stop_and_env_pending_checks.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0042_testnet_emergency_stop_and_env_pending_checks.rollback.sql", "utf8");
// Today's live definitions are exactly the ones the rollback restores.
const LIVE_GUARDS = ROLLBACK.slice(ROLLBACK.indexOf("CREATE OR REPLACE FUNCTION public.guard_new_entry_intent"), ROLLBACK.indexOf("DROP FUNCTION"));
const U = "00000000-0000-4000-8000-000000000001", PROD = "00000000-0000-4000-8000-0000000000a1", TEST = "00000000-0000-4000-8000-0000000000b1";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.safety_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Safety events are append-only'; END $$;
CREATE TABLE public.exchange_connections (id uuid PRIMARY KEY, user_id uuid, exchange text, status text, is_testnet boolean);
CREATE TABLE public.risk_settings (user_id uuid PRIMARY KEY, trading_halted boolean NOT NULL DEFAULT false, max_total_positions int, max_open_exposure numeric, max_daily_loss numeric);
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, market_type text, is_open boolean, futures_details jsonb, execution_environment text, entry_price numeric, quantity numeric, unrealized_pnl numeric DEFAULT 0);
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, exchange_connection_id uuid, market_type text, idempotency_key text, status text DEFAULT 'pending', execution_environment text, price numeric, quantity numeric);
CREATE TABLE public.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, closed_at timestamptz, net_pnl numeric, execution_environment text);
CREATE TABLE public.live_auth (ok boolean NOT NULL);
CREATE FUNCTION public.futures_live_authorized(_u uuid, _c uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce((SELECT ok FROM public.live_auth LIMIT 1), false) $$;
${LIVE_GUARDS}
CREATE TRIGGER entry_intent_risk_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_new_entry_intent();
CREATE TRIGGER futures_live_intent_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_futures_live_intent();
`;
async function fresh(withMigration: boolean) { const d = new PGlite(); await d.exec(STUB); if (withMigration) await d.exec(MIGRATION); return d; }
let db: PGlite;
const entry = (env: "testnet" | "production", notional = 5, key = `futures:${crypto.randomUUID()}`, d = db) =>
  d.query("INSERT INTO public.orders(user_id,exchange_connection_id,market_type,idempotency_key,execution_environment,price,quantity) VALUES($1,$2,'usd_m_futures',$3,$4,1,$5)", [U, env === "testnet" ? TEST : PROD, key, env, notional]);
const exit = (env: "testnet" | "production") => entry(env, 5, `futures:exit:${crypto.randomUUID()}`);
const halted = async () => (await db.query<{ h: boolean }>("SELECT trading_halted AS h FROM public.risk_settings WHERE user_id=$1", [U])).rows[0]!.h;
async function seed(d: PGlite) {
  await d.exec("DELETE FROM public.orders; DELETE FROM public.positions; DELETE FROM public.trades; DELETE FROM public.risk_settings; DELETE FROM public.exchange_connections; DELETE FROM public.live_auth;");
  await d.query("INSERT INTO public.exchange_connections VALUES ($1,$3,'binance','connected',false),($2,$3,'binance','connected',true)", [PROD, TEST, U]);
  await d.query("INSERT INTO public.risk_settings VALUES ($1,false,NULL,10,2)", [U]);
  await d.exec("INSERT INTO public.live_auth VALUES (true)"); // stands in for a production PASS + opt-in, so production paths can be exercised
}

beforeAll(async () => { db = await fresh(true); }, 60_000);
beforeEach(async () => { await seed(db); await db.exec("DELETE FROM public.testnet_emergency_stops"); });

describe("separate Testnet emergency stop (draft 0042)", () => {
  it("halts Testnet entries without activating the production stop", async () => {
    await db.query("SELECT public.testnet_emergency_halt($1,'test')", [U]);
    await expect(entry("testnet")).rejects.toThrow(/Testnet emergency stop is active/);
    expect(await halted()).toBe(false);
  });
  it("does not block production entries", async () => {
    await db.query("SELECT public.testnet_emergency_halt($1,'test')", [U]);
    await expect(entry("production")).resolves.toBeTruthy();
  });
  it("never closes or edits production positions", async () => {
    await db.query("INSERT INTO public.positions(user_id,market_type,is_open,execution_environment,entry_price,quantity,futures_details) VALUES($1,'usd_m_futures',true,'production',1,1,'{\"protection\":\"confirmed\"}')", [U]);
    await db.query("SELECT public.testnet_emergency_halt($1,'test')", [U]);
    const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.positions WHERE execution_environment='production' AND is_open");
    expect(r.rows[0]!.n).toBe(1);
  });
  it("keeps exits available while halted", async () => {
    await db.query("SELECT public.testnet_emergency_halt($1,'test')", [U]);
    await expect(exit("testnet")).resolves.toBeTruthy();
  });
  it("release re-enables Testnet entries and both actions are recorded append-only", async () => {
    await db.query("SELECT public.testnet_emergency_halt($1,'test')", [U]); await db.query("SELECT public.testnet_emergency_release($1)", [U]);
    await expect(entry("testnet")).resolves.toBeTruthy();
    const ev = await db.query<{ action: string }>("SELECT action FROM public.testnet_emergency_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 2", [U]);
    expect(ev.rows.map((r) => r.action).sort()).toEqual(["halt", "release"]);
    await expect(db.exec("UPDATE public.testnet_emergency_events SET action='halt'")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM public.testnet_emergency_events")).rejects.toThrow(/append-only/);
  });
});

describe("production emergency stop still stops both environments", () => {
  it("blocks Testnet entries", async () => {
    await db.exec("UPDATE public.risk_settings SET trading_halted=true");
    await expect(entry("testnet")).rejects.toThrow(/halted/);
  });
  it("blocks production entries", async () => {
    await db.exec("UPDATE public.risk_settings SET trading_halted=true");
    await expect(entry("production")).rejects.toThrow(/halted/);
  });
});

describe("environment-specific pending-order checks", () => {
  it("a pending Testnet order does not block production", async () => {
    await entry("testnet");
    await expect(entry("production")).resolves.toBeTruthy();
  });
  it("a pending production order does not block Testnet", async () => {
    await entry("production");
    await expect(entry("testnet")).resolves.toBeTruthy();
  });
  it("a pending order still blocks its own environment", async () => {
    await entry("testnet");
    await expect(entry("testnet")).rejects.toThrow(/Testnet position limit|Unresolved Futures order/);
  });
  it("legacy unknown intents block both environments", async () => {
    await db.exec("ALTER TABLE public.orders DISABLE TRIGGER USER");
    await db.query("INSERT INTO public.orders(user_id,exchange_connection_id,market_type,idempotency_key,execution_environment,price,quantity) VALUES($1,$2,'usd_m_futures','legacy','legacy_unknown',1,1)", [U, PROD]);
    await db.exec("ALTER TABLE public.orders ENABLE TRIGGER USER");
    await expect(entry("testnet")).rejects.toThrow(/Unresolved Futures order/);
    await expect(entry("production")).rejects.toThrow(/Unresolved Futures order/);
  });
  it("an order labelled with the wrong environment is refused", async () => {
    await expect(db.query("INSERT INTO public.orders(user_id,exchange_connection_id,market_type,idempotency_key,execution_environment,price,quantity) VALUES($1,$2,'usd_m_futures','x','production',1,1)", [U, TEST])).rejects.toThrow(/does not match/);
  });
});

describe("fixed Testnet limits in the database", () => {
  it("match the app's fixed Testnet limits", async () => {
    const r = await db.query<{ max_exposure: string; max_open_positions: number; max_daily_loss: string }>("SELECT * FROM public.testnet_futures_limits()");
    expect(Number(r.rows[0]!.max_exposure)).toBe(TESTNET_FUTURES_LIMITS.maxExposure);
    expect(r.rows[0]!.max_open_positions).toBe(TESTNET_FUTURES_LIMITS.maxOpenPositions);
    expect(Number(r.rows[0]!.max_daily_loss)).toBe(TESTNET_FUTURES_LIMITS.maxDailyLoss);
  });
  it("Testnet exposure above 10 USDT is refused", async () => { await expect(entry("testnet", 10.01)).rejects.toThrow(/Testnet exposure/); });
  it("Testnet daily loss of 2 USDT blocks entries", async () => {
    await db.query("INSERT INTO public.trades(user_id,closed_at,net_pnl,execution_environment) VALUES($1,now(),-2,'testnet')", [U]);
    await expect(entry("testnet")).rejects.toThrow(/Testnet loss limit/);
  });
  it("production losses do not count against Testnet", async () => {
    await db.query("INSERT INTO public.trades(user_id,closed_at,net_pnl,execution_environment) VALUES($1,now(),-5,'production')", [U]);
    await expect(entry("testnet")).resolves.toBeTruthy();
  });
  it("Testnet entries do not use production risk limits", async () => {
    await db.exec("UPDATE public.risk_settings SET max_open_exposure=1");
    await expect(entry("testnet", 8)).resolves.toBeTruthy();
  });
  it("production entries still use production risk limits", async () => {
    await expect(entry("production", 11)).rejects.toThrow(/Account exposure limit/);
  });
});

describe("permissions", () => {
  it("browser roles cannot write the Testnet stop or call its switches", async () => {
    const r = await db.query<{ ins: boolean; upd: boolean; halt: boolean; rel: boolean; sel: boolean }>(`SELECT
      has_table_privilege('authenticated','public.testnet_emergency_stops','INSERT') ins, has_table_privilege('authenticated','public.testnet_emergency_stops','UPDATE') upd,
      has_function_privilege('authenticated','public.testnet_emergency_halt(uuid,text)','EXECUTE') halt, has_function_privilege('authenticated','public.testnet_emergency_release(uuid)','EXECUTE') rel,
      has_table_privilege('authenticated','public.testnet_emergency_stops','SELECT') sel`);
    expect(r.rows[0]).toEqual({ ins: false, upd: false, halt: false, rel: false, sel: true });
  });
  it("anonymous visitors cannot read it", async () => {
    const r = await db.query<{ sel: boolean }>("SELECT has_table_privilege('anon','public.testnet_emergency_stops','SELECT') sel");
    expect(r.rows[0]!.sel).toBe(false);
  });
});

describe("rollback", () => {
  it("restores today's behaviour and removes the Testnet stop objects", async () => {
    const d = await fresh(true); await d.exec(ROLLBACK); await seed(d);
    await entry("testnet", 5, undefined, d);
    // Today's behaviour: a pending Testnet Futures order blocks production entries again.
    await expect(entry("production", 5, undefined, d)).rejects.toThrow(/Unresolved Futures order/);
    const t = await d.query<{ n: number }>("SELECT count(*)::int n FROM pg_tables WHERE tablename LIKE 'testnet_emergency%'");
    expect(t.rows[0]!.n).toBe(0);
  }, 60_000);
});
