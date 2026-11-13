// Test harness: draft 0049 (NOT applied anywhere real) in PGlite + the 0049-aligned engine and worker ports. Every value
// here is a TEST INPUT (the owner's proposals: 5% liquidation buffer, 5 s price age, 60 s expiry, 0.13% cost), not
// approved policy. Nothing touches the live database, an exchange or any network.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { initialFuturesPaperState, type FPBar, type FPConfig, type FPIntent, type FPState } from "@/lib/futures-paper-engine";
import { stepFuturesPaperCandleV3, type FPV3Ledger, type FPV3Options } from "@/lib/futures-paper-engine-v3";
import { futuresPaperCommitPayloadV3 } from "@/lib/futures-paper-ledger-v3";
import { FP_SQL } from "@/lib/futures-paper-worker-queries";
import { viewFromRows, type CommitOutcome, type WorkerAccountView, type WorkerPorts } from "@/lib/futures-paper-worker";
import type { RawSymbolBundle } from "@/lib/futures-paper-market-data";

export const MIGRATION_0049 = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8");
export const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
export const M = 60_000;
export const SPEC = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
export const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 50,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: SPEC, ETHUSDT: SPEC },
  limits: { maxExposure: 5000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: {},
};
let uidN = 0x5000;
export const freshUser = () => `00000000-0000-4000-8000-${(uidN++).toString(16).padStart(12, "0")}`;

