// Phase 4H finalization — DRAFT 0052 over drafts 0049 + 0050 + 0051 in PGlite; nothing is applied anywhere real.
// Owner decisions: A entry-fill completeness REQUIRED (the database derives every fill, partial fill, remainder and
// cancellation itself and refuses any other event set — including a cancellation that claims a refusal the database
// would not make); B a stopped/halted account with exposure is EXIT ONLY (exits, funding, time limits keep running;
// entries and increases are refused; the halt is preserved); configuration-change audit trail. Every test drives the
// DATABASE: the payload is produced by the real engine from what the worker "saw", while the recorded candle (or a
// mutated payload) differs — the assertion is that the database refuses the incomplete or invalid event set.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { FPBar, FPConfig, FPIntent } from "@/lib/futures-paper-engine";
import type { FPV3Options } from "@/lib/futures-paper-engine-v3";
import { runFuturesPaperWorkerTick, type CommitOutcome } from "@/lib/futures-paper-worker";
import { CFG, M, as, accountBudget, costOverride, freshUser, loadView, makeDb, newAccount, pglitePorts, rawBundle, stepView, strategyBudget } from "./helpers/fp-v3-harness";
import { MIGRATION_0050, callFn } from "./helpers/fp-gateway-harness";
import { H8, MIGRATION_0051, ROLLBACK_0051, gridAt, quietT0 } from "./helpers/fp-v4-harness";
import { MIGRATION_0052, ROLLBACK_0052, TEST_REASON, commitV5, makeEntryDb, setStatus } from "./helpers/fp-v5-harness";

let db: PGlite;
beforeAll(async () => { db = await makeEntryDb(); }, 120_000);
type OHLC = [number, number, number, number];
const QUIET: Record<string, OHLC> = { BTCUSDT: [100, 100.3, 99.8, 100.05], ETHUSDT: [50, 50.2, 49.9, 50.1] };
const CROSSED: OHLC = [100, 100.3, 98.5, 99.2];
function bar(s: string, t: number, tr: OHLC = QUIET[s]!, o: { mark?: OHLC; v?: number; funding?: { t: number; rate: number }[] } = {}): FPBar {
  const m = o.mark ?? tr;
  return { symbol: s, t, tfMs: M, trade: { o: tr[0], h: tr[1], l: tr[2], c: tr[3], v: o.v ?? 1e6 }, mark: { o: m[0], h: m[1], l: m[2], c: m[3] }, index: { c: m[3] }, funding: o.funding ?? (t % H8 === 0 ? [{ t, rate: 0.0001 }] : []) };
}
type Ev = { seq: number; t: number; kind: string; qty: number; fee: number; wallet_delta: number; margin_delta: number; reason: string; side: string | null; proposal_id: string | null };
type Payload = { candles: Record<string, { trade: { o: number; h: number; l: number; c: number; v: number }; mark: { o: number; h: number; l: number; c: number }; funding: { t: number; rate: number }[] }>; state: { seq: number; positions: Record<string, Record<string, unknown>>; pending: Record<string, Record<string, unknown>> }; events: Ev[] };
const record = (p: unknown, s: string, b: FPBar) => { const c = (p as Payload).candles[s]!; c.trade = { ...b.trade }; c.mark = { ...b.mark! }; c.funding = b.funding.map((f) => ({ ...f })); return p; };
const n = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: number }>(sql, p)).rows[0]!.n);
const T = () => quietT0();
/** Volume participation cap of 10 %: a recorded volume of 30 allows a 3.000 fill. */
const CAP: FPConfig = { ...CFG, costs: { ...CFG.costs, maxParticipationPct: 10 } };

