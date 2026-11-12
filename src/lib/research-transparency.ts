// Pure, browser-safe transparency helpers. They only re-describe stored agent outputs; nothing here
// creates prices, sizes, confidence or missing data.
import { analystReport, unavailableReport } from "./research";
import { AGENT_LABELS, RESEARCH_AGENTS, type AgentResult, type ResearchAgent, type ResearchReport } from "./research-pipeline";

export type AgentStatus = AgentResult["status"] | "not_run";
export interface AgentRecord { agent: ResearchAgent; status: AgentStatus; report: ResearchReport }
const ANALYSTS: ResearchAgent[] = ["market", "fundamentals", "news", "sentiment"];
const DECISION: ResearchAgent[] = ["manager", "trader", "risk_aggressive", "risk_conservative", "risk_neutral", "portfolio"];

/** Always 12 entries, in pipeline order; an agent with no stored output is "not_run" (never invented). */
export function allAgents(rows: { agent: string; status: string; report: unknown }[]): AgentRecord[] {
  return RESEARCH_AGENTS.map((agent) => {
    const row = rows.find((r) => r.agent === agent);
    const parsed = row ? analystReport.safeParse(row.report) : null;
    const status = row && ["completed", "unavailable", "failed"].includes(row.status) ? (row.status as AgentResult["status"]) : null;
    if (!row || !status || !parsed?.success) return { agent, status: "not_run" as const, report: unavailableReport("This agent did not run, so no assessment exists.") };
    return { agent, status, report: parsed.data };
  });
}

export function bullBearArguments(agents: AgentRecord[]) {
  const side = (agent: "bull" | "bear") => {
    const a = agents.find((x) => x.agent === agent);
    if (!a || a.status !== "completed") return { available: false as const, status: a?.status ?? "not_run", reason: a?.report.limitations[0] ?? a?.report.summary ?? "No report." };
    return { available: true as const, status: a.status, outlook: a.report.outlook, summary: a.report.summary, arguments: a.report.observations, counterpoints: a.report.risks };
  };
  return { bull: side("bull"), bear: side("bear") };
}

/** Disagreement among completed, directional agents. Bull and Bear argue opposite sides by design and are listed separately. */
export function agentDisagreement(agents: AgentRecord[]) {
  const outlooks = Object.fromEntries(agents.map((a) => [a.agent, a.status === "completed" ? a.report.outlook : null])) as Record<ResearchAgent, ResearchReport["outlook"] | null>;
  const judged = agents.filter((a) => a.agent !== "bull" && a.agent !== "bear" && a.status === "completed");
  const bullish = judged.filter((a) => a.report.outlook === "bullish").map((a) => AGENT_LABELS[a.agent]);
  const bearish = judged.filter((a) => a.report.outlook === "bearish").map((a) => AGENT_LABELS[a.agent]);
  const neutral = judged.filter((a) => a.report.outlook === "neutral" || a.report.outlook === "insufficient_data").map((a) => AGENT_LABELS[a.agent]);
  const conflicts: string[] = [];
  if (bullish.length && bearish.length) conflicts.push(`Opposite directions: bullish — ${bullish.join(", ")}; bearish — ${bearish.join(", ")}.`);
  const pair = (a: ResearchAgent, b: ResearchAgent) => { if (outlooks[a] && outlooks[b] && outlooks[a] !== outlooks[b]) conflicts.push(`${AGENT_LABELS[a]} (${outlooks[a]?.replaceAll("_", " ")}) and ${AGENT_LABELS[b]} (${outlooks[b]?.replaceAll("_", " ")}) differ.`); };
  pair("manager", "portfolio"); pair("trader", "portfolio");
  const risk = (["risk_aggressive", "risk_conservative", "risk_neutral"] as const).map((r) => outlooks[r]).filter((o): o is NonNullable<typeof o> => o !== null);
  if (new Set(risk).size > 1) conflicts.push("The three risk analysts do not agree.");
  const level = judged.length < 2 ? "unavailable" as const : bullish.length && bearish.length ? "high" as const : conflicts.length || neutral.length && (bullish.length || bearish.length) ? "some" as const : "none" as const;
  return { level, outlooks, bullish, bearish, neutral, conflicts, debate: { bull: outlooks.bull, bear: outlooks.bear } };
}

export interface SourceNote { source: string; agent: ResearchAgent | null; status: "unavailable" | "failed" | "not_run" | "partial"; reason: string }
/** Unavailable or failed sources and agents, with the stored reason. */
export function unavailableSources(agents: AgentRecord[]): SourceNote[] {
  const names: Partial<Record<ResearchAgent, string>> = { market: "Market data", fundamentals: "Financial statements", news: "News headlines", sentiment: "Social sentiment" };
  return agents.flatMap((a) => a.status === "completed" ? [] : [{ source: names[a.agent] ?? AGENT_LABELS[a.agent], agent: a.agent, status: a.status === "unavailable" || a.status === "failed" || a.status === "not_run" ? a.status : "partial", reason: a.report.limitations[0] ?? a.report.summary }]);
}

export function researchLimitations(agents: AgentRecord[]) {
  return [...new Set(agents.flatMap((a) => a.report.limitations))];
}

/** Hindsight warning: the model's training data may postdate the evidence. */
export function leakageWarnings(asOf: string | null, model: string, now = Date.now()) {
  const w = [`The AI model (${model}) may have been trained on information published after the evidence date${asOf ? ` (${new Date(asOf).toISOString().slice(0, 10)})` : ""}. Its view of a past period can reflect hindsight, so this research is not evidence of predictive skill. The provider does not publish a training cutoff here.`];
  if (asOf && now - Date.parse(asOf) > 2 * 86_400_000) w.push("The latest completed daily candle is more than 2 days old; conditions may have changed since.");
  return w;
}

export type ResearchOutcome = "complete" | "partial" | "failed" | "stopped_by_budget";
/** "complete" means every agent that had evidence finished; analysts may be unavailable only because a source is missing. */
export function decisionOutcome(agents: AgentRecord[], budgetStopped: boolean): ResearchOutcome {
  if (budgetStopped) return "stopped_by_budget";
  if (!agents.some((a) => a.status === "completed")) return "failed";
  const market = agents.find((a) => a.agent === "market");
  const analystsOk = agents.filter((a) => ANALYSTS.includes(a.agent)).every((a) => a.status === "completed" || a.status === "unavailable");
  const rest = agents.filter((a) => !ANALYSTS.includes(a.agent)).every((a) => a.status === "completed");
  return market?.status === "completed" && analystsOk && rest ? "complete" : "partial";
}
export const DECISION_AGENTS = DECISION;
