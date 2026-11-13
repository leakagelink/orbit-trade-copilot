// Phase 4H — DRAFT 0051 (G2 event completeness) over drafts 0049 + 0050 in PGlite; nothing is applied anywhere real.
// The three Phase 4G G2 characterization cases are re-run here and must now be REFUSED (except the control, which 0049
// already refused), followed by adversarial cases: gaps through stops, stop+target in one candle, fabricated exits,
// liquidation precedence, time limits, partial positions, funding timestamps/missing/duplicate/off-grid rates, skipped
// candles, ambiguous touches, altered protection terms, replay/idempotency, atomic rollback and privileges.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { FPBar, FPConfig, FPIntent } from "@/lib/futures-paper-engine";
import { CFG, M, accountBudget, freshUser, loadView, newAccount, stepView, strategyBudget } from "./helpers/fp-v3-harness";
import { callFn, HOLDER_A } from "./helpers/fp-gateway-harness";
import { H8, ROLLBACK_0051, MIGRATION_0051, asRole, commitV4, gridAt, makeCompletenessDb, quietT0 } from "./helpers/fp-v4-harness";

let db: PGlite;
beforeAll(async () => { db = await makeCompletenessDb(); }, 120_000);
type OHLC = [number, number, number, number];
const QUIET: Record<string, OHLC> = { BTCUSDT: [100, 100.3, 99.8, 100.05], ETHUSDT: [50, 50.2, 49.9, 50.1] };
const ADJ = 0.01 / 200 + 0.01 / 100; // CFG spread/2 + slippage
function bar(s: string, t: number, tr: OHLC = QUIET[s]!, o: { mark?: OHLC; v?: number | undefined; funding?: { t: number; rate: number }[] } = {}): FPBar {
  const m = o.mark ?? tr;
  return { symbol: s, t, tfMs: M, trade: { o: tr[0], h: tr[1], l: tr[2], c: tr[3], v: o.v ?? 1e6 }, mark: { o: m[0], h: m[1], l: m[2], c: m[3] }, index: { c: m[3] }, funding: o.funding ?? (t % H8 === 0 ? [{ t, rate: 0.0001 }] : []) };
}
type Payload = { candles: Record<string, { trade: { o: number; h: number; l: number; c: number }; mark: { o: number; h: number; l: number; c: number }; funding: { t: number; rate: number }[] }>; state: { positions: Record<string, Record<string, unknown>>; pending: Record<string, Record<string, unknown>> }; events: { kind: string }[] };
const record = (p: unknown, s: string, b: FPBar) => { const c = (p as Payload).candles[s]!; c.trade = { ...b.trade }; c.mark = { ...b.mark! }; c.funding = b.funding.map((f) => ({ ...f })); return p; };
const n = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: number }>(sql, p)).rows[0]!.n);

