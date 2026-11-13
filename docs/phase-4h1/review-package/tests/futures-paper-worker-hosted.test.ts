// Phase 4G workstreams C/D — the hosted worker connection (DISABLED by default) driven end to end over DRAFT 0049 +
// DRAFT 0050 in PGlite through an emulated Data API (one call = one READ COMMITTED statement as service_role). Neither
// migration is applied anywhere real; no route, schedule or network is involved. Policy values are TEST INPUTS.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerMetric, WorkerPorts } from "@/lib/futures-paper-worker";
import { HOSTED_WORKER_ENABLED_BY_DEFAULT, createHostedWorkerPorts, runHostedFuturesPaperWorkerTick, type HostedMetric, type HostedRpc } from "@/lib/futures-paper-worker-hosted";
import { M, accountBudget, as, freshUser, newAccount, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, HOLDER_B, NOW, callFn, expireLease, intentsFrom, makeGatewayDb, marketFrom, n, pgliteRpc, type ShimHooks } from "./helpers/fp-gateway-harness";

let db: PGlite;
beforeAll(async () => { db = await makeGatewayDb(); }, 120_000);
const N = 12, T0 = NOW - 3_000 - N * M; // N closed one-minute candles
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
async function setup(strategyMax = 500) { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", strategyMax); return { user, id: await newAccount(db, user, T0 - M, CFG_H) }; }
function tick(id: string | string[], o: { hooks?: ShimHooks; market?: WorkerPorts["market"]; intents?: WorkerPorts["intents"]; holder?: string; max?: number; rpc?: HostedRpc; timeoutMs?: number } = {}) {
  const seen: (HostedMetric | WorkerMetric)[] = [];
  return runHostedFuturesPaperWorkerTick({
    enabled: true, rpc: o.rpc ?? pgliteRpc(db, o.hooks), holder: o.holder ?? HOLDER_A, accounts: Array.isArray(id) ? id : [id], maxCandlesPerAccount: o.max ?? 50,
    market: o.market ?? marketFrom(T0), intents: o.intents ?? intentsFrom(T0, `h${Math.random().toString(36).slice(2, 7)}`), clock,
    monitor: { record: (m) => { seen.push(m); } }, hosted: { timeoutMs: o.timeoutMs ?? 2_000 },
  }).then((r) => ({ ...r, seen }));
}
const commits = (id: string) => n(db, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id]);
const codes = (ms: { code: string }[]) => ms.map((m) => m.code);
const leaseOpen = async (id: string) => n(db, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE account_id=$1 AND expires_at > clock_timestamp()`, [id]);

describe("disabled by default", () => {
  it("off unless enabled: true; no port or database function is touched", async () => {
    expect(HOSTED_WORKER_ENABLED_BY_DEFAULT).toBe(false);
    const boom = (() => { throw new Error("rpc touched"); }) as unknown as HostedRpc;
    const trap = new Proxy({}, { get: () => { throw new Error("port touched"); } }) as never;
    const r = await runHostedFuturesPaperWorkerTick({ rpc: boom, holder: HOLDER_A, accounts: ["a"], market: trap, intents: trap, clock: trap } as never);
    expect(r.status).toBe("disabled"); expect(r.committed).toBe(0);
    expect((await runHostedFuturesPaperWorkerTick({ enabled: "true", rpc: boom, holder: HOLDER_A, accounts: ["a"], market: trap, intents: trap, clock: trap } as never)).status).toBe("disabled");
  });
  it("a holder that is not a UUID is refused before any call", () => {
    expect(() => createHostedWorkerPorts({ rpc: (() => { throw new Error("x"); }) as never, holder: "worker-1", clock })).toThrow(/UUID/);
  });
});

describe("normal operation over the gateway", () => {
  it("catches up, records provenance for every candle, creates approvals and releases the lease", async () => {
    const { id } = await setup(); const r = await tick(id);
    expect(r.committed).toBe(N); expect(await commits(id)).toBe(N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_candle_provenance WHERE account_id=$1`, [id])).toBe(2 * N);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBeGreaterThan(0);
    expect(await leaseOpen(id)).toBe(0);
    expect(codes(r.metrics).filter((c) => ["HALT_FOR_REVIEW", "RECOMPUTE", "UNKNOWN_OUTCOME"].includes(c))).toEqual([]);
    expect(codes(r.hosted).filter((c) => !["LEASE_ACQUIRED", "LEASE_RELEASED"].includes(c))).toEqual([]);
  });
  it("two independent accounts in one tick: a failure on one never stops the other", async () => {
    const a = await setup(), b = await setup();
    const r = await tick([a.id, b.id], { hooks: { before: (_fn, args) => (args["p_account"] === a.id ? "throw" : undefined) } });
    expect(await commits(a.id)).toBe(0); expect(await commits(b.id)).toBe(N);
    expect(codes(r.hosted)).toContain("RPC_NO_RESPONSE");
  });
});

