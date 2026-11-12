// Immutable AI decision record: pure builder, shared by server and tests. Browser-safe.
// Separates research decision and risk evaluation; it carries no execution authorization, order intent or order.
import { costStatus, type BudgetState } from "./research-budget";
import type { RiskPreview } from "./research-risk-preview";
import { evaluateResearchRisk } from "./research-risk-evaluation";
import { dataQuality } from "./research-data-quality";
import { AGENT_INPUTS, AGENT_ROLES, managerConclusion, portfolioDecision } from "./research-decisions";
import { AGENT_LABELS } from "./research-pipeline";
import { agentDisagreement, bullBearArguments, decisionOutcome, leakageWarnings, researchLimitations, RUN_STATUS_FOR_OUTCOME, unavailableSources, type AgentRecord } from "./research-transparency";

export const DECISION_RECORD_SCHEMA = 2;
/** Bump when any analyst system prompt or role text in research.server.ts changes. */
export const RESEARCH_PROMPT_VERSION = "research-prompts-v12";
export const RESEARCH_STRATEGY = { key: "daily-12-agent", label: "12-agent daily research", timeframe: "1d" } as const;

export interface AgentCall {
  agent: string; status: "completed" | "failed"; startedAt: string; durationMs: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costUsd: number | null; providerMessageId: string | null; stopReason: string | null;
  error?: string | null;
  /** Format-correction calls made after an invalid first reply (0 or 1). */
  repairs?: number;
  /** SHA-256 of the exact evidence sent to this agent. */
  inputSha256?: string | null;
  /** Spending reservation for this call: database ledger ("atomic", migration 0043) or in-memory only. */
  ledger?: { mode: "atomic" | "pending_migration"; reservations: number; reservedTokens: number; consumedTokens: number | null; basis: "provider_reported" | "reservation_estimate"; settled: boolean } | null;
  /** True when the owner's cancel request was already recorded when this in-flight call finished (null = could not check). */
  finishedAfterCancelRequest?: boolean | null;
}
export interface SourceSummary {
  market?: { provider?: string; asOf?: string; fetchedAt?: string; candles?: number };
  fundamentals?: { provider?: string; statements?: number; latestStatement?: string | null; limitation?: string };
  news?: { provider?: string; fetchedAt?: string; headlines?: number; newestPublished?: string | null; limitation?: string };
  sentiment?: { provider?: string; available?: boolean; limitation?: string };
}
export interface DecisionRecordInput {
  runId: string; userId: string; symbol: string; timeframe: "1d"; startedAt: string; decidedAt: string;
  snapshot: { provider: string; asOf: string; fetchedAt: string; close: number } | null;
  snapshotHash: string | null;
  sources: SourceSummary;
  agents: AgentRecord[];
  proposal: { status: string; reasons: string[]; direction?: string } | null;
  riskPreview: RiskPreview | null; riskEngineBlock: string | null; accountExposure?: number | null;
  provider: { name: string; model: string };
  calls: AgentCall[]; budget: BudgetState | null; failure: string | null;
}

export function marketOf(symbol: string) { return symbol.endsWith("-USD") ? "crypto" as const : "equity" as const; }

export function buildDecisionRecord(i: DecisionRecordInput) {
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => i.calls.every((c) => c[k] !== null) ? i.calls.reduce((a, c) => a + (c[k] ?? 0), 0) : null;
  const costs = i.calls.map((c) => c.costUsd);
  const cost = costStatus(costs);
  const manager = i.agents.find((a) => a.agent === "manager"), portfolio = i.agents.find((a) => a.agent === "portfolio");
  const conclusion = (a: AgentRecord | undefined) => a ? { status: a.status, outlook: a.status === "completed" ? a.report.outlook : null, summary: a.report.summary } : null;
  // A run that hit any failure (for example its proposal could not be stored) is never reported as complete.
  const base = decisionOutcome(i.agents, i.budget?.stoppedBy ?? null);
  const outcome = i.failure && !i.agents.some((a) => a.status === "completed") ? "failed" as const : i.failure && base === "complete" ? "partial" as const : base;
  const rejections = [...(i.proposal?.status === "withheld" ? i.proposal.reasons : []), ...(i.riskEngineBlock ? [`Risk Engine: ${i.riskEngineBlock}`] : []), ...(i.riskPreview?.blockReason ? [`Risk preview: ${i.riskPreview.blockReason}`] : []), ...(i.riskPreview?.unavailable ?? []).map((u) => `Risk preview input unavailable: ${u}`)];
  const quality = dataQuality({
    symbol: i.symbol, now: Date.parse(i.decidedAt),
    market: i.snapshot ? { asOf: i.snapshot.asOf, fetchedAt: i.snapshot.fetchedAt, candles: i.sources.market?.candles ?? 0 } : null,
    fundamentals: i.sources.fundamentals ? { statements: i.sources.fundamentals.statements ?? null, latestStatement: i.sources.fundamentals.latestStatement ?? null, limitation: i.sources.fundamentals.limitation ?? null } : null,
    news: i.sources.news ? { headlines: i.sources.news.headlines ?? null, newestPublished: i.sources.news.newestPublished ?? null, fetchedAt: i.sources.news.fetchedAt ?? null, limitation: i.sources.news.limitation ?? null } : null,
    sentiment: i.sources.sentiment ? { limitation: i.sources.sentiment.limitation ?? null } : null,
    agents: i.agents, sourceError: i.snapshot ? null : i.failure,
  });
  const unavailable = unavailableSources(i.agents);
  const missingNames = quality.sources.filter((s) => s.status === "UNAVAILABLE").map((s) => s.label);
  const status = RUN_STATUS_FOR_OUTCOME[outcome];
  return {
    schemaVersion: DECISION_RECORD_SCHEMA, advisoryOnly: true as const, executionAllowed: false as const,
    runId: i.runId, userId: i.userId, market: marketOf(i.symbol), symbol: i.symbol, timeframe: i.timeframe,
    strategy: RESEARCH_STRATEGY,
    startedAt: i.startedAt, decidedAt: i.decidedAt, totalDurationMs: Math.max(0, Date.parse(i.decidedAt) - Date.parse(i.startedAt)),
    outcome, status, failure: i.failure, stopReason: i.budget?.stopReason ?? null,
    marketData: { snapshot: i.snapshot, snapshotSha256: i.snapshotHash, sources: i.sources },
    // Standard envelope per agent; the analytical content stays each agent's own report.
    agents: i.agents.map((a) => {
      const call = i.calls.filter((c) => c.agent === a.agent).at(-1) ?? null;
      return {
        agent: a.agent, label: AGENT_LABELS[a.agent], role: AGENT_ROLES[a.agent], status: a.status, report: a.report,
        envelope: {
          direction: a.status === "completed" ? a.report.outlook : null,
          summary: a.report.summary, supportingEvidence: a.report.observations, contradictingEvidence: a.report.risks, limitations: a.report.limitations,
          dataSources: AGENT_INPUTS[a.agent], unavailableSources: a.agent === "market" || a.agent === "fundamentals" || a.agent === "news" || a.agent === "sentiment" ? unavailable.filter((u) => u.agent === a.agent).map((u) => u.source) : missingNames,
          modelUncertainty: "not_assessed" as const,
          model: call ? i.provider.model : null, promptVersion: call ? RESEARCH_PROMPT_VERSION : null,
          marketDataAsOf: i.snapshot?.asOf ?? null, inputSha256: call?.inputSha256 ?? null,
          call: call ? { status: call.status, startedAt: call.startedAt, durationMs: call.durationMs, inputTokens: call.inputTokens, outputTokens: call.outputTokens, cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens, costUsd: call.costUsd, repairs: call.repairs ?? 0, error: call.error ?? null } : null,
        },
      };
    }),
    arguments: bullBearArguments(i.agents),
    conclusions: { researchManager: conclusion(manager), portfolioManager: conclusion(portfolio) },
    decisions: { researchManager: managerConclusion(manager), portfolio: portfolioDecision(portfolio, i.proposal), advisoryOnly: true as const },
    riskEvaluation: {
      preview: i.riskPreview, riskEngineBlock: i.riskEngineBlock, proposalStatus: i.proposal?.status ?? null, rejectionReasons: rejections,
      evaluation: evaluateResearchRisk({ symbol: i.symbol, proposal: i.proposal, preview: i.riskPreview, riskEngineBlock: i.riskEngineBlock, accountExposure: i.accountExposure ?? null, evaluatedAt: i.decidedAt }),
    },
    transparency: { disagreement: agentDisagreement(i.agents), unavailable, limitations: researchLimitations(i.agents), leakage: leakageWarnings(i.snapshot?.asOf ?? null, i.provider.model, Date.parse(i.decidedAt)), dataQuality: quality },
    execution: {
      provider: i.provider.name, model: i.provider.model, promptVersion: RESEARCH_PROMPT_VERSION,
      calls: i.calls,
      totals: { calls: i.calls.length, failedCalls: i.calls.filter((c) => c.status === "failed").length, repairs: i.calls.reduce((a, c) => a + (c.repairs ?? 0), 0), retries: 0, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), latencyMs: i.calls.reduce((a, c) => a + c.durationMs, 0), costUsd: cost.amountUsd, costStatus: cost.status, costNote: cost.status === "UNKNOWN_COST" ? "Cost not reported by the provider; no price was assumed." : null },
      budget: i.budget,
    },
  };
}
export type DecisionRecord = ReturnType<typeof buildDecisionRecord>;

/** Deterministic JSON (sorted keys) for hashing evidence. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export async function sha256Hex(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
