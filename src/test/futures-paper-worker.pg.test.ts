// Phase 4F — the Futures PAPER worker (disabled by default; enabled explicitly here) against DRAFT 0049 on a real,
// throwaway PostgreSQL with genuinely concurrent sessions: session advisory-lock leases, backend kills before and after
// COMMIT, restart recovery, racing workers without leases (compare-and-set + idempotent replay), cross-account budget
// races and multi-symbol atomicity. Run via scripts/futures-paper/concurrency-check-4f-worker.sh; skipped without
// FUTURES_PAPER_PG_URL. Never touches the live database. Policy values are TEST INPUTS, not approved policy.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { initialFuturesPaperState, type FPConfig, type FPIntent } from "@/lib/futures-paper-engine";
import { runFuturesPaperWorkerTick, viewFromRows, type CommitOutcome, type WorkerMetric, type WorkerPorts } from "@/lib/futures-paper-worker";
import { FP_SQL } from "@/lib/futures-paper-worker-queries";
import { rawBundle, type OHLC } from "./helpers/fp-v3-harness";

const URL = process.env["FUTURES_PAPER_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8");
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`;
const M = 60_000, N = 24, T0 = Math.floor(Date.now() / M) * M - (N + 30) * M, NOW = T0 + N * M + 3_000;
const SPEC = { stepSize: 0.001, tickSize: 0.1, minNotional: 5, maintenanceMarginRate: 0.004 };
const CFG: FPConfig = {
  startingBalance: 1000, triggerSource: "MARK", maxBasisPct: 0.5, entryTtlBars: 50,
  costs: { takerFeePct: 0.05, spreadPct: 0.01, slippagePct: 0.01, maxParticipationPct: null }, specs: { BTCUSDT: SPEC, ETHUSDT: SPEC },
  limits: { maxExposure: 5000, maxDailyLoss: 200, maxPositions: 2, maxLossPerTrade: 10, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 },
  strategyBudgets: {},
};
const path = (sym: string, k: number): OHLC => { const b = sym === "BTCUSDT" ? 100 : 50, o = b + 1.5 * Math.sin(k / 2), c = b + 1.5 * Math.sin((k + 1) / 2); return [o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c]; };
const market: WorkerPorts["market"] = { candles: async (symbols, timeframe, barT) => symbols.map((s) => rawBundle(s, barT, M, { trade: path(s, (barT - T0) / M) }, NOW, timeframe)) };
const intentsFor = (tag: string, every = 4, strategyId = "s1"): WorkerPorts["intents"] => ({ forCandle: async (_a, barT): Promise<FPIntent[]> => {
  const k = (barT - T0) / M; if (k % every !== 0) return [];
  return ["BTCUSDT", "ETHUSDT"].map((s, i) => { const c = path(s, k)[3], long = (k / every + i) % 2 === 0; return { maxHoldBars: 3, proposal: { proposalId: `${tag}-${s}-${k}`, engine: "scalp_intraday", strategyId, symbol: s, market: "usdm_futures", environment: "paper", side: long ? "LONG" : "SHORT", referencePrice: null, stopPrice: long ? c - 1 : c + 1, takeProfitPrice: long ? c + 2 : c - 2, createdAt: barT + M } }; });
} });

type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string) => { const s = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); });
let dbn = 0;
async function freshDb() {
  const admin = connect(URL!); const name = `fpaper4fw_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`), owner = connect(url);
  await owner.unsafe(STUB); await owner.unsafe(MIGRATION);
  return { url, owner };
}
async function account(owner: Sql, user: string) {
  const r = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
    VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, CFG, initialFuturesPaperState(1000)] as never[]); });
  const id = String(r[0]!["id"]);
  await owner.unsafe(`SELECT set_config('futures_paper.commit','on',false); UPDATE public.futures_paper_accounts SET cursor_t=${T0 - M} WHERE id='${id}'; SELECT set_config('futures_paper.commit','off',false);`);
  return id;
}
const budgets = (owner: Sql, user: string, s1: number) => owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`);
  await tx.unsafe(`INSERT INTO public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) VALUES ($1,'paper',1000,400,600)`, [user]);
  await tx.unsafe(`INSERT INTO public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) VALUES ($1,'s1','paper','scalping',$2)`, [user, s1]); });