interface Acct { id: string; user: string; t: number; prop?: string }
async function newAcct(cfg: FPConfig = CFG, t0 = T()): Promise<Acct> {
  const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
  return { id: await newAccount(db, user, t0 - M, cfg), user, t: t0 };
}
const longIntent = (a: Acct, o: { maxHoldBars?: number; tp?: number | null } = {}): FPIntent => ({ maxHoldBars: o.maxHoldBars ?? 30, proposal: { proposalId: `e52-${a.id.slice(-8)}-${a.t}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99, takeProfitPrice: o.tp === undefined ? 103 : o.tp, createdAt: a.t + M } });
type View = Awaited<ReturnType<typeof loadView>>;
async function attempt(a: Acct, fed: Record<string, FPBar> = {}, intents: FPIntent[] = [], o: { recorded?: Record<string, FPBar>; mutate?: (p: Payload) => void; prep?: (v: View) => void; opts?: FPV3Options } = {}) {
  const v = await loadView(db, a.id); o.prep?.(v);
  const bars = ["BTCUSDT", "ETHUSDT"].map((s) => fed[s] ?? bar(s, a.t));
  const s = stepView(v, bars, intents, [], o.opts ?? {});
  for (const [sym, b] of Object.entries(o.recorded ?? {})) record(s.payload, sym, b);
  o.mutate?.(s.payload as unknown as Payload);
  return { v, s, run: () => commitV5(db, a.id, v.seq, a.t, s.payload) };
}
async function step(a: Acct, fed: Record<string, FPBar> = {}, intents: FPIntent[] = [], o: Parameters<typeof attempt>[3] = {}) {
  const x = await attempt(a, fed, intents, o); const seq = await x.run(); a.t += M; return { ...x, seq };
}
/** Accepts a BTCUSDT LONG at the account's current candle; its fills start at the next open. */
async function accept(a: Acct, o: { maxHoldBars?: number } = {}) { const it = longIntent(a, o); a.prop = it.proposal.proposalId; await step(a, {}, [it]); return it; }
async function openLong(cfg: FPConfig = CFG, o: { maxHoldBars?: number; t0?: number } = {}) { const a = await newAcct(cfg, o.t0); await accept(a, o); await step(a); expect(await pos(a.id)).toBeDefined(); return a; }
const pos = async (id: string) => (await db.query<{ qty: string; entry_price: string; stop_dist: string }>(`SELECT * FROM public.futures_paper_positions WHERE account_id=$1 AND symbol='BTCUSDT'`, [id])).rows[0];
const appr = async (id: string) => (await db.query<{ approved_qty: string; filled_qty: string; status: string; proposal_id: string }>(`SELECT * FROM public.futures_paper_risk_approvals WHERE account_id=$1 ORDER BY approved_seq DESC LIMIT 1`, [id])).rows[0]!;
const entry = async (id: string, t: number) => (await db.query<{ outcome: string; required_qty: string | null; filled_qty: string; cancelled_qty: string; reason_code: string | null; bars_waited: number }>(`SELECT * FROM public.futures_paper_entry_checks WHERE account_id=$1 AND bar_t=$2`, [id, t])).rows[0];
const acct = async (id: string) => (await db.query<{ status: string; halted: boolean }>(`SELECT status, halted FROM public.futures_paper_accounts WHERE id=$1`, [id])).rows[0]!;
const reasonOf = (p: Payload, kind: string, to: string) => { const e = p.events.find((x) => x.kind === kind)!; e.reason = to; };

describe("A. entry-fill completeness (the database derives every fill and cancellation)", () => {
  it("a full fill at the next open is required and recorded", async () => {
    const a = await newAcct(); await accept(a); const t = a.t; await step(a);
    const r = (await entry(a.id, t))!, ap = await appr(a.id);
    expect([r.outcome, r.bars_waited, ap.status]).toEqual(["filled", 1, "filled"]);
    expect(Number(r.required_qty)).toBeCloseTo(Number(ap.approved_qty), 9);
  });
  it("missing implied fill: a worker that fills nothing while the recorded candle implies a fill is refused", async () => {
    const a = await newAcct(CAP); await accept(a);
    const bad = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 0 }) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t) } });
    expect(bad.s.events.filter((e) => e.kind === "entry_fill")).toEqual([]);
    await expect(bad.run()).rejects.toThrow(/futures paper completeness: the recorded candle requires an entry fill of [\d.]+ for BTCUSDT .* but none was submitted/);
    const t = a.t; await step(a); expect((await entry(a.id, t))!.outcome).toBe("filled");
  });
  it("incorrect partial fill quantity (too little or too much for the recorded volume cap) is refused", async () => {
    const a = await newAcct(CAP); await accept(a);
    const rec = { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) };
    await expect((await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 20 }) }, [], { recorded: rec })).run()).rejects.toThrow(/requires an entry fill of 3(\.0+)? for BTCUSDT .* but 2(\.0+)? at \d+ was submitted/);
    await expect((await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 1e6 }) }, [], { recorded: rec })).run()).rejects.toThrow(/requires an entry fill of 3(\.0+)? for BTCUSDT/);
    const t = a.t; await step(a, rec);
    const r = (await entry(a.id, t))!, ap = await appr(a.id);
    expect([r.outcome, Number(r.filled_qty), ap.status, Number(ap.filled_qty)]).toEqual(["partial", 3, "open", 3]);
  });
  it("a fill beyond the approved remainder is refused (0049)", async () => {
    const a = await newAcct(); await accept(a); const q = Number((await appr(a.id)).approved_qty);
    await expect((await attempt(a, {}, [], { mutate: (p) => { const f = p.events.find((e) => e.kind === "entry_fill")!; f.qty = q + 0.001; } })).run()).rejects.toThrow(/exceeds the approved remainder/);
  });
  it("duplicate fill: two fills of one entry in one candle are refused even when they add up", async () => {
    const a = await newAcct(); await accept(a);
    const split = (p: Payload) => {
      const i = p.events.findIndex((e) => e.kind === "entry_fill"), f = p.events[i]!, k = Math.round(f.qty / 0.001), q1 = Math.floor(k / 2) * 0.001, q2 = f.qty - q1;
      const part = (q: number, seq: number): Ev => ({ ...f, seq, qty: q, fee: (f.fee * q) / f.qty, wallet_delta: (-f.fee * q) / f.qty, margin_delta: (f.margin_delta * q) / f.qty });
      p.events.splice(i, 1, part(q1, f.seq), part(q2, f.seq + 1));
      for (let j = i + 2; j < p.events.length; j++) p.events[j]!.seq += 1;
      p.state.seq += 1;
    };
    // Same fill time twice: 0049's database-derived fill id is unique, so the duplicate is refused.
    await expect((await attempt(a, {}, [], { mutate: split })).run()).rejects.toThrow(/duplicate key value violates unique constraint/);
    // A second fill later in the same candle (distinct fill id) is refused by 0052: one fill per candle, at its open.
    await expect((await attempt(a, {}, [], { mutate: (p) => { split(p); const fs = p.events.filter((e) => e.kind === "entry_fill"); fs[1]!.t += 1; } })).run()).rejects.toThrow(/futures paper completeness: 2 entry fills for BTCUSDT/);
  });
  it("replay: an identical payload returns the committed sequence and writes nothing; a conflicting one is refused", async () => {
    const a = await newAcct(CAP); await accept(a);
    const x = await attempt(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    const seq = await x.run(), before = await n(`SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE account_id=$1`, [a.id]), evs = await n(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [a.id]);
    expect(await x.run()).toBe(seq);
    expect(await n(`SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE account_id=$1`, [a.id])).toBe(before);
    expect(await n(`SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [a.id])).toBe(evs);
    const v = x.s.payload as unknown as Payload; v.events[0]!.reason = "different";
    await expect(commitV5(db, a.id, x.v.seq, a.t, v)).rejects.toThrow(/already committed with a different payload/);
  });
  it("time limit: the remainder is cancelled at the open when entryTtlBars is reached; an early time-limit cancellation is refused", async () => {
    const a = await newAcct({ ...CAP, entryTtlBars: 2 }); await accept(a);
    const v30 = () => ({ BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    const early = await attempt(a, v30(), [], { prep: (v) => { (v.state.pending["BTCUSDT"] as { ttlBars: number }).ttlBars = 1; } });
    expect(early.s.events.map((e) => e.kind)).toContain("entry_cancelled");
    await expect(early.run()).rejects.toThrow(/cancellation of the BTCUSDT entry .* has no valid reason/);
    await step(a, v30());
    const t = a.t; await step(a, v30());
    const r = (await entry(a.id, t))!;
    expect([r.outcome, r.reason_code, r.bars_waited, Number(r.filled_qty)]).toEqual(["cancelled_ttl", "TIME_LIMIT", 2, 3]);
    expect(Number(r.cancelled_qty)).toBeCloseTo(Number((await appr(a.id)).approved_qty) - 6, 9);
    expect((await appr(a.id)).status).toBe("cancelled");
  });
  it("expiry: after the approval expires the remainder is cancelled at the open [APPROVAL_EXPIRED]; early or mislabelled expiry is refused", async () => {
    const a = await newAcct(CAP); await accept(a);
    const v30 = () => ({ BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    const early = await attempt(a, v30(), [], { prep: (v) => { v.ledger.approvals["BTCUSDT"]!.expiresT = a.t - 1; } });
    expect(early.s.events.find((e) => e.kind === "entry_cancelled")!.reason).toMatch(/\[APPROVAL_EXPIRED\]/);
    await expect(early.run()).rejects.toThrow(/requires an entry fill of 3(\.0+)? for BTCUSDT/);
    await step(a, v30()); await step(a, v30()); // W = 1, W = 2 (open = expiry: inclusive, still fills)
    const late = await attempt(a, v30(), [], { mutate: (p) => reasonOf(p, "entry_cancelled", "unfilled remainder cancelled at its time limit") });
    await expect(late.run()).rejects.toThrow(/cancellation reason \[none\] of .* does not match the database-derived reason \(expired\)/);
    const t = a.t; await step(a, v30());
    const r = (await entry(a.id, t))!;
    expect([r.outcome, r.reason_code, Number(r.filled_qty)]).toEqual(["cancelled_expired", "APPROVAL_EXPIRED", 0]);
  });
  it("position closed while a remainder is pending: the remainder must be cancelled at the close", async () => {
    const a = await newAcct(CAP); await accept(a);
    await step(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    const crossed = () => ({ BTCUSDT: bar("BTCUSDT", a.t, CROSSED, { v: 30 }) });
    const wrong = await attempt(a, crossed(), [], { mutate: (p) => reasonOf(p, "entry_cancelled", "unfilled remainder cancelled at its time limit") });
    await expect(wrong.run()).rejects.toThrow(/the BTCUSDT position closed in candle \d+; its pending remainder .* must be cancelled at the close/);
    const t = a.t; const ok = await step(a, crossed());
    expect(ok.s.events.map((e) => e.kind)).toEqual(["entry_fill", "exit_fill", "entry_cancelled"]);
    expect((await entry(a.id, t))!.outcome).toBe("cancelled_closed");
  });
  it("a cancellation that claims a fill refusal the database would not make is refused", async () => {
    const a = await newAcct(); await accept(a);
    const x = await attempt(a, {}, [], { opts: { refused: { [a.prop!]: "DAILY_LOSS_LIMIT" } } });
    expect(x.s.events.find((e) => e.kind === "entry_cancelled")!.reason).toMatch(/^fill refused \[DAILY_LOSS_LIMIT\]/);
    await expect(x.run()).rejects.toThrow(/cancellation of .* \[DAILY_LOSS_LIMIT\] refused: the database permits the fill/);
    const halted = await attempt(a, {}, [], { opts: { refused: { [a.prop!]: "ACCOUNT_HALTED" } } });
    await expect(halted.run()).rejects.toThrow(/claims \[ACCOUNT_HALTED\], but the account is active, not halted/);
  });
  it("a database-verified refusal (strategy budget lowered after approval) commits with the database's own code; a different code is refused", async () => {
    const a = await newAcct(); await accept(a);
    await strategyBudget(db, a.user, "s1", "scalping", 1);
    const mislabelled = await attempt(a, {}, [], { opts: { refused: { [a.prop!]: "EXPOSURE_LIMIT" } } });
    await expect(mislabelled.run()).rejects.toThrow(/cancellation reason \[EXPOSURE_LIMIT\] for .* differs from the database refusal \[STRATEGY_BUDGET_EXCEEDED\]/);
    const t = a.t; const ok = await step(a);
    expect(ok.s.events.find((e) => e.kind === "entry_cancelled")!.reason).toMatch(/^fill refused \[STRATEGY_BUDGET_EXCEEDED\]/);
    const r = (await entry(a.id, t))!;
    expect([r.outcome, r.reason_code, Number(r.filled_qty)]).toEqual(["cancelled_refused", "STRATEGY_BUDGET_EXCEEDED", 0]);
    expect(await pos(a.id)).toBeUndefined();
  });
  it("a volume cap within rounding of a lot boundary is ambiguous and refused (never guessed)", async () => {
    const a = await newAcct(CAP); await accept(a);
    const edge = { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 29.999999999995 }) };
    await expect((await attempt(a, edge)).run()).rejects.toThrow(/futures paper completeness: ambiguous fill quantity for BTCUSDT/);
  });
});

describe("B. stopped or halted account with exposure — exit only", () => {
  it("a stopped account with an open position keeps committing (no entries); it stays stopped", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const x = await step(a, {}, [longIntent(a)]);
    expect(x.s.events.map((e) => e.kind)).toEqual(["order_rejected"]);
    expect(await pos(a.id)).toBeDefined(); expect(await acct(a.id)).toEqual({ status: "stopped", halted: false });
  });
  it("a stop crossed on a stopped account REQUIRES the exit; afterwards the flat stopped account is refused and stays stopped", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const bad = await attempt(a, {}, [], { recorded: { BTCUSDT: bar("BTCUSDT", a.t, CROSSED) } });
    await expect(bad.run()).rejects.toThrow(/the recorded candle requires a exit_fill \(stop\) for BTCUSDT/);
    const ok = await step(a, { BTCUSDT: bar("BTCUSDT", a.t, CROSSED) });
    expect(ok.s.events.map((e) => e.kind)).toEqual(["exit_fill"]);
    expect(await pos(a.id)).toBeUndefined(); expect(await acct(a.id)).toEqual({ status: "stopped", halted: false });
    await expect((await attempt(a)).run()).rejects.toThrow(/futures paper account is stopped/);
    await expect(setStatus(db, a.id, { status: "active", reason: "try to resume" })).rejects.toThrow(/stays stopped/);
  });
  it("a stopped account cannot open a new entry (a worker that believes it is active is refused)", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const eth: FPIntent = { ...longIntent(a), proposal: { ...longIntent(a).proposal, proposalId: `eth-${a.id.slice(-6)}`, symbol: "ETHUSDT", stopPrice: 49.5, takeProfitPrice: 51 } };
    const x = await attempt(a, {}, [eth], { prep: (v) => { v.status = "active"; } });
    expect(x.s.events.map((e) => e.kind)).toContain("order_accepted");
    await expect(x.run()).rejects.toThrow(/entries are refused while the account is not active or is halted/);
  });
  it("a stopped account's pending remainder must be cancelled at the open [ACCOUNT_NOT_ACTIVE]; a fill or a wrong reason is refused", async () => {
    const a = await newAcct(CAP); await accept(a); await step(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const v30 = () => ({ BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    const fill = await attempt(a, v30(), [], { prep: (v) => { v.status = "active"; } });
    expect(fill.s.events.map((e) => e.kind)).toContain("entry_fill");
    await expect(fill.run()).rejects.toThrow(/entries are refused while the account is not active or is halted/);
    const wrong = await attempt(a, v30(), [], { mutate: (p) => reasonOf(p, "entry_cancelled", "fill refused [ACCOUNT_HALTED]: emergency paper stop; unfilled entry cancelled") });
    await expect(wrong.run()).rejects.toThrow(/cancellation reason \[ACCOUNT_HALTED\] of .* does not match the database-derived reason \(not_active\)/);
    const t = a.t; await step(a, v30());
    expect((await entry(a.id, t))!.outcome).toBe("cancelled_not_active");
    expect(Number((await pos(a.id))!.qty)).toBe(3); expect((await appr(a.id)).status).toBe("cancelled");
  });
  it("an exit that would exceed or reverse the position is refused (no reversal, no increase)", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const crossed = { BTCUSDT: bar("BTCUSDT", a.t, CROSSED) };
    await expect((await attempt(a, crossed, [], { mutate: (p) => { p.events.find((e) => e.kind === "exit_fill")!.qty *= 2; } })).run()).rejects.toThrow(/close quantity .* differs from the open quantity/);
    await expect((await attempt(a, crossed, [], { mutate: (p) => { p.events.find((e) => e.kind === "exit_fill")!.side = "SHORT"; } })).run()).rejects.toThrow(/exit_fill event without a matching open BTCUSDT position/);
  });
  it("a stopped account with exposure must commit every candle (a skipped candle is refused)", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" }); a.t += M;
    await expect((await attempt(a)).run()).rejects.toThrow(/futures paper completeness: candle \d+ skips 1 candle\(s\) while a position or pending entry exists/);
  });
  it("the time limit still forces the exit on a stopped account", async () => {
    const a = await openLong(CFG, { maxHoldBars: 3 }); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" }); await step(a);
    const x = await attempt(a, {}, [], { prep: (v) => { (v.state.positions["BTCUSDT"] as { maxHoldBars: number }).maxHoldBars = 30; } });
    await expect(x.run()).rejects.toThrow(/requires a exit_fill \(time\) for BTCUSDT/);
    await step(a); expect(await pos(a.id)).toBeUndefined(); expect((await acct(a.id)).status).toBe("stopped");
  });
  it("funding while halted: the held position must pay funding at the grid; the halt flag is preserved", async () => {
    const G = gridAt(), a = await openLong(CFG, { t0: G - 3 * M }); await step(a); // a.t = G
    await setStatus(db, a.id, { halted: true, reason: "emergency paper stop (test)" });
    const f = [{ t: G + 2, rate: 0.0005 }];
    const omit = await attempt(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: [] }) }, [], { recorded: { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: f }) } });
    await expect(omit.run()).rejects.toThrow(/0 funding event\(s\) for BTCUSDT but the recorded candle requires 1/);
    const ok = await step(a, { BTCUSDT: bar("BTCUSDT", G, QUIET["BTCUSDT"], { funding: f }) });
    expect(ok.s.events.map((e) => e.kind)).toEqual(["funding"]);
    expect(await acct(a.id)).toEqual({ status: "active", halted: true });
  });
  it("a halted account's pending remainder is cancelled at the open [ACCOUNT_HALTED]", async () => {
    const a = await newAcct(CAP); await accept(a); await step(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    await setStatus(db, a.id, { halted: true, reason: "emergency paper stop (test)" });
    const t = a.t; await step(a, { BTCUSDT: bar("BTCUSDT", a.t, QUIET["BTCUSDT"], { v: 30 }) });
    expect((await entry(a.id, t))!).toMatchObject({ outcome: "cancelled_halted", reason_code: "ACCOUNT_HALTED" });
  });
  it("missing data on a stopped account fails closed (no candle for the held symbol)", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    await expect((await attempt(a, {}, [], { mutate: (p) => { delete p.candles["BTCUSDT"]; } })).run()).rejects.toThrow(/no candle for BTCUSDT/);
  });
});

