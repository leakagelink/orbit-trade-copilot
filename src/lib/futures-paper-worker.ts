// Futures PAPER worker core (Phase 4F, workstream C) — DISABLED BY DEFAULT. Nothing in the app imports it; there is no
// route, cron entry, schedule or deployment for it, and `runFuturesPaperWorkerTick` returns "disabled" without touching
// a single port unless the caller passes `enabled: true` explicitly (only tests do). It is pure orchestration over
// injected ports (database, public market data, intents, clock, monitor); it has no database client, network call,
// credential, exchange, order, wallet, Autopilot or AI access of its own. The database side is draft 0049 (NOT applied).
//
// Per account and candle: lease → load (authoritative cursor/sequence/ledger) → wait until the candle is closed →
// fetch + provenance checks → aligned engine step → payload → compare-and-set commit → classify any refusal → next.
// Guarantees: one account per transaction; a lease per account (losing it is harmless: the commit is compare-and-set);
// identical replay is idempotent; duplicate/out-of-order candles are refused three times (provenance, engine, database);
// a crash before commit writes nothing and after commit is recovered by reloading the cursor; bounded retries everywhere;
// unknown or inconsistent refusals halt the account for review and are never retried.
import { FuturesPaperDataError, type FPConfig, type FPIntent, type FPState } from "./futures-paper-engine";
import { futuresPaperCommitPayloadV3 } from "./futures-paper-ledger-v3";
import { planLedgerRefusalV3, stepFuturesPaperCandleV3, ledgerStateProblems, type FPV3Ledger, type V3ApprovalCode, type V3FillCode, type V3Refusal, type CostAssumption, type V3Approval, type V3Position } from "./futures-paper-engine-v3";
import { selectClosedCandles, FP_TIMEFRAMES, type FPTimeframe, type MarketDataCode, type RawSymbolBundle } from "./futures-paper-market-data";
import type { BudgetEngine } from "./account-risk-budget";

/** The worker is OFF. Changing this needs a separate owner approval for activation (and a schedule, which does not exist). */
export const FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT = false as const;
export const FUTURES_PAPER_WORKER_VERSION = "futures-paper-worker-v1 (draft 0049)" as const;

export interface WorkerAccountView {
  accountId: string; userId: string; status: "active" | "paused" | "stopped"; halted: boolean; seq: number; cursorT: number;
  timeframe: FPTimeframe; tfMs: number; symbols: string[]; config: FPConfig; state: FPState; ledger: FPV3Ledger;
}
export type CommitOutcome = { kind: "committed"; seq: number } | { kind: "refused"; message: string } | { kind: "lost" } | { kind: "transient"; message: string };
export interface WorkerPorts {
  db: {
    tryAcquireLease(accountId: string, holder: string): Promise<boolean>;
    releaseLease(accountId: string, holder: string): Promise<void>;
    /** Must read every row from ONE snapshot (e.g. a REPEATABLE READ, READ ONLY transaction). */
    load(accountId: string): Promise<WorkerAccountView>;
    evaluatedProposals(userId: string, proposalIds: string[]): Promise<string[]>;
    commit(accountId: string, expectedSeq: number, barT: number, payload: unknown): Promise<CommitOutcome>;
    markForReview(accountId: string, code: string): Promise<void>;
  };
  market: { candles(symbols: string[], timeframe: FPTimeframe, barT: number): Promise<RawSymbolBundle[]> };
  intents: { forCandle(accountId: string, barT: number): Promise<FPIntent[]> };
  clock: { now(): number; sleep(ms: number): Promise<void> };
  monitor: { record(m: WorkerMetric): void };
}
export interface WorkerOptions {
  enabled?: boolean; holder: string; accounts: string[];
  maxAccounts?: number; maxCandlesPerAccount?: number; maxRecompute?: number; maxReloads?: number; fetchAttempts?: number;
  fetchBackoffMs?: number; closeGraceMs?: number; maxFutureSkewMs?: number;
}
export const WORKER_CODES = [
  "DISABLED", "LEASE_BUSY", "COMMITTED", "LOST_RESPONSE_RESENT", "UNKNOWN_OUTCOME", "WAIT_CANDLE_NOT_CLOSED", "ACCOUNT_STOPPED",
  "DATA_UNAVAILABLE", "DATA_INVALID", "ENGINE_DATA_ERROR", "LEDGER_STATE_MISMATCH", "RECOMPUTE", "RELOAD", "RELOAD_LIMIT",
  "RECOMPUTE_LIMIT", "TRANSIENT_DB_ERROR", "HALT_FOR_REVIEW", "CATCH_UP_LIMIT", "LOAD_FAILED",
] as const;
export type WorkerCode = (typeof WORKER_CODES)[number];
export interface WorkerMetric {
  code: WorkerCode; accountId: string | null; barT: number | null; detailCode?: string | null; attempt?: number;
  lagMs?: number | null; latencyMs?: number; events?: number; refusals?: Pick<V3Refusal, "stage" | "code" | "source">[];
}
export interface TickSummary { status: "disabled" | "ran"; committed: number; halted: string[]; metrics: WorkerMetric[] }

