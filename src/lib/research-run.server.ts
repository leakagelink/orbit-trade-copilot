// Research run orchestration (advisory only). Writes only research tables; it never creates orders, order intents,
// positions or settings, and never reads exchange credentials. Risk inputs come from the read-only research-risk.server
// module (no order-capable imports; a test walks the import graph). AI output is never an input to sizing.
// Spending: every AI call first reserves budget atomically in the database ledger (research-ledger.server.ts, draft
// migration 0043); until 0043 is applied only the in-memory per-run meter applies. Cancellation and ownership checks
// fail closed: if they cannot be verified, no further AI call starts.
import { AI_MODEL, AI_PROVIDER_NAME } from "./ai-provider";
import { runResearchStages, runDecisionStages, type ResearchAgent, type AgentResult, type ResearchReport } from "./research-pipeline";
import { buildResearchProposal } from "./research-proposal";
import { createBudgetMeter, DEFAULT_RESEARCH_BUDGET, projectCallTokens, researchBudget, type BudgetMeter, type ResearchBudget } from "./research-budget";
import { buildDecisionRecord, canonicalJson, sha256Hex, type AgentCall } from "./research-record";
import { allAgents, RUN_STATUS_FOR_OUTCOME } from "./research-transparency";
import { computeRiskPreview } from "./research-risk.server";
import { claimResearchWorker, ledgerDb, releaseResearchBudget, reserveResearchBudget, runStoppingRefusal, settleResearchBudget, type LedgerMode, type Reservation } from "./research-ledger.server";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
type ResearchData = Awaited<ReturnType<typeof import("./research.server").loadResearchData>>;
export interface AnalystCallResult {
  report: ResearchReport; inputTokens: number; outputTokens: number;
  reported: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null; providerMessageId: string | null; stopReason: string | null; repairs?: number };
}
export interface ResearchRunDeps {
  loadResearchData: (symbol: string) => Promise<ResearchData>;
  runAnalyst: (agent: ResearchAgent, symbol: string, evidence: unknown, beforeRepair?: (projectedTokens: number) => void | Promise<void>) => Promise<AnalystCallResult>;
  now?: () => number;
  /** Identity of this worker for the run (tests pass a fixed one). */
  workerId?: string;
}
/** Tables the research pipeline may write. Anything else is a bug (tests assert this). */
export const RESEARCH_WRITE_TABLES = ["ai_research_runs", "ai_agent_outputs", "ai_research_reports", "ai_research_decisions", "ai_trade_proposals", "ai_research_usage", "ai_research_stage_metrics", "ai_decision_records", "ai_risk_evaluations"] as const;
/** Append-only audit event the owner writes to ask a running research run to stop. */
export const RESEARCH_CANCEL_ACTION = "ai_research_cancel_requested";
const SYSTEM_OVERHEAD_CHARS = 2400;

// Tables added by draft migration 0043 are not in the generated types until it is applied.
type Untyped = { from: (t: string) => { select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown; error: { code?: string; message?: string } | null }> }; maybeSingle: () => Promise<{ data: unknown; error: { code?: string; message?: string } | null }> }; insert: (row: unknown) => Promise<{ error: { code?: string; message?: string } | null }> } };
const untyped = (db: Admin) => db as unknown as Untyped;
export const tableMissing = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(e.message ?? ""));

export async function loadResearchBudget(db: Admin): Promise<{ limits: ResearchBudget; source: "configured" | "default" | "default_table_pending" }> {
  const r = await untyped(db).from("ai_research_budget_config").select("per_run_tokens,per_user_day_tokens,per_user_month_tokens,platform_month_tokens,max_calls_per_run,max_repairs_per_run,max_run_seconds,per_run_usd,platform_month_usd").maybeSingle();
  if (tableMissing(r.error)) return { limits: { ...DEFAULT_RESEARCH_BUDGET }, source: "default_table_pending" };
  if (r.error) throw new Error("Research spending limits unavailable; no AI calls were made");
  if (!r.data) return { limits: { ...DEFAULT_RESEARCH_BUDGET }, source: "default" };
  const d = r.data as Record<string, unknown>;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const or = (v: unknown, fallback: number) => num(v) ?? fallback;
  const D = DEFAULT_RESEARCH_BUDGET;
  return { limits: researchBudget.parse({ perRunTokens: num(d["per_run_tokens"]), perUserDayTokens: or(d["per_user_day_tokens"], D.perUserDayTokens), perUserMonthTokens: num(d["per_user_month_tokens"]), platformMonthTokens: num(d["platform_month_tokens"]), maxCallsPerRun: or(d["max_calls_per_run"], D.maxCallsPerRun), maxRepairsPerRun: or(d["max_repairs_per_run"], D.maxRepairsPerRun), maxRunSeconds: or(d["max_run_seconds"], D.maxRunSeconds), perRunUsd: num(d["per_run_usd"]), platformMonthUsd: num(d["platform_month_usd"]) }), source: "configured" };
}

