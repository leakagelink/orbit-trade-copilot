// Phase 4E Workstream B — DRAFT migration 0048 (successor of 0047; strategy attribution for real USD-M Futures orders,
// NOT applied) run verbatim in PGlite (single session) against minimal stand-ins of public.orders/positions/trades with
// the real column names. Nothing touches the real database. Multi-session behaviour is covered separately by
// src/test/phase4e-attribution-concurrency.pg.test.ts on a throwaway real PostgreSQL.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIG = readFileSync("docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql", "utf8");
const RB = readFileSync("docs/proposed-migrations/0048_futures_strategy_attribution_v2.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-0000000048a1", B = "00000000-0000-4000-8000-0000000048b2";
const SHA = "a".repeat(64);
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
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY o_own ON public.orders FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY p_own ON public.positions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY t_own ON public.trades FOR SELECT TO authenticated USING (user_id = auth.uid());`;

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
async function claim(user: string, key: string, env = "production", strategy = "ema-50-200", version = 1) {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE service_role");
    const o = await tx.query<{ id: string }>(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, 'usd_m_futures', $2, $3) RETURNING id`, [user, env, key]);
    const r = await tx.query<{ r: string }>(`SELECT public.claim_futures_order_strategy_identity($1, $2, $3, $4) AS r`, [o.rows[0]!.id, strategy, version, SHA]);
    return { id: o.rows[0]!.id, result: r.rows[0]!.r };
  });
}
const svc = (sql: string, params: unknown[] = []) => as("service_role", null, sql, params);
let refN = 0;
async function ev(o: string, user: string, kind: string, x: Record<string, unknown> = {}): Promise<number> {
  const r = await svc(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, trade_id, kind, qty, amount, evidence_ref)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [user, x["env"] ?? "production", o, x["position"] ?? null, x["trade"] ?? null, kind, x["qty"] ?? 0, x["amount"] ?? 0, x["ref"] ?? `${kind}-${++refN}`]);
  return Number((r.rows[0] as { id: string }).id);
}
async function correct(o: string, user: string, original: number, revision: number | null, qty: number | string | null, amount: number | string | null, x: Record<string, unknown> = {}): Promise<number> {
  const r = await svc(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, kind, evidence_ref, corrects_event_id, correction_revision, corrected_qty, corrected_amount, reason)
    VALUES ($1, 'production', $2, $3, 'correction', $4, $5, $6, $7, $8, $9) RETURNING id`,
    [user, o, x["position"] ?? null, x["ref"] ?? `cor-${++refN}`, original, revision, qty, amount, x["reason"] === undefined ? "exchange statement differs" : x["reason"]]);
  return Number((r.rows[0] as { id: string }).id);
}
async function position(user: string, order: string) {
  return (await svc(`INSERT INTO public.positions(user_id, market_type, execution_environment, entry_order_id) VALUES ($1, 'usd_m_futures', 'production', $2) RETURNING id`, [user, order])).rows[0] as { id: string };
}
type Totals = { filled_qty: string; reduced_qty: string; open_qty: string; fees: string; funding: string; restatements: string };
const totals = async (o: string) => (await svc(`SELECT filled_qty, reduced_qty, open_qty, fees, funding, restatements FROM public.futures_strategy_attribution_totals WHERE entry_order_id = $1`, [o])).rows[0] as Totals;
const num = (t: Totals) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)]));

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIG); }, 120_000);

describe("draft 0048 — correction semantics: a correction RESTATES one original event (replacement, never a delta)", () => {
  it("entry-fill quantity, reduction quantity, fee and funding restatements all flow into the effective totals", async () => {
    const c = await claim(A, "futures:sem-0001"); const p = await position(A, c.id);
    const f1 = await ev(c.id, A, "entry_fill", { qty: 0.6 }); await ev(c.id, A, "entry_fill", { qty: 0.4 });
    const r1 = await ev(c.id, A, "reduction", { position: p.id, qty: 0.3 });
    const fee = await ev(c.id, A, "fee", { amount: -0.12 });
    const fund = await ev(c.id, A, "funding", { position: p.id, amount: -0.02 });
    expect(num(await totals(c.id))).toEqual({ filled_qty: 1, reduced_qty: 0.3, open_qty: 0.7, fees: -0.12, funding: -0.02, restatements: 0 });
    await correct(c.id, A, f1, 1, 0.5, 0);              // fill 1 was really 0.5
    await correct(c.id, A, r1, 1, 0.25, 0);             // reduction was really 0.25
    await correct(c.id, A, fee, 1, 0, -0.1);            // fee restated
    await correct(c.id, A, fee, 2, 0, -0.11);           // and restated again: revision 2 replaces revision 1
    await correct(c.id, A, fund, 1, 0, 0.01);           // funding was a receipt
    expect(num(await totals(c.id))).toEqual({ filled_qty: 0.9, reduced_qty: 0.25, open_qty: 0.65, fees: -0.11, funding: 0.01, restatements: 5 });
    const eff = (await svc(`SELECT event_id, original_amount, effective_amount, revision FROM public.futures_strategy_attribution_effective WHERE event_id = $1`, [fee])).rows[0] as Record<string, string>;
    expect({ orig: Number(eff["original_amount"]), eff: Number(eff["effective_amount"]), rev: Number(eff["revision"]) }).toEqual({ orig: -0.12, eff: -0.11, rev: 2 });
    // The original rows are never changed; corrections are separate rows and never appear in the effective view.
    expect(Number(((await svc(`SELECT amount FROM public.futures_strategy_attribution_events WHERE id = $1`, [fee])).rows[0] as { amount: string }).amount)).toBe(-0.12);
    expect((await svc(`SELECT count(*)::int n FROM public.futures_strategy_attribution_effective WHERE entry_order_id = $1`, [c.id])).rows[0]).toEqual({ n: 5 });
  });
  it("an entry fill can be voided (restated to 0) only while the effective reductions still fit", async () => {
    const c = await claim(A, "futures:void-001"); const p = await position(A, c.id);
    const f1 = await ev(c.id, A, "entry_fill", { qty: 0.5 }); const f2 = await ev(c.id, A, "entry_fill", { qty: 0.5 });
    await ev(c.id, A, "reduction", { position: p.id, qty: 0.6 });
    await expect(correct(c.id, A, f1, 1, 0, 0)).rejects.toThrow(/would make effective reductions 0.6 exceed the effective filled quantity 0.5/);
    await correct(c.id, A, f2, 1, 0.1, 0); // 0.5 + 0.1 = 0.6 ≥ 0.6 → allowed
    expect(num(await totals(c.id))).toMatchObject({ filled_qty: 0.6, reduced_qty: 0.6, open_qty: 0 });
    await expect(ev(c.id, A, "reduction", { position: p.id, qty: 0.0001 })).rejects.toThrow(/would exceed the effective filled quantity 0.6/);
  });
  it("reductions are checked against CORRECTED fills, and a reduction restated upward cannot exceed them", async () => {
    const c = await claim(A, "futures:redc-001"); const p = await position(A, c.id);
    const f = await ev(c.id, A, "entry_fill", { qty: 1 });
    await correct(c.id, A, f, 1, 0.4, 0);
    await expect(ev(c.id, A, "reduction", { position: p.id, qty: 0.5 })).rejects.toThrow(/would exceed the effective filled quantity 0.4/);
    const r = await ev(c.id, A, "reduction", { position: p.id, qty: 0.4 });
    await expect(correct(c.id, A, r, 1, 0.41, 0)).rejects.toThrow(/exceed the effective filled quantity/);
    await correct(c.id, A, f, 2, 1, 0); // fill restored to 1 (revision 2)
    await correct(c.id, A, r, 1, 0.9, 0);
    expect(num(await totals(c.id))).toMatchObject({ filled_qty: 1, reduced_qty: 0.9, open_qty: 0.1, restatements: 3 });
  });
});

describe("draft 0048 — duplicate, circular, repeated and invalid corrections are refused", () => {
  it("stale, skipped and forked revisions (compare-and-set on the revision number)", async () => {
    const c = await claim(A, "futures:rev-0001"); const fee = await ev(c.id, A, "fee", { amount: -1 });
    await expect(correct(c.id, A, fee, 2, 0, -0.9)).rejects.toThrow(/next correction must be revision 1/);
    await expect(correct(c.id, A, fee, 0, 0, -0.9)).rejects.toThrow(/next correction must be revision 1|check constraint/);
    await expect(correct(c.id, A, fee, null, 0, -0.9)).rejects.toThrow(/next correction must be revision 1|check constraint/);
    await correct(c.id, A, fee, 1, 0, -0.9);
    await expect(correct(c.id, A, fee, 1, 0, -0.8)).rejects.toThrow(/stale or out-of-order correction: event \d+ is at revision 1/);
    await correct(c.id, A, fee, 2, 0, -0.8);
  });
  it("no-op restatements, duplicate evidence, corrections of corrections, self-reference and cross-order references", async () => {
    const c = await claim(A, "futures:dupc-001"), other = await claim(A, "futures:dupc-002");
    const fee = await ev(c.id, A, "fee", { amount: -1 }); const otherFee = await ev(other.id, A, "fee", { amount: -1 });
    await expect(correct(c.id, A, fee, 1, 0, -1)).rejects.toThrow(/repeats the current effective values/);   // no-op vs original
    const c1 = await correct(c.id, A, fee, 1, 0, -0.5, { ref: "stmt-2026-11-13" });
    await expect(correct(c.id, A, fee, 2, 0, -0.5)).rejects.toThrow(/repeats the current effective values/); // repeated restatement
    await expect(correct(c.id, A, fee, 2, 0, -0.4, { ref: "stmt-2026-11-13" })).rejects.toThrow(/unique|duplicate/); // same evidence twice
    await expect(correct(c.id, A, c1, 1, 0, -0.4)).rejects.toThrow(/never another correction/);              // correction of a correction
    await expect(correct(c.id, A, otherFee, 1, 0, -0.4)).rejects.toThrow(/same attributed order/);
    await expect(correct(c.id, A, 999_999_999, 1, 0, -0.4)).rejects.toThrow(/earlier, existing original event/);
    // Self-reference with a forced id: refused before the foreign key could be satisfied by the row itself.
    await expect(svc(`INSERT INTO public.futures_strategy_attribution_events(id, user_id, execution_environment, entry_order_id, kind, evidence_ref, corrects_event_id, correction_revision, corrected_qty, corrected_amount, reason)
      OVERRIDING SYSTEM VALUE VALUES (888888, $1, 'production', $2, 'correction', 'self', 888888, 1, 0, -0.3, 'x')`, [A, c.id])).rejects.toThrow(/earlier, existing original event/);
  });
  it("restated values must keep the original event's shape; corrections carry no own quantity, amount, position or trade", async () => {
    const c = await claim(A, "futures:shape-01"); const p = await position(A, c.id);
    const f = await ev(c.id, A, "entry_fill", { qty: 1 }); const fee = await ev(c.id, A, "fee", { amount: -1 }); const fund = await ev(c.id, A, "funding", { position: p.id, amount: -1 });
    await expect(correct(c.id, A, f, 1, 0.9, -1)).rejects.toThrow(/restates a quantity only/);
    await expect(correct(c.id, A, fee, 1, 1, -1.5)).rejects.toThrow(/restates an amount only/);
    await expect(correct(c.id, A, fund, 1, 1, 0)).rejects.toThrow(/restates an amount only/);
    await expect(correct(c.id, A, fee, 1, 0, 0.2)).rejects.toThrow(/cannot make the fee positive/);
    await expect(correct(c.id, A, f, 1, -0.1, 0)).rejects.toThrow(/numbers|check constraint/);
    await expect(correct(c.id, A, f, 1, "NaN", 0)).rejects.toThrow(/numbers|check constraint/);
    await expect(correct(c.id, A, f, 1, 0.9, 0, { reason: null })).rejects.toThrow(/kind_shape/);
    await expect(correct(c.id, A, f, 1, 0.9, 0, { position: p.id })).rejects.toThrow(/kind_shape/);
    await expect(correct(c.id, A, f, 1, null, 0)).rejects.toThrow(/kind_shape|null/);
    await expect(correct(c.id, A, f, 21, 0.9, 0)).rejects.toThrow(/next correction must be revision 1|kind_shape/);
    // Non-correction rows can never carry correction fields; reductions and fills carry no amount.
    await expect(svc(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref, corrected_qty) VALUES ($1, 'production', $2, 'entry_fill', 1, 'cf', 2)`, [A, c.id])).rejects.toThrow(/correction_fields/);
    await expect(ev(c.id, A, "reduction", { position: p.id, qty: 0.1, amount: -1 })).rejects.toThrow(/kind_shape/);
    await expect(ev(c.id, A, "entry_fill", { qty: 1, amount: 3 })).rejects.toThrow(/kind_shape/);
  });
  it("at most 20 revisions per original event", async () => {
    const c = await claim(A, "futures:max-0001"); const fee = await ev(c.id, A, "fee", { amount: -1 });
    for (let r = 1; r <= 20; r++) await correct(c.id, A, fee, r, 0, -1 + r / 100);
    await expect(correct(c.id, A, fee, 21, 0, -0.5)).rejects.toThrow(/kind_shape/);
  }, 60_000);
});

