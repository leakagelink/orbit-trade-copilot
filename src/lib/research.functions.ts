import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { researchInput } from "./research";
import { runResearchStages, runDecisionStages, type ResearchAgent, type AgentResult } from "./research-pipeline";
import { buildResearchProposal } from "./research-proposal";
import { AI_MODEL } from "./ai-provider";

export const listResearch = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data, error } = await context.supabase.from("ai_research_runs").select("*,ai_agent_outputs(*),ai_research_reports(*),ai_research_decisions(*),ai_trade_proposals(*),ai_research_stage_metrics(*)").eq("user_id",context.userId).order("created_at", { ascending: false }).limit(30);
  if (error) throw new Error("Research history is unavailable");
  return data;
});

export const startResearchRun = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => researchInput.parse(input)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const claim = await db.rpc("claim_ai_research", { _id: data.requestId, _user_id: context.userId, _symbol: data.symbol });
    if (claim.error) throw new Error(claim.error.message.includes("allowance") ? "Monthly research allowance reached. Check usage; new capacity is available next UTC month." : "Research could not start. A prior run may be unresolved; check history before trying again.");
    if (!claim.data) return { runId: data.requestId };
    const { loadResearchData, runAnalyst } = await import("./research.server");
    try {
      const evidence = await loadResearchData(data.symbol);
      const snapshotWrite = await db.from("ai_research_runs").update({ snapshot: evidence.snapshot, research_evidence: { version: 3, news: evidence.news, sentiment: evidence.sentiment } }).eq("id",data.requestId).eq("user_id",context.userId);
      if (snapshotWrite.error) throw snapshotWrite.error;
      const analyze = async (agent: ResearchAgent,input: unknown) => {
        const started=Date.now();let result:Awaited<ReturnType<typeof runAnalyst>>;
        try{result=await runAnalyst(agent,data.symbol,input);}catch(error){const metric=await db.from("ai_research_stage_metrics").insert({user_id:context.userId,run_id:data.requestId,agent,duration_ms:Date.now()-started,status:"failed"});if(metric.error)throw new Error("Research monitoring unavailable");throw error;}
        const metric=await db.from("ai_research_stage_metrics").insert({user_id:context.userId,run_id:data.requestId,agent,duration_ms:Date.now()-started,status:"completed",input_tokens:result.inputTokens,output_tokens:result.outputTokens});if(metric.error)throw new Error("Research monitoring unavailable");
        const usage = await db.from("ai_research_usage").insert({ run_id: data.requestId, user_id: context.userId, agent, model: AI_MODEL, input_tokens: result.inputTokens, output_tokens: result.outputTokens });
        if (usage.error) throw usage.error;
        return result.report;
      };
      const save = async ({ agent,status,report }: AgentResult) => {
        const row = { run_id: data.requestId,user_id: context.userId,agent,status,report };
        const saved = agent === "market" || agent === "fundamentals" ? await db.from("ai_agent_outputs").insert(row) : ["trader","risk_aggressive","risk_conservative","risk_neutral","portfolio"].includes(agent) ? await db.from("ai_research_decisions").insert(row) : await db.from("ai_research_reports").insert(row);
        if (saved.error) throw saved.error;
      };
      const first = await runResearchStages({
        market: { evidence: evidence.snapshot },
        fundamentals: { evidence: evidence.fundamentals, missing: evidence.fundamentals.facts.length ? undefined : evidence.fundamentals.limitation },
        news: { evidence: evidence.news, missing: evidence.news.articles.length ? undefined : evidence.news.limitation },
        sentiment: { evidence: evidence.sentiment, missing: evidence.sentiment.limitation },
      }, analyze, save);
      const results = await runDecisionStages(first.results, evidence.snapshot, analyze, save);
      const proposal = buildResearchProposal(evidence.snapshot, results);
      const proposalWrite = await db.from("ai_trade_proposals").insert({ run_id: data.requestId, user_id: context.userId, proposal });
      if (proposalWrite.error) throw proposalWrite.error;
      const status = results.every(r => r.status === "completed") ? "completed" : results.some(r => r.status === "completed") ? "partial" : "failed";
      const saved = await db.from("ai_research_runs").update({ status, completed_at: new Date().toISOString() }).eq("id",data.requestId).eq("user_id",context.userId);
      if (saved.error) throw saved.error;
    } catch (error) {
      console.error("Research run failed",error);
      const failed = await db.from("ai_research_runs").update({ status: "failed", error: "Research could not finish. Market data or report storage may be unavailable. No trades were placed.", completed_at: new Date().toISOString() }).eq("id",data.requestId).eq("user_id",context.userId);
      if (failed.error) throw new Error("Research status could not be saved; check history before starting again");
    }
    return { runId: data.requestId };
  });