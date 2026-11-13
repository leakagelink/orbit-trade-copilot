// Phase 4E — genuine multi-session PostgreSQL tests for DRAFT 0048 (attribution corrections). Needs a real server:
// scripts/futures-paper/concurrency-check-4e.sh starts a throwaway local PostgreSQL; skipped when FUTURES_PAPER_PG_URL is
// unset. Never touches the live database. Every scenario runs in BOTH orders (session 1 first, then session 2 first):
// the first writer holds its transaction open while the second blocks on the identity row lock, then the second
// re-evaluates against the committed effective totals.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const M0048 = readFileSync("docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text, idempotency_key text NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, idempotency_key));
CREATE TABLE public.positions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, entry_order_id uuid REFERENCES public.orders(id));
CREATE TABLE public.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, market_type text NOT NULL DEFAULT 'spot', execution_environment text NOT NULL, position_id uuid, order_id uuid, strategy_id uuid);
GRANT SELECT ON public.orders, public.positions, public.trades TO authenticated; GRANT ALL ON public.orders, public.positions, public.trades TO service_role;`;
const USER = "00000000-0000-4000-8000-0000000004ee";

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
const svcTx = <T>(s: Sql, f: (tx: postgres.TransactionSql) => Promise<T>) => s.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE service_role"); return f(tx); }) as Promise<T>;

async function setup(fillQty: number, reductions: number[] = []) {
  const admin = connect(URL!); const name = `phase4e_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(M0048);
  const order = await svcTx(owner, async (tx) => {
    const o = (await tx.unsafe(`INSERT INTO public.orders(user_id, market_type, execution_environment, idempotency_key) VALUES ('${USER}', 'usd_m_futures', 'production', 'futures:cc4e-0001') RETURNING id`))[0]!["id"] as string;
    await tx.unsafe(`SELECT public.claim_futures_order_strategy_identity('${o}', 'ema-50-200', 1, '${"d".repeat(64)}')`); return o;
  });
  const pos = await svcTx(owner, async (tx) => (await tx.unsafe(`INSERT INTO public.positions(user_id, market_type, execution_environment, entry_order_id) VALUES ('${USER}', 'usd_m_futures', 'production', '${order}') RETURNING id`))[0]!["id"] as string);
  const fill = await svcTx(owner, async (tx) => Number((await tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, qty, evidence_ref) VALUES ('${USER}', 'production', '${order}', 'entry_fill', ${fillQty}, 'fill-1') RETURNING id`))[0]!["id"]));
  const reds: number[] = [];
  for (const [i, q] of reductions.entries()) reds.push(await svcTx(owner, async (tx) => Number((await tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, kind, qty, evidence_ref) VALUES ('${USER}', 'production', '${order}', '${pos}', 'reduction', ${q}, 'red-setup-${i}') RETURNING id`))[0]!["id"])));
  return { url, owner, order, pos, fill, reds };
}
type Op = (tx: postgres.TransactionSql) => Promise<unknown>;
const reduce = (order: string, pos: string, qty: number, ref: string): Op => (tx) => tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, position_id, kind, qty, evidence_ref) VALUES ('${USER}', 'production', '${order}', '${pos}', 'reduction', ${qty}, '${ref}')`);
const correct = (order: string, original: number, revision: number, qty: number, amount: number, ref: string): Op => (tx) => tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, evidence_ref, corrects_event_id, correction_revision, corrected_qty, corrected_amount, reason) VALUES ('${USER}', 'production', '${order}', 'correction', '${ref}', ${original}, ${revision}, ${qty}, ${amount}, 'exchange statement')`);
/** Runs `first` in session 1 (holding its transaction open), then `second` in session 2 while session 1 still holds the lock. */
async function race(url: string, first: Op, second: Op) {
  const [s1, s2] = [connect(url), connect(url)];
  const run = (s: Sql, op: Op, holdMs: number) => svcTx(s, async (tx) => { await op(tx); if (holdMs) await tx.unsafe(`SELECT pg_sleep(${holdMs / 1000})`); return "ok"; }).catch((e: Error) => e.message);
  return Promise.all([run(s1, first, 400), new Promise((r) => setTimeout(r, 120)).then(() => run(s2, second, 0))]);
}
const totals = async (s: Sql, order: string) => {
  const [t] = await s`SELECT filled_qty::float8 f, reduced_qty::float8 r, open_qty::float8 o, restatements::int n FROM public.futures_strategy_attribution_totals WHERE entry_order_id = ${order}`;
  return { filled: t!["f"] as number, reduced: t!["r"] as number, open: t!["o"] as number, restatements: t!["n"] as number };
};

