// Genuine multi-session concurrency tests for DRAFT migration 0044 (forward paper ledger). Needs a real PostgreSQL with
// separate sessions: run scripts/paper/concurrency-check.sh, which starts a throwaway local server. Skipped when
// PAPER_PG_URL is not set. Never touches the live database. Drives the real paper worker (paper.server.ts) and the
// commit function from separate connections, and checks that no order, fill, position or settlement is ever duplicated.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialPaperState, reconcilePaper, utcDay, PAPER_ENGINE_VERSION, type PaperState } from "@/lib/paper-engine";
import { processPaperStrategy, runPaperTick, type PaperCommitPayload, type PaperStore, type PaperStrategyRow } from "@/lib/paper.server";
import type { Candle } from "@/lib/indicators";

const URL = process.env["PAPER_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0044_forward_paper_trading.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;
// jsonb parameters are passed as objects: postgres.js serializes them itself.
// Test-only invariant monitor (not part of 0044): after every ledger change, record any account whose committed
// paper exposure or open positions exceed its limits. The migration must never let one through.
const MONITOR = `CREATE TABLE public.test_violations (user_id uuid, what text, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.test_monitor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a public.paper_accounts%ROWTYPE; e numeric; p integer; BEGIN
  SELECT * INTO a FROM public.paper_accounts WHERE user_id = NEW.user_id;
  SELECT sum(open_exposure), sum(open_positions) INTO e, p FROM public.paper_strategies WHERE user_id = NEW.user_id;
  IF e > a.max_exposure + 0.000001 THEN INSERT INTO public.test_violations(user_id, what) VALUES (NEW.user_id, 'exposure ' || e); END IF;
  IF p > a.max_open_positions THEN INSERT INTO public.test_violations(user_id, what) VALUES (NEW.user_id, 'positions ' || p); END IF;
  RETURN NULL; END $$;
CREATE TRIGGER test_monitor AFTER UPDATE ON public.paper_strategies FOR EACH ROW EXECUTE FUNCTION public.test_monitor();`;

const TF = 3_600_000;
const CFG = { pairs: ["BTC/USDT"], timeframe: "1h", indicators: [], entry: { logic: "all", conditions: [{ left: "price", operator: ">", right: "0" }] }, exit: { logic: "any", conditions: [] }, risk: { stop_loss_pct: 2, take_profit_pct: 4, trailing_stop_pct: null, position_size_pct: 50, capital_allocation: 1000, max_open_positions: 1, daily_loss_limit_pct: 5 } };
const COSTS = { feePct: 0.1, spreadPct: 0.02, slippagePct: 0.05, maxParticipationPct: 50 };
const POLICY = { riskPerTradePct: 1, positionSizePct: 50, maxPositionNotional: 300, stopLossPct: 2, takeProfitPct: 4, dailyLossLimit: 100, strategyBudget: 1000, entryOrder: "market", limitOffsetPct: 0, orderTtlBars: 3 };
const END = Math.floor(Date.now() / TF) * TF - 2 * TF;
const N = 110, START = END - (N - 1) * TF, CURSOR = START + 59 * TF;
const CANDLES: Candle[] = (() => {
  const out: Candle[] = []; let prev = 100;
  for (let k = 0; k < N; k++) { const c = 100 + 6 * Math.sin(k / 3); const o = prev; out.push({ t: START + k * TF, o, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.6, c, v: 5 }); prev = c; }
  return out;
})();
const BIG = { max_exposure: 1_000_000, max_daily_loss: 1_000_000, max_open_positions: 50, max_position_notional: 1_000_000 };
const id = (p: string, n: number) => `00000000-0000-4000-${p}-${String(n).padStart(12, "0")}`;
const UA = id("8a01", 1), UB = id("8a01", 2);

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!);
  const name = `paper_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`);
  const owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(MIGRATION); await owner.unsafe(MONITOR);
  return { url, owner };
}
/** A backend (service_role) session. */
async function backend(url: string) { const s = connect(url); await s.unsafe("SET ROLE service_role"); return s; }

/** Creates the account (if new) and a strategy the way the backend does; then, test-only as the table owner, moves the
 *  cursor into the past so recorded candles can be replayed. Fixed ids keep order/position keys comparable across databases. */
