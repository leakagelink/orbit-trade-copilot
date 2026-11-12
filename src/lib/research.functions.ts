import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { researchInput } from "./research";

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
    const { executeResearchRun } = await import("./research-run.server");
    return executeResearchRun(db, context.userId, data.requestId, data.symbol, { loadResearchData, runAnalyst });
  });