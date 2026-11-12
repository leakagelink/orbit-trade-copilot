// Runs DRAFT migration 0044 (forward paper ledger) verbatim in an in-memory Postgres (PGlite) and drives the real paper
// worker against it. Nothing touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { initialPaperState, reconcilePaper, PAPER_ENGINE_VERSION } from "@/lib/paper-engine";
import { processPaperStrategy, runPaperTick, type PaperStore, type PaperStrategyRow } from "@/lib/paper.server";
import type { Candle } from "@/lib/indicators";

const MIGRATION = readFileSync("docs/proposed-migrations/0044_forward_paper_trading.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0044_forward_paper_trading.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
-- Hosted default grants: new tables and functions are granted to the API roles unless a migration revokes them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;
const TF = 3_600_000;
const CFG = { pairs: ["BTC/USDT"], timeframe: "1h", indicators: [], entry: { logic: "all", conditions: [{ left: "price", operator: ">", right: "0" }] }, exit: { logic: "any", conditions: [] }, risk: { stop_loss_pct: 2, take_profit_pct: 4, trailing_stop_pct: null, position_size_pct: 50, capital_allocation: 1000, max_open_positions: 1, daily_loss_limit_pct: 5 } };
const COSTS = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 50 };
const POLICY = { riskPerTradePct: 1, positionSizePct: 50, maxPositionNotional: 300, stopLossPct: 2, takeProfitPct: 4, dailyLossLimit: 100, strategyBudget: 1000, entryOrder: "market", limitOffsetPct: 0, orderTtlBars: 3 };
// Past, fully closed hourly candles: a deterministic wave that triggers stops and targets.
const END = Math.floor(Date.now() / TF) * TF - 2 * TF;
const N = 110;
const START = END - (N - 1) * TF;
const CANDLES: Candle[] = (() => {
  const out: Candle[] = []; let prev = 100;
  for (let k = 0; k < N; k++) { const c = 100 + 6 * Math.sin(k / 3); const o = prev; out.push({ t: START + k * TF, o, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.6, c, v: 5 }); prev = c; }
  return out;
})();