async function strategy(owner: Sql, url: string, user: string, sid: string, limits: Record<string, number> = BIG, cursor = CURSOR) {
  const b = await backend(url);
  const cols = Object.keys(limits);
  await b.unsafe(`INSERT INTO public.paper_accounts(user_id,${cols.join(",")}) VALUES ($1,${cols.map((_, i) => `$${i + 2}`).join(",")}) ON CONFLICT DO NOTHING`, [user, ...Object.values(limits)]);
  await b.unsafe(`INSERT INTO public.paper_strategies(id,user_id,strategy_id,strategy_name,config,engine_version,data_source,pair,timeframe,costs,risk,starting_capital,state)
    VALUES ($1,$2,gen_random_uuid(),'Wave test',$3::jsonb,$4,'binance-public-spot-klines','BTC/USDT','1h',$5::jsonb,$6::jsonb,1000,$7::jsonb)`,
    [sid, user, CFG, PAPER_ENGINE_VERSION, COSTS, POLICY, initialPaperState(1000)] as never[]);
  await owner.unsafe(`SELECT set_config('paper.commit','on',false)`);
  await owner.unsafe(`UPDATE public.paper_strategies SET cursor_t=${cursor} WHERE id='${sid}'`);
  await owner.unsafe(`SELECT set_config('paper.commit','off',false)`);
}

