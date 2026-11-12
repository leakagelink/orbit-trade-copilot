// Immutable AI decision record: pure builder, shared by server and tests. Browser-safe.
import type { BudgetState } from "./research-budget";
import type { RiskPreview } from "./research-risk-preview";
import { agentDisagreement, bullBearArguments, decisionOutcome, leakageWarnings, researchLimitations, unavailableSources, type AgentRecord } from "./research-transparency";

export const DECISION_RECORD_SCHEMA = 1;
/** Bump when any analyst system prompt or role text in research.server.ts changes. */
export const RESEARCH_PROMPT_VERSION = "research-prompts-v3";

export interface AgentCall {
  agent: string; status: "completed" | "failed"; startedAt: string; durationMs: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costUsd: number | null; providerMessageId: string | null; stopReason: string | null;
}
export interface DecisionRecordInput {
  runId: string; userId: string; symbol: string; timeframe: "1d"; startedAt: string; decidedAt: string;
  snapshot: { provider: string; asOf: string; fetchedAt: string; close: number } | null;
  snapshotHash: string | null;
  sources: Record<string, unknown>;
  agents: AgentRecord[];
  proposal: { status: string; reasons: string[] } | null;
  riskPreview: RiskPreview | null; riskEngineBlock: string | null;
  provider: { name: string; model: string };
  calls: AgentCall[]; budget: BudgetState | null; failure: string | null;
}

export function marketOf(symbol: string) { return symbol.endsWith("-USD") ? "crypto" as const : "equity" as const; }

export function buildDecisionRecord(i: DecisionRecordInput) {
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => i.calls.every((c) => c[k] !== null) ? i.calls.reduce((a, c) => a + (c[k] ?? 0), 0) : null;
  const costs = i.calls.map((c) => c.costUsd);
  const manager = i.agents.find((a) => a.agent === "manager"), portfolio = i.agents.find((a) => a.agent === "portfolio");
  const conclusion = (a: AgentRecord | undefined) => a ? { status: a.status, outlook: a.status === "completed" ? a.report.outlook : null, summary: a.report.summary } : null;
  const outcome = i.failure && !i.agents.some((a) => a.status === "completed") ? "failed" as const : decisionOutcome(i.agents, !!i.budget?.stoppedBy);
  const rejections = [...(i.proposal?.status === "withheld" ? i.proposal.reasons : []), ...(i.riskEngineBlock ? [`Risk Engine: ${i.riskEngineBlock}`] : []), ...(i.riskPreview?.blockReason ? [`Risk preview: ${i.riskPreview.blockReason}`] : []), ...(i.riskPreview?.unavailable ?? []).map((u) => `Risk preview input unavailable: ${u}`)];
  return {
    schemaVersion: DECISION_RECORD_SCHEMA, advisoryOnly: true as const, executionAllowed: false as const,
    runId: i.runId, userId: i.userId, market: marketOf(i.symbol), symbol: i.symbol, timeframe: i.timeframe,
    startedAt: i.startedAt, decidedAt: i.decidedAt, outcome, failure: i.failure,
    marketData: { snapshot: i.snapshot, snapshotSha256: i.snapshotHash, sources: i.sources },
    agents: i.agents.map((a) => ({ agent: a.agent, status: a.status, report: a.report })),
    arguments: bullBearArguments(i.agents),
    conclusions: { researchManager: conclusion(manager), portfolioManager: conclusion(portfolio) },
    riskEvaluation: { preview: i.riskPreview, riskEngineBlock: i.riskEngineBlock, proposalStatus: i.proposal?.status ?? null, rejectionReasons: rejections },
    transparency: { disagreement: agentDisagreement(i.agents), unavailable: unavailableSources(i.agents), limitations: researchLimitations(i.agents), leakage: leakageWarnings(i.snapshot?.asOf ?? null, i.provider.model, Date.parse(i.decidedAt)) },
    execution: {
      provider: i.provider.name, model: i.provider.model, promptVersion: RESEARCH_PROMPT_VERSION,
      calls: i.calls,
      totals: { calls: i.calls.length, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), latencyMs: i.calls.reduce((a, c) => a + c.durationMs, 0), costUsd: costs.length && costs.every((c) => c !== null) ? costs.reduce((a, c) => a + (c ?? 0), 0) : null, costNote: costs.some((c) => c === null) ? "Cost not reported by the provider; no price was assumed." : null },
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
