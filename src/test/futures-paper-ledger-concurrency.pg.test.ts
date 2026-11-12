// Genuine multi-session concurrency tests for DRAFT migration 0045 (Futures paper ledger). Needs a real PostgreSQL:
// run scripts/futures-paper/concurrency-check.sh (throwaway local server). Skipped when FUTURES_PAPER_PG_URL is not set.
// Never touches the live database. Separate sessions race to commit engine output; exactly one commit per candle may
// win, sequences stay gap-free and the wallet always reconciles with the event ledger.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { futuresPaperCommitPayload, initialFuturesPaperState, reconcileFuturesPaper, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent } from "@/lib/futures-paper-engine";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;
const M = 60_000;
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 3,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null },
  specs: { BTCUSDT: { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 } },
  limits: { maxExposure: 5000, maxDailyLoss: 500, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 1, maxDataAgeMs: 60_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: { s1: 10_000 },
};
const N = 60, T0 = Math.floor(Date.now() / M) * M - (N + 5) * M;
const BARS: FPBar[] = Array.from({ length: N }, (_, k) => { const c = 100 + 2 * Math.sin(k / 2), o = 100 + 2 * Math.sin((k - 1) / 2); return { symbol: "BTCUSDT", t: T0 + k * M, tfMs: M, trade: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1e6 }, mark: { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c }, index: { c }, funding: k % 20 === 10 ? [{ t: T0 + k * M, rate: 0.0001 }] : [] }; });
const intents = (k: number) => (k % 6 === 0 ? [{ maxHoldBars: 8, proposal: { proposalId: `cc-prop-${k}`, engine: "scalp_intraday" as const, strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures" as const, environment: "paper" as const, side: (k % 12 === 0 ? "LONG" : "SHORT") as "LONG" | "SHORT", referencePrice: null, stopPrice: BARS[k]!.mark!.c * (k % 12 === 0 ? 0.99 : 1.01), takeProfitPrice: BARS[k]!.mark!.c * (k % 12 === 0 ? 1.01 : 0.99), createdAt: T0 + (k + 1) * M } }] : []);

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!); const name = `fpaper_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(MIGRATION);
  const r = await owner.unsafe(`SET ROLE service_role; INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ('00000000-0000-4000-8000-000000000001', 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT'], '1m', '${JSON.stringify(CFG)}'::jsonb, 1000, 0, '${JSON.stringify(initialFuturesPaperState(1000))}'::jsonb) RETURNING id; RESET ROLE;`);
  const id = (r as unknown as { id: string }[][]).flat().find((x) => x?.id)!.id;
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return { url, id, owner };
}
// The worker loop each session runs: read the committed state, compute the next candle, try to commit (compare-and-set).
async function worker(sql: Sql, id: string) {
  let wins = 0, losses = 0;
  for (let guard = 0; guard < N * 3; guard++) {
    const [a] = await sql`SELECT seq, cursor_t, state FROM public.futures_paper_accounts WHERE id = ${id}`;
    const cursor = Number(a!["cursor_t"]), k = BARS.findIndex((b) => b.t > cursor); if (k < 0) break;
    const r = stepFuturesPaper(a!["state"] as never, CFG, BARS[k]!, intents(k));
    try { await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(`SELECT public.futures_paper_commit_bar($1, $2, $3, $4::jsonb)`, [id, Number(a!["seq"]), BARS[k]!.t, futuresPaperCommitPayload(r.state, r.events) as never]); }); wins++; }
    catch (e) { if (/sequence moved|not after the cursor/.test(String(e))) losses++; else if (/entries are refused/.test(String(e))) return { wins, losses, refused: true }; else throw e; }
  }
  return { wins, losses, refused: false };
}

describe.skipIf(!URL)("draft 0045 under real concurrent sessions", () => {
  it("racing workers commit every candle exactly once; the ledger reconciles with a single-threaded replay", async () => {
    const { url, id, owner } = await freshDb();
    const results = await Promise.all(Array.from({ length: 6 }, () => worker(connect(url), id)));
    expect(results.reduce((a, r) => a + r.wins, 0)).toBe(N);
    expect(results.reduce((a, r) => a + r.losses, 0)).toBeGreaterThan(0); // they really did race
    const rows = await owner`SELECT * FROM public.futures_paper_events WHERE account_id = ${id} ORDER BY seq`;
    const seqs = rows.map((r) => Number(r["seq"])); expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // Same candles, one thread, no database: identical events and wallet.
    let s = initialFuturesPaperState(1000); const ev: FPEvent[] = [];
    for (let k = 0; k < N; k++) { const r = stepFuturesPaper(s, CFG, BARS[k]!, intents(k)); s = r.state; ev.push(...r.events); }
    expect(rows.length).toBe(ev.length);
    expect(rows.filter((r) => r["kind"] === "entry_fill").length).toBe(ev.filter((e) => e.kind === "entry_fill").length);
    const [acc] = await owner`SELECT wallet FROM public.futures_paper_accounts WHERE id = ${id}`;
    expect(Number(acc!["wallet"])).toBeCloseTo(s.wallet, 6);
    expect(Number(rows.at(-1)!["wallet_after"])).toBeCloseTo(s.wallet, 6);
    expect(reconcileFuturesPaper(s, ev, 1000)).toEqual([]);
    expect(ev.some((e) => e.kind === "exit_fill") && ev.some((e) => e.kind === "funding")).toBe(true);
  }, 60_000);

  it("concurrent halts and commits: no entry event is ever written after the halt commits", async () => {
    const { url, id, owner } = await freshDb();
    const halter = connect(url);
    let haltSeq = -1;
    const [w] = await Promise.all([worker(connect(url), id), (async () => { await new Promise((r) => setTimeout(r, 40)); await halter.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); const r = await tx.unsafe(`UPDATE public.futures_paper_accounts SET halted = true WHERE id = '${id}' RETURNING seq`); haltSeq = Number(r[0]!["seq"]); }); })()]);
    expect(w.wins).toBeGreaterThan(0); // some candles committed before the halt
    expect(w.refused).toBe(true);      // and the next entry after it was refused by the database
    // The halt takes the same row lock as the commit function, so RETURNING seq is the last sequence before the halt.
    expect(haltSeq).toBeGreaterThanOrEqual(0);
    const late = await owner`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id = ${id} AND kind IN ('entry_fill','order_accepted') AND seq > ${haltSeq}`;
    expect(late[0]!["n"]).toBe(0);
  }, 60_000);
});
