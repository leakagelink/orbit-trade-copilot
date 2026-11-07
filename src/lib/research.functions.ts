import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analystReport, researchInput, unavailableReport } from "./research";
import type { z } from "zod";

export const listResearch = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data, error } = await context.supabase.from("ai_research_runs").select("*,ai_agent_outputs(*)").eq("user_id",context.userId).order("created_at", { ascending: false }).limit(30);
  if (error) throw new Error("Research history is unavailable");
  return data;
});

export const startResearchRun = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => researchInput.parse(input)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const claim = await db.rpc("claim_ai_research", { _id: data.requestId, _user_id: context.userId, _symbol: data.symbol });
    if (claim.error) throw new Error("Another research run may be in progress; check history before starting again");
    if (!claim.data) return { runId: data.requestId };
    const { loadResearchData, runAnalyst } = await import("./research.server");
    try {
      const evidence = await loadResearchData(data.symbol);
      const snapshotWrite = await db.from("ai_research_runs").update({ snapshot: evidence.snapshot }).eq("id",data.requestId).eq("user_id",context.userId);
      if (snapshotWrite.error) throw snapshotWrite.error;
      const results = await Promise.all((["market","fundamentals"] as const).map(async agent => {
        let status: "completed" | "unavailable" | "failed" = "completed";
        let report: z.infer<typeof analystReport> = unavailableReport(evidence.fundamentals.limitation);
        if (agent === "fundamentals" && !evidence.fundamentals.facts.length) status = "unavailable";
        else {
          try {
            const result = await runAnalyst(agent,data.symbol,agent === "market" ? evidence.snapshot : evidence.fundamentals);
            report = result.report;
            const usage = await db.from("ai_research_usage").insert({ run_id: data.requestId, user_id: context.userId, agent, model: "openai/gpt-6-astra", input_tokens: result.inputTokens, output_tokens: result.outputTokens });
            if (usage.error) throw usage.error;
          } catch (error) {
            console.error("Research analyst failed",agent,error);
            status = "failed"; report = unavailableReport("This analyst could not finish. No automatic retry was made; the request may have consumed AI credits.");
          }
        }
        const saved = await db.from("ai_agent_outputs").insert({ run_id: data.requestId,user_id: context.userId,agent,status,report });
        if (saved.error) throw saved.error;
        return status;
      }));
      const status = results.every(s => s === "completed") ? "completed" : results.some(s => s === "completed") ? "partial" : "failed";
      const saved = await db.from("ai_research_runs").update({ status, completed_at: new Date().toISOString() }).eq("id",data.requestId).eq("user_id",context.userId);
      if (saved.error) throw saved.error;
    } catch (error) {
      console.error("Research run failed",error);
      const failed = await db.from("ai_research_runs").update({ status: "failed", error: "Research could not finish. Market data or report storage may be unavailable. No trades were placed.", completed_at: new Date().toISOString() }).eq("id",data.requestId).eq("user_id",context.userId);
      if (failed.error) throw new Error("Research status could not be saved; check history before starting again");
    }
    return { runId: data.requestId };
  });