export async function makeDb() { const db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION_0049); return db; }
export async function as<T = Record<string, unknown>>(db: PGlite, role: "service_role" | "authenticated" | "anon", sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role};`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE;"); }
}
export async function newAccount(db: PGlite, user: string, cursorT: number, cfg: FPConfig = CFG, symbols = ["BTCUSDT", "ETHUSDT"], timeframe: "1m" | "5m" | "15m" = "1m") {
  const r = await as<{ id: string }>(db, "service_role", `INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', $2, $3, $4::jsonb, $5, 0, $6::jsonb) RETURNING id`, [user, symbols, timeframe, JSON.stringify(cfg), cfg.startingBalance, JSON.stringify(initialFuturesPaperState(cfg.startingBalance))]);
  const id = r.rows[0]!.id;
  // Test-only, as the table owner: move the cursor into the past so recorded candles can be replayed. API roles cannot.
  await db.exec(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${cursorT} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
export const accountBudget = (db: PGlite, user: string, total: number, research: number, scalping: number) => as(db, "service_role", `INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',$2,$3,$4)
  ON CONFLICT (user_id, environment) DO UPDATE SET max_loss=EXCLUDED.max_loss, research_max_loss=EXCLUDED.research_max_loss, scalping_max_loss=EXCLUDED.scalping_max_loss`, [user, total, research, scalping]);
export const strategyBudget = (db: PGlite, user: string, strategy: string, engine: "research" | "scalping", max: number) => as(db, "service_role", `INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,$2,'paper',$3,$4)
  ON CONFLICT (user_id, strategy_id, environment) DO UPDATE SET max_loss = EXCLUDED.max_loss`, [user, strategy, engine, max]);
export const costOverride = (db: PGlite, user: string, strategy: string, symbol: string, pct: number, status: "unvalidated" | "validated" = "unvalidated") => as(db, "service_role", `INSERT INTO public.futures_paper_cost_assumptions(user_id, strategy_id, symbol, round_trip_cost_pct, validation_status) VALUES ($1,$2,$3,$4,$5)`, [user, strategy, symbol, pct, status]);
export async function commitRaw(db: PGlite, id: string, seq: number, barT: number, payload: unknown) {
  return Number((await as<{ seq: string }>(db, "service_role", FP_SQL.commit, [id, seq, barT, JSON.stringify(payload)])).rows[0]!.seq);
}
export async function loadView(db: PGlite, accountId: string): Promise<WorkerAccountView> {
  const a = (await db.query<Record<string, unknown>>(FP_SQL.account, [accountId])).rows[0]!;
  const user = String(a["user_id"]);
  const [ab, u, c, ap, p] = await Promise.all([db.query<Record<string, unknown>>(FP_SQL.accountBudget, [user]), db.query<Record<string, unknown>>(FP_SQL.usage, [user]), db.query<Record<string, unknown>>(FP_SQL.costs, [user]), db.query<Record<string, unknown>>(FP_SQL.approvals, [accountId]), db.query<Record<string, unknown>>(FP_SQL.positions, [accountId])]);
  return viewFromRows(a, ab.rows[0] ?? null, u.rows, c.rows, ap.rows, p.rows);
}
export const usageOf = async (db: PGlite, user: string, strategy: string | null, engine: string | null) => Number((await db.query<{ u: string }>(`SELECT public.fp3_usage($1, $2, $3)::numeric AS u`, [user, strategy, engine])).rows[0]!.u);

/** One engine step for a loaded view + payload. */
export function stepView(v: WorkerAccountView, bars: FPBar[], intents: FPIntent[], evaluated: string[] = [], opts: FPV3Options = {}) {
  const prev: FPState = { ...v.state, accountCursor: v.cursorT };
  const ledger: FPV3Ledger = { ...v.ledger, evaluatedProposals: evaluated };
  const r = stepFuturesPaperCandleV3(prev, v.config, bars, intents, { accountStatus: v.status, accountHalted: v.halted }, ledger, opts);
  return { ...r, prev, payload: futuresPaperCommitPayloadV3(prev, r.state, r.events, bars, intents) };
}

// ---- raw Binance-format market data for the worker's market port ----
export type OHLC = [number, number, number, number];
export function rawBundle(symbol: string, barT: number, tfMs: number, px: { trade: OHLC; v?: number; mark?: OHLC; index?: number | null; funding?: { t: number; rate: number }[] }, fetchedAt: number, timeframe = "1m"): RawSymbolBundle {
  const row = ([o, h, l, c]: OHLC, v: number) => [barT, String(o), String(h), String(l), String(c), String(v), barT + tfMs - 1, "0", 0, "0", "0", "0"];
  const mk = px.mark ?? px.trade, ix = px.index === undefined ? mk[3] : px.index;
  return { source: "binance-public-usdm", symbol, timeframe, fetchedAt, trade: [row(px.trade, px.v ?? 1e6)], mark: [row(mk, 0)], index: ix === null ? [] : [row([ix, ix, ix, ix], 0)], funding: (px.funding ?? []).map((f) => ({ fundingTime: f.t, fundingRate: String(f.rate) })) };
}

/** Worker ports over one PGlite database (single connection: leases are an in-memory map here; real PG uses advisory locks). */
export function pglitePorts(db: PGlite, o: { market: WorkerPorts["market"]; intents?: WorkerPorts["intents"]; now: () => number; beforeCommit?: (n: number) => void | Promise<void>; afterCommit?: (n: number) => void | Promise<void> }) {
  const leases = new Map<string, string>(); const metrics: unknown[] = []; let commits = 0;
  const ports: WorkerPorts = {
    db: {
      async tryAcquireLease(id, holder) { const h = leases.get(id); if (h && h !== holder) return false; leases.set(id, holder); return true; },
      async releaseLease(id, holder) { if (leases.get(id) === holder) leases.delete(id); },
      load: (id) => loadView(db, id),
      async evaluatedProposals(user, ids) { return (await db.query<{ proposal_id: string }>(FP_SQL.evaluated, [user, ids])).rows.map((r) => r.proposal_id); },
      async commit(id, seq, barT, payload): Promise<CommitOutcome> {
        const n = ++commits; await o.beforeCommit?.(n);
        try { const s = await commitRaw(db, id, seq, barT, payload); await o.afterCommit?.(n); return { kind: "committed", seq: s }; }
        catch (e) { if ((e as Error).message === "LOST") throw e; return { kind: "refused", message: String((e as Error).message) }; }
      },
      async markForReview(id, code) { await as(db, "service_role", FP_SQL.markForReview, [id, `review:${code}`]); },
    },
    market: o.market, intents: o.intents ?? { forCandle: async () => [] },
    clock: { now: o.now, sleep: async () => {} }, monitor: { record: (m) => { metrics.push(m); } },
  };
  return { ports, leases, metrics };
}
