// Phase 4D Workstream D — DRAFT migration 0047 (strategy attribution for real USD-M Futures orders, NOT applied) run
// verbatim in PGlite against minimal stand-ins of public.orders/positions/trades (same column names as the real schema;
// a test below checks those names exist in drizzle/migrations). Nothing touches the real database.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIG = readFileSync("docs/proposed-migrations/0047_futures_strategy_attribution.sql", "utf8");
const RB = readFileSync("docs/proposed-migrations/0047_futures_strategy_attribution.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-0000000047a1", B = "00000000-0000-4000-8000-0000000047b2";
const SHA = "a".repeat(64), SHA2 = "b".repeat(64);
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text, idempotency_key text NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, idempotency_key));
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, entry_order_id uuid REFERENCES public.orders(id));
CREATE TABLE public.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, position_id uuid, order_id uuid, strategy_id uuid);
GRANT SELECT ON public.orders, public.positions, public.trades TO authenticated; GRANT ALL ON public.orders, public.positions, public.trades TO service_role;
-- Like the real tables: row security with owner-only reads.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY o_own ON public.orders FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY p_own ON public.positions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY t_own ON public.trades FOR SELECT TO authenticated USING (user_id = auth.uid());`;

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
/** One claim transaction, as the future order path would run it: insert the pending order, then capture identity. */
async function claim(user: string, key: string, env = "production", strategy = "ema-50-200", version = 1, sha = SHA, market = "usd_m_futures") {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE service_role");
    const o = await tx.query<{ id: string }>(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING id`, [user, market, env, key]);
    const r = await tx.query<{ r: string }>(`SELECT public.claim_futures_order_strategy_identity($1, $2, $3, $4) AS r`, [o.rows[0]!.id, strategy, version, sha]);
    return { id: o.rows[0]!.id, result: r.rows[0]!.r };
  });
}
const svc = (sql: string, params: unknown[] = []) => as("service_role", null, sql, params);
const ev = (o: string, user: string, kind: string, x: Record<string, unknown> = {}) => svc(
  `INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, trade_id, kind, qty, amount, evidence_ref, corrects_event_id, reason)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
  [user, x["env"] ?? "production", o, x["position"] ?? null, x["trade"] ?? null, kind, x["qty"] ?? 0, x["amount"] ?? 0, x["ref"] ?? `${kind}-${Math.random()}`, x["corrects"] ?? null, x["reason"] ?? null]);
async function position(user: string, order: string, env = "production") {
  return (await svc(`INSERT INTO public.positions(user_id, market_type, execution_environment, entry_order_id) VALUES ($1, 'usd_m_futures', $2, $3) RETURNING id`, [user, env, order])).rows[0] as { id: string };
}

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIG); }, 120_000);

describe("draft 0047 — identity captured at intent creation, immutable, consistent across retries", () => {
  it("captures inside the claim transaction; an identical retry is a no-op; a conflicting retry is refused", async () => {
    const c = await claim(A, "futures:req-0001");
    expect(c.result).toBe("captured");
    expect((await svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 1, $2) AS r`, [c.id, SHA])).rows[0]).toEqual({ r: "existing" });
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 2, $2)`, [c.id, SHA])).rejects.toThrow(/different strategy identity/);
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 1, $2)`, [c.id, SHA2])).rejects.toThrow(/different strategy identity/);
    const row = (await svc(`SELECT user_id, execution_environment, idempotency_key, strategy_version FROM public.futures_order_strategy_identity WHERE order_id=$1`, [c.id])).rows[0];
    expect(row).toEqual({ user_id: A, execution_environment: "production", idempotency_key: "futures:req-0001", strategy_version: 1 });
  });
  it("a legacy order (claimed in an earlier transaction) can never receive an identity later", async () => {
    const o = (await svc(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, 'usd_m_futures', 'production', 'futures:legacy-01') RETURNING id`, [A])).rows[0] as { id: string };
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 1, $2)`, [o.id, SHA])).rejects.toThrow(/legacy orders stay UNATTRIBUTED/);
  });
  it("refuses spot orders, exit orders, mismatched owner/environment/key, malformed identity and NULL arguments", async () => {
    await expect(claim(A, "spot:req-1", "production", "s", 1, SHA, "spot")).rejects.toThrow(/only captured for USD-M Futures/);
    await expect(claim(A, "futures:exit:req-1")).rejects.toThrow(/exit orders inherit lineage/);
    await expect(claim(A, "futures:bad-ver", "production", "s", 0)).rejects.toThrow(/strategy_version_check|check constraint/);
    await expect(claim(A, "futures:bad-sha", "production", "s", 1, "XYZ")).rejects.toThrow(/check constraint/);
    await expect(claim(A, "futures:bad-id", "production", "s; drop table x", 1)).rejects.toThrow(/check constraint/);
    await expect(claim(A, "futures:legacy-env", "legacy_unknown")).rejects.toThrow(/check constraint|owner, environment/);
    await expect(db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE service_role");
      const o = await tx.query<{ id: string }>(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, 'usd_m_futures', 'testnet', 'futures:direct-1') RETURNING id`, [A]);
      await tx.query(`INSERT INTO public.futures_order_strategy_identity(order_id, user_id, execution_environment, idempotency_key, strategy_id, strategy_version, strategy_config_sha256) VALUES ($1, $2, 'production', 'futures:direct-1', 's', 1, $3)`, [o.rows[0]!.id, A, SHA]);
    })).rejects.toThrow(/must match the order owner, environment/);
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity(NULL, 's', 1, $1)`, [SHA])).rejects.toThrow(/every argument is required/);
  });
  it("identity and events are append-only for every role, including the backend", async () => {
    const c = await claim(A, "futures:imm-0001");
    for (const role of ["service_role", "authenticated"] as const) {
      await expect(as(role, A, `UPDATE public.futures_order_strategy_identity SET strategy_version = 9 WHERE order_id='${c.id}'`)).rejects.toThrow();
      await expect(as(role, A, `DELETE FROM public.futures_order_strategy_identity WHERE order_id='${c.id}'`)).rejects.toThrow();
      await expect(as(role, A, `UPDATE public.futures_strategy_attribution_events SET amount = 0`)).rejects.toThrow();
    }
    await expect(db.exec(`UPDATE public.futures_order_strategy_identity SET strategy_version = 9`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.futures_order_strategy_identity`)).rejects.toThrow(/append-only|truncate/i);
    await expect(db.exec(`TRUNCATE public.futures_strategy_attribution_events`)).rejects.toThrow(/append-only|truncate/i);
  });
});

describe("draft 0047 — owner isolation and grants", () => {
  it("browser roles read only their own rows, cannot write or capture; anon has no access", async () => {
    await claim(B, "futures:b-0001", "testnet");
    const own = (await as<{ user_id: string }>("authenticated", B, `SELECT user_id FROM public.futures_order_strategy_identity`)).rows;
    expect(own.length).toBe(1); expect(own.every((r) => r.user_id === B)).toBe(true);
    expect((await as("authenticated", B, `SELECT * FROM public.futures_strategy_attribution_events WHERE user_id <> '${B}'`)).rows).toEqual([]);
    await expect(as("authenticated", A, `INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref) VALUES ('${A}', 'production', gen_random_uuid(), 'entry_fill', 1, 'x')`)).rejects.toThrow(/permission/);
    await expect(as("authenticated", A, `SELECT public.claim_futures_order_strategy_identity(gen_random_uuid(), 's', 1, '${SHA}')`)).rejects.toThrow(/permission/);
    await expect(as("anon", null, `SELECT * FROM public.futures_order_strategy_identity`)).rejects.toThrow(/permission/);
    await expect(as("anon", null, `SELECT * FROM public.futures_trade_strategy_attribution`)).rejects.toThrow(/permission/);
  });
});

describe("draft 0047 — partial fills, reductions, fees/funding, corrections, duplicate prevention", () => {
  it("records actual fills and partial reductions without a trade row; reductions can never exceed the attributed fill", async () => {
    const c = await claim(A, "futures:pf-00001"); const p = await position(A, c.id);
    await ev(c.id, A, "entry_fill", { qty: 0.6, ref: "fill-1" }); await ev(c.id, A, "entry_fill", { qty: 0.4, ref: "fill-2" });
    await ev(c.id, A, "fee", { amount: -0.12, ref: "fee-fill-1" });
    await ev(c.id, A, "reduction", { position: p.id, qty: 0.3, amount: -1.5, ref: "reduce-1" }); // partial reduction, no trades row
    await ev(c.id, A, "funding", { position: p.id, amount: -0.02, ref: "funding-1" });
    await expect(ev(c.id, A, "reduction", { position: p.id, qty: 0.8, ref: "reduce-2" })).rejects.toThrow(/would exceed the attributed filled quantity/);
    await ev(c.id, A, "reduction", { position: p.id, qty: 0.7, amount: 2, ref: "reduce-3" });
    await expect(ev(c.id, A, "reduction", { position: p.id, qty: 0.001, ref: "reduce-4" })).rejects.toThrow(/would exceed/);
    const tot = (await svc(`SELECT sum(qty) FILTER (WHERE kind='reduction') r, sum(amount) a FROM public.futures_strategy_attribution_events WHERE entry_order_id=$1`, [c.id])).rows[0] as { r: string; a: string };
    expect(Number(tot.r)).toBeCloseTo(1, 12); expect(Number(tot.a)).toBeCloseTo(-0.12 - 1.5 - 0.02 + 2, 12);
  });
  it("the same evidence can never be attributed twice; shape rules hold", async () => {
    const c = await claim(A, "futures:dup-0001"); const p = await position(A, c.id);
    await ev(c.id, A, "entry_fill", { qty: 1, ref: "exch-trade-77" });
    await expect(ev(c.id, A, "entry_fill", { qty: 1, ref: "exch-trade-77" })).rejects.toThrow(/unique|duplicate/);
    await ev(c.id, A, "funding", { position: p.id, amount: -0.5, ref: "fund-2026-11-13T08" });
    await expect(ev(c.id, A, "funding", { position: p.id, amount: -0.5, ref: "fund-2026-11-13T08" })).rejects.toThrow(/unique|duplicate/);
    await expect(ev(c.id, A, "fee", { amount: 0.5, ref: "fee+" })).rejects.toThrow(/kind_shape/);
    await expect(ev(c.id, A, "entry_fill", { qty: 0, ref: "zero" })).rejects.toThrow(/kind_shape/);
    await expect(ev(c.id, A, "reduction", { qty: 1, ref: "nopos" })).rejects.toThrow(/kind_shape/);
    await expect(ev(c.id, A, "entry_fill", { qty: "NaN", ref: "nan" })).rejects.toThrow(/numbers/);
  });
  it("events are bound to the identity's owner/environment and to its own position and trade", async () => {
    const c = await claim(A, "futures:bind-001"), other = await claim(A, "futures:bind-002");
    const p = await position(A, c.id), q = await position(A, other.id);
    await expect(ev(c.id, B, "entry_fill", { qty: 1 })).rejects.toThrow(/owner\/environment differs/);
    await expect(ev(c.id, A, "entry_fill", { qty: 1, env: "testnet" })).rejects.toThrow(/owner\/environment differs/);
    await expect(ev(c.id, A, "funding", { position: q.id, amount: -1 })).rejects.toThrow(/not the position opened by the attributed entry order/);
    const t = (await svc(`INSERT INTO public.trades(user_id, market_type, execution_environment, position_id) VALUES ($1, 'usd_m_futures', 'production', $2) RETURNING id`, [A, q.id])).rows[0] as { id: string };
    await ev(c.id, A, "entry_fill", { qty: 1, ref: "bind-fill" });
    await expect(ev(c.id, A, "reduction", { position: p.id, trade: t.id, qty: 1 })).rejects.toThrow(/not the close of the attributed position/);
    await expect(ev("00000000-0000-4000-8000-00000000dead", A, "entry_fill", { qty: 1 })).rejects.toThrow(/without a captured strategy identity|foreign key/);
  });
  it("corrections are new immutable records referencing an original event of the same order", async () => {
    const c = await claim(A, "futures:cor-0001"), other = await claim(A, "futures:cor-0002");
    const fee = (await ev(c.id, A, "fee", { amount: -1, ref: "fee-x" })).rows[0] as { id: number };
    const otherFee = (await ev(other.id, A, "fee", { amount: -1, ref: "fee-y" })).rows[0] as { id: number };
    const cor = (await ev(c.id, A, "correction", { corrects: fee.id, amount: 0.4, reason: "exchange fee rebate evidence", ref: "cor-1" })).rows[0] as { id: number };
    await expect(ev(c.id, A, "correction", { corrects: otherFee.id, amount: 1, reason: "x", ref: "cor-2" })).rejects.toThrow(/same attributed order/);
    await expect(ev(c.id, A, "correction", { corrects: cor.id, amount: 1, reason: "x", ref: "cor-3" })).rejects.toThrow(/never another correction/);
    await expect(ev(c.id, A, "correction", { corrects: fee.id, amount: 1, ref: "cor-4" })).rejects.toThrow(/kind_shape/);
  });
});

describe("draft 0047 — lineage view and legacy policy", () => {
  it("order → position → trade lineage; legacy trades are UNATTRIBUTED and the mutable trades.strategy_id is ignored", async () => {
    const c = await claim(A, "futures:lin-0001", "production", "ema-50-200", 3, SHA2); const p = await position(A, c.id);
    await svc(`INSERT INTO public.trades(user_id, market_type, execution_environment, position_id) VALUES ($1, 'usd_m_futures', 'production', $2)`, [A, p.id]);
    const legacyOrder = (await svc(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, 'usd_m_futures', 'production', 'futures:lin-legacy') RETURNING id`, [A])).rows[0] as { id: string };
    const lp = await position(A, legacyOrder.id);
    await svc(`INSERT INTO public.trades(user_id, market_type, execution_environment, position_id, strategy_id) VALUES ($1, 'usd_m_futures', 'production', $2, gen_random_uuid())`, [A, lp.id]);
    const rows = (await as<{ entry_order_id: string; strategy_id: string | null; strategy_version: number | null; attribution_status: string }>("authenticated", A,
      `SELECT entry_order_id, strategy_id, strategy_version, attribution_status FROM public.futures_trade_strategy_attribution WHERE entry_order_id IN ('${c.id}', '${legacyOrder.id}') ORDER BY attribution_status`)).rows;
    expect(rows).toEqual([
      { entry_order_id: c.id, strategy_id: "ema-50-200", strategy_version: 3, attribution_status: "ATTRIBUTED" },
      { entry_order_id: legacyOrder.id, strategy_id: null, strategy_version: null, attribution_status: "UNATTRIBUTED" },
    ]);
    expect((await as("authenticated", B, `SELECT * FROM public.futures_trade_strategy_attribution`)).rows.every((r) => (r as { user_id: string }).user_id === B)).toBe(true);
  });
});