interface Acct { id: string; user: string; t: number }
/** Opens a BTCUSDT LONG: accept at `t0`, fill at `t0 + M` (stop 99, target 103 from the mark close, maxHold). */
async function openLong(t0: number, o: { cfg?: FPConfig; maxHoldBars?: number; v?: number; tp?: number | null } = {}): Promise<Acct> {
  const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
  const id = await newAccount(db, user, t0 - M, o.cfg ?? CFG);
  const long: FPIntent = { maxHoldBars: o.maxHoldBars ?? 30, proposal: { proposalId: `c51-${id.slice(-8)}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: o.tp === undefined ? 103 : o.tp, createdAt: t0 + M } };
  const a = { id, user, t: t0 };
  await step(a, {}, [long]);
  await step(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: o.v }) });
  expect(await n(`SELECT count(*)::int n FROM public.futures_paper_positions WHERE account_id=$1`, [id])).toBe(1);
  return a;
}
/** Engine step for the account's next candle (`fed` = what the engine sees), optionally recorded differently, then commit. */
async function attempt(a: Acct, fed: Record<string, FPBar> = {}, intents: FPIntent[] = [], o: { recorded?: Record<string, FPBar>; mutate?: (p: Payload, s: ReturnType<typeof stepView>) => void; prep?: (v: Awaited<ReturnType<typeof loadView>>) => void } = {}) {
  const v = await loadView(db, a.id); o.prep?.(v);
  const bars = ["BTCUSDT", "ETHUSDT"].map((s) => fed[s] ?? bar(s, a.t));
  const s = stepView(v, bars, intents);
  for (const [sym, b] of Object.entries(o.recorded ?? {})) record(s.payload, sym, b);
  o.mutate?.(s.payload as unknown as Payload, s);
  return { v, s, run: () => commitV4(db, a.id, v.seq, a.t, s.payload) };
}
async function step(a: Acct, fed: Record<string, FPBar> = {}, intents: FPIntent[] = []) {
  const x = await attempt(a, fed, intents); const seq = await x.run(); a.t += M; return { ...x, seq };
}
const pos = async (id: string) => (await db.query<{ qty: string; entry_price: string; stop_dist: string; margin: string; leverage: number }>(`SELECT * FROM public.futures_paper_positions WHERE account_id=$1 AND symbol='BTCUSDT'`, [id])).rows[0];
const check = async (id: string, t: number) => (await db.query<{ outcome: string; qty: string; funding_required: number }>(`SELECT * FROM public.futures_paper_candle_checks WHERE account_id=$1 AND bar_t=$2 AND symbol='BTCUSDT'`, [id, t])).rows[0];
const stopOf = async (id: string) => { const p = (await pos(id))!; return Number(p.entry_price) - Number(p.stop_dist); };
const T = () => quietT0();

describe("G2 regressions from Phase 4G (now enforced)", () => {
  it("1. a recorded stop crossing with NO exit is refused; the engine's own exit then commits", async () => {
    const a = await openLong(T()), crossed = bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2]);
    const bad = await attempt(a, {}, [], { recorded: { BTCUSDT: crossed } });
    expect(bad.s.events.filter((e) => e.kind === "exit_fill")).toEqual([]);
    await expect(bad.run()).rejects.toThrow(/futures paper completeness: the recorded candle requires a exit_fill \(stop\) for BTCUSDT/);
    await step(a, { BTCUSDT: crossed });
    expect((await check(a.id, a.t - M))!.outcome).toBe("stop");
    expect(await pos(a.id)).toBeUndefined();
  });
  it("2. a recorded funding entry on a held position with NO funding event is refused", async () => {
    const G = gridAt(), a = await openLong(G - 3 * M); await step(a); // held through G - M
    const f = [{ t: G + 2, rate: 0.01 }];
    const bad = await attempt(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [] }) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: f }) } });
    await expect(bad.run()).rejects.toThrow(/0 funding event\(s\) for BTCUSDT but the recorded candle requires 1/);
    const ok = await step(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: f }) });
    expect(ok.s.events.filter((e) => e.kind === "funding")).toHaveLength(1);
    expect((await check(a.id, G))!.funding_required).toBe(1);
  });
  it("3. control: an exit outside the recorded candle range is still refused (0049's own check)", async () => {
    const a = await openLong(T());
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2]) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, [100, 100.3, 99.8, 100.05]) } });
    await expect(x.run()).rejects.toThrow(/exit price .* is outside the recorded candle/);
  });
});

describe("exits: the database derives the required outcome itself (conservative intrabar order)", () => {
  it("gap through the stop: the exit must be at the (worse) open, not at the stop", async () => {
    const a = await openLong(T());
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, [99.2, 99.3, 98.3, 98.6]) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, [98.5, 98.97, 98.3, 98.6]) } });
    await expect(x.run()).rejects.toThrow(/BTCUSDT close differs from the required exit_fill \(stop_open\)/);
    const ok = await step(a, { BTCUSDT: bar("BTCUSDT", a.t, [98.5, 98.97, 98.3, 98.6]) });
    expect(ok.s.events.find((e) => e.kind === "exit_fill")!.price).toBeCloseTo(98.5 * (1 - ADJ), 9);
    expect((await check(a.id, a.t - M))!.outcome).toBe("stop_open");
  });
  it("stop and target both inside one candle: the stop is required (a target exit is refused)", async () => {
    const a = await openLong(T()), both = bar("BTCUSDT", a.t, [100.1, 103.2, 98.0, 103]);
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, [100.1, 103.2, 99.9, 103]) }, [], { recorded: { BTCUSDT: both } });
    expect(x.s.trades[0]!.reason).toBe("target");
    await expect(x.run()).rejects.toThrow(/close differs from the required exit_fill \(stop\)/);
    await step(a, { BTCUSDT: both }); expect((await check(a.id, a.t - M))!.outcome).toBe("stop");
  });
  it("a fabricated exit where the recorded candle triggers nothing is refused", async () => {
    const a = await openLong(T());
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, [100.1, 103.2, 99.9, 102.9]) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, [100.1, 102.95, 99.9, 102.9]) } });
    await expect(x.run()).rejects.toThrow(/BTCUSDT exit_fill at .* submitted, but the recorded candle triggers no stop, target, liquidation or time limit/);
  });
  it("gap through the target at the open: exit at the open (target_open)", async () => {
    const a = await openLong(T());
    await step(a, { BTCUSDT: bar("BTCUSDT", a.t, [103.5, 103.8, 103.2, 103.6]) });
    expect((await check(a.id, a.t - M))!.outcome).toBe("target_open");
  });
  it("liquidation at the open takes precedence over a stop at the open", async () => {
    const a = await openLong(T()), p = (await pos(a.id))!;
    const q = Number(p.qty), e = Number(p.entry_price), m = Number(p.margin), liq = (q * e - m) / (q * (1 - 0.004));
    expect(liq).toBeGreaterThan(50);
    const tr: OHLC = [liq * 0.97, liq * 0.99, liq * 0.96, liq * 0.98];
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, tr, { mark: [liq * 1.02, liq * 1.03, liq * 1.01, liq * 1.02] }) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, tr) } });
    expect(x.s.trades[0]!.reason).toBe("stop");
    await expect(x.run()).rejects.toThrow(/close differs from the required liquidation \(liquidation_open\)/);
    await step(a, { BTCUSDT: bar("BTCUSDT", a.t, tr) }); expect((await check(a.id, a.t - M))!.outcome).toBe("liquidation_open");
  });
  it("time limit reached: omitting the time exit is refused", async () => {
    const a = await openLong(T(), { maxHoldBars: 3 }); await step(a); // bars 1 (fill), 2
    const x = await attempt(a, {}, [], { prep: (v) => { (v.state.positions["BTCUSDT"] as { maxHoldBars: number }).maxHoldBars = 30; } });
    expect(x.s.trades).toEqual([]);
    await expect(x.run()).rejects.toThrow(/requires a exit_fill \(time\) for BTCUSDT/);
    await step(a); expect((await check(a.id, a.t - M))!.outcome).toBe("time");
  });
  it("partial position (volume-capped fills): the stop covers exactly the filled quantity; omission refused", async () => {
    const cfg: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 1 } };
    const a = await openLong(T(), { cfg, v: 300 });
    const filled = Number((await pos(a.id))!.qty);
    expect(filled).toBeLessThan(Number((await db.query<{ q: string }>(`SELECT approved_qty q FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [a.id])).rows[0]!.q));
    const crossed = bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2], { v: 300 });
    const bad = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 300 }) }, [], { recorded: { BTCUSDT: crossed } });
    await expect(bad.run()).rejects.toThrow(/requires a exit_fill \(stop\)/);
    const ok = await step(a, { BTCUSDT: crossed });
    const exit = ok.s.events.find((e) => e.kind === "exit_fill")!;
    expect(Number((await check(a.id, a.t - M))!.qty)).toBeCloseTo(exit.qty, 9);
    expect(exit.qty).toBeGreaterThan(filled); // the next open's partial fill is protected in the same candle
  });
  it("a recorded price that touches the stop within rounding is ambiguous and refused (never guessed)", async () => {
    const a = await openLong(T()), stop = await stopOf(a.id);
    const touch = bar("BTCUSDT", a.t, [100, 100.3, stop, 100.05]);
    await expect((await attempt(a, { BTCUSDT: touch })).run()).rejects.toThrow(/futures paper completeness: ambiguous stop inside the candle for BTCUSDT/);
  });
});