describe("configuration-change audit trail", () => {
  const rows = async (user: string, entity: string) => (await db.query<{ version: number; operation: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown>; reason: string; actor_role: string; actor_label: string | null; value_sha256: string; prev_sha256: string | null; chain_sha256: string; entity_key: string }>(`SELECT * FROM public.futures_paper_config_changes WHERE user_id=$1 AND entity=$2 ORDER BY entity_key, version`, [user, entity])).rows;
  const withReason = async <T>(reason: string, f: () => Promise<T>) => { await db.exec(`SELECT set_config('futures_paper.change_reason', '${reason.replace(/'/g, "''")}', false)`); try { return await f(); } finally { await db.exec(`SELECT set_config('futures_paper.change_reason', '${TEST_REASON}', false)`); } };
  it("a budget or cost write without a reason is refused; with a reason old value, new value, actor, version and chain are recorded", async () => {
    const user = freshUser();
    await expect(withReason("", () => accountBudget(db, user, 1000, 400, 600))).rejects.toThrow(/configuration change refused: account_budget insert needs a reason/);
    await withReason("owner sets the paper budget", () => accountBudget(db, user, 1000, 400, 600));
    await withReason("owner lowers the research sub-budget", () => accountBudget(db, user, 1000, 300, 600));
    const r = await rows(user, "account_budget");
    expect(r.map((x) => [x.version, x.operation, x.reason, x.actor_role])).toEqual([[1, "INSERT", "owner sets the paper budget", "service_role"], [2, "UPDATE", "owner lowers the research sub-budget", "service_role"]]);
    expect([r[1]!.old_value!["research_max_loss"], r[1]!.new_value["research_max_loss"]]).toEqual([400, 300]);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(r[0]!.value_sha256).toMatch(/^[0-9a-f]{64}$/); expect(r[0]!.prev_sha256).toBeNull(); expect(r[1]!.prev_sha256).toBe(r[0]!.chain_sha256);
    expect(r[1]!.chain_sha256).toBe(sha([r[0]!.chain_sha256, "account_budget", user, "paper", "2", "UPDATE", r[1]!.value_sha256, "owner lowers the research sub-budget"].join("|")));
    expect(Number((await db.query<{ v: string }>(`SELECT research_max_loss v FROM public.account_risk_budgets WHERE user_id=$1`, [user])).rows[0]!.v)).toBe(300); // the audit never alters a value
    await expect(withReason("", () => strategyBudget(db, user, "s9", "research", 10))).rejects.toThrow(/strategy_budget insert needs a reason/);
    await expect(withReason("  ", () => costOverride(db, user, "s9", "BTCUSDT", 0.2))).rejects.toThrow(/cost_assumption insert needs a reason/);
    await withReason("owner records a symbol cost override", () => costOverride(db, user, "*", "BTCUSDT", 0.2));
    expect((await rows(user, "cost_assumption")).map((x) => [x.entity_key, x.version, x.new_value["round_trip_cost_pct"]])).toEqual([["*:BTCUSDT", 1, 0.2]]);
  });
  it("a no-op update writes nothing; audit records are append-only", async () => {
    const user = freshUser(); await accountBudget(db, user, 1000, 400, 600);
    await accountBudget(db, user, 1000, 400, 600); // same values
    expect((await rows(user, "account_budget")).length).toBe(1);
    await expect(db.query(`UPDATE public.futures_paper_config_changes SET reason='x' WHERE user_id=$1`, [user])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM public.futures_paper_config_changes WHERE user_id=$1`, [user])).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE public.futures_paper_config_changes`)).rejects.toThrow(/append-only/);
    await expect(as(db, "service_role", `INSERT INTO public.futures_paper_config_changes(user_id, entity, entity_key, operation, new_value, actor_role, reason, version, value_sha256, chain_sha256) VALUES ($1,'account_budget','paper','INSERT','{}','x','forged',9,repeat('a',64),repeat('a',64))`, [user])).rejects.toThrow(/permission denied/);
  });
  it("account creation (frozen policy configuration) and status/halt changes are recorded; the worker review hold names the worker", async () => {
    const a = await newAcct();
    const cfgRow = (await rows(a.user, "account_config"))[0]!;
    expect([cfgRow.entity_key, cfgRow.reason, (cfgRow.new_value["config"] as { limits: { maxDailyLoss: number } }).limits.maxDailyLoss]).toEqual([a.id, TEST_REASON, 50]);
    await withReason("", () => setStatus(db, a.id, { halted: true, reason: "owner emergency stop" }));
    const lease = await callFn(db, "fpw_acquire_lease", { p_account: a.id, p_holder: "00000000-0000-4000-8000-00000000aaaa", p_ttl_seconds: 60 });
    await withReason("", () => callFn(db, "fpw_mark_review", { p_account: a.id, p_holder: "00000000-0000-4000-8000-00000000aaaa", p_fence: lease.data, p_code: "TEST_REVIEW" }));
    const st = await rows(a.user, "account_status");
    expect(st.map((x) => [x.version, x.reason, x.actor_label, x.new_value["halted"], x.new_value["status"]])).toEqual([[1, "owner emergency stop", null, true, "active"], [2, "review:TEST_REVIEW", "worker", true, "paused"]]);
  });
  it("owner-only reads: the owner sees their records, another user sees none; API roles cannot write", async () => {
    const a = await newAcct();
    await db.exec(`SELECT set_config('test.uid', '${a.user}', false)`);
    try {
      expect((await as<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.futures_paper_config_changes`)).rows[0]!.n).toBeGreaterThan(0);
      await db.exec(`SELECT set_config('test.uid', '${freshUser()}', false)`);
      expect((await as<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.futures_paper_config_changes WHERE user_id = '${a.user}'`)).rows[0]!.n).toBe(0);
      expect((await as<{ n: number }>(db, "authenticated", `SELECT count(*)::int n FROM public.futures_paper_entry_checks WHERE user_id = '${a.user}'`)).rows[0]!.n).toBe(0);
    } finally { await db.exec(`SELECT set_config('test.uid', '', false)`); }
    await expect(as(db, "anon", `SELECT count(*) FROM public.futures_paper_config_changes`)).rejects.toThrow(/permission denied/);
  });
});