describe("draft 0047 — scope and rollback", () => {
  it("never alters, updates or triggers on real orders/positions/trades; no backfill; no CASCADE; no transaction control", () => {
    const code = MIG.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/ALTER\s+TABLE\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/ON\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\s+public\.futures_order_strategy_identity[\s\S]*?\bSELECT\b[\s\S]*?\bFROM\s+public\.orders\b(?![\s\S]*VALUES)/i);
    expect(code).not.toMatch(/CASCADE|\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(RB.replace(/--.*$/gm, "")).not.toMatch(/CASCADE|public\.(orders|positions|trades)\b/i);
  });
  it("uses only column names that exist on the real tables (drizzle/migrations)", () => {
    const all = readdirSync("drizzle/migrations").filter((f) => f.endsWith(".sql")).map((f) => readFileSync(`drizzle/migrations/${f}`, "utf8")).join("\n");
    for (const col of ["market_type", "execution_environment", "entry_order_id", "position_id", "idempotency_key"]) expect(all, col).toMatch(new RegExp(`\\b${col}\\b`));
  });
  it("rolls back to nothing and re-applies cleanly", async () => {
    await db.exec(RB);
    const left = await db.query<{ n: string }>(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname LIKE 'futures_%attribution%' OR relname = 'futures_order_strategy_identity')
      + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (proname LIKE '%futures_attribution%' OR proname LIKE '%strategy_identity%')) AS n`);
    expect(Number(left.rows[0]!.n)).toBe(0);
    expect(Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.orders`)).rows[0]!.n)).toBeGreaterThan(0); // real-table stand-ins untouched
    await db.exec(MIG);
  });
});