describe("draft 0048 — preserved 0047 rules", () => {
  it("identity: captured only in the claim transaction; consistent retries; legacy orders stay UNATTRIBUTED", async () => {
    const c = await claim(A, "futures:id-00001"); expect(c.result).toBe("captured");
    expect((await svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 1, $2) AS r`, [c.id, SHA])).rows[0]).toEqual({ r: "existing" });
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 2, $2)`, [c.id, SHA])).rejects.toThrow(/different strategy identity/);
    const legacy = (await svc(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ($1, 'usd_m_futures', 'production', 'futures:legacy-48') RETURNING id`, [A])).rows[0] as { id: string };
    await expect(svc(`SELECT public.claim_futures_order_strategy_identity($1, 'ema-50-200', 1, $2)`, [legacy.id, SHA])).rejects.toThrow(/legacy orders stay UNATTRIBUTED/);
    const lp = await position(A, legacy.id);
    await svc(`INSERT INTO public.trades(user_id, market_type, execution_environment, position_id, strategy_id) VALUES ($1, 'usd_m_futures', 'production', $2, gen_random_uuid())`, [A, lp.id]);
    const row = (await svc(`SELECT strategy_id, attribution_status FROM public.futures_trade_strategy_attribution WHERE entry_order_id = $1`, [legacy.id])).rows[0];
    expect(row).toEqual({ strategy_id: null, attribution_status: "UNATTRIBUTED" }); // trades.strategy_id is never used to infer
    expect((await svc(`SELECT count(*)::int n FROM public.futures_strategy_attribution_totals WHERE entry_order_id = $1`, [legacy.id])).rows[0]).toEqual({ n: 0 });
  });
  it("append-only for every role; owner-only reads through tables and all three views; anon and browsers cannot write", async () => {
    const c = await claim(B, "futures:b-48-001", "testnet"); await svc(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref) VALUES ($1, 'testnet', $2, 'entry_fill', 1, 'b-fill')`, [B, c.id]);
    for (const role of ["service_role", "authenticated"] as const) {
      await expect(as(role, B, `UPDATE public.futures_strategy_attribution_events SET qty = 2`)).rejects.toThrow();
      await expect(as(role, B, `DELETE FROM public.futures_strategy_attribution_events`)).rejects.toThrow();
    }
    await expect(db.exec(`TRUNCATE public.futures_strategy_attribution_events`)).rejects.toThrow(/append-only|truncate/i);
    for (const v of ["futures_strategy_attribution_totals", "futures_strategy_attribution_effective", "futures_trade_strategy_attribution", "futures_order_strategy_identity"]) {
      const rows = (await as<{ user_id: string }>("authenticated", B, `SELECT user_id FROM public.${v}`)).rows;
      expect(rows.every((r) => r.user_id === B), v).toBe(true);
      await expect(as("anon", null, `SELECT * FROM public.${v}`), v).rejects.toThrow(/permission/);
    }
    expect((await as("authenticated", B, `SELECT * FROM public.futures_strategy_attribution_totals`)).rows.length).toBe(1);
    await expect(as("authenticated", B, `INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref) VALUES ('${B}', 'testnet', '${c.id}', 'entry_fill', 1, 'x')`)).rejects.toThrow(/permission/);
    await expect(as("authenticated", B, `SELECT public.futures_attribution_effective_qty('${c.id}')`)).rejects.toThrow(/permission/);
    await expect(as("service_role", null, `SELECT public.futures_attribution_effective_qty('${c.id}')`)).rejects.toThrow(/permission/);
  });
  it("events stay bound to the identity's owner, environment, position and trade", async () => {
    const c = await claim(A, "futures:bind-48a"), other = await claim(A, "futures:bind-48b");
    const q = await position(A, other.id);
    await expect(ev(c.id, B, "entry_fill", { qty: 1 })).rejects.toThrow(/owner\/environment differs/);
    await expect(ev(c.id, A, "entry_fill", { qty: 1, env: "testnet" })).rejects.toThrow(/owner\/environment differs/);
    await expect(ev(c.id, A, "funding", { position: q.id, amount: -1 })).rejects.toThrow(/not the position opened by the attributed entry order/);
  });
});