describe("operational failures", () => {
  it("database unavailable: nothing is processed, nothing throws, nothing is written", async () => {
    const { id } = await setup(); const r = await tick(id, { hooks: { before: () => "throw" } });
    expect(r.status).toBe("ran"); expect(r.committed).toBe(0); expect(codes(r.metrics)).toEqual(["LEASE_BUSY"]); expect(codes(r.hosted)).toEqual(["RPC_NO_RESPONSE"]);
    expect(await commits(id)).toBe(0);
  });
  it("connection timeout on commit: aborted at the deadline, resent once, then left for the next tick — committed exactly once", async () => {
    const { id } = await setup(); let hangs = 2;
    const r = await tick(id, { timeoutMs: 50, hooks: { before: (fn) => (fn === "fpw_commit" && hangs-- > 0 ? "hang" : undefined) } });
    expect(codes(r.metrics)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]); expect(codes(r.hosted).filter((c) => c === "RPC_TIMEOUT")).toHaveLength(2);
    expect(await commits(id)).toBe(0);
    const r2 = await tick(id); expect(r2.committed).toBe(N); expect(await commits(id)).toBe(N);
  });
  it("reply lost AFTER the database committed: the identical resend returns the committed sequence; nothing is duplicated", async () => {
    const { id } = await setup(); let lose = 1;
    const r = await tick(id, { hooks: { after: (fn, reply) => (fn === "fpw_commit" && lose-- > 0 ? "throw" : reply) } });
    expect(codes(r.metrics).slice(0, 2)).toEqual(["LOST_RESPONSE_RESENT", "COMMITTED"]); expect(r.committed).toBe(N);
    expect(await commits(id)).toBe(N); expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_candle_provenance WHERE account_id=$1`, [id])).toBe(2 * N);
  });
  it("worker restart during a transaction (rolled back mid-commit): nothing survives; the resend commits it once", async () => {
    const { id } = await setup(); let crash = 1;
    const r = await tick(id, { hooks: { before: async (fn, args) => {
      if (fn !== "fpw_commit" || crash-- <= 0) return undefined;
      await db.exec("BEGIN"); const inTx = await callFn(db, fn, args); await db.exec("ROLLBACK");
      expect(inTx.error).toBeNull(); return "throw"; // the process died before COMMIT
    } } });
    expect(codes(r.metrics).slice(0, 2)).toEqual(["LOST_RESPONSE_RESENT", "COMMITTED"]); expect(await commits(id)).toBe(N);
  });
  it("snapshot unavailable mid-tick: the account stops for this tick without a halt; the next tick resumes", async () => {
    const { id } = await setup(); let snaps = 0;
    const r = await tick(id, { hooks: { before: (fn) => (fn === "fpw_snapshot" && ++snaps === 3 ? "throw" : undefined) } });
    expect(r.committed).toBe(2); expect(codes(r.metrics).at(-1)).toBe("LOAD_FAILED"); expect(r.halted).toEqual([]);
    expect((await tick(id)).committed).toBe(N - 2);
  });
  it("lease taken over mid-tick: the old holder's next commit is refused as transient, writes nothing and halts nothing", async () => {
    const { id } = await setup(); let done = 0;
    const r = await tick(id, { hooks: { before: async (fn) => {
      // Taken over between this worker's snapshot and its commit (e.g. a stalled process whose lease expired).
      if (fn === "fpw_commit" && ++done === 3) { await expireLease(db, id); await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: HOLDER_B, p_ttl_seconds: 60 }); }
      return undefined;
    } } });
    expect(r.committed).toBe(2); expect(await commits(id)).toBe(2); expect(r.halted).toEqual([]);
    expect(codes(r.hosted)).toContain("LEASE_LOST"); expect(codes(r.metrics).at(-1)).toBe("TRANSIENT_DB_ERROR");
  });
  it("two workers competing for one account: the second is refused the lease and writes nothing", async () => {
    const { id } = await setup();
    await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: HOLDER_B, p_ttl_seconds: 60 });
    const r = await tick(id); expect(codes(r.metrics)).toEqual(["LEASE_BUSY"]); expect(await commits(id)).toBe(0);
  });
});

describe("market data refused before any commit", () => {
  const cases: [string, (s: string, t: number, b: ReturnType<ReturnType<typeof marketFrom>["candles"]> extends Promise<(infer B)[]> ? B : never) => unknown, string][] = [
    ["conflicting duplicate candle", (_s, _t, b) => ({ ...b, trade: [b.trade[0], [...(b.trade[0] as unknown[]).slice(0, 5), "999", ...(b.trade[0] as unknown[]).slice(6)]] }), "CANDLE_DUPLICATE_CONFLICT"],
    ["out-of-order candles", (_s, t, b) => ({ ...b, trade: [b.trade[0], [t - M, "1", "1", "1", "1", "1", t - 1]] }), "CANDLE_OUT_OF_SEQUENCE"],
    ["missing mark price", (_s, _t, b) => ({ ...b, mark: [] }), "MARK_MISSING"],
    ["stale feed (newest candle before the requested one)", (_s, t, b) => ({ ...b, trade: [[t - M, "100", "101", "99", "100", "1", t - 1]] }), "CANDLE_STALE_FEED"],
    ["unverified source", (_s, _t, b) => ({ ...b, source: "some-other-feed" }), "SOURCE_MISMATCH"],
  ];
  for (const [why, over, code] of cases) it(`${why} → ${code}`, async () => {
    const { id } = await setup(); const r = await tick(id, { market: marketFrom(T0, over as never) });
    expect(r.metrics.map((m) => [m.code, (m as WorkerMetric).detailCode])).toEqual([["DATA_INVALID", code]]); expect(await commits(id)).toBe(0);
  });
  it("a fetch older than the provenance window is refused by the connection (nothing committed)", async () => {
    const { id } = await setup(); const r = await tick(id, { market: marketFrom(T0, undefined, () => NOW - 5 * 60_000 + 1) });
    expect(await commits(id)).toBe(0);
    expect(r.hosted.filter((m) => m.code === "PROVENANCE_INVALID").map((m) => m.detailCode)).toEqual(["PROVENANCE_FETCH_STALE"]);
  });
  it("candles too old for new entries: intents are withheld; exits and bookkeeping continue", async () => {
    const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500);
    const id = await newAccount(db, user, T0 - M); // 5 s data age (test input) — every candle here is older
    const r = await tick(id);
    expect(r.committed).toBe(N); expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBe(0);
    expect(r.hosted.filter((m) => m.code === "ENTRY_WINDOW_MISSED").length).toBeGreaterThan(0);
  });
});

describe("database refusals", () => {
  it("approval refusal: a snapshot overstating the budget makes the database refuse; the proposal becomes a rejection, never a fill", async () => {
    const { id } = await setup(3);
    const r = await tick(id, { hooks: { after: (fn, reply) => {
      if (fn === "fpw_snapshot" && reply.data) { const d = reply.data as { usage: { max_loss: number }[] }; d.usage = d.usage.map((u) => ({ ...u, max_loss: 500 })); }
      return reply;
    } } });
    expect(r.metrics.filter((m) => m.code === "RECOMPUTE").map((m) => (m as WorkerMetric).detailCode)).toContain("APPROVAL_STRATEGY_BUDGET");
    expect(r.halted).toEqual([]);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBe(0);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='order_rejected'`, [id])).toBeGreaterThan(0);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [id])).toBe(0);
  });
  it("commit refusal → halt for review (audited); while paused no entry is made, exits continue; the owner's resume is audited and entries resume", async () => {
    const { id } = await setup(); let tamper = true;
    const hooks: ShimHooks = { before: (fn, args) => {
      if (fn === "fpw_commit" && tamper) { const p = args["p_payload"] as { events: { kind: string; margin_delta: number }[] }; if (p.events.some((e) => e.kind === "entry_fill")) args["p_payload"] = { ...p, events: p.events.map((e) => (e.kind === "entry_fill" ? { ...e, margin_delta: e.margin_delta * 2 } : e)) }; }
      return undefined;
    } };
    const r = await tick(id, { hooks, max: 3 });
    expect(r.halted).toEqual([id]); expect(r.metrics.at(-1)).toMatchObject({ code: "HALT_FOR_REVIEW", detailCode: "FILL_INCONSISTENT" });
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND kind='entry_fill'`, [id])).toBe(0);
    const st = (await db.query<{ status: string; status_reason: string }>(`SELECT status, status_reason FROM public.futures_paper_accounts WHERE id=$1`, [id])).rows[0]!;
    expect(st).toEqual({ status: "paused", status_reason: "review:FILL_INCONSISTENT" });
    tamper = false;
    const before = await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id]);
    const seqAtPause = await n(db, `SELECT seq::int n FROM public.futures_paper_accounts WHERE id=$1`, [id]);
    const p = await tick(id, { max: 4 }); expect(p.committed).toBe(4); expect(p.halted).toEqual([]);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBe(before);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1 AND seq > $2 AND kind IN ('entry_fill','order_accepted')`, [id, seqAtPause])).toBe(0);
    await as(db, "service_role", `UPDATE public.futures_paper_accounts SET status='active', status_reason=NULL WHERE id=$1`, [id]); // owner recovery
    await tick(id);
    expect(await n(db, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE account_id=$1`, [id])).toBeGreaterThan(before);
    expect((await db.query<{ code: string }>(`SELECT code FROM public.futures_paper_worker_audit WHERE account_id=$1 ORDER BY id`, [id])).rows.map((x) => x.code))
      .toEqual(["STATUS:ACTIVE>PAUSED", "REVIEW:FILL_INCONSISTENT", "STATUS:PAUSED>ACTIVE"]);
  });
});

describe("secrets and cross-account access", () => {
  const SECRET = "apikey=sb_secret_ABCDEF123 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl postgres://svc:pw@db.example:5432/x";
  it("a database error carrying secret-like text never reaches monitoring; the refusal text the planner sees is redacted", async () => {
    const { id } = await setup(); const seen: unknown[] = [];
    const rpc = pgliteRpc(db, { after: (fn, reply) => (fn === "fpw_commit" ? { data: null, error: { code: "P0001", message: `unexpected internal failure ${SECRET}` }, status: 400 } : reply) });
    const p = createHostedWorkerPorts({ rpc, holder: HOLDER_A, clock, monitor: { record: (m) => seen.push(m) } });
    const market = p.wrapMarket(marketFrom(T0));
    expect(await p.db.tryAcquireLease(id, HOLDER_A)).toBe(true);
    const v = await p.db.load(id); await market.candles(v.symbols, v.timeframe, T0);
    const out = await p.db.commit(id, v.seq, T0, { events: [], state: v.state, candles: {} });
    expect(out.kind).toBe("refused"); await p.db.releaseLease(id, HOLDER_A);
    const msg = (out as { message: string }).message;
    for (const s of ["sb_secret_ABCDEF123", "eyJhbGciOiJIUzI1NiJ9", "svc:pw", "apikey=sb"]) expect(msg).not.toContain(s);
    const r = await tick(id, { rpc });
    const dump = JSON.stringify([seen, r]);
    for (const s of ["sb_secret", "eyJ", "svc:pw", "unexpected internal failure", "Bearer"]) expect(dump).not.toContain(s);
    expect(r.halted).toEqual([id]); // an unrecognised refusal is never retried
  });
  it("the connection refuses to ask for another owner's proposals (before any call); the database refuses it too", async () => {
    const a = await setup(), b = await setup(); const rpc = pgliteRpc(db);
    const p = createHostedWorkerPorts({ rpc, holder: HOLDER_A, clock });
    await p.db.tryAcquireLease(a.id, HOLDER_A); await p.db.load(a.id);
    await expect(p.db.evaluatedProposals(b.user, ["x"])).rejects.toThrow(/CROSS_ACCOUNT_REFUSED/);
    expect(rpc.calls).not.toContain("fpw_evaluated");
    await expect(p.db.evaluatedProposals(a.user, ["x"])).resolves.toEqual([]);
  });
});