const n = async (sql: Sql, q: string, p: unknown[] = []) => Number((await sql.unsafe(q, p as never[]))[0]!["n"]);

/** Database port over ONE real session. `dead` emulates a crashed process: every later call fails. */
function pgPorts(sql: Sql, o: { intents: WorkerPorts["intents"]; noLease?: boolean; hooks?: { inTx?: (tx: Sql, k: number) => Promise<void>; afterCommit?: (k: number) => Promise<void> } }) {
  const metrics: WorkerMetric[] = []; let commits = 0, dead = false;
  const alive = () => { if (dead) throw new Error("process died"); };
  const ports: WorkerPorts = {
    db: {
      async tryAcquireLease(id) { alive(); return o.noLease ? true : (await sql.unsafe(FP_SQL.lease, [id]))[0]!["ok"] === true; },
      async releaseLease(id) { alive(); if (!o.noLease) await sql.unsafe(FP_SQL.release, [id]); },
      async load(id) {
        alive(); const a = (await sql.unsafe(FP_SQL.account, [id]))[0]!; const user = String(a["user_id"]);
        const [ab, u, c, ap, p] = await Promise.all([sql.unsafe(FP_SQL.accountBudget, [user]), sql.unsafe(FP_SQL.usage, [user]), sql.unsafe(FP_SQL.costs, [user]), sql.unsafe(FP_SQL.approvals, [id]), sql.unsafe(FP_SQL.positions, [id])]);
        return viewFromRows(a, ab[0] ?? null, [...u], [...c], [...ap], [...p]);
      },
      async evaluatedProposals(user, ids) { alive(); return (await sql.unsafe(FP_SQL.evaluated, [user, ids] as never[])).map((r) => String(r["proposal_id"])); },
      async commit(id, seq, barT, payload): Promise<CommitOutcome> {
        alive(); const k = ++commits;
        try {
          const s = await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); const r = await tx.unsafe(FP_SQL.commit, [id, seq, barT, payload] as never[]); /* postgres.js serializes the object as jsonb */ await o.hooks?.inTx?.(tx as unknown as Sql, k); return Number(r[0]!["seq"]); });
          await o.hooks?.afterCommit?.(k);
          return { kind: "committed", seq: s };
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "P0001") return { kind: "refused", message: String((e as Error).message) };
          dead = dead || /process died|terminat|CONNECTION/i.test(String((e as Error).message) + String(code));
          throw e; // outcome unknown (connection lost) → the worker treats it as a lost reply
        }
      },
      async markForReview(id, code) { alive(); await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(FP_SQL.markForReview, [id, `review:${code}`]); }); },
    },
    market, intents: o.intents, clock: { now: () => NOW, sleep: async () => {} }, monitor: { record: (m) => { metrics.push(m); } },
  };
  return { ports, metrics, kill: () => { dead = true; } };
}
const tick = (p: WorkerPorts, id: string, holder: string, max = 3) => runFuturesPaperWorkerTick(p, { enabled: true, holder, accounts: [id], maxCandlesPerAccount: max });