describe("draft 0048 — scope and rollback", () => {
  it("never alters real orders/positions/trades; no backfill; no CASCADE; no transaction control", () => {
    const code = MIG.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/ALTER\s+TABLE\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/ON\s+public\.(orders|positions|trades)\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+public\.futures_order_strategy_identity[^;]*SELECT/i);
    expect(code).not.toMatch(/CASCADE|\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(RB.replace(/--.*$/gm, "")).not.toMatch(/CASCADE|public\.(orders|positions|trades)\b/i);
  });
  it("draft 0047 is left byte-identical (0048 supersedes it; never apply both)", () => {
    const sha = (f: string) => require("node:crypto").createHash("sha256").update(readFileSync(f)).digest("hex");
    expect(sha("docs/proposed-migrations/0047_futures_strategy_attribution.sql")).toBe("42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b");
    expect(sha("docs/proposed-migrations/0047_futures_strategy_attribution.rollback.sql")).toBe("bb980bbcc5849ddd1fb671064f0fb568d6e6de1345127dfc635aa7a0f3755ae8");
  });
  it("rolls back to nothing, leaves the stand-ins untouched and re-applies cleanly", async () => {
    await db.exec(RB);
    const left = await db.query<{ n: string }>(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (relname LIKE 'futures_%attribution%' OR relname = 'futures_order_strategy_identity'))
      + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (proname LIKE '%futures_attribution%' OR proname LIKE '%strategy_identity%')) AS n`);
    expect(Number(left.rows[0]!.n)).toBe(0);
    expect(Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.orders`)).rows[0]!.n)).toBeGreaterThan(0);
    await db.exec(MIG);
  });
});