describe("funding: grid times, missing / duplicate / off-grid rates, positions opened in the funding candle", () => {
  const held = async () => { const G = gridAt(), a = await openLong(G - 3 * M); await step(a); return { a, G }; };
  it("a held position at a funding time with no rate in the candle is refused (missing data → pause, retry later)", async () => {
    const { a, G } = await held();
    await expect((await attempt(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [] }) })).run()).rejects.toThrow(/funding rate for BTCUSDT at \d+ is missing while a position is held/);
  });
  it("two rates inside one funding window (duplicate charge) are refused as ambiguous", async () => {
    const { a, G } = await held();
    await expect((await attempt(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [{ t: G, rate: 0.0001 }, { t: G + 1, rate: 0.0001 }] }) })).run()).rejects.toThrow(/2 funding entries for BTCUSDT .* do not match its 1 funding time/);
  });
  it("an off-grid funding entry for a held position is refused as ambiguous", async () => {
    const { a, G } = await held(); await step(a, { BTCUSDT: bar("BTCUSDT", G) });
    await expect((await attempt(a, { BTCUSDT: bar("BTCUSDT", G + M, QUIET["BTCUSDT"], { funding: [{ t: G + M + 5, rate: 0.0001 }] }) })).run()).rejects.toThrow(/1 funding entries for BTCUSDT .* do not match its 0 funding time/);
  });
  it("a duplicated funding event (same time twice) is refused", async () => {
    const { a, G } = await held(); const f = [{ t: G + 3, rate: 0.0002 }];
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [...f, ...f] }) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: f }) } });
    expect(x.s.events.filter((e) => e.kind === "funding")).toHaveLength(2);
    await expect(x.run()).rejects.toThrow(/2 funding event\(s\) for BTCUSDT but the recorded candle requires 1/);
  });
  it("Binance-style ms jitter (t = grid + 3 ms) is accepted and charged once", async () => {
    const { a, G } = await held();
    const ok = await step(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [{ t: G + 3, rate: -0.0003 }] }) });
    expect(ok.s.events.filter((e) => e.kind === "funding").map((e) => e.t)).toEqual([G + 3]);
  });
  it("no position at the funding time (flat, or filled at that candle's open) → no charge required", async () => {
    const G = gridAt(), user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
    const flat = { id: await newAccount(db, user, G - M), user, t: G };
    await step(flat, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [{ t: G + 2, rate: 0.01 }] }) });
    const a = await openLong(G - M); // accepted at G - M, filled at G's open
    expect(await n(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='funding'`, [a.id])).toBe(0);
    expect((await check(a.id, G))!.funding_required).toBe(0);
  });
});

describe("gaps, frozen terms, configuration, replay and atomicity", () => {
  it("a skipped candle while a position is held is refused; a flat account may skip", async () => {
    const a = await openLong(T()); a.t += M;
    await expect((await attempt(a)).run()).rejects.toThrow(/futures paper completeness: candle \d+ skips 1 candle\(s\) while a position or pending entry exists/);
    const user = freshUser(), t0 = T(); const flat = { id: await newAccount(db, user, t0 - M), user, t: t0 + 5 * M };
    await step(flat);
  });
  it("a state whose position target or hold limit differs from the frozen terms is refused", async () => {
    const a = await openLong(T());
    await expect((await attempt(a, {}, [], { mutate: (p) => { p.state.positions["BTCUSDT"]!["targetDist"] = 5; } })).run()).rejects.toThrow(/state position BTCUSDT does not carry its frozen stop, target, hold limit or candle count/);
    await expect((await attempt(a, {}, [], { mutate: (p) => { p.state.positions["BTCUSDT"]!["maxHoldBars"] = 999; } })).run()).rejects.toThrow(/does not carry its frozen/);
    const terms = (await db.query<{ target_dist: string; max_hold_bars: number; trigger_source: string }>(`SELECT * FROM public.futures_paper_protection_terms WHERE account_id=$1`, [a.id])).rows[0]!;
    expect([terms.trigger_source, terms.max_hold_bars]).toEqual(["MARK", 30]); expect(Number(terms.target_dist)).toBeCloseTo(103 - 100.05, 9);
  });
  it("an account config without a valid triggerSource cannot open exposure", async () => {
    const user = freshUser(), t0 = T(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
    const cfg = { ...CFG, triggerSource: undefined } as unknown as FPConfig, a = { id: await newAccount(db, user, t0 - M, cfg), user, t: t0 };
    const it: FPIntent = { maxHoldBars: 30, proposal: { proposalId: `nt-${a.id.slice(-6)}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: 103, createdAt: t0 + M } };
    await expect((await attempt(a, {}, [it])).run()).rejects.toThrow(/no valid triggerSource/);
  });
  it("refusals roll back everything for the candle; identical replays return the committed sequence without writing", async () => {
    const a = await openLong(T()), crossed = bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2]);
    const before = await n(`SELECT seq::int n FROM public.futures_paper_accounts WHERE id=$1`, [a.id]);
    await expect((await attempt(a, {}, [], { recorded: { BTCUSDT: crossed } })).run()).rejects.toThrow(/completeness/);
    for (const tbl of ["futures_paper_candles", "futures_paper_events", "futures_paper_candle_checks", "futures_paper_commits"]) expect(await n(`SELECT count(*)::int n FROM public.${tbl} WHERE account_id=$1 AND bar_t=$2`, [a.id, a.t]), tbl).toBe(0);
    expect(await n(`SELECT seq::int n FROM public.futures_paper_accounts WHERE id=$1`, [a.id])).toBe(before);
    expect(await pos(a.id)).toBeDefined();
    const x = await attempt(a, { BTCUSDT: crossed }); const seq = await x.run();
    const rows = await n(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [a.id]);
    expect(await x.run()).toBe(seq);
    expect(await n(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [a.id])).toBe(rows);
    const other = structuredClone(x.s.payload) as unknown as Payload; other.candles["BTCUSDT"]!.trade.c = 99.25;
    await expect(commitV4(db, a.id, x.v.seq, a.t, other)).rejects.toThrow(/already committed with a different payload/);
  });
});

