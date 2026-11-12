// Research run orchestration (advisory only). Writes only research tables; it never creates orders, order intents,
// positions or settings, and never reads exchange credentials. The only trading-module call is the read-only
// `accountRiskBlock` check (selects only). AI output is never an input to sizing.
import { AI_MODEL, AI_PROVIDER_NAME } from "./ai-provider";
import { runResearchStages, runDecisionStages, type ResearchAgent, type AgentResult, type ResearchReport } from "./research-pipeline";
import { buildResearchProposal } from "./research-proposal";
import { createBudgetMeter, DEFAULT_RESEARCH_BUDGET, projectCallTokens, researchBudget, type BudgetMeter, type ResearchBudget } from "./research-budget";
import { buildDecisionRecord, canonicalJson, sha256Hex, type AgentCall } from "./research-record";
import { allAgents, RUN_STATUS_FOR_OUTCOME } from "./research-transparency";
import { riskPreview, type RiskPreview } from "./research-risk-preview";
import { tradeNet } from "./trade-accounting";

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
/** True once the owner has asked this run to stop (append-only audit event). */
export async function cancelRequested(db: Admin, userId: string, runId: string) {
  const r = await db.from("audit_logs").select("id").eq("user_id", userId).eq("action", RESEARCH_CANCEL_ACTION).eq("entity_id", runId).limit(1);
  if (r.error) { console.error("Research cancel check failed", r.error.message); return false; }
  return (r.data?.length ?? 0) > 0;
}

/** Read-only account inputs for the preview, then the existing Risk Engine check on the resulting cost. */
export async function computeRiskPreview(db: Admin, userId: string, snapshot: { close: number; asOf: string; candles: { t: number; o: number; h: number; l: number; c: number }[] } | null): Promise<{ preview: RiskPreview; riskEngineBlock: string | null; accountExposure: number | null }> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const [risk, pos, trades] = await Promise.all([
    db.from("risk_settings").select("max_open_exposure,max_daily_loss,max_total_positions,trading_halted").eq("user_id", userId).maybeSingle(),
    db.from("positions").select("entry_price,quantity,unrealized_pnl").eq("user_id", userId).eq("is_open", true),
    db.from("trades").select("realized_pnl,fees,funding_pnl,costs_verified").eq("user_id", userId).gte("closed_at", start.toISOString()),
  ]);
  const limits = risk.error || !risk.data ? null : { maxOpenExposure: risk.data.max_open_exposure === null ? null : Number(risk.data.max_open_exposure), maxDailyLoss: risk.data.max_daily_loss === null ? null : Number(risk.data.max_daily_loss), maxTotalPositions: risk.data.max_total_positions, halted: risk.data.trading_halted };
  const account = pos.error || trades.error || !pos.data || !trades.data ? null : {
    openExposure: pos.data.reduce((a, p) => a + Number(p.entry_price) * Number(p.quantity), 0),
    openPositions: pos.data.length,
    dailyNet: trades.data.reduce((a, t) => a + tradeNet(t), 0) + pos.data.reduce((a, p) => a + Math.min(0, Number(p.unrealized_pnl)), 0),
  };
  const preview = riskPreview({ referencePrice: snapshot?.close ?? null, asOf: snapshot?.asOf ?? null, candles: snapshot?.candles ?? [], limits, account });
  let riskEngineBlock: string | null = null;
  if (preview.status === "estimate" && preview.positionValue !== null && preview.positionValue > 0) {
    const { accountRiskBlock } = await import("./engine.server"); // read-only check; places nothing
    riskEngineBlock = await accountRiskBlock(db, userId, preview.positionValue);
  }
  return { preview, riskEngineBlock, accountExposure: account?.openExposure ?? null };
}