describe("privileges, migration order and rollback", () => {
  it("v5 and the 0052 helpers are executable by no API role; the gateway stays service-only and commits through v5", async () => {
    for (const fn of ["futures_paper_commit_bar_v5(uuid,bigint,bigint,jsonb)", "fp5_required_fill_qty(uuid,text,bigint,numeric)", "fp5_verify_fill_refusal(uuid,text,bigint,bigint,jsonb,numeric,text)", "fp5_audit_config()", "futures_paper_commit_bar_v4(uuid,bigint,bigint,jsonb)", "futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)"]) {
      const r = (await db.query<{ a: boolean; s: boolean; n: boolean }>(`SELECT has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') a, has_function_privilege('service_role', 'public.${fn}', 'EXECUTE') s, has_function_privilege('anon', 'public.${fn}', 'EXECUTE') n`)).rows[0]!;
      expect([fn, r.a, r.s, r.n]).toEqual([fn, false, false, false]);
    }
    const g = (await db.query<{ s: boolean; a: boolean; src: string }>(`SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') s, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, prosrc src FROM pg_proc p WHERE proname='fpw_commit'`)).rows[0]!;
    expect([g.s, g.a, /futures_paper_commit_bar_v5\(p_account/.test(g.src), /commit_bar_v4/.test(g.src)]).toEqual([true, false, true, false]);
    for (const t of ["futures_paper_entry_checks", "futures_paper_config_changes"]) for (const role of ["authenticated", "service_role"]) {
      const p = (await db.query<{ w: boolean }>(`SELECT has_table_privilege('${role}', 'public.${t}', 'INSERT,UPDATE,DELETE,TRUNCATE') w`)).rows[0]!;
      expect([t, role, p.w]).toEqual([t, role, false]);
    }
  });
  it("0052 needs 0051; 0051's rollback is blocked while 0052 exists; 0052's rollback restores 0049's v3 and 0051's gateway byte-for-byte", async () => {
    const only50 = await makeDb(); await only50.exec(MIGRATION_0050);
    await expect(only50.exec(MIGRATION_0052)).rejects.toThrow(/0052 requires drafts 0049, 0050 and 0051/);
    const ref = only50; await ref.exec(MIGRATION_0051);
    const def = async (d: PGlite, f: string) => (await d.query<{ d: string; acl: string | null }>(`SELECT pg_get_functiondef('public.${f}'::regprocedure) d, proacl::text acl FROM pg_proc WHERE oid = 'public.${f}'::regprocedure`)).rows[0]!;
    const V3 = "futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)", GW = "fpw_commit(uuid,uuid,bigint,bigint,bigint,jsonb,jsonb)";
    const d = await makeEntryDb();
    expect((await def(d, V3)).d).not.toBe((await def(ref, V3)).d);
    await expect(d.exec(ROLLBACK_0051)).rejects.toThrow(/cannot drop|depends on/);
    expect(await d.query(`SELECT to_regclass('public.futures_paper_candle_checks') IS NOT NULL ok`).then((r) => (r.rows[0] as { ok: boolean }).ok)).toBe(true);
    await d.exec(ROLLBACK_0052);
    expect(await def(d, V3)).toEqual(await def(ref, V3));
    expect(await def(d, GW)).toEqual(await def(ref, GW));
    const left = (await d.query<{ n: number }>(`SELECT (SELECT count(*) FROM pg_proc WHERE proname LIKE 'fp5\\_%' OR proname = 'futures_paper_commit_bar_v5') + (SELECT count(*) FROM pg_class WHERE relname IN ('futures_paper_entry_checks','futures_paper_config_changes','futures_paper_0052_requires_0051')) + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%config_audit') AS n`)).rows[0]!;
    expect(Number(left.n)).toBe(0);
    await d.exec(ROLLBACK_0051); // now permitted
  });
});

describe("worker: a stopped account with exposure is processed exit-only; crash recovery through 0052", () => {
  it("the worker keeps closing a stopped account's position, sends no intents, and finishes when flat; a lost reply is resent identically", async () => {
    const a = await openLong(); await setStatus(db, a.id, { status: "stopped", reason: "owner stop (test)" });
    const t1 = a.t, t2 = a.t + M, now = t2 + 2 * M + 3_000;
    const market = { candles: async (symbols: string[], timeframe: string, barT: number) => symbols.map((s) => rawBundle(s, barT, M, { trade: s === "BTCUSDT" && barT === t2 ? CROSSED : QUIET[s]!, v: 1e6 }, now, timeframe)) };
    let asked = 0; const intents = { forCandle: async (): Promise<FPIntent[]> => { asked++; return [longIntent(a)]; } };
    const base = pglitePorts(db, { market, intents, now: () => now });
    let lost = 0;
    const ports = { ...base.ports, db: { ...base.ports.db, async commit(acct: string, seq: number, barT: number, payload: unknown): Promise<CommitOutcome> {
      try { const s = await commitV5(db, acct, seq, barT, payload); if (barT === t2 && lost++ === 0) throw new Error("reply lost after commit"); return { kind: "committed", seq: s }; }
      catch (e) { if (/reply lost/.test(String(e))) return { kind: "lost" }; return { kind: "refused", message: String((e as Error).message) }; }
    } } };
    const r = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "exit-only", accounts: [a.id], maxCandlesPerAccount: 2 });
    expect(r.metrics.map((m) => m.code)).toEqual(["COMMITTED", "LOST_RESPONSE_RESENT", "COMMITTED", "CATCH_UP_LIMIT"]);
    expect(asked).toBe(0);
    const kinds = (await db.query<{ kind: string }>(`SELECT kind FROM public.futures_paper_events WHERE account_id=$1 AND bar_t >= $2 ORDER BY seq`, [a.id, t1])).rows.map((x) => x.kind);
    expect(kinds).toEqual(["exit_fill"]);
    expect(await pos(a.id)).toBeUndefined(); expect((await acct(a.id)).status).toBe("stopped");
    const again = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "exit-only", accounts: [a.id] });
    expect(again.metrics.map((m) => m.code)).toEqual(["ACCOUNT_STOPPED"]);
  });
});