/** The production store's queries, over one real backend session. Optional barrier after reading the account. */
function store(s: Sql, o: { afterAccount?: () => Promise<void>; commit?: (id: string, expected: number, p: PaperCommitPayload) => Promise<void>; only?: string[] } = {}): PaperStore {
  return {
    async listRunnable() {
      const rows = await s.unsafe(`SELECT id,user_id,config,costs,risk,pair,timeframe,tf_ms,status,cursor_t,state FROM public.paper_strategies WHERE status IN ('active','paused') ORDER BY last_checked_at NULLS FIRST, id`);
      return (rows as unknown as PaperStrategyRow[]).filter((r) => !o.only || o.only.includes(r.id));
    },
    async account(u) {
      const a = await s.unsafe(`SELECT * FROM public.paper_accounts WHERE user_id=$1`, [u]);
      const p = await s.unsafe(`SELECT id,open_exposure,open_positions,to_char(day_utc,'YYYY-MM-DD') day_utc,day_net FROM public.paper_strategies WHERE user_id=$1 AND status<>'stopped'`, [u]);
      if (o.afterAccount) await o.afterAccount();
      return { account: a[0] as never, peers: p as never };
    },
    async hasPro() { return true; },
    async commit(id, expected, payload) {
      if (o.commit) return o.commit(id, expected, payload);
      await s.unsafe(`SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [id, expected, payload as never]);
    },
    async mark(id, f) { await s.unsafe(`UPDATE public.paper_strategies SET data_status=$2, status=coalesce($3,status), status_reason=coalesce($4,status_reason), last_checked_at=now() WHERE id=$1 AND status<>'stopped'`, [id, f.data_status, f.status ?? null, f.status_reason ?? null]); },
  };
}
const feed = async () => ({ candles: CANDLES, fetchedAt: Date.now() });
const barrier = (n: number) => { let c = 0; let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return async () => { if (++c >= n) open(); await p; }; };
async function untilUpToDate(run: () => Promise<{ outcome: string }[]>, max = 20) {
  const seen: string[] = [];
  for (let k = 0; k < max; k++) { const r = await run(); seen.push(...r.map((x) => x.outcome)); if (r.every((x) => x.outcome === "up_to_date")) return seen; }
  throw new Error(`not up to date after ${max} ticks: ${seen.join(",")}`);
}

/** Ledger contents that must not depend on worker timing (sizing caps that mention peers are excluded). */
async function fingerprint(owner: Sql, sid: string) {
  const q = (sql: string) => owner.unsafe(sql, [sid]).then((r) => JSON.stringify(r));
  return [
    await q(`SELECT bar_t, signal, cash, equity, position_qty, unrealized FROM public.paper_bars WHERE paper_strategy_id=$1 ORDER BY bar_t`),
    await q(`SELECT bar_t, seq, order_key, event, intent, kind, side, qty, price, fee, spread_cost, slippage_cost, cash_delta, reason FROM public.paper_order_events WHERE paper_strategy_id=$1 ORDER BY bar_t, seq`),
    await q(`SELECT position_key, opened_bar_t, closed_bar_t, qty, avg_entry, avg_exit, gross_pnl, fees, net_pnl, close_reason FROM public.paper_trades WHERE paper_strategy_id=$1 ORDER BY closed_bar_t`),
    await q(`SELECT cursor_t, state, cash, equity, open_exposure, open_positions, day_net FROM public.paper_strategies WHERE id=$1`),
  ].join("\n");
}
/** No duplicate candle, order, fill, position or settlement; cash reconciles; nothing exceeded account limits. */
async function integrity(owner: Sql) {
  const one = async (sql: string) => Number(Object.values((await owner.unsafe(sql))[0]!)[0]);
  expect(await one(`SELECT count(*) - count(DISTINCT (paper_strategy_id, bar_t)) FROM public.paper_bars`)).toBe(0);
  expect(await one(`SELECT count(*) FROM (SELECT paper_strategy_id, max(bar_t)-min(bar_t) span, count(*) n, max(s.tf_ms) tf FROM public.paper_bars JOIN public.paper_strategies s ON s.id=paper_strategy_id GROUP BY 1) x WHERE span <> (n-1)*tf`)).toBe(0);
  expect(await one(`SELECT count(*) FROM (SELECT order_key FROM public.paper_order_events WHERE event='created' GROUP BY 1 HAVING count(*)>1) x`)).toBe(0);
  expect(await one(`SELECT count(*) FROM (SELECT f.order_key FROM public.paper_order_events f JOIN public.paper_order_events c ON c.order_key=f.order_key AND c.event='created'
    WHERE f.event IN ('filled','partially_filled') GROUP BY f.order_key, c.qty HAVING sum(f.qty) > c.qty + 0.00000001) x`)).toBe(0);
  expect(await one(`SELECT count(*) - count(DISTINCT position_key) FROM public.paper_trades`)).toBe(0);
  expect(await one(`SELECT count(*) FROM public.paper_order_events e JOIN public.paper_strategies s ON s.id=e.paper_strategy_id WHERE e.user_id<>s.user_id`)).toBe(0);
  expect(await one(`SELECT count(*) FROM public.paper_bars b JOIN public.paper_strategies s ON s.id=b.paper_strategy_id WHERE b.user_id<>s.user_id`)).toBe(0);
  expect(await one(`SELECT count(*) FROM public.test_violations`)).toBe(0);
  for (const s of await owner.unsafe(`SELECT id, state, starting_capital FROM public.paper_strategies`)) {
    const trades = await owner.unsafe(`SELECT net_pnl FROM public.paper_trades WHERE paper_strategy_id=$1`, [s["id"]]);
    expect(reconcilePaper(Number(s["starting_capital"]), s["state"] as PaperState, trades.map((t) => ({ net_pnl: Number(t["net_pnl"]) })))).toBeLessThan(1e-6);
  }
}
/** Reference: the same strategies processed by one worker, alone, in a separate database. */
async function reference(users: [string, string[]][]) {
  const { url, owner } = await freshDb();
  for (const [u, sids] of users) for (const sid of sids) await strategy(owner, url, u, sid);
  const s = await backend(url);
  await untilUpToDate(() => runPaperTick(store(s), feed));
  return owner;
}
const S = (n: number) => id("9a01", n);

/** A minimal valid payload for the next candle of a strategy, with one simulated fill (crafted; DB-level tests only). */
function payload(barT: number, startCash: number, f: { intent: "entry" | "exit"; notional: number; dayNet: number }): PaperCommitPayload {
  const delta = f.intent === "entry" ? -f.notional : f.notional;
  const cash = startCash + delta;
  return {
    bar: { bar_t: barT, candle: { o: 100, h: 100, l: 100, c: 100, v: 10 }, signal: "none", decision: {}, cash, equity: cash + (f.intent === "entry" ? f.notional : 0), position_qty: f.intent === "entry" ? f.notional / 100 : 0, unrealized: 0,
      open_exposure: f.intent === "entry" ? f.notional : 0, open_positions: f.intent === "entry" ? 1 : 0, day_utc: utcDay(barT), day_net: f.dayNet },
    events: [{ order_key: `x:${barT}:${f.intent}`, seq: 0, event: "filled", intent: f.intent, kind: "market", side: f.intent === "entry" ? "buy" : "sell", qty: f.notional / 100, price: 100, fee: 0, spread_cost: 0, slippage_cost: 0, cash_delta: delta, reason: "crafted" }],
    trades: [], state: { ...initialPaperState(1000), cash }, data_fetched_at: Date.now(),
  } as unknown as PaperCommitPayload;
}
const commitSql = (sid: string, cursor: number, p: PaperCommitPayload) => [`SELECT public.paper_commit_bar($1,$2,$3::jsonb) AS r`, [sid, cursor, p as never]] as const;
const isWaitingOnLock = async (owner: Sql) => Number((await owner.unsafe(`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`))[0]!["n"]) > 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL)("draft 0044 under genuinely concurrent database sessions", () => {
  it("two workers processing the same account at once: every candle once, ledger identical to a single worker", async () => {
    const { url, owner } = await freshDb();
    await strategy(owner, url, UA, S(1)); await strategy(owner, url, UA, S(2));
    const [w1, w2] = [await backend(url), await backend(url)];
    const seen = await untilUpToDate(async () => (await Promise.all([runPaperTick(store(w1), feed), runPaperTick(store(w2), feed)])).flat());
    expect(seen).toContain("cursor_conflict"); // the race really happened and lost cleanly
    await integrity(owner);
    expect(Number((await owner.unsafe(`SELECT count(*) n FROM public.paper_bars`))[0]!["n"])).toBe(2 * (N - 60));
    const ref = await reference([[UA, [S(1), S(2)]]]);
    for (const sid of [S(1), S(2)]) expect(await fingerprint(owner, sid)).toBe(await fingerprint(ref, sid));
    expect(Number((await owner.unsafe(`SELECT count(*) n FROM public.paper_trades`))[0]!["n"])).toBeGreaterThan(2);
  }, 120_000);

  it("duplicate candle: 12 sessions commit the same candle, exactly one succeeds", async () => {
    const { url, owner } = await freshDb();
    await strategy(owner, url, UA, S(3));
    let captured: PaperCommitPayload | null = null;
    const w = await backend(url);
    await processPaperStrategy(store(w, { commit: async (_i, _e, p) => { captured = p; throw new Error("captured"); } }), (await store(w).listRunnable())[0]!, feed, Date.now());
    const ss = await Promise.all(Array.from({ length: 12 }, () => backend(url)));
    const out = await Promise.allSettled(ss.map((s) => s.unsafe(...commitSql(S(3), CURSOR, captured!) as unknown as [string, never[]])));
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(out.filter((r) => r.status === "rejected").every((r) => /paper_cursor_conflict/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    expect(Number((await owner.unsafe(`SELECT count(*) n FROM public.paper_bars`))[0]!["n"])).toBe(1);
    expect(Number((await owner.unsafe(`SELECT count(*) n FROM public.paper_order_events`))[0]!["n"])).toBe(captured!.events.length);
  }, 60_000);

  it("two strategies competing for the same exposure: the database refuses the stale one, it recovers, limits never exceeded", async () => {
    const { url, owner } = await freshDb();
    const limits = { ...BIG, max_exposure: 400 };
    await strategy(owner, url, UA, S(4), limits); await strategy(owner, url, UA, S(5), limits);
    // Flat prices: whichever strategy gets in holds its position, so the other one must fit the remaining room.
    const flatFeed = async () => ({ candles: CANDLES.map((c) => ({ ...c, o: 100, h: 100, l: 100, c: 100, v: 1000 })), fetchedAt: Date.now() });
    const [w1, w2] = [await backend(url), await backend(url)];
    const both = barrier(2); // each worker reads the account before either commits: both size against 0 exposure
    const [r1, r2] = await Promise.all([
      runPaperTick(store(w1, { afterAccount: both, only: [S(4)] }), flatFeed), runPaperTick(store(w2, { afterAccount: both, only: [S(5)] }), flatFeed),
    ]);
    expect([...r1, ...r2].map((x) => x.outcome)).toContain("risk_recheck");
    // Recovery: the refused candle is recomputed with the fresh account view and the entry is resized at fill — never stuck.
    await untilUpToDate(async () => (await Promise.all([runPaperTick(store(w1, { only: [S(4)] }), flatFeed), runPaperTick(store(w2, { only: [S(5)] }), flatFeed)])).flat());
    const rows = await owner.unsafe(`SELECT cursor_t, open_exposure FROM public.paper_strategies ORDER BY open_exposure DESC`);
    expect(rows.map((r) => Number(r["cursor_t"]))).toEqual([END, END]);
    expect(Number(rows[0]!["open_exposure"])).toBeCloseTo(300, 0);
    expect(Number(rows[1]!["open_exposure"])).toBeGreaterThan(99);
    expect(Number(rows[0]!["open_exposure"]) + Number(rows[1]!["open_exposure"])).toBeLessThanOrEqual(400.000001);
    await integrity(owner);
  }, 120_000);

  it("concurrent entry near the daily loss limit: an entry committed after the loss is refused, one committed before it stands", async () => {
    const { url, owner } = await freshDb();
    const limits = { ...BIG, max_daily_loss: 50 };
    const C = END - 10 * TF, bt = C + TF;
    await strategy(owner, url, UA, S(6), limits, C); await strategy(owner, url, UA, S(7), limits, C);
    const [a, b] = [await backend(url), await backend(url)];
    // Loss first: S6 realizes -60 inside an open transaction; S7's entry waits on the account lock, then sees the loss.
    const tx = await a.reserve(); await tx.unsafe("BEGIN"); await tx.unsafe("SET LOCAL ROLE service_role");
    await tx.unsafe(...commitSql(S(6), C, payload(bt, 1000, { intent: "exit", notional: 240, dayNet: -60 })) as unknown as [string, never[]]);
    const entry = b.unsafe(...commitSql(S(7), C, payload(bt, 1000, { intent: "entry", notional: 100, dayNet: 0 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e));
    await sleep(400); expect(await isWaitingOnLock(owner)).toBe(true);
    await tx.unsafe("COMMIT"); tx.release();
    expect(await entry).toMatch(/paper_risk_conflict: daily loss/);
    // Opposite order, on a fresh database: the entry holds the account lock, the loss waits; both stand (a valid serial order).
    const { url: url2, owner: owner2 } = await freshDb();
    await strategy(owner2, url2, UA, S(6), limits, C); await strategy(owner2, url2, UA, S(7), limits, C);
    const [c, d] = [await backend(url2), await backend(url2)];
    const tx2 = await c.reserve(); await tx2.unsafe("BEGIN"); await tx2.unsafe("SET LOCAL ROLE service_role");
    await tx2.unsafe(...commitSql(S(7), C, payload(bt, 1000, { intent: "entry", notional: 100, dayNet: 0 })) as unknown as [string, never[]]);
    const loss = d.unsafe(...commitSql(S(6), C, payload(bt, 1000, { intent: "exit", notional: 240, dayNet: -60 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e));
    await sleep(400); expect(await isWaitingOnLock(owner2)).toBe(true);
    await tx2.unsafe("COMMIT"); tx2.release();
    expect(await loss).toBe("ok");
    expect(Number((await owner2.unsafe(`SELECT count(*) n FROM public.paper_bars`))[0]!["n"])).toBe(2);
    // After the loss, any further entry that day is refused.
    expect(await c.unsafe(...commitSql(S(7), bt, payload(bt + TF, 900, { intent: "entry", notional: 50, dayNet: 0 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e)))
      .toMatch(utcDay(bt) === utcDay(bt + TF) ? /daily loss/ : /ok/);
  }, 60_000);

  it("emergency paper stop during an active candle: the stop waits for the candle, later entries are refused; a stop first refuses the entry", async () => {
    const { url, owner } = await freshDb();
    const C = END - 10 * TF, bt = C + TF;
    await strategy(owner, url, UA, S(9), BIG, C);
    const [w, ops] = [await backend(url), await backend(url)];
    const tx = await w.reserve(); await tx.unsafe("BEGIN"); await tx.unsafe("SET LOCAL ROLE service_role");
    await tx.unsafe(...commitSql(S(9), C, payload(bt, 1000, { intent: "entry", notional: 100, dayNet: 0 })) as unknown as [string, never[]]);
    const stop = ops.unsafe(`UPDATE public.paper_accounts SET halted=true, halt_reason='test' WHERE user_id=$1 RETURNING halted_at`, [UA]).then((r) => r[0]!["halted_at"] as Date);
    await sleep(400); expect(await isWaitingOnLock(owner)).toBe(true);
    const committedAt = new Date(); await tx.unsafe("COMMIT"); tx.release();
    const haltedAt = await stop;
    expect(haltedAt.getTime()).toBeGreaterThanOrEqual(committedAt.getTime() - 1000);
    // A worker that read the account before the stop still cannot fill a new entry.
    expect(await w.unsafe(...commitSql(S(9), bt, payload(bt + TF, 900, { intent: "entry", notional: 50, dayNet: 0 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e))).toMatch(/paper_entry_blocked/);
    // Exits stay possible while stopped.
    expect(await w.unsafe(...commitSql(S(9), bt, payload(bt + TF, 900, { intent: "exit", notional: 100, dayNet: 0 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e))).toBe("ok");
    // Reverse order: the stop holds the account row; an entry waits, then is refused.
    const { url: u2, owner: o2 } = await freshDb();
    await strategy(o2, u2, UA, S(9), BIG, C);
    const [w2, ops2] = [await backend(u2), await backend(u2)];
    const t2 = await ops2.reserve(); await t2.unsafe("BEGIN"); await t2.unsafe("SET LOCAL ROLE service_role");
    await t2.unsafe(`UPDATE public.paper_accounts SET halted=true WHERE user_id=$1`, [UA]);
    const late = w2.unsafe(...commitSql(S(9), C, payload(bt, 1000, { intent: "entry", notional: 100, dayNet: 0 })) as unknown as [string, never[]]).then(() => "ok", (e) => String(e));
    await sleep(400); expect(await isWaitingOnLock(o2)).toBe(true);
    await t2.unsafe("COMMIT"); t2.release();
    expect(await late).toMatch(/paper_entry_blocked/);
    expect(Number((await o2.unsafe(`SELECT count(*) n FROM public.paper_order_events`))[0]!["n"])).toBe(0);
  }, 60_000);

  it("worker crash mid-commit (connection killed): nothing partial is stored; recovery equals an uninterrupted run", async () => {
    const { url, owner } = await freshDb();
    await strategy(owner, url, UA, S(10));
    const w = await backend(url);
    const victim = connect(url); await victim.unsafe("SELECT 1");
    const pid = Number((await victim.unsafe(`SELECT pg_backend_pid() p`))[0]!["p"]);
    let commits = 0;
    const crashing = store(w, { commit: async (sid, expected, p) => {
      if (commits++ < 7) { await w.unsafe(`SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [sid, expected, p as never]); return; }
      await victim.unsafe("BEGIN"); await victim.unsafe("SET LOCAL ROLE service_role");
      await victim.unsafe(`SELECT public.paper_commit_bar($1,$2,$3::jsonb)`, [sid, expected, p as never]);
      await owner.unsafe(`SELECT pg_terminate_backend(${pid})`); // the worker dies before COMMIT
      throw new Error("worker crashed");
    } });
    const r = await runPaperTick(crashing, feed);
    expect(r[0]!.committed).toBe(7);
    expect(Number((await owner.unsafe(`SELECT count(*) n FROM public.paper_bars`))[0]!["n"])).toBe(7);
    expect(Number((await owner.unsafe(`SELECT cursor_t FROM public.paper_strategies`))[0]!["cursor_t"])).toBe(CURSOR + 7 * TF);
    const fresh = await backend(url);
    await untilUpToDate(() => runPaperTick(store(fresh), feed));
    await integrity(owner);
    const ref = await reference([[UA, [S(10)]]]);
    expect(await fingerprint(owner, S(10))).toBe(await fingerprint(ref, S(10)));
  }, 120_000);

  it("two users processed simultaneously by separate workers: separate ledgers, identical to running each alone", async () => {
    const { url, owner } = await freshDb();
    for (const [u, base] of [[UA, 11], [UB, 21]] as const) { await strategy(owner, url, u, S(base)); await strategy(owner, url, u, S(base + 1)); }
    const ws = await Promise.all([0, 1, 2, 3].map(() => backend(url)));
    await untilUpToDate(async () => (await Promise.all(ws.map((w) => runPaperTick(store(w), feed)))).flat());
    await integrity(owner);
    const ref = await reference([[UA, [S(11), S(12)]], [UB, [S(21), S(22)]]]);
    for (const sid of [S(11), S(12), S(21), S(22)]) expect(await fingerprint(owner, sid)).toBe(await fingerprint(ref, sid));
    // A signed-in owner sees only their own rows.
    const viewer = connect(url);
    await viewer.unsafe(`SET ROLE authenticated`); await viewer.unsafe(`SELECT set_config('test.uid','${UA}',false)`);
    const users = (await viewer.unsafe(`SELECT DISTINCT user_id FROM public.paper_order_events`)).map((r) => r["user_id"]);
    expect(users).toEqual([UA]);
  }, 180_000);
});