/** Provider-reported input + output tokens recorded since a time (user, or the whole platform). */
export async function usageTokensSince(db: Admin, userId: string | null, since: string) {
  let total = 0;
  for (let page = 0; page < 200; page++) {
    let q = db.from("ai_research_usage").select("input_tokens,output_tokens").gte("created_at", since).order("id").range(page * 1000, page * 1000 + 999);
    if (userId) q = q.eq("user_id", userId);
    const r = await q;
    if (r.error || !r.data) throw new Error("Research usage evidence unavailable; no AI calls were made");
    total += r.data.reduce((a, x) => a + Number(x.input_tokens) + Number(x.output_tokens), 0);
    if (r.data.length < 1000) return total;
  }
  throw new Error("Research usage evidence too large to verify; no AI calls were made");
}
/** Provider-reported tokens recorded this UTC month (user, or the whole platform). */
export function monthTokens(db: Admin, userId: string | null, now = Date.now()) {
  const d = new Date(now); return usageTokensSince(db, userId, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString());
}
/** Provider-reported tokens recorded this UTC day for one user. */
export function dayTokens(db: Admin, userId: string, now = Date.now()) {
  const d = new Date(now); return usageTokensSince(db, userId, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString());
}
/**
 * Whether the owner has asked this run to stop (append-only audit event). "unknown" when the check itself failed:
 * callers must then treat the run as not allowed to continue (fail closed).
 */
export async function cancelState(db: Admin, userId: string, runId: string): Promise<"cancelled" | "active" | "unknown"> {
  try {
    const r = await db.from("audit_logs").select("id").eq("user_id", userId).eq("action", RESEARCH_CANCEL_ACTION).eq("entity_id", runId).limit(1);
    if (r.error || !r.data) { console.error("Research cancel check failed", r.error?.message ?? "no data"); return "unknown"; }
    return r.data.length > 0 ? "cancelled" : "active";
  } catch (e) { console.error("Research cancel check failed", e instanceof Error ? e.message : e); return "unknown"; }
}

export { computeRiskPreview };

