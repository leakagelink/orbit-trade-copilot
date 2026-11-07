import type { z } from "zod";
import { analystReport, unavailableReport } from "./research";

export const RESEARCH_AGENTS = ["market","fundamentals","news","sentiment","bull","bear","manager"] as const;
export type ResearchAgent = (typeof RESEARCH_AGENTS)[number];
export type ResearchReport = z.infer<typeof analystReport>;
export type AgentResult = { agent: ResearchAgent; status: "completed" | "unavailable" | "failed"; report: ResearchReport };
export const AGENT_LABELS: Record<ResearchAgent,string> = { market: "Market Analyst", fundamentals: "Fundamentals Analyst", news: "News Analyst", sentiment: "Social Sentiment Analyst", bull: "Bull Researcher", bear: "Bear Researcher", manager: "Research Manager" };

/** Ordered dependency stages; missing evidence never initiates paid inference. */
export async function runResearchStages(
  inputs: Record<"market" | "fundamentals" | "news" | "sentiment", { evidence: unknown; missing?: string | undefined }>,
  analyze: (agent: ResearchAgent, evidence: unknown) => Promise<ResearchReport>,
  save: (result: AgentResult) => Promise<void>,
) {
  async function perform(agent: ResearchAgent, evidence: unknown, missing?: string): Promise<AgentResult> {
    let result: AgentResult;
    if (missing) result = { agent, status: "unavailable", report: unavailableReport(missing) };
    else {
      try { result = { agent, status: "completed", report: analystReport.parse(await analyze(agent,evidence)) }; }
      catch { result = { agent, status: "failed", report: unavailableReport("This report could not finish. No automatic retry was made; AI credits may have been consumed.") }; }
    }
    await save(result);
    return result;
  }
  // allSettled drains sibling writes before the run is marked terminal.
  async function stage(jobs: Promise<AgentResult>[]) {
    const settled = await Promise.allSettled(jobs);
    const rejected = settled.find(r => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    return settled.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  }
  const analysts = await stage((["market","fundamentals","news","sentiment"] as const).map(agent => perform(agent,inputs[agent].evidence,inputs[agent].missing)));
  const noEvidence = analysts.some(r => r.status === "failed") ? "An analyst failed; dependent debate is paused. Check the run before authorizing another attempt." : analysts.every(r => r.status !== "completed") ? "No completed analyst evidence is available for a debate." : undefined;
  const debate = await stage((["bull","bear"] as const).map(agent => perform(agent,{ analysts },noEvidence)));
  const noDebate = debate.some(r => r.status !== "completed") ? "Both debate reports are required for a balanced synthesis." : undefined;
  const manager = await perform("manager", { analysts, debate },noDebate);
  const results = [...analysts,...debate,manager];
  return { results, status: results.every(r => r.status === "completed") ? "completed" as const : results.some(r => r.status === "completed") ? "partial" as const : "failed" as const };
}