export async function executeResearchRun(db: Admin, userId: string, runId: string, symbol: string, deps: ResearchRunDeps) {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const calls: AgentCall[] = [];
  const results: AgentResult[] = [];
  let evidence: ResearchData | null = null;
  let meter: BudgetMeter | null = null;
  let failure: string | null = null;
  let proposal: ReturnType<typeof buildResearchProposal> | null = null;
  try {
    const budget = await loadResearchBudget(db);
    const [userDay, userMonth, platformMonth] = await Promise.all([dayTokens(db, userId, now()), monthTokens(db, userId, now()), monthTokens(db, null, now())]);
    meter = createBudgetMeter(budget.limits, { userDayTokens: userDay, userMonthTokens: userMonth, platformMonthTokens: platformMonth, platformMonthUsd: null }, { startedAt: Date.parse(startedAt), now });
    const m = meter;
    let cancelled = false;
    const checkCancelled = async () => {
      if (!cancelled) cancelled = await cancelRequested(db, userId, runId);
      if (cancelled) m.halt("cancelled", "Cancelled by you. No further AI calls were made; completed reports are kept.");
    };
    evidence = await deps.loadResearchData(symbol);
    const ev = evidence;
    const snapshotWrite = await db.from("ai_research_runs").update({ snapshot: ev.snapshot, research_evidence: { version: 3, news: ev.news, sentiment: ev.sentiment } }).eq("id", runId).eq("user_id", userId);
    if (snapshotWrite.error) throw snapshotWrite.error;
    const analyze = async (agent: ResearchAgent, input: unknown) => {
      await checkCancelled();
      let handle = m.reserve(projectCallTokens(JSON.stringify({ symbol, evidence: input }).length + SYSTEM_OVERHEAD_CHARS));
      const inputSha256 = await sha256Hex(canonicalJson({ symbol, evidence: input }));
      const started = now(); const at = new Date(started).toISOString();
      let result: AnalystCallResult;
      try { result = await deps.runAnalyst(agent, symbol, input, async (projected) => { await checkCancelled(); handle += m.reserve(projected, "repair"); }); }
      catch (error) {
        m.settleFailed(handle);
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        console.error(`Research agent ${agent} failed: ${reason}`);
        calls.push({ agent, status: "failed", startedAt: at, durationMs: now() - started, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, providerMessageId: null, stopReason: null, error: reason, inputSha256 });
        const metric = await db.from("ai_research_stage_metrics").insert({ user_id: userId, run_id: runId, agent, duration_ms: now() - started, status: "failed" });
        if (metric.error) throw new Error("Research monitoring unavailable");
        throw error;
      }
      const r = result.reported;
      m.settle(handle, (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0), r.costUsd);
      const durationMs = now() - started;
      calls.push({ agent, status: "completed", startedAt: at, durationMs, ...r, inputSha256 });
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
    failure = error instanceof Error && /limits unavailable|usage evidence/.test(error.message) ? error.message : "Research could not finish. Market data or report storage may be unavailable. No trades were placed.";
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
  let ledger: "stored" | "pending_migration" | "failed" = "failed";
  const ins = await untyped(db).from("ai_decision_records").insert({ run_id: runId, user_id: userId, market: record.market, symbol, timeframe: "1d", outcome: record.outcome, decided_at: record.decidedAt, record, schema_version: record.schemaVersion });
  if (!ins.error) ledger = "stored";
  else if (tableMissing(ins.error)) {
    // Until draft migration 0043 is approved the record is kept with the run (mutable, labelled provisional).
    const keep = await db.from("ai_research_runs").update({ research_evidence: { version: 3, news: evidence?.news ?? null, sentiment: evidence?.sentiment ?? null, pendingDecisionRecord: record } as never }).eq("id", runId).eq("user_id", userId);
    ledger = keep.error ? "failed" : "pending_migration";
  } else console.error("Decision record could not be saved", ins.error);
  // Risk evaluation history (append-only once migration 0043 is applied; until then it lives in the record only).
  const ev = record.riskEvaluation.evaluation;
  const evWrite = await untyped(db).from("ai_risk_evaluations").insert({ run_id: runId, user_id: userId, symbol, market_type: ev.marketType, proposed_direction: ev.proposedDirection, decision: ev.decision, execution_authorized: false, estimated_position_size: ev.estimatedPositionSize, estimated_risk_amount: ev.estimatedRiskAmount, available_risk_budget: ev.availableRiskBudget, account_exposure: ev.accountExposure, rejection_reasons: ev.rejectionReasons, missing_inputs: ev.missingInputs, evaluation: ev });
  if (evWrite.error && !tableMissing(evWrite.error)) console.error("Risk evaluation could not be saved", evWrite.error);
  const status = RUN_STATUS_FOR_OUTCOME[record.outcome];
  const errorText = failure ?? record.stopReason ?? null;
  const completedAt = new Date(now()).toISOString();
  // Compare-and-set: a run already closed elsewhere (stale-run cancellation) is never overwritten.
  let saved = await db.from("ai_research_runs").update({ status, ...(errorText ? { error: errorText } : {}), completed_at: completedAt }).eq("id", runId).eq("user_id", userId).in("status", ["queued", "running"]);
  if (saved.error && saved.error.code === "23514" && (status === "cancelled" || status === "budget_exceeded")) {
    // Before migration 0043 the status list lacks these two; keep the precise outcome in the record and the reason here.
    saved = await db.from("ai_research_runs").update({ status: results.some((r) => r.status === "completed") ? "partial" : "failed", error: `${status === "cancelled" ? "Cancelled" : "Stopped by a research limit"}: ${errorText ?? "no reason recorded"}`, completed_at: completedAt }).eq("id", runId).eq("user_id", userId).in("status", ["queued", "running"]);
  }
  if (saved.error) throw new Error("Research status could not be saved; check history before starting again");
  return { runId, outcome: record.outcome, status, ledger, stopReason: meter?.state().stopReason ?? null };
}