describe.skipIf(!URL)("draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders)", () => {
  for (const order of ["correction first", "reduction first"] as const) {
    it(`fill 1.0 restated to 0.5 vs a 0.6 reduction (${order}): exactly one commits; reductions never exceed effective fills`, async () => {
      const { url, owner, order: o, pos, fill } = await setup(1);
      const c = correct(o, fill, 1, 0.5, 0, "stmt-a"), r = reduce(o, pos, 0.6, "red-a");
      const out = order === "correction first" ? await race(url, c, r) : await race(url, r, c);
      expect(out[0]).toBe("ok");
      expect(out[1]).toMatch(order === "correction first" ? /would exceed the effective filled quantity 0.5/ : /would make effective reductions 0.6 exceed the effective filled quantity 0.5/);
      const t = await totals(owner, o);
      expect(t.reduced).toBeLessThanOrEqual(t.filled);
      expect(t).toEqual(order === "correction first" ? { filled: 0.5, reduced: 0, open: 0.5, restatements: 1 } : { filled: 1, reduced: 0.6, open: 0.4, restatements: 0 });
    }, 60_000);
  }
  for (const same of [true, false]) {
    it(`two simultaneous revision-1 corrections of one fee (${same ? "identical values" : "different values"}): exactly one commits, the other is stale`, async () => {
      const { url, owner, order: o } = await setup(1);
      const fee = await svcTx(owner, async (tx) => Number((await tx.unsafe(`INSERT INTO public.futures_strategy_attribution_events(user_id, execution_environment, entry_order_id, kind, amount, evidence_ref) VALUES ('${USER}', 'production', '${o}', 'fee', -1, 'fee-1') RETURNING id`))[0]!["id"]));
      const out = await race(url, correct(o, fee, 1, 0, -0.5, "stmt-1"), correct(o, fee, 1, 0, same ? -0.5 : -0.7, "stmt-2"));
      expect(out[0]).toBe("ok");
      expect(out[1]).toMatch(/stale or out-of-order correction: event \d+ is at revision 1/);
      const [n] = await owner`SELECT count(*)::int n, max(correction_revision)::int r FROM public.futures_strategy_attribution_events WHERE corrects_event_id = ${fee}`;
      expect({ n: n!["n"], r: n!["r"] }).toEqual({ n: 1, r: 1 });
      const [e] = await owner`SELECT effective_amount::float8 a FROM public.futures_strategy_attribution_effective WHERE event_id = ${fee}`;
      expect(e!["a"]).toBe(-0.5);
    }, 60_000);
  }
  for (const order of ["correction first", "reduction first"] as const) {
    it(`reduction 0.5 restated to 0.8 vs a new 0.4 reduction on a 1.0 fill (${order}): exactly one commits`, async () => {
      const { url, owner, order: o, pos, reds } = await setup(1, [0.5]);
      const c = correct(o, reds[0]!, 1, 0.8, 0, "stmt-r"), r = reduce(o, pos, 0.4, "red-b");
      const out = order === "correction first" ? await race(url, c, r) : await race(url, r, c);
      expect(out[0]).toBe("ok");
      expect(out[1]).toMatch(/exceed the effective filled quantity 1/);
      const t = await totals(owner, o);
      expect(t.reduced).toBeLessThanOrEqual(t.filled);
      expect(t.reduced).toBeCloseTo(order === "correction first" ? 0.8 : 0.9, 12);
    }, 60_000);
  }
  it("two simultaneous 0.3 reductions against a fill corrected down to 0.5: exactly one commits", async () => {
    const { url, owner, order: o, pos, fill } = await setup(1);
    await svcTx(owner, correct(o, fill, 1, 0.5, 0, "stmt-down"));
    await svcTx(owner, reduce(o, pos, 0.1, "red-0"));
    const out = await race(url, reduce(o, pos, 0.3, "red-x"), reduce(o, pos, 0.3, "red-y"));
    expect(out[0]).toBe("ok"); expect(out[1]).toMatch(/would exceed the effective filled quantity 0.5/);
    const t = await totals(owner, o);
    expect(t.filled).toBe(0.5); expect(t.reduced).toBeCloseTo(0.4, 12); expect(t.open).toBeCloseTo(0.1, 12); expect(t.restatements).toBe(1);
  }, 60_000);
});
