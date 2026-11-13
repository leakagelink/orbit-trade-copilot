// Phase 4G workstream D — the hosted worker connection (DISABLED by default; enabled explicitly here) over DRAFT 0049 +
// DRAFT 0050 on a real, throwaway PostgreSQL with genuinely concurrent sessions. Every call emulates the hosted Data API:
// its own READ COMMITTED transaction as service_role. Covers fenced lease contention and takeover, client timeouts with
// and without server-side cancellation, a backend killed mid-commit, independent accounts in parallel, a same-owner
// budget race, and finding G3 (0049 alone lets a REPEATABLE READ caller overspend a budget; the gateway refuses it).
// Run via scripts/futures-paper/concurrency-check-4g.sh; skipped without FUTURES_PAPER_PG_URL. Never the live database.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, type FPIntent } from "@/lib/futures-paper-engine";
import { selectClosedCandles } from "@/lib/futures-paper-market-data";
import { viewFromRows, type WorkerMetric, type WorkerPorts } from "@/lib/futures-paper-worker";
import { FP_SQL } from "@/lib/futures-paper-worker-queries";
import { runHostedFuturesPaperWorkerTick, type HostedMetric, type HostedRpc } from "@/lib/futures-paper-worker-hosted";
import { CFG, rawBundle, stepView } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, HOLDER_B, NOW, intentsFrom, marketFrom } from "./helpers/fp-gateway-harness";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const M49 = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8"), M50 = readFileSync("docs/proposed-migrations/0050_futures_paper_worker_gateway.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, N = 12, T0 = NOW - 3_000 - N * M;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string, max = 2) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb(gateway = true) {
  const admin = connect(URL!, 1), name = `fpaper4g_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); await owner.unsafe(M49); if (gateway) await owner.unsafe(M50);
  return { url, owner };
}
const asService = <T,>(sql: Sql, f: (tx: Sql) => Promise<T>, iso?: string) => sql.begin(iso ?? "", async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return f(tx as unknown as Sql); }) as Promise<T>;
async function account(owner: Sql, user: string, cfg = CFG_H) {
  const r = await asService(owner, (tx) => tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, cfg, initialFuturesPaperState(1000)] as never[]));
  const id = String(r[0]!["id"]);
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const budgets = (owner: Sql, user: string, s1: number) => asService(owner, async (tx) => {
  await tx.unsafe(`INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',1000,400,600)`, [user]);
  await tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,'s1','paper','scalping',$2)`, [user, s1]);
});
const num = async (sql: Sql, q: string, p: unknown[] = []) => Number((await sql.unsafe(q, p as never[]))[0]!["n"]);
const commitsOf = (sql: Sql, id: string) => num(sql, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id]);

const CAST: Record<string, string> = { p_account: "::uuid", p_holder: "::uuid", p_user: "::uuid", p_fence: "::bigint", p_expected_seq: "::bigint", p_bar_t: "::bigint", p_ttl_seconds: "::integer", p_payload: "::jsonb", p_provenance: "::jsonb", p_code: "::text" };
/** Data API emulation over a real pool: one call = one READ COMMITTED transaction; driver connection errors are thrown (no reply). */
function pgRpc(sql: Sql, o: { cancelOnAbort?: boolean; autocommit?: boolean } = {}): HostedRpc {
  return async (fn, args, signal) => {
    const keys = Object.keys(args), params: unknown[] = [];
    const list = keys.map((k) => { params.push(args[k]); // postgres.js serializes jsonb parameters itself
      return k === "p_ids" ? `${k} => ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))` : `${k} => $${params.length}${CAST[k] ?? ""}`; });
    try {
      // autocommit: a connection whose session role is already service_role runs the call as one implicit transaction
      // (used where the backend is killed: postgres.js 3.4.9 schedules its ROLLBACK write on the dead socket otherwise).
      const rows = o.autocommit ? await sql.unsafe(`SELECT public.${fn}(${list.join(", ")}) AS r`, params as never[]) : await asService(sql, async (tx) => {
        const q = tx.unsafe(`SELECT public.${fn}(${list.join(", ")}) AS r`, params as never[]);
        const onAbort = () => { try { Promise.resolve(q.cancel()).catch(() => {}); } catch { /* connection already gone */ } };
        if (o.cancelOnAbort !== false) signal.addEventListener("abort", onAbort, { once: true });
        try { return await q; } finally { signal.removeEventListener("abort", onAbort); }
      });
      return { data: rows[0]!["r"] ?? null, error: null, status: 200 };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { data: null, error: { code, message: (e as Error).message }, status: 400 };
      throw e;
    }
  };
}
const clock: WorkerPorts["clock"] = { now: () => NOW, sleep: async () => {} };
function tick(rpc: HostedRpc, id: string | string[], o: { holder?: string; max?: number; timeoutMs?: number; intents?: WorkerPorts["intents"] } = {}) {
  return runHostedFuturesPaperWorkerTick({ enabled: true, rpc, holder: o.holder ?? HOLDER_A, accounts: Array.isArray(id) ? id : [id], maxCandlesPerAccount: o.max ?? 50,
    market: marketFrom(T0), intents: o.intents ?? intentsFrom(T0, `pg${Math.random().toString(36).slice(2, 7)}`), clock, hosted: { timeoutMs: o.timeoutMs ?? 5_000 } });
}
const codes = (ms: (HostedMetric | WorkerMetric)[]) => ms.map((m) => m.code);
const holder = (i: number) => `00000000-0000-4000-8000-0000000c${String(i).padStart(4, "0")}`;
const waitFor = async (f: () => Promise<boolean>, ms = 15_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 50)); } };
function holdAccountLock(owner: Sql, id: string) {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let locked!: () => void; const ready = new Promise<void>((r) => { locked = r; });
  const done = owner.begin(async (tx) => { await tx.unsafe(`SELECT id FROM public.futures_paper_accounts WHERE id=$1 FOR NO KEY UPDATE`, [id]); locked(); await gate; }); // blocks the commit's FOR UPDATE, not the lease's foreign-key check
  return { ready, release: async () => { release(); await done; } };
}

describe.skipIf(!URL)("hosted worker connection on real PostgreSQL sessions", () => {
  it("four workers compete for one account: fenced lease rows serialize them; every candle commits exactly once; no lease is left held", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000c01"; await budgets(owner, user, 500); const id = await account(owner, user);
    const ws = [0, 1, 2, 3].map((i) => ({ rpc: pgRpc(connect(url)), h: holder(i) }));
    const all: (HostedMetric | WorkerMetric)[] = [];
    for (let round = 0; round < 40 && (await commitsOf(owner, id)) < N; round++) {
      const rs = await Promise.all(ws.map((w) => tick(w.rpc, id, { holder: w.h, max: 2 }))); for (const r of rs) all.push(...r.metrics, ...r.hosted);
    }
    expect(await commitsOf(owner, id)).toBe(N);
    expect(codes(all).filter((c) => c === "LEASE_BUSY").length).toBeGreaterThan(0);
    expect(codes(all).filter((c) => ["HALT_FOR_REVIEW", "UNKNOWN_OUTCOME", "RPC_REFUSED"].includes(c))).toEqual([]);
    const fills = await owner.unsafe(`SELECT fill_id FROM public.futures_paper_events WHERE account_id=$1 AND fill_id IS NOT NULL`, [id]);
    expect(new Set(fills.map((r) => r["fill_id"])).size).toBe(fills.length);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE expires_at > clock_timestamp()`)).toBe(0);
  }, 120_000);

  it("a stalled holder whose lease was taken over cannot commit (fencing); the new holder finishes; nothing is duplicated", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000c02"; await budgets(owner, user, 500); const id = await account(owner, user);
    const base = pgRpc(connect(url)); let k = 0;
    const stalled: HostedRpc = async (fn, args, signal) => {
      if (fn === "fpw_commit" && ++k === 3) { // A stalls; its lease expires; B takes over and commits two candles
        await owner.unsafe(`UPDATE public.futures_paper_worker_leases SET expires_at = clock_timestamp() - interval '1 s' WHERE account_id=$1`, [id]);
        const rb = await tick(pgRpc(connect(url)), id, { holder: HOLDER_B, max: 2 }); expect(rb.committed).toBe(2);
      }
      return base(fn, args, signal);
    };
    const ra = await tick(stalled, id);
    expect(ra.committed).toBe(2); expect(codes(ra.hosted)).toContain("LEASE_LOST"); expect(ra.halted).toEqual([]);
    expect(await commitsOf(owner, id)).toBe(4);
    const rc = await tick(base, id); expect(rc.committed).toBe(N - 4); expect(await commitsOf(owner, id)).toBe(N);
  }, 120_000);

  it("client timeout WITH server-side cancellation: nothing is written; the next tick commits each candle once", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000c03"; await budgets(owner, user, 500); const id = await account(owner, user);
    const lock = holdAccountLock(owner, id); await lock.ready;
    const r = await tick(pgRpc(connect(url)), id, { timeoutMs: 400 });
    expect(codes(r.metrics)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]); expect(codes(r.hosted).filter((c) => c === "RPC_TIMEOUT")).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 300));
    expect(await commitsOf(owner, id)).toBe(0);
    await lock.release();
    await waitFor(async () => (await num(owner, `SELECT count(*)::int n FROM pg_stat_activity WHERE query LIKE '%fpw_commit%' AND state = 'active' AND pid <> pg_backend_pid()`)) === 0);
    expect(await commitsOf(owner, id)).toBe(0);
    await waitFor(async () => (await num(owner, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE expires_at > clock_timestamp()`)) === 0);
    const r2 = await tick(pgRpc(connect(url)), id); expect(r2.committed).toBe(N); expect(await commitsOf(owner, id)).toBe(N);
  }, 120_000);

  it("client timeout WITHOUT cancellation (the server finishes later): the first attempt commits, the resend replays it; the next tick continues — exactly once", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000c04"; await budgets(owner, user, 500); const id = await account(owner, user);
    const lock = holdAccountLock(owner, id); await lock.ready;
    const rpc = pgRpc(connect(url, 4), { cancelOnAbort: false });
    const r = await tick(rpc, id, { timeoutMs: 400 });
    expect(codes(r.metrics)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]);
    await lock.release();
    await waitFor(async () => (await commitsOf(owner, id)) === 1);
    await waitFor(async () => (await num(owner, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE expires_at > clock_timestamp()`)) === 0);
    expect(await num(owner, `SELECT count(*)::int n FROM public.futures_paper_candle_provenance WHERE account_id=$1`, [id])).toBe(2);
    const r2 = await tick(pgRpc(connect(url)), id); expect(r2.committed).toBe(N - 1); expect(await commitsOf(owner, id)).toBe(N);
  }, 120_000);

  it("a backend killed in the middle of a commit: the transaction rolls back; no halt; the candle is committed once later", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000c05"; await budgets(owner, user, 500); const id = await account(owner, user);
    const lock = holdAccountLock(owner, id); await lock.ready;
    const direct = postgres(url, { max: 2, onnotice: () => {}, idle_timeout: 5, connection: { role: "service_role" } }); opened.push(direct);
    expect((await direct.unsafe(`SELECT current_user AS u, current_setting('transaction_isolation') AS i`))[0]).toEqual({ u: "service_role", i: "read committed" });
    const running = tick(pgRpc(direct, { autocommit: true }), id, { timeoutMs: 3_000 });
    await waitFor(async () => (await num(owner, `SELECT count(*)::int n FROM pg_stat_activity WHERE query LIKE '%fpw_commit%' AND wait_event_type = 'Lock'`)) === 1);
    await owner.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%fpw_commit%' AND wait_event_type = 'Lock'`);
    await new Promise((res) => setTimeout(res, 200)); await lock.release();
    const r = await running;
    expect(r.halted).toEqual([]); expect(codes(r.metrics)).not.toContain("HALT_FOR_REVIEW");
    await waitFor(async () => (await num(owner, `SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE expires_at > clock_timestamp()`)) === 0, 130_000);
    const r2 = await tick(pgRpc(connect(url)), id); expect(await commitsOf(owner, id)).toBe(N); expect(r.committed + r2.committed).toBe(N);
  }, 180_000);

  it("two independent accounts (different owners) processed concurrently: both complete; neither waits for the other's lease", async () => {
    const { url, owner } = await freshDb(); const ua = "00000000-0000-4000-8000-000000000c06", ub = "00000000-0000-4000-8000-000000000c07";
    await budgets(owner, ua, 500); await budgets(owner, ub, 500); const a = await account(owner, ua), b = await account(owner, ub);
    const [ra, rb] = await Promise.all([tick(pgRpc(connect(url)), a, { holder: holder(10) }), tick(pgRpc(connect(url)), b, { holder: holder(11) })]);
    expect([ra.committed, rb.committed]).toEqual([N, N]); expect(codes([...ra.metrics, ...rb.metrics])).not.toContain("LEASE_BUSY");
    expect(await num(owner, `SELECT count(DISTINCT user_id)::int n FROM public.futures_paper_candle_provenance`)).toBe(2);
  }, 120_000);

  it("same-owner budget race through the gateway: one approval is refused and becomes a rejection — usage never exceeds the budget", async () => {
    const { url, owner } = await freshDb();
    for (let round = 0; round < 3; round++) {
      const user = `00000000-0000-4000-8000-00000000c1${round}0`; await budgets(owner, user, 12);
      const ids = [await account(owner, user), await account(owner, user)];
      const only = (i: number): WorkerPorts["intents"] => ({ forCandle: async (acct, barT) => (barT === T0 ? (await intentsFrom(T0, `race${round}-${i}`).forCandle(acct, barT)) : []) });
      const rs = await Promise.all(ids.map((id, i) => tick(pgRpc(connect(url)), id, { holder: holder(20 + i), max: 1, intents: only(i) })));
      expect(rs.flatMap((r) => r.halted)).toEqual([]);
      const approvals = await num(owner, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE user_id=$1`, [user]);
      const recomputes = rs.flatMap((r) => r.metrics).filter((m) => m.code === "RECOMPUTE");
      expect(approvals + recomputes.length).toBe(2);
      expect(Number((await owner.unsafe(`SELECT public.fp3_usage($1::uuid, 's1', NULL) AS u`, [user]))[0]!["u"])).toBeLessThanOrEqual(12 + 1e-9);
    }
  }, 120_000);

  it("G3: on 0049 alone a REPEATABLE READ caller overspends a shared budget; READ COMMITTED does not; the 0050 gateway refuses REPEATABLE READ", async () => {
    for (const iso of ["ISOLATION LEVEL REPEATABLE READ", "ISOLATION LEVEL READ COMMITTED"]) {
      const { url, owner } = await freshDb(false); const user = `00000000-0000-4000-8000-0000000c3${iso.includes("REPEAT") ? "001" : "002"}`;
      await budgets(owner, user, 12); const a = await account(owner, user, CFG), b = await account(owner, user, CFG);
      const bundles = ["BTCUSDT", "ETHUSDT"].map((s) => rawBundle(s, T0, M, { trade: s === "BTCUSDT" ? [100, 100.4, 99.6, 100.2] : [50, 50.2, 49.8, 50.1] }, NOW));
      const chk = selectClosedCandles(bundles, { symbols: ["BTCUSDT", "ETHUSDT"], timeframe: "1m", barT: T0, now: NOW, closeGraceMs: 2_000, maxFutureSkewMs: 5_000 }); if (!chk.ok) throw new Error(chk.code);
      const load = async (id: string) => { const acc = (await owner.unsafe(FP_SQL.account, [id]))[0]!; const ab = await owner.unsafe(FP_SQL.accountBudget, [user]), u = await owner.unsafe(FP_SQL.usage, [user]), c = await owner.unsafe(FP_SQL.costs, [user]), ap = await owner.unsafe(FP_SQL.approvals, [id]), p = await owner.unsafe(FP_SQL.positions, [id]); return viewFromRows(acc, ab[0] ?? null, [...u], [...c], [...ap], [...p]); };
      const intent = (tag: string): FPIntent[] => [{ maxHoldBars: 3, proposal: { proposalId: `g3-proposal-${tag}`, engine: "scalp_intraday", strategyId: "s1", symbol: "BTCUSDT", market: "usdm_futures", environment: "paper", side: "LONG", referencePrice: null, stopPrice: 99.2, takeProfitPrice: 101, createdAt: T0 + M } }];
      const sa = stepView(await load(a), chk.bars, intent(`a${iso.length}`)), sb = stepView(await load(b), chk.bars, intent(`b${iso.length}`));
      const pa = sa.payload, pb = sb.payload;
      let go!: () => void; const barrier = new Promise<void>((r) => { go = r; }); let snap!: () => void; const snapped = new Promise<void>((r) => { snap = r; });
      const s1 = connect(url, 1), s2 = connect(url, 1);
      const first = asService(s1, async (tx) => { await tx.unsafe(`SELECT 1`); snap(); await barrier; return tx.unsafe(FP_SQL.commit, [a, 0, T0, pa] as never[]); }, iso).then(() => "accepted", (e: Error) => e.message);
      await snapped;
      await asService(s2, (tx) => tx.unsafe(FP_SQL.commit, [b, 0, T0, pb] as never[]));
      go();
      const outcome = await first, usage = Number((await owner.unsafe(`SELECT public.fp3_usage($1::uuid, 's1', NULL) AS u`, [user]))[0]!["u"]);
      console.log("G3", iso, JSON.stringify({ outcome: outcome.slice(0, 80), usage }));
      if (iso.includes("REPEAT")) { expect(outcome).toBe("accepted"); expect(usage).toBeGreaterThan(12); } // the gap: a stale snapshot sizes against old usage
      else { expect(outcome).toMatch(/budget .* would be exceeded/); expect(usage).toBeLessThanOrEqual(12 + 1e-9); }
    }
    const { owner } = await freshDb(true);
    const err = await asService(owner, (tx) => tx.unsafe(`SELECT public.fpw_commit(gen_random_uuid(), gen_random_uuid(), 1, 0, 0, '{}'::jsonb, '[]'::jsonb)`), "ISOLATION LEVEL REPEATABLE READ").catch((e: Error) => e.message);
    expect(err).toMatch(/commits must run at READ COMMITTED/);
  }, 120_000);
});