describe.skipIf(!URL)("Futures paper worker on real PostgreSQL sessions", () => {
  it("lease contention: four workers on one account — advisory-lock leases serialize them; every candle commits exactly once", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a01"; await budgets(owner, user, 500); const id = await account(owner, user);
    const workers = Array.from({ length: 4 }, (_, i) => ({ i, ...pgPorts(connect(url), { intents: intentsFor("lc") }) }));
    for (let round = 0; round < 40 && (await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])) < N; round++) await Promise.all(workers.map((w) => tick(w.ports, id, `w${w.i}`, 2)));
    const all = workers.flatMap((w) => w.metrics.map((m) => m.code));
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
    expect(all.filter((c) => c === "LEASE_BUSY").length).toBeGreaterThan(0);
    expect(all.filter((c) => ["HALT_FOR_REVIEW", "RECOMPUTE", "UNKNOWN_OUTCOME"].includes(c))).toEqual([]);
    expect(await n(owner, `SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory'`)).toBe(0); // every lease released
  }, 120_000);

  it("no lease at all: racing workers still commit every candle exactly once (compare-and-set + idempotent identical replay)", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a02"; await budgets(owner, user, 500); const id = await account(owner, user);
    const workers = Array.from({ length: 4 }, () => pgPorts(connect(url), { intents: intentsFor("nl"), noLease: true }));
    for (let round = 0; round < 40 && (await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])) < N; round++) await Promise.all(workers.map((w, i) => tick(w.ports, id, `n${i}`, 4)));
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
    const fills = await owner.unsafe(`SELECT fill_id FROM public.futures_paper_events WHERE account_id=$1 AND fill_id IS NOT NULL`, [id]);
    expect(new Set(fills.map((r) => r["fill_id"])).size).toBe(fills.length);
    expect(workers.flatMap((w) => w.metrics.map((m) => m.code)).filter((c) => c === "HALT_FOR_REVIEW")).toEqual([]);
  }, 120_000);

  it("crash BEFORE COMMIT (backend killed inside the transaction): nothing is written, the lease dies with the session, another worker continues", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a03"; await budgets(owner, user, 500); const id = await account(owner, user);
    const killer = connect(url);
    const a = pgPorts(connect(url), { intents: intentsFor("cb"), hooks: { inTx: async (tx, k) => { if (k === 3) { const pid = (await tx.unsafe(`SELECT pg_backend_pid() AS p`))[0]!["p"]; await killer.unsafe(`SELECT pg_terminate_backend($1)`, [pid]); } } } });
    const r = await tick(a.ports, id, "A", 10);
    expect(r.committed).toBe(2); expect(r.metrics.map((m) => m.code).slice(-2)).toEqual(["LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME"]);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(2); // the killed candle left nothing
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_candles WHERE account_id=$1 AND bar_t=$2`, [id, T0 + 2 * M])).toBe(0);
    const b = pgPorts(connect(url), { intents: intentsFor("cb") });
    const rb = await tick(b.ports, id, "B", 50); // the dead session's advisory lock is gone
    expect(rb.metrics[0]!.code).toBe("COMMITTED"); expect(rb.committed).toBe(N - 2);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
  }, 120_000);

  it("crash AFTER COMMIT (process dies before reading the reply): the next worker reloads the committed cursor; nothing is duplicated", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a04"; await budgets(owner, user, 500); const id = await account(owner, user);
    const a = pgPorts(connect(url), { intents: intentsFor("ca") });
    a.ports.db.commit = ((orig) => async (...args: Parameters<WorkerPorts["db"]["commit"]>) => { const out = await orig(...args); if (args[2] === T0 + 4 * M) { a.kill(); throw new Error("process died"); } return out; })(a.ports.db.commit);
    const r = await tick(a.ports, id, "A", 10);
    expect(r.committed).toBe(4); expect(r.metrics.map((m) => m.code).slice(-1)).toEqual(["UNKNOWN_OUTCOME"]);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(5); // candle 4 did commit
    await a.ports.db.releaseLease(id, "A").catch(() => {}); // a dead process releases nothing; end its session instead
    await opened.at(-1)!.end({ timeout: 1 }).catch(() => {});
    const b = pgPorts(connect(url), { intents: intentsFor("ca") });
    const rb = await tick(b.ports, id, "B", 50);
    expect(rb.committed).toBe(N - 5);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id])).toBe(N);
  }, 120_000);

  it("restart recovery: a worker killed every few candles ends identical to an uninterrupted run", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a05"; await budgets(owner, user, 500);
    const ref = await account(owner, user), kil = await account(owner, user);
    await tick(pgPorts(connect(url), { intents: intentsFor("ref") }).ports, ref, "R", 100);
    for (let life = 0; life < 30 && (await n(owner, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [kil])) < N; life++) {
      const s = connect(url); const w = pgPorts(s, { intents: intentsFor("kil") });
      w.ports.db.commit = ((orig) => { let c = 0; return async (...args: Parameters<WorkerPorts["db"]["commit"]>) => { if (++c === 3) { w.kill(); throw new Error("process died"); } return orig(...args); }; })(w.ports.db.commit);
      await tick(w.ports, kil, `life${life}`, 100); await s.end({ timeout: 1 }).catch(() => {});
    }
    const q = `SELECT seq, cursor_t, wallet::text w FROM public.futures_paper_accounts WHERE id=$1`;
    const [x] = await owner.unsafe(q, [ref]), [y] = await owner.unsafe(q, [kil]);
    expect([y!["seq"], y!["cursor_t"], y!["w"]]).toEqual([x!["seq"], x!["cursor_t"], x!["w"]]);
    const kinds = async (id: string) => (await owner.unsafe(`SELECT kind, qty::text, price::text, wallet_delta::text FROM public.futures_paper_events WHERE account_id=$1 ORDER BY seq`, [id])).map((r) => `${r["kind"]}|${r["qty"]}|${r["price"]}|${r["wallet_delta"]}`);
    expect(await kinds(kil)).toEqual(await kinds(ref));
  }, 180_000);

  it("cross-account budget race: two workers on two accounts of one owner approve at once; the database serializes on the budget row, one approval is refused and becomes a rejection — usage never exceeds the budget", async () => {
    const { url, owner } = await freshDb();
    for (let round = 0; round < 3; round++) {
      const user = `00000000-0000-4000-8000-00000000b00${round}`; await budgets(owner, user, 12);
      const ids = [await account(owner, user), await account(owner, user)];
      const ws = ids.map((_, i) => pgPorts(connect(url), { intents: { forCandle: async (_a, barT) => (barT === T0 ? (await intentsFor(`r${round}a${i}`, 4).forCandle(_a, barT)).filter((x) => x.proposal.symbol === "BTCUSDT") : []) } }));
      await Promise.all(ws.map((w, i) => tick(w.ports, ids[i]!, `x${i}`, 1)));
      const ms = ws.flatMap((w) => w.metrics);
      expect(ms.filter((m) => m.code === "COMMITTED")).toHaveLength(2);
      expect(ms.filter((m) => m.code === "HALT_FOR_REVIEW")).toEqual([]);
      const approvals = await n(owner, `SELECT count(*)::int n FROM public.futures_paper_risk_approvals WHERE user_id=$1`, [user]);
      const recomputes = ms.filter((m) => m.code === "RECOMPUTE").map((m) => m.detailCode);
      expect(approvals + recomputes.length).toBe(2); // either both fit sequentially, or one was refused and rejected
      for (const c of recomputes) expect(c).toBe("APPROVAL_STRATEGY_BUDGET");
      console.log("RACE", round, JSON.stringify({ approvals, recomputes }));
      expect(Number((await owner.unsafe(`SELECT public.fp3_usage($1::uuid, 's1', NULL) AS u`, [user]))[0]!["u"])).toBeLessThanOrEqual(12 + 1e-9);
    }
  }, 120_000);

  it("multi-symbol atomicity: a candle refused for one symbol writes nothing for the other; the account is paused for review", async () => {
    const { url, owner } = await freshDb(); const user = "00000000-0000-4000-8000-000000000a07"; await budgets(owner, user, 500); const id = await account(owner, user);
    const w = pgPorts(connect(url), { intents: intentsFor("ms") });
    await tick(w.ports, id, "M", 1);
    const orig = w.ports.db.commit;
    w.ports.db.commit = (a, s, t, p) => { const x = p as { events: { kind: string; symbol: string; margin_delta: number }[] }; return orig(a, s, t, { ...x, events: x.events.map((e) => (e.kind === "entry_fill" && e.symbol === "ETHUSDT" ? { ...e, margin_delta: e.margin_delta * 2 } : e)) }); };
    const before = await n(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [id]);
    const r = await tick(w.ports, id, "M", 5);
    expect(r.metrics.map((m) => [m.code, m.detailCode ?? null])).toEqual([["HALT_FOR_REVIEW", "FILL_INCONSISTENT"]]);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [id])).toBe(before);
    expect(await n(owner, `SELECT count(*)::int n FROM public.futures_paper_candles WHERE account_id=$1 AND bar_t=$2`, [id, T0 + M])).toBe(0);
    expect(String((await owner.unsafe(`SELECT status_reason FROM public.futures_paper_accounts WHERE id=$1`, [id]))[0]!["status_reason"])).toBe("review:FILL_INCONSISTENT");
  }, 120_000);
});