const D = { maxAccounts: 20, maxCandlesPerAccount: 30, maxRecompute: 3, maxReloads: 2, fetchAttempts: 2, fetchBackoffMs: 500, closeGraceMs: 2_000, maxFutureSkewMs: 5_000 };

export async function runFuturesPaperWorkerTick(ports: WorkerPorts, opts: WorkerOptions): Promise<TickSummary> {
  if (opts?.enabled !== true) return { status: "disabled", committed: 0, halted: [], metrics: [{ code: "DISABLED", accountId: null, barT: null }] };
  const o = { ...D, ...opts };
  const sum: TickSummary = { status: "ran", committed: 0, halted: [], metrics: [] };
  const rec = (m: WorkerMetric) => { sum.metrics.push(m); try { ports.monitor.record(m); } catch { /* monitoring never blocks the ledger */ } };
  for (const accountId of o.accounts.slice(0, o.maxAccounts)) {
    if (!(await ports.db.tryAcquireLease(accountId, o.holder))) { rec({ code: "LEASE_BUSY", accountId, barT: null }); continue; }
    try { await runAccount(ports, o, accountId, rec, sum); }
    finally { await ports.db.releaseLease(accountId, o.holder).catch(() => {}); }
  }
  return sum;
}

async function runAccount(ports: WorkerPorts, o: typeof D & WorkerOptions, accountId: string, rec: (m: WorkerMetric) => void, sum: TickSummary) {
  const halt = async (barT: number | null, detailCode: string) => {
    await ports.db.markForReview(accountId, detailCode).catch(() => {});
    sum.halted.push(accountId); rec({ code: "HALT_FOR_REVIEW", accountId, barT, detailCode });
  };
  let reloads = 0;
  for (let n = 0; n < o.maxCandlesPerAccount; n++) {
    let v: WorkerAccountView;
    try { v = await ports.db.load(accountId); } catch { rec({ code: "LOAD_FAILED", accountId, barT: null }); return; }
    if (v.status === "stopped") { rec({ code: "ACCOUNT_STOPPED", accountId, barT: null }); return; }
    const tf = FP_TIMEFRAMES[v.timeframe], barT = v.cursorT + tf, now = ports.clock.now();
    if (tf !== v.tfMs) { await halt(barT, "TIMEFRAME_MISMATCH"); return; }
    if (barT + tf + o.closeGraceMs > now) { rec({ code: "WAIT_CANDLE_NOT_CLOSED", accountId, barT, lagMs: now - (v.cursorT + tf) }); return; }
    if (v.state.accountCursor !== undefined && v.state.accountCursor > v.cursorT) { await halt(barT, "STATE_CURSOR_AHEAD"); return; }
    const problems = ledgerStateProblems(v.state, v.ledger);
    if (problems.length) {
      // A load that is not one snapshot can tear while another worker commits: re-read once (bounded) before halting.
      rec({ code: "LEDGER_STATE_MISMATCH", accountId, barT, detailCode: "LEDGER_STATE_MISMATCH" });
      if (++reloads <= o.maxReloads) { n--; continue; }
      await halt(barT, "LEDGER_STATE_MISMATCH"); return;
    }

    // Public market data: bounded attempts with backoff; nothing is ever forward-filled.
    let bundles: RawSymbolBundle[] | null = null;
    for (let a = 1; a <= o.fetchAttempts && !bundles; a++) {
      try { bundles = await ports.market.candles(v.symbols, v.timeframe, barT); }
      catch { if (a < o.fetchAttempts) await ports.clock.sleep(o.fetchBackoffMs * a); }
    }
    if (!bundles) { rec({ code: "DATA_UNAVAILABLE", accountId, barT }); return; }
    const chk = selectClosedCandles(bundles, { symbols: v.symbols, timeframe: v.timeframe, barT, now: ports.clock.now(), closeGraceMs: o.closeGraceMs, maxFutureSkewMs: o.maxFutureSkewMs });
    if (!chk.ok) { rec({ code: chk.code === "CANDLE_NOT_CLOSED" ? "WAIT_CANDLE_NOT_CLOSED" : "DATA_INVALID", accountId, barT, detailCode: chk.code satisfies MarketDataCode }); return; }

    const intents = await ports.intents.forCandle(accountId, barT);
    const ledger: FPV3Ledger = { ...v.ledger, evaluatedProposals: intents.length ? await ports.db.evaluatedProposals(v.userId, intents.map((i) => i.proposal.proposalId)) : [] };
    const prev: FPState = { ...v.state, accountCursor: v.cursorT };
    let refused: Record<string, V3FillCode> = {}, rejected: Record<string, V3ApprovalCode> = {};
    let done = false, reload = false;
    for (let attempt = 1; attempt <= o.maxRecompute + 1 && !done && !reload; attempt++) {
      let r: ReturnType<typeof stepFuturesPaperCandleV3>;
      try { r = stepFuturesPaperCandleV3(prev, v.config, chk.bars, intents, { accountStatus: v.status, accountHalted: v.halted }, ledger, { refused, rejected }); }
      catch (e) {
        if (e instanceof FuturesPaperDataError && /ledger and state disagree|did not converge|still refused/.test(e.message)) { await halt(barT, "ENGINE_INCONSISTENT"); return; }
        rec({ code: "ENGINE_DATA_ERROR", accountId, barT, detailCode: e instanceof FuturesPaperDataError ? "ENGINE_DATA_ERROR" : "ENGINE_EXCEPTION" }); return;
      }
      const payload = futuresPaperCommitPayloadV3(prev, r.state, r.events, chk.bars, intents);
      const t0 = ports.clock.now();
      let out = await ports.db.commit(accountId, v.seq, barT, payload).catch((): CommitOutcome => ({ kind: "lost" }));
      if (out.kind === "lost") {
        // Lost reply: resend the IDENTICAL payload exactly once (0049 returns the committed sequence idempotently).
        rec({ code: "LOST_RESPONSE_RESENT", accountId, barT, attempt });
        out = await ports.db.commit(accountId, v.seq, barT, payload).catch((): CommitOutcome => ({ kind: "lost" }));
        if (out.kind === "lost") { rec({ code: "UNKNOWN_OUTCOME", accountId, barT }); return; } // next tick reloads the cursor
      }
      if (out.kind === "committed") {
        if (out.seq !== r.state.seq) { await halt(barT, "COMMITTED_SEQUENCE_MISMATCH"); return; }
        sum.committed++; done = true;
        rec({ code: "COMMITTED", accountId, barT, attempt, latencyMs: ports.clock.now() - t0, lagMs: ports.clock.now() - (barT + tf), events: r.events.length, refusals: r.refusals.map((x) => ({ stage: x.stage, code: x.code, source: x.source })) });
        break;
      }
      if (out.kind === "transient") { rec({ code: "TRANSIENT_DB_ERROR", accountId, barT }); return; }
      const plan = planLedgerRefusalV3(prev, r, out.message, { refused, rejected });
      if (plan.action === "recompute") { refused = plan.refused; rejected = plan.rejected; rec({ code: "RECOMPUTE", accountId, barT, attempt, detailCode: plan.code }); continue; }
      if (plan.action === "wait") { rec({ code: "WAIT_CANDLE_NOT_CLOSED", accountId, barT, detailCode: plan.code }); return; }
      if (plan.action === "reload_account") { rec({ code: "RELOAD", accountId, barT, detailCode: plan.code }); reload = true; break; }
      await halt(barT, plan.code); return;
    }
    if (reload) { if (++reloads > o.maxReloads) { rec({ code: "RELOAD_LIMIT", accountId, barT }); return; } n--; continue; }
    if (!done) { rec({ code: "RECOMPUTE_LIMIT", accountId, barT }); await halt(barT, "RECOMPUTE_LIMIT"); return; }
  }
  rec({ code: "CATCH_UP_LIMIT", accountId, barT: null });
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger view from database rows (pure). The SQL a database port must run is in `futures-paper-worker-queries.ts`.
// ---------------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
const num = (x: unknown) => { const v = typeof x === "string" ? Number(x) : (x as number); if (typeof v !== "number" || !Number.isFinite(v)) throw new FuturesPaperDataError("ledger row: number expected"); return v; };
export function viewFromRows(account: Row, accountBudget: Row | null, usage: Row[], costs: Row[], approvals: Row[], positions: Row[]): WorkerAccountView {
  const tf = String(account["timeframe"]) as FPTimeframe;
  const ledger: FPV3Ledger = {
    accountBudget: accountBudget ? { maxLoss: num(accountBudget["max_loss"]), research: num(accountBudget["research_max_loss"]), scalping: num(accountBudget["scalping_max_loss"]) } : null,
    strategies: usage.map((u) => ({ strategyId: String(u["strategy_id"]), engine: String(u["engine"]) as BudgetEngine, maxLoss: num(u["max_loss"]) })),
    usage: Object.fromEntries(usage.map((u) => [String(u["strategy_id"]), { closedLoss: num(u["closed_loss"]), openRisk: num(u["open_risk"]), pendingRisk: num(u["pending_risk"]) }])),
    costs: costs.map((c): CostAssumption => ({ strategyId: String(c["strategy_id"]), symbol: String(c["symbol"]), roundTripCostPct: num(c["round_trip_cost_pct"]), validationStatus: c["validation_status"] === "validated" ? "validated" : "unvalidated" })),
    approvals: Object.fromEntries(approvals.map((a): [string, V3Approval] => [String(a["symbol"]), {
      proposalId: String(a["proposal_id"]), strategyId: String(a["strategy_id"]), engine: String(a["budget_engine"]) as BudgetEngine, symbol: String(a["symbol"]), side: a["side"] === "SHORT" ? "SHORT" : "LONG",
      approvedQty: num(a["approved_qty"]), filledQty: num(a["filled_qty"]), leverage: num(a["leverage"]), referencePrice: num(a["reference_price"]), stopDist: num(a["stop_dist"]),
      costPct: num(a["cost_pct"]), approvedT: num(a["reference_t"]), expiresT: num(a["expires_t"]) }])),
    positions: Object.fromEntries(positions.map((p): [string, V3Position] => [String(p["symbol"]), { symbol: String(p["symbol"]), proposalId: String(p["proposal_id"]), strategyId: String(p["strategy_id"]), riskReserved: num(p["risk_reserved"]) }])),
    evaluatedProposals: [], requireValidatedCost: false,
  };
  const status = String(account["status"]);
  return {
    accountId: String(account["id"]), userId: String(account["user_id"]), status: status === "paused" || status === "stopped" ? status : "active", halted: account["halted"] === true,
    seq: num(account["seq"]), cursorT: num(account["cursor_t"]), timeframe: tf, tfMs: num(account["tf_ms"]), symbols: (account["symbols"] as string[]).slice().sort(),
    config: account["config"] as FPConfig, state: account["state"] as FPState, ledger,
  };
}