let db: PGlite;
async function as<T = Record<string, unknown>>(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query<T>(sql, params); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}
const count = async (t: string, where = "true") => Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.${t} WHERE ${where}`)).rows[0]!.n);

/** Creates a paper strategy as the backend would, then (test-only, as the table owner) moves its cursor into the past
 *  so recorded historical candles can be replayed. The backend role cannot do this. */
async function newStrategy(user: string, cursor: number, overrides: Record<string, unknown> = {}) {
  await as("service_role", null, `INSERT INTO public.paper_accounts(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user]);
  const r = await as<{ id: string }>("service_role", null, `INSERT INTO public.paper_strategies(user_id,strategy_id,strategy_name,config,engine_version,data_source,pair,timeframe,costs,risk,starting_capital,state)
    VALUES ($1, gen_random_uuid(), 'Wave test', $2::jsonb, $3, 'binance-public-spot-klines', 'BTC/USDT', '1h', $4::jsonb, $5::jsonb, 1000, $6::jsonb) RETURNING id`,
    [user, JSON.stringify(CFG), PAPER_ENGINE_VERSION, JSON.stringify(overrides["costs"] ?? COSTS), JSON.stringify(overrides["risk"] ?? POLICY), JSON.stringify(initialPaperState(1000))]);
  const id = r.rows[0]!.id;
  await db.exec(`SELECT set_config('paper.commit','on',false); UPDATE public.paper_strategies SET cursor_t=${cursor} WHERE id='${id}'; SELECT set_config('paper.commit','off',false);`);
  return id;
}
const store = (o: { failAfter?: number } = {}): PaperStore => {
  let commits = 0;
  return {
    async listRunnable() { return (await as<PaperStrategyRow>("service_role", null, `SELECT id,user_id,config,costs,risk,pair,timeframe,tf_ms,status,cursor_t,state FROM public.paper_strategies WHERE status IN ('active','paused')`)).rows; },
    async account(u) {
      const a = await as("service_role", null, `SELECT * FROM public.paper_accounts WHERE user_id=$1`, [u]);
      const p = await as("service_role", null, `SELECT id,open_exposure,open_positions,to_char(day_utc,'YYYY-MM-DD') day_utc,day_net FROM public.paper_strategies WHERE user_id=$1 AND status<>'stopped'`, [u]);
      return { account: a.rows[0] as never, peers: p.rows as never };
    },
    async hasPro() { return true; },
    async commit(id, expected, payload) {
      if (o.failAfter !== undefined && commits >= o.failAfter) throw new Error("simulated crash before commit");
      await as("service_role", null, `SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [id, expected, JSON.stringify(payload)]); commits++;
    },
    async mark(id, f) { await as("service_role", null, `UPDATE public.paper_strategies SET data_status=$2, status=coalesce($3,status), status_reason=coalesce($4,status_reason) WHERE id=$1`, [id, f.data_status, f.status ?? null, f.status_reason ?? null]); },
  };
};
const row = async (id: string) => (await as<PaperStrategyRow & { cash: string; status_reason: string | null; open_positions: number }>("service_role", null, `SELECT * FROM public.paper_strategies WHERE id=$1`, [id])).rows[0]!;
const feed = (cs: Candle[] = CANDLES) => async () => ({ candles: cs, fetchedAt: Date.now() });

beforeAll(async () => { db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION); }, 60_000);

describe("draft 0044 privileges", () => {
  it("browser roles cannot write any paper table; anonymous visitors cannot read", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    for (const t of ["paper_accounts", "paper_strategies", "paper_bars", "paper_order_events", "paper_trades"]) {
      await expect(as("authenticated", A, `DELETE FROM public.${t}`)).rejects.toThrow(/permission denied/);
      await expect(as("authenticated", A, `TRUNCATE public.${t}`)).rejects.toThrow(/permission denied/);
      await expect(as("anon", null, `SELECT * FROM public.${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(as("authenticated", A, `UPDATE public.paper_strategies SET status='active' WHERE id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `UPDATE public.paper_accounts SET halted=false`)).rejects.toThrow(/permission denied/);
  });
  it("only the backend can run the commit function", async () => {
    await expect(as("authenticated", A, `SELECT public.paper_commit_bar(gen_random_uuid(), 0, '{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, `SELECT public.paper_commit_bar(gen_random_uuid(), 0, '{}'::jsonb)`)).rejects.toThrow(/permission denied/);
  });
  it("history rows cannot be inserted directly, even by the backend", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    await expect(as("service_role", null, `INSERT INTO public.paper_trades(paper_strategy_id,user_id,position_key,opened_bar_t,closed_bar_t,qty,avg_entry,avg_exit,gross_pnl,fees,spread_cost,slippage_cost,net_pnl,close_reason) VALUES ('${id}','${A}','fake',1,2,1,1,2,1,0,0,0,1,'x')`)).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, `INSERT INTO public.paper_bars(paper_strategy_id,user_id,bar_t,candle,signal,decision,cash,equity,position_qty,unrealized,data_source,data_fetched_at) VALUES ('${id}','${A}',1,'{}','none','{}',1,1,0,0,'x',now())`)).rejects.toThrow(/permission denied/);
  });
  it("the backend cannot change a strategy's frozen terms or its ledger outside the commit function", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    await expect(as("service_role", null, `UPDATE public.paper_strategies SET risk='{}'::jsonb WHERE id='${id}'`)).rejects.toThrow(/frozen/);
    await expect(as("service_role", null, `UPDATE public.paper_strategies SET starting_capital=5000 WHERE id='${id}'`)).rejects.toThrow(/frozen/);
    await expect(as("service_role", null, `UPDATE public.paper_strategies SET cash=99999 WHERE id='${id}'`)).rejects.toThrow(/only through paper_commit_bar/);
    await expect(as("service_role", null, `DELETE FROM public.paper_strategies WHERE id='${id}'`)).rejects.toThrow(/permission denied/);
    await expect(db.exec(`DELETE FROM public.paper_strategies WHERE id='${id}'`)).rejects.toThrow(/cannot be deleted/);
  });
  it("the database fingerprints the frozen config and starts every strategy flat at the next candle", async () => {
    const r = await as<{ config_sha256: string; cursor_t: string; cash: string }>("service_role", null, `INSERT INTO public.paper_strategies(user_id,strategy_id,strategy_name,config,engine_version,data_source,pair,timeframe,costs,risk,starting_capital,state,cash,cursor_t)
      VALUES ('${A}', gen_random_uuid(), 'Fresh', '{"a":1}', '${PAPER_ENGINE_VERSION}', 'binance-public-spot-klines', 'ETH/USDT', '1h', '{}', '{}', 500, '${JSON.stringify(initialPaperState(500))}', 999999, 0) RETURNING config_sha256, cursor_t, cash`);
    const x = r.rows[0]!;
    expect(x.config_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(x.cash)).toBe(500); // supplied cash ignored
    expect(Number(x.cursor_t)).toBe(Math.ceil(Date.now() / TF) * TF - TF); // no earlier candle can be acted on
    await expect(as("service_role", null, `INSERT INTO public.paper_strategies(user_id,strategy_id,strategy_name,config,engine_version,data_source,pair,timeframe,costs,risk,starting_capital,state)
      VALUES ('${A}', gen_random_uuid(), 'Rich', '{}', '${PAPER_ENGINE_VERSION}', 'binance-public-spot-klines', 'SOL/USDT', '1h', '{}', '{}', 500, '${JSON.stringify(initialPaperState(9000))}')`)).rejects.toThrow(/must start flat/);
  });
});

