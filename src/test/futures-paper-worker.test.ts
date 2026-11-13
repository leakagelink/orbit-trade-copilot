// Phase 4F workstream C — the Futures PAPER worker core (disabled by default) over draft 0049 in PGlite (NOT applied
// anywhere real). Single-connection PGlite: leases are an in-memory map here; real advisory-lock leases, connection kills
// and concurrent sessions are in futures-paper-worker.pg.test.ts. No schedule, route or deployment exists.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { FPIntent } from "@/lib/futures-paper-engine";
import { FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT, WORKER_CODES, runFuturesPaperWorkerTick, type WorkerMetric, type WorkerPorts } from "@/lib/futures-paper-worker";
import type { RawSymbolBundle } from "@/lib/futures-paper-market-data";
import { CFG, M, accountBudget, as, freshUser, loadView, makeDb, newAccount, pglitePorts, rawBundle, strategyBudget, type OHLC } from "./helpers/fp-v3-harness";

let db: PGlite;
beforeAll(async () => { db = await makeDb(); }, 120_000);
const N = 12, T0 = Math.floor(Date.now() / M) * M - 200 * M, NOW = T0 + N * M + 3_000; // candles T0 … T0+(N−1)M are closed
const path = (sym: string, k: number): OHLC => { const b = sym === "BTCUSDT" ? 100 : 50, o = b + Math.sin(k / 2), c = b + Math.sin((k + 1) / 2); return [o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]; };
const market = (over?: (sym: string, barT: number, b: RawSymbolBundle) => RawSymbolBundle): WorkerPorts["market"] => ({
  candles: async (symbols, timeframe, barT) => symbols.map((s) => { const b = rawBundle(s, barT, M, { trade: path(s, (barT - T0) / M) }, NOW, timeframe); return over ? over(s, barT, b) : b; }),
});
const intents: WorkerPorts["intents"] = { forCandle: async (_a, barT): Promise<FPIntent[]> => { const k = (barT - T0) / M; if (k % 4 !== 0) return []; const c = path("BTCUSDT", k)[3]; return [{ maxHoldBars: 3, proposal: { proposalId: `wk-${_a.slice(-6)}-${k}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: k % 8 === 0 ? "LONG" : "SHORT", referencePrice: null, stopPrice: k % 8 === 0 ? c - 1 : c + 1, takeProfitPrice: k % 8 === 0 ? c + 2 : c - 2, createdAt: barT + M } }]; } };
async function setup() { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); const id = await newAccount(db, user, T0 - M); return { user, id }; }
const count = async (sql: string, p: unknown[]) => Number((await db.query<{ n: string }>(sql, p)).rows[0]!.n);
const codes = (ms: unknown[]) => (ms as WorkerMetric[]).map((m) => m.code);

describe("disabled by default", () => {
  it("the flag is off and a tick without enabled: true touches no port at all", async () => {
    expect(FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT).toBe(false);
    const boom = new Proxy({}, { get: () => { throw new Error("a port was touched"); } }) as WorkerPorts;
    const r = await runFuturesPaperWorkerTick(boom, { holder: "x", accounts: ["a", "b"] });
    expect(r).toEqual({ status: "disabled", committed: 0, halted: [], metrics: [{ code: "DISABLED", accountId: null, barT: null }] });
    expect((await runFuturesPaperWorkerTick(boom, { enabled: "true" as never, holder: "x", accounts: ["a"] })).status).toBe("disabled");
  });
});

describe("normal operation, catch-up bound, idempotency and recovery", () => {
  it("catches up in bounded batches, commits every candle exactly once, then waits for the next close", async () => {
    const { id } = await setup(); const { ports, metrics } = pglitePorts(db, { market: market(), intents, now: () => NOW });
    const a = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w1", accounts: [id], maxCandlesPerAccount: 5 });
    expect(a.committed).toBe(5); expect(codes(metrics)).toContain("CATCH_UP_LIMIT");
    const b = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w1", accounts: [id], maxCandlesPerAccount: 50 });
    expect(b.committed).toBe(N - 5); expect(codes(b.metrics).at(-1)).toBe("WAIT_CANDLE_NOT_CLOSED");
    expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBeGreaterThan(0);
    for (const m of metrics as WorkerMetric[]) expect(WORKER_CODES).toContain(m.code);
  });
  it("lease contention: a second holder is refused while the lease is held and commits nothing", async () => {
    const { id } = await setup(); const { ports, leases } = pglitePorts(db, { market: market(), intents, now: () => NOW });
    leases.set(id, "other");
    const r = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w2", accounts: [id] });
    expect(codes(r.metrics)).toEqual(["LEASE_BUSY"]); expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(0);
  });
  it("lost reply after a successful commit: the identical payload is resent once and returns the same sequence (no duplicate)", async () => {
    const { id } = await setup();
    const { ports, metrics } = pglitePorts(db, { market: market(), intents, now: () => NOW, afterCommit: (n) => { if (n === 1) throw new Error("LOST"); } });
    const r = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w", accounts: [id], maxCandlesPerAccount: 3 });
    expect(codes(metrics).slice(0, 2)).toEqual(["LOST_RESPONSE_RESENT", "COMMITTED"]); expect(r.committed).toBe(3);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(3);
  });
  it("crash BEFORE commit: nothing is written; the next tick recomputes the identical candle and commits it", async () => {
    const { id } = await setup(); let crash = true;
    const { ports } = pglitePorts(db, { market: market(), intents, now: () => NOW, beforeCommit: () => { if (crash) throw new Error("worker died before COMMIT"); } });
    const r1 = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w", accounts: [id] });
    expect(codes(r1.metrics)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(0);
    crash = false; const r2 = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w", accounts: [id], maxCandlesPerAccount: 50 });
    expect(r2.committed).toBe(N);
  });
  it("crash AFTER commit (both replies lost): the next tick reloads the committed cursor and continues; nothing is duplicated", async () => {
    const { id } = await setup();
    const { ports } = pglitePorts(db, { market: market(), intents, now: () => NOW, afterCommit: (n) => { if (n <= 2) throw new Error("LOST"); } });
    const r1 = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w", accounts: [id] });
    expect(codes(r1.metrics)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]); expect(r1.committed).toBe(0);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(1); // it did commit
    const r2 = await runFuturesPaperWorkerTick(ports, { enabled: true, holder: "w", accounts: [id], maxCandlesPerAccount: 50 });
    expect(r2.committed).toBe(N - 1);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
  });
  it("restart recovery is deterministic: a run interrupted every 3 candles ends byte-identical to an uninterrupted run", async () => {
    const a = await setup(), b = await setup();
    const one = pglitePorts(db, { market: market(), intents: { forCandle: (_x, t) => intents.forCandle("same-acct", t) }, now: () => NOW });
    await runFuturesPaperWorkerTick(one.ports, { enabled: true, holder: "u", accounts: [a.id], maxCandlesPerAccount: 50 });
    for (let i = 0; i < 6; i++) { const fresh = pglitePorts(db, { market: market(), intents: { forCandle: (_x, t) => intents.forCandle("same-acct", t).then((xs) => xs.map((x) => ({ ...x, proposal: { ...x.proposal, proposalId: `${x.proposal.proposalId}-b` } }))) }, now: () => NOW }); await runFuturesPaperWorkerTick(fresh.ports, { enabled: true, holder: `restart-${i}`, accounts: [b.id], maxCandlesPerAccount: 3 }); }
    const va = await loadView(db, a.id), vb = await loadView(db, b.id);
    expect(vb.seq).toBe(va.seq); expect(vb.cursorT).toBe(va.cursorT); expect(vb.state.wallet).toBe(va.state.wallet);
    const strip = (s: typeof va.state) => JSON.stringify({ ...s, seen: s.seen.map((x) => x.replace(/-b$/, "")), positions: Object.fromEntries(Object.entries(s.positions).map(([k, p]) => [k, { ...p, proposalId: p.proposalId.replace(/-b$/, "") }])) });
    expect(strip(vb.state)).toBe(strip(va.state));
  });
});

describe("data protection: duplicates, out-of-order, gaps — no commit", () => {
  it("identical duplicate rows are dropped and commit; conflicting duplicates, out-of-order rows and gaps stop the account without a commit", async () => {
    const { id } = await setup();
    const dup = pglitePorts(db, { market: market((_s, _t, b) => ({ ...b, trade: [...b.trade, ...b.trade] })), intents, now: () => NOW });
    expect((await runFuturesPaperWorkerTick(dup.ports, { enabled: true, holder: "d", accounts: [id], maxCandlesPerAccount: 1 })).committed).toBe(1);
    const cases: [string, (s: string, t: number, b: RawSymbolBundle) => RawSymbolBundle][] = [
      ["CANDLE_DUPLICATE_CONFLICT", (s, t, b) => (s === "ETHUSDT" ? { ...b, trade: [...b.trade, [t, "1", "2", "0.5", "1.5", "1", t + M - 1]] } : b)],
      ["CANDLE_OUT_OF_SEQUENCE", (_s, t, b) => ({ ...b, trade: [...b.trade, [t - M, "1", "2", "0.5", "1.5", "1", t - 1]] })],
      ["CANDLE_STALE_FEED", (s, t, b) => (s === "BTCUSDT" ? { ...b, trade: [[t - M, "1", "2", "0.5", "1.5", "1", t - 1]] } : b)],
      ["MARK_MISSING", (s, _t, b) => (s === "BTCUSDT" ? { ...b, mark: [] } : b)],
    ];
    for (const [want, f] of cases) {
      const before = await count(`SELECT count(*) n FROM public.futures_paper_events WHERE account_id=$1`, [id]);
      const p = pglitePorts(db, { market: market(f), intents, now: () => NOW });
      const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "d", accounts: [id] });
      expect(r.metrics[0], want).toMatchObject({ code: "DATA_INVALID", detailCode: want }); expect(r.committed).toBe(0);
      expect(await count(`SELECT count(*) n FROM public.futures_paper_events WHERE account_id=$1`, [id])).toBe(before);
    }
  });
  it("market port failures: bounded attempts with backoff, then DATA_UNAVAILABLE (no fabricated prices)", async () => {
    const { id } = await setup(); let calls = 0; const sleeps: number[] = [];
    const p = pglitePorts(db, { market: { candles: async () => { calls++; throw new Error("feed down"); } }, intents, now: () => NOW });
    p.ports.clock.sleep = async (ms) => { sleeps.push(ms); };
    const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "m", accounts: [id], fetchAttempts: 3, fetchBackoffMs: 100 });
    expect(calls).toBe(3); expect(sleeps).toEqual([100, 200]); expect(codes(r.metrics)).toEqual(["DATA_UNAVAILABLE"]);
  });
});

describe("database refusals: classified, bounded, never an ambiguous retry", () => {
  it("an approval the database refuses (proposal already evaluated in another account, unseen by a stale read) becomes a rejection; the candle then commits", async () => {
    const { user, id } = await setup(); const other = await newAccount(db, user, T0 - M);
    const shared: WorkerPorts["intents"] = { forCandle: async (_a, barT) => intents.forCandle("shared", barT) };
    await runFuturesPaperWorkerTick(pglitePorts(db, { market: market(), intents: shared, now: () => NOW }).ports, { enabled: true, holder: "o", accounts: [other], maxCandlesPerAccount: 1 });
    const p = pglitePorts(db, { market: market(), intents: shared, now: () => NOW });
    p.ports.db.evaluatedProposals = async () => []; // stale read: the database is the authority
    const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "s", accounts: [id], maxCandlesPerAccount: 1 });
    expect(r.metrics.map((m) => [m.code, m.detailCode ?? null])).toEqual([["RECOMPUTE", "APPROVAL_DUPLICATE_PROPOSAL"], ["COMMITTED", null], ["CATCH_UP_LIMIT", null]]);
    const ev = (await db.query<{ kind: string; reason: string }>(`SELECT kind, reason FROM public.futures_paper_events WHERE account_id=$1`, [id])).rows;
    expect(ev).toEqual([{ kind: "order_rejected", reason: "[APPROVAL_DUPLICATE_PROPOSAL] the database refused this approval at commit" }]);
  });
  it("multi-symbol atomicity: one inconsistent symbol refuses the WHOLE candle (nothing for the other symbol), and the account is paused for review — never retried", async () => {
    const { id } = await setup();
    const p = pglitePorts(db, { market: market(), intents, now: () => NOW });
    await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id], maxCandlesPerAccount: 1 }); // approval at candle 0
    const orig = p.ports.db.commit;
    p.ports.db.commit = (a, s, t, payload) => { const x = payload as { events: { kind: string; fee: number }[] }; return orig(a, s, t, { ...x, events: x.events.map((e) => (e.kind === "entry_fill" ? { ...e, fee: e.fee / 2 } : e)) }); };
    const before = await count(`SELECT count(*) n FROM public.futures_paper_candles WHERE account_id=$1`, [id]);
    const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id] });
    expect(r.metrics.map((m) => [m.code, m.detailCode ?? null])).toEqual([["HALT_FOR_REVIEW", "FILL_INCONSISTENT"]]);
    expect(await count(`SELECT count(*) n FROM public.futures_paper_candles WHERE account_id=$1`, [id])).toBe(before); // neither BTC nor ETH recorded
    const a = (await db.query<{ status: string; status_reason: string }>(`SELECT status, status_reason FROM public.futures_paper_accounts WHERE id=$1`, [id])).rows[0]!;
    expect(a).toEqual({ status: "paused", status_reason: "review:FILL_INCONSISTENT" });
  });
  it("a paused (review) account keeps running exits: entries are refused, positions still close", async () => {
    const { id } = await setup();
    const p = pglitePorts(db, { market: market(), intents, now: () => NOW });
    await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id], maxCandlesPerAccount: 2 }); // approval + fill
    expect(Object.keys((await loadView(db, id)).state.positions)).toEqual(["BTCUSDT"]);
    await as(db, "service_role", `UPDATE public.futures_paper_accounts SET status='paused', status_reason='review:test' WHERE id=$1`, [id]);
    const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id], maxCandlesPerAccount: 50 });
    expect(r.committed).toBe(N - 2);
    const kinds = (await db.query<{ kind: string }>(`SELECT kind FROM public.futures_paper_events WHERE account_id=$1 AND bar_t >= $2`, [id, T0 + 2 * M])).rows.map((x) => x.kind);
    expect(kinds).toContain("exit_fill"); expect(kinds).not.toContain("order_accepted"); expect(kinds).not.toContain("entry_fill");
  });
  it("a refusal that keeps coming back is bounded: recompute once, then REFUSAL_REPEATED halts; unknown messages halt immediately", async () => {
    const { id } = await setup(); const p = pglitePorts(db, { market: market(), intents, now: () => NOW });
    await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id], maxCandlesPerAccount: 1 });
    p.ports.db.commit = async () => ({ kind: "refused", message: "exposure 9 would exceed 1 at fill" });
    const r = await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id] });
    expect(r.metrics.map((m) => [m.code, m.detailCode ?? null])).toEqual([["RECOMPUTE", "EXPOSURE_LIMIT"], ["HALT_FOR_REVIEW", "REFUSAL_REPEATED"]]);
    const { id: id2 } = await setup(); const q = pglitePorts(db, { market: market(), intents, now: () => NOW });
    q.ports.db.commit = async () => ({ kind: "refused", message: "something nobody wrote" });
    expect((await runFuturesPaperWorkerTick(q.ports, { enabled: true, holder: "b", accounts: [id2] })).metrics.map((m) => m.detailCode)).toEqual(["UNCLASSIFIED_REFUSAL"]);
    q.ports.db.commit = async () => ({ kind: "transient", message: "connection reset" });
    const { id: id3 } = await setup();
    expect(codes((await runFuturesPaperWorkerTick(q.ports, { enabled: true, holder: "c", accounts: [id3] })).metrics)).toEqual(["TRANSIENT_DB_ERROR"]);
  });
  it("a stopped account is left alone; a ledger/state mismatch halts for review before any step", async () => {
    const { id } = await setup(); const p = pglitePorts(db, { market: market(), intents, now: () => NOW });
    await as(db, "service_role", `UPDATE public.futures_paper_accounts SET status='stopped' WHERE id=$1`, [id]);
    expect(codes((await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id] })).metrics)).toEqual(["ACCOUNT_STOPPED"]);
    const { id: id2 } = await setup();
    await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id2], maxCandlesPerAccount: 1 });
    const load = p.ports.db.load; p.ports.db.load = async (x) => { const v = await load(x); v.ledger.approvals = {}; return v; }; // ledger lost the approval
    expect((await runFuturesPaperWorkerTick(p.ports, { enabled: true, holder: "a", accounts: [id2] })).metrics.map((m) => m.code)).toEqual(["LEDGER_STATE_MISMATCH", "HALT_FOR_REVIEW"]);
  });
});