describe("gateway path, privileges and migration order", () => {
  it("the 0050 gateway now commits through 0051: an omitted stop exit is refused via fpw_commit too", async () => {
    const t0 = Math.floor(Date.now() / M) * M - 8 * M, a = await openLong(t0, { cfg: { ...CFG, limits: { ...CFG.limits, maxDataAgeMs: 3_600_000 } } });
    const fence = Number((await callFn(db, "fpw_acquire_lease", { p_account: a.id, p_holder: HOLDER_A, p_ttl_seconds: 60 })).data);
    const x = await attempt(a, {}, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2]) } });
    const prov = ["BTCUSDT", "ETHUSDT"].map((s) => ({ symbol: s, source: "binance-public-usdm", timeframe: "1m", open_t: a.t, close_t: a.t + M - 1, fetched_at: Date.now(), raw_sha256: "a".repeat(64), independently_verified: false }));
    const r = await callFn(db, "fpw_commit", { p_account: a.id, p_holder: HOLDER_A, p_fence: fence, p_expected_seq: x.v.seq, p_bar_t: a.t, p_payload: x.s.payload, p_provenance: prov });
    expect(r.error?.message).toMatch(/futures paper completeness: the recorded candle requires a exit_fill \(stop\)/);
    const ok = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, [100, 100.3, 98.5, 99.2]) });
    const r2 = await callFn(db, "fpw_commit", { p_account: a.id, p_holder: HOLDER_A, p_fence: fence, p_expected_seq: ok.v.seq, p_bar_t: a.t, p_payload: ok.s.payload, p_provenance: prov });
    expect(r2.error).toBeNull(); expect((await check(a.id, a.t))!.outcome).toBe("stop");
  });
  it("no API role can call the v4 commit or helpers, or write terms/checks; owners read only their own evidence", async () => {
    for (const role of ["service_role", "authenticated", "anon"] as const) {
      await expect(asRole(db, role, `SELECT public.futures_paper_commit_bar_v4(gen_random_uuid(), 0, 0, '{}'::jsonb)`)).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, `SELECT public.fp4_reached(1, 2, true, 'x')`)).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, `INSERT INTO public.futures_paper_protection_terms(account_id, proposal_id, user_id, symbol, side, trigger_source, stop_dist, max_hold_bars, recorded_seq) VALUES (gen_random_uuid(),'x',gen_random_uuid(),'BTCUSDT','LONG','MARK',1,1,1)`)).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, `SELECT count(*) FROM public.futures_paper_0051_requires_0050`)).rejects.toThrow(/permission denied/);
    }
    const a = await openLong(T());
    await db.exec(`SET test.uid = '${a.user}'`);
    expect((await asRole<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.futures_paper_protection_terms`)).rows[0]!.n).toBe(1);
    await db.exec(`SET test.uid = '${freshUser()}'`);
    expect((await asRole<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.futures_paper_protection_terms`)).rows[0]!.n).toBe(0);
    await db.exec(`RESET test.uid`);
    await expect(db.exec(`UPDATE public.futures_paper_protection_terms SET max_hold_bars = 1`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.futures_paper_candle_checks`)).rejects.toThrow(/append-only/);
  });
  it("0051 needs 0050; 0050's rollback is blocked while 0051 exists; 0051's rollback restores 0050's gateway byte-for-byte", async () => {
    const { makeDb } = await import("./helpers/fp-v3-harness");
    const only49 = await makeDb(); await expect(only49.exec(MIGRATION_0051)).rejects.toThrow(/0051 requires drafts 0049 and 0050/);
    const { makeGatewayDb, ROLLBACK_0050 } = await import("./helpers/fp-gateway-harness");
    const g = await makeGatewayDb();
    const def = async () => (await g.query<{ d: string }>(`SELECT pg_get_functiondef('public.fpw_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure) d`)).rows[0]!.d;
    const acl = async () => (await g.query<{ a: string }>(`SELECT proacl::text a FROM pg_proc WHERE oid = 'public.fpw_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure`)).rows[0]!.a;
    const [d0, a0] = [await def(), await acl()];
    await g.exec(MIGRATION_0051);
    expect(await def()).toMatch(/futures_paper_commit_bar_v4/); expect(await acl()).toBe(a0);
    await expect(g.exec(ROLLBACK_0050)).rejects.toThrow(/depend/);
    await g.exec(ROLLBACK_0051);
    expect(await def()).toBe(d0); expect(await acl()).toBe(a0);
    expect((await g.query<{ n: number }>(`SELECT count(*)::int n FROM pg_class WHERE relname IN ('futures_paper_protection_terms','futures_paper_candle_checks','futures_paper_0051_requires_0050')`)).rows[0]!.n).toBe(0);
    expect((await g.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'fp4_%' OR proname = 'futures_paper_commit_bar_v4'`)).rows[0]!.n).toBe(0);
    await g.exec(ROLLBACK_0050); // 0050 can roll back once 0051 is gone
  }, 60_000);
});