describe("paper worker on the draft ledger", () => {
  it("processes only closed candles, reconciles cash and stores every signal, fill and settlement", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    const openCandle = { t: END + TF * 2, o: 100, h: 100, l: 100, c: 100, v: 5 }; // still forming at "now"
    const r = await processPaperStrategy(store(), await row(id), feed([...CANDLES, openCandle]), Date.now());
    expect(r.outcome).toBe("committed");
    expect(await count("paper_bars", `paper_strategy_id='${id}'`)).toBe(N - 60 < 30 ? N - 60 : 30);
    const r2 = await processPaperStrategy(store(), await row(id), feed([...CANDLES, openCandle]), Date.now());
    expect(r2.committed).toBe(N - 60 - 30);
    expect(await count("paper_bars", `paper_strategy_id='${id}' AND bar_t >= ${openCandle.t}`)).toBe(0);
    const s = await row(id);
    expect(Number(s.cursor_t)).toBe(END);
    const trades = (await db.query<{ net_pnl: string; gross_pnl: string; fees: string }>(`SELECT net_pnl, gross_pnl, fees FROM public.paper_trades WHERE paper_strategy_id='${id}'`)).rows;
    expect(trades.length).toBeGreaterThan(2);
    expect(reconcilePaper(1000, s.state, trades.map((t) => ({ net_pnl: Number(t.net_pnl) })))).toBeLessThan(1e-6);
    expect(Math.abs(Number(s.cash) - s.state.cash)).toBeLessThan(1e-9);
    expect(await count("paper_order_events", `paper_strategy_id='${id}' AND event='partially_filled'`)).toBeGreaterThan(0); // volume 5 × 50%
    expect(await count("paper_order_events", `paper_strategy_id='${id}' AND NOT simulated`)).toBe(0);
  });
  it("a crash before commit loses nothing and recovery reproduces the uninterrupted ledger", async () => {
    const steady = await newStrategy(A, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 100 } });
    const crashy = await newStrategy(B, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 100 } });
    for (let k = 0; k < 2; k++) await processPaperStrategy(store(), await row(steady), feed(), Date.now());
    const crashed = await processPaperStrategy(store({ failAfter: 7 }), await row(crashy), feed(), Date.now());
    expect(crashed.outcome).toBe("commit_failed");
    expect(Number((await row(crashy)).cursor_t)).toBe(START + (59 + 7) * TF);
    for (let k = 0; k < 2; k++) await processPaperStrategy(store(), await row(crashy), feed(), Date.now());
    const norm = async (id: string) => (await db.query(`SELECT bar_t, seq, event, intent, kind, side, qty::text, price::text, fee::text, cash_delta::text FROM public.paper_order_events WHERE paper_strategy_id='${id}' ORDER BY bar_t, seq`)).rows;
    expect(await norm(crashy)).toEqual(await norm(steady));
    expect((await row(crashy)).cash).toBe((await row(steady)).cash);
  });
  it("two workers on the same strategy commit each candle exactly once", async () => {
    const id = await newStrategy(A, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 50 } });
    const s = await row(id);
    const results = await Promise.all([processPaperStrategy(store(), s, feed(), Date.now()), processPaperStrategy(store(), s, feed(), Date.now())]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["committed", "cursor_conflict"]);
    expect(await count("paper_bars", `paper_strategy_id='${id}'`)).toBe(30);
    expect((await db.query(`SELECT bar_t FROM public.paper_bars WHERE paper_strategy_id='${id}' GROUP BY bar_t HAVING count(*) > 1`)).rows).toHaveLength(0);
  });
  it("a market-data outage or stale feed changes nothing", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    const before = await row(id);
    const out = await processPaperStrategy(store(), before, async () => { throw new Error("HTTP 503"); }, Date.now());
    expect(out.outcome).toBe("data_outage");
    const stale = await processPaperStrategy(store(), before, feed(CANDLES.slice(0, 60)), Date.now());
    expect(stale.outcome).toBe("stale");
    const after = await row(id);
    expect(after.cursor_t).toBe(before.cursor_t);
    expect(await count("paper_bars", `paper_strategy_id='${id}'`)).toBe(0);
    expect((after as unknown as { data_status: string }).data_status).toMatch(/stale/);
  });
  it("a missing candle pauses the strategy instead of filling across the gap", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    const gapped = CANDLES.filter((_, k) => k !== 61);
    const r = await processPaperStrategy(store(), await row(id), feed(gapped), Date.now());
    expect(r.outcome).toBe("committed"); expect(r.committed).toBe(1); // candle 60 only
    const g = await processPaperStrategy(store(), await row(id), feed(gapped), Date.now());
    expect(g.outcome).toBe("data_gap");
    const s = await row(id);
    expect(s.status).toBe("paused"); expect(s.status_reason).toMatch(/missing/);
  });
  it("the database refuses replays, skipped candles, unclosed candles and unreconciled cash", async () => {
    const id = await newStrategy(A, START + 59 * TF);
    const s = await row(id);
    const bar = (t: number, cash = 1000) => ({ bar: { bar_t: t, candle: {}, signal: "none", decision: {}, cash, equity: cash, position_qty: 0, unrealized: 0, open_exposure: 0, open_positions: 0, day_utc: "2026-01-01", day_net: 0 }, events: [], trades: [], state: { ...s.state, cash }, data_fetched_at: Date.now() });
    const commit = (expected: number, p: unknown) => as("service_role", null, `SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [id, expected, JSON.stringify(p)]);
    await expect(commit(START + 59 * TF, bar(START + 61 * TF))).rejects.toThrow(/out_of_sequence/);
    await expect(commit(START + 59 * TF, bar(START + 60 * TF, 1200))).rejects.toThrow(/cash_mismatch/);
    await commit(START + 59 * TF, bar(START + 60 * TF));
    await expect(commit(START + 59 * TF, bar(START + 60 * TF))).rejects.toThrow(/cursor_conflict/);
    expect(await count("paper_bars", `paper_strategy_id='${id}'`)).toBe(1);
    const live = await newStrategy(A, Math.floor(Date.now() / TF) * TF - TF);
    const lv = await row(live);
    await expect(as("service_role", null, `SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [live, Number(lv.cursor_t), JSON.stringify({ ...bar(Number(lv.cursor_t) + TF), state: lv.state })])).rejects.toThrow(/not_closed/);
  });
  it("entry fills are refused while halted or above account limits; exits still settle", async () => {
    const id = await newStrategy(B, START + 59 * TF);
    const s = await row(id);
    const entry = { bar: { bar_t: START + 60 * TF, candle: {}, signal: "none", decision: {}, cash: 700, equity: 1000, position_qty: 3, unrealized: 0, open_exposure: 300, open_positions: 1, day_utc: "2026-01-01", day_net: 0 }, events: [{ order_key: "k", seq: 0, event: "filled", intent: "entry", kind: "market", side: "buy", qty: 3, price: 100, fee: 0, spread_cost: 0, slippage_cost: 0, cash_delta: -300, reason: "" }], trades: [], state: { ...s.state, cash: 700 }, data_fetched_at: Date.now() };
    await db.exec(`UPDATE public.paper_accounts SET halted=true WHERE user_id='${B}'`);
    await expect(as("service_role", null, `SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [id, START + 59 * TF, JSON.stringify(entry)])).rejects.toThrow(/entry_blocked/);
    await db.exec(`UPDATE public.paper_accounts SET halted=false, max_exposure=200 WHERE user_id='${B}'`);
    await expect(as("service_role", null, `SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [id, START + 59 * TF, JSON.stringify(entry)])).rejects.toThrow(/risk_conflict: account exposure/);
    await db.exec(`UPDATE public.paper_accounts SET max_exposure=1000 WHERE user_id='${B}'`);
  });
  it("the emergency paper stop flattens the position at the next open and blocks every later entry", async () => {
    const id = await newStrategy(B, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 20 } });
    await processPaperStrategy(store(), await row(id), feed(CANDLES.slice(0, 62)), Date.now());
    expect((await row(id)).open_positions).toBe(1);
    // Test-only, as the table owner: date the stop to 64h after START so recorded candles straddle it.
    await db.exec(`ALTER TABLE public.paper_accounts DISABLE TRIGGER paper_accounts_guard; UPDATE public.paper_accounts SET halted=true, halt_reason='test', halted_at=to_timestamp(${(START + 64 * TF) / 1000}) WHERE user_id='${B}'; ALTER TABLE public.paper_accounts ENABLE TRIGGER paper_accounts_guard;`);
    const after = await count("paper_order_events", `paper_strategy_id='${id}'`);
    await processPaperStrategy(store(), await row(id), feed(), Date.now());
    const later = (await db.query<{ event: string; intent: string; reason: string }>(`SELECT event,intent,reason FROM public.paper_order_events WHERE paper_strategy_id='${id}' ORDER BY bar_t, seq OFFSET ${after}`)).rows;
    expect(later.filter((e) => e.intent === "entry" && /filled/.test(e.event))).toHaveLength(0);
    expect(later.some((e) => e.intent === "exit" && e.event === "filled" && e.reason === "emergency_stop")).toBe(true);
    const exitAt = (await db.query<{ bar_t: string }>(`SELECT bar_t FROM public.paper_order_events WHERE paper_strategy_id='${id}' AND reason='emergency_stop' AND event='filled'`)).rows[0]!;
    expect(Number(exitAt.bar_t)).toBe(START + 64 * TF); // first open at or after the stop, never earlier
    expect((await row(id)).open_positions).toBe(0);
    await db.exec(`UPDATE public.paper_accounts SET halted=false WHERE user_id='${B}'`);
  });
  it("owners see only their own paper ledger", async () => {
    const mine = await as<{ user_id: string }>("authenticated", A, `SELECT DISTINCT user_id FROM public.paper_bars`);
    expect(mine.rows.map((r) => r.user_id)).toEqual([A]);
    const theirs = await as<{ user_id: string }>("authenticated", B, `SELECT DISTINCT user_id FROM public.paper_strategies`);
    expect(theirs.rows.every((r) => r.user_id === B)).toBe(true);
  });
  it("a stopped strategy never restarts or commits, and cannot stop while holding a position", async () => {
    const id = await newStrategy(A, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 20 } });
    await processPaperStrategy(store(), await row(id), feed(CANDLES.slice(0, 62)), Date.now());
    expect((await row(id)).open_positions).toBe(1);
    await expect(as("service_role", null, `UPDATE public.paper_strategies SET status='stopped' WHERE id='${id}'`)).rejects.toThrow(/close the open paper position/);
    const flatId = await newStrategy(B, START + 59 * TF, { risk: { ...POLICY, maxPositionNotional: 20 } });
    await as("service_role", null, `UPDATE public.paper_strategies SET status='stopped' WHERE id='${flatId}'`);
    await expect(as("service_role", null, `UPDATE public.paper_strategies SET status='active' WHERE id='${flatId}'`)).rejects.toThrow(/cannot restart/);
    const ticks = await runPaperTick(store(), feed() as never, Date.now());
    expect(ticks.some((t) => t.id === flatId)).toBe(false);
  });
  it("history is append-only for every role, including the table owner", async () => {
    await expect(db.exec(`UPDATE public.paper_trades SET net_pnl = 0`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.paper_order_events`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.paper_bars`)).rejects.toThrow(/append-only/);
    await expect(as("service_role", null, `UPDATE public.paper_bars SET equity = 0`)).rejects.toThrow(/permission denied/);
  });
  it("the rollback removes every paper object and leaves nothing behind", async () => {
    const tmp = new PGlite(); await tmp.exec(STUB); await tmp.exec(MIGRATION); await tmp.exec(ROLLBACK);
    const left = await tmp.query(`SELECT relname FROM pg_class WHERE relname LIKE 'paper_%' UNION ALL SELECT proname FROM pg_proc WHERE proname LIKE '%paper%'`);
    expect(left.rows).toHaveLength(0);
  });
});