const CANCELLED_MESSAGE = "Cancelled by you. No further AI calls were made; completed reports are kept.";
const CANCEL_UNVERIFIED_MESSAGE = "Could not confirm that this run is still allowed to continue, so no further AI calls were made. Completed reports are kept.";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function executeResearchRun(db: Admin, userId: string, runId: string, symbol: string, deps: ResearchRunDeps) {
  const now = deps.now ?? Date.now;
  const workerId = deps.workerId ?? crypto.randomUUID();
  const ledger = ledgerDb(db);
  const startedAt = new Date(now()).toISOString();
  const calls: AgentCall[] = [];
  const results: AgentResult[] = [];
  let evidence: ResearchData | null = null;
  let meter: BudgetMeter | null = null;
  let failure: string | null = null;
  let proposal: ReturnType<typeof buildResearchProposal> | null = null;
  // Exactly one worker per run. A second or stale worker makes no AI calls and writes nothing.
  let mode: LedgerMode = "pending_migration";
  try {
    const claim = await claimResearchWorker(ledger, runId, userId, workerId);
    if (claim.mode === "refused") return { runId, outcome: "failed" as const, status: null, ledger: "not_run_worker" as const, stopReason: "Another worker already owns this research run; this request made no AI calls and changed nothing.", finalized: false };
    mode = claim.mode;
  } catch (e) { failure = errorText(e); }
  const atomic = mode === "atomic";
  const ownRun = <T extends { eq: (k: string, v: string) => T }>(q: T) => (atomic ? q.eq("worker_id", workerId) : q);
  try {
    if (failure) throw new Error(failure);
    const budget = await loadResearchBudget(db);
    const [userDay, userMonth, platformMonth] = await Promise.all([dayTokens(db, userId, now()), monthTokens(db, userId, now()), monthTokens(db, null, now())]);
    meter = createBudgetMeter(budget.limits, { userDayTokens: userDay, userMonthTokens: userMonth, platformMonthTokens: platformMonth, platformMonthUsd: null }, { startedAt: Date.parse(startedAt), now });
    const m = meter;
    let cancelled = false;
    // Fail closed: an unverifiable cancel state stops the run before the next AI call.
    const checkCancelled = async () => {
      if (!cancelled) {
        const state = await cancelState(db, userId, runId);
        if (state === "unknown") m.halt("cancel_check_failed", CANCEL_UNVERIFIED_MESSAGE);
        cancelled = state === "cancelled";
      }
      if (cancelled) m.halt("cancelled", CANCELLED_MESSAGE);
    };
    evidence = await deps.loadResearchData(symbol);
    const ev = evidence;
    const snapshotWrite = await ownRun(db.from("ai_research_runs").update({ snapshot: ev.snapshot, research_evidence: { version: 3, news: ev.news, sentiment: ev.sentiment } }).eq("id", runId).eq("user_id", userId));
    if (snapshotWrite.error) throw snapshotWrite.error;
    const analyze = async (agent: ResearchAgent, input: unknown) => {
      await checkCancelled();
      const inputSha256 = await sha256Hex(canonicalJson({ symbol, evidence: input }));
      const reservations: string[] = [];
      let reservedTotal = 0;
      // Database reservation (atomic across every run and user). A refusal releases the in-memory reservation too.
      const ledgerReserve = async (tokens: number, kind: "call" | "repair") => {
        if (!atomic) return;
        const res: Reservation = await reserveResearchBudget(ledger, { runId, userId, workerId, agent, kind, tokens }).catch((e) => ({ ok: false as const, stoppedBy: "ledger_unavailable", reason: errorText(e) }));
        if (!res.ok) {
          m.release(tokens, kind);
          if (res.stoppedBy === "cancelled") cancelled = true;
          if (runStoppingRefusal(res.stoppedBy)) m.halt(res.stoppedBy, res.reason);
          throw new Error(res.reason);
        }
        reservations.push(res.id); reservedTotal += tokens;
        // A parallel agent may have stopped the run while this reservation was in flight: never send it.
        const stopped = m.state().stoppedBy;
        if (stopped) {
          const id = reservations.pop()!; reservedTotal -= tokens; m.release(tokens, kind);
          await releaseResearchBudget(ledger, { reservationId: id, workerId });
          m.halt(stopped, m.state().stopReason ?? "Research was stopped");
        }
      };
      const projected = projectCallTokens(JSON.stringify({ symbol, evidence: input }).length + SYSTEM_OVERHEAD_CHARS);
      let handle = m.reserve(projected);
      await ledgerReserve(projected, "call");
      const settleLedger = async (consumed: number | null, costUsd: number | null): Promise<NonNullable<AgentCall["ledger"]>> => {
        const settled = atomic && reservations.length ? await settleResearchBudget(ledger, { reservationIds: reservations, workerId, consumedTokens: consumed, costUsd }) : false;
        if (atomic && !settled) console.error(`Research reservation for ${agent} could not be settled; it keeps counting in full`);
        return { mode, reservations: atomic ? reservations.length : 0, reservedTokens: atomic ? reservedTotal : handle, consumedTokens: consumed ?? (atomic ? reservedTotal : handle), basis: consumed === null ? "reservation_estimate" : "provider_reported", settled };
      };
      // Recorded on every call that finishes: was the owner's cancel already requested by then? (null = unknown)
      const afterCancel = async () => { const s = await cancelState(db, userId, runId); if (s === "cancelled") cancelled = true; return s === "unknown" ? null : s === "cancelled"; };
      const started = now(); const at = new Date(started).toISOString();
      let result: AnalystCallResult;
      try {
        result = await deps.runAnalyst(agent, symbol, input, async (projectedRepair) => {
          await checkCancelled();
          const t = m.reserve(projectedRepair, "repair");
          await ledgerReserve(projectedRepair, "repair");
          handle += t;
        });
      } catch (error) {
        m.settleFailed(handle);
        const ledgerInfo = await settleLedger(null, null); // usage unknown: the reservation counts in full
        const reason = errorText(error);
        console.error(`Research agent ${agent} failed: ${reason}`);
        calls.push({ agent, status: "failed", startedAt: at, durationMs: now() - started, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, providerMessageId: null, stopReason: null, error: reason, inputSha256, ledger: ledgerInfo, finishedAfterCancelRequest: await afterCancel() });
        const metric = await db.from("ai_research_stage_metrics").insert({ user_id: userId, run_id: runId, agent, duration_ms: now() - started, status: "failed" });
        if (metric.error) throw new Error("Research monitoring unavailable");
        throw error;
      }
      const r = result.reported;
      const actual = r.inputTokens === null && r.outputTokens === null ? null : (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      m.settle(handle, actual ?? handle, r.costUsd);
      // Settle before anything else so the call is accounted even if the run was closed meanwhile.
      const ledgerInfo = await settleLedger(actual, r.costUsd);
      const durationMs = now() - started;
      calls.push({ agent, status: "completed", startedAt: at, durationMs, ...r, inputSha256, ledger: ledgerInfo, finishedAfterCancelRequest: await afterCancel() });
      const metric = await db.from("ai_research_stage_metrics").insert({ user_id: userId, run_id: runId, agent, duration_ms: durationMs, status: "completed", input_tokens: result.inputTokens, output_tokens: result.outputTokens, provider_cost_usd: r.costUsd });
      if (metric.error) throw new Error("Research monitoring unavailable");
      const usage = await db.from("ai_research_usage").insert({ run_id: runId, user_id: userId, agent, model: AI_MODEL, input_tokens: result.inputTokens, output_tokens: result.outputTokens });
      if (usage.error) throw usage.error;
      return result.report;
    };
    const save = async (result: AgentResult) => {
      const row = { run_id: runId, user_id: userId, agent: result.agent, status: result.status, report: result.report };
      const saved = result.agent === "market" || result.agent === "fundamentals" ? await db.from("ai_agent_outputs").insert(row) : ["trader", "risk_aggressive", "risk_conservative", "risk_neutral", "portfolio"].includes(result.agent) ? await db.from("ai_research_decisions").insert(row) : await db.from("ai_research_reports").insert(row);
      if (saved.error) throw saved.error;
      results.push(result);
    };
    const first = await runResearchStages({
      market: { evidence: ev.snapshot },
      fundamentals: { evidence: ev.fundamentals, missing: ev.fundamentals.facts.length ? undefined : ev.fundamentals.limitation },
      news: { evidence: ev.news, missing: ev.news.articles.length ? undefined : ev.news.limitation },
      sentiment: { evidence: ev.sentiment, missing: ev.sentiment.limitation },
    }, analyze, save);
    const all = await runDecisionStages(first.results, ev.snapshot, analyze, save);
    proposal = buildResearchProposal(ev.snapshot, all);
    const proposalWrite = await db.from("ai_trade_proposals").insert({ run_id: runId, user_id: userId, proposal });
    if (proposalWrite.error) throw proposalWrite.error;
  } catch (error) {
    console.error("Research run failed", error);
    failure = error instanceof Error && /limits unavailable|usage evidence|ownership could not be verified/.test(error.message) ? error.message : "Research could not finish. Market data or report storage may be unavailable. No trades were placed.";
  }
  // Decision record: always written, including for failed and partial runs.
  const agents = allAgents(results);
  const snap = evidence?.snapshot ?? null;
  let risk: Awaited<ReturnType<typeof computeRiskPreview>> | null = null;
  try { risk = await computeRiskPreview(db, userId, snap); } catch { risk = null; }
  const record = buildDecisionRecord({
    runId, userId, symbol, timeframe: "1d", startedAt, decidedAt: new Date(now()).toISOString(),
    snapshot: snap ? { provider: snap.provider, asOf: snap.asOf, fetchedAt: snap.fetchedAt, close: snap.close } : null,
    snapshotHash: snap ? await sha256Hex(canonicalJson(snap)) : null,
    sources: evidence ? {
      market: { provider: snap?.provider ?? "Yahoo Finance", asOf: snap?.asOf ?? "", fetchedAt: snap?.fetchedAt ?? "", candles: snap?.candles.length ?? 0 },
      fundamentals: { provider: "Yahoo Finance", statements: evidence.fundamentals.facts.length, latestStatement: evidence.fundamentals.facts.map((f) => f.date).sort().at(-1) ?? null, limitation: evidence.fundamentals.limitation },
      news: { provider: evidence.news.provider, fetchedAt: evidence.news.fetchedAt, headlines: evidence.news.articles.length, newestPublished: evidence.news.articles.length ? new Date(Math.max(...evidence.news.articles.map((a) => a.providerPublishTime)) * 1000).toISOString() : null, limitation: evidence.news.limitation },
      sentiment: { provider: evidence.sentiment.provider, available: false, limitation: evidence.sentiment.limitation },
    } : {},
    agents, proposal, riskPreview: risk?.preview ?? null, riskEngineBlock: risk?.riskEngineBlock ?? null, accountExposure: risk?.accountExposure ?? null,
    provider: { name: AI_PROVIDER_NAME, model: AI_MODEL }, calls, budget: meter?.state() ?? null, failure,
  });
  let ledgerState: "stored" | "pending_migration" | "failed" = "failed";
  const ins = await untyped(db).from("ai_decision_records").insert({ run_id: runId, user_id: userId, market: record.market, symbol, timeframe: "1d", outcome: record.outcome, decided_at: record.decidedAt, record, schema_version: record.schemaVersion });
  if (!ins.error) ledgerState = "stored";
  else if (tableMissing(ins.error)) {
    // Until draft migration 0043 is approved the record is kept with the run (mutable, labelled provisional).
    const keep = await db.from("ai_research_runs").update({ research_evidence: { version: 3, news: evidence?.news ?? null, sentiment: evidence?.sentiment ?? null, pendingDecisionRecord: record } as never }).eq("id", runId).eq("user_id", userId).in("status", ["queued", "running"]);
    ledgerState = keep.error ? "failed" : "pending_migration";
  } else console.error("Decision record could not be saved", ins.error);
  // Risk evaluation history (append-only once migration 0043 is applied; until then it lives in the record only).
  const ev = record.riskEvaluation.evaluation;
  const evWrite = await untyped(db).from("ai_risk_evaluations").insert({ run_id: runId, user_id: userId, symbol, market_type: ev.marketType, proposed_direction: ev.proposedDirection, decision: ev.decision, execution_authorized: false, estimated_position_size: ev.estimatedPositionSize, estimated_risk_amount: ev.estimatedRiskAmount, available_risk_budget: ev.availableRiskBudget, account_exposure: ev.accountExposure, rejection_reasons: ev.rejectionReasons, missing_inputs: ev.missingInputs, evaluation: ev });
  if (evWrite.error && !tableMissing(evWrite.error)) console.error("Risk evaluation could not be saved", evWrite.error);
  const status = RUN_STATUS_FOR_OUTCOME[record.outcome];
  const reasonText = failure ?? record.stopReason ?? null;
  const completedAt = new Date(now()).toISOString();
  // Compare-and-set on status (and, with 0043, on this worker): a run already closed elsewhere is never overwritten.
  let saved = await ownRun(db.from("ai_research_runs").update({ status, ...(reasonText ? { error: reasonText } : {}), completed_at: completedAt }).eq("id", runId).eq("user_id", userId)).in("status", ["queued", "running"]).select("id");
  if (saved.error && saved.error.code === "23514" && (status === "cancelled" || status === "budget_exceeded")) {
    // Before migration 0043 the status list lacks these two; keep the precise outcome in the record and the reason here.
    saved = await ownRun(db.from("ai_research_runs").update({ status: results.some((r) => r.status === "completed") ? "partial" : "failed", error: `${status === "cancelled" ? "Cancelled" : "Stopped by a research limit"}: ${reasonText ?? "no reason recorded"}`, completed_at: completedAt }).eq("id", runId).eq("user_id", userId)).in("status", ["queued", "running"]).select("id");
  }
  if (saved.error) throw new Error("Research status could not be saved; check history before starting again");
  const finalized = (saved.data?.length ?? 0) > 0;
  if (!finalized) console.error(`Research run ${runId} was already closed elsewhere; its saved status was left unchanged`);
  return { runId, outcome: record.outcome, status, ledger: ledgerState, stopReason: meter?.state().stopReason ?? null, finalized };
}
