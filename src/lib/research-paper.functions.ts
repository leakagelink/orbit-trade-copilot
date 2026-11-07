import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { paperResearchInput, paperScenario, observePaperResearch } from "./research-paper";
import { researchRunLimit } from "./research-allowance";

export const listPaperResearch = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const [papers, observations, allowances, runs, elite] = await Promise.all([
    context.supabase.from("ai_research_paper").select("*").eq("user_id",context.userId).order("confirmed_at",{ascending:false}).limit(50),
    context.supabase.from("ai_research_paper_observations").select("*").eq("user_id",context.userId).order("observed_at",{ascending:false}).limit(200),
    context.supabase.from("ai_research_allowances").select("*").eq("user_id",context.userId).eq("period",new Date().toISOString().slice(0,7)+"-01").maybeSingle(),
    context.supabase.from("ai_research_runs").select("id",{count:"exact",head:true}).eq("user_id",context.userId).gte("created_at",new Date().toISOString().slice(0,7)+"-01T00:00:00Z"),
    context.supabase.rpc("has_elite_access",{_uid:context.userId}),
  ]);
  if (papers.error || observations.error || allowances.error || runs.error || elite.error) throw new Error("Research paper history and usage unavailable");
  return { papers:papers.data, observations:observations.data, used:allowances.data?.used??runs.count??0, limit:allowances.data?.run_limit??researchRunLimit(elite.data===true) };
});

export const confirmPaperResearch = createServerFn({ method:"POST" }).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>paperResearchInput.parse(i)).handler(async ({data,context})=>{
  const {requirePro}=await import("./plan.server");await requirePro(context.supabase,context.userId);
  const found=await context.supabase.from("ai_trade_proposals").select("*,ai_research_runs(symbol)").eq("id",data.proposalId).eq("user_id",context.userId).maybeSingle();
  if (found.error || !found.data || !found.data.ai_research_runs) throw new Error("Owned research proposal required");
  paperScenario(found.data.proposal);
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  const saved=await db.from("ai_research_paper").insert({proposal_id:found.data.id,user_id:context.userId,run_id:found.data.run_id,symbol:found.data.ai_research_runs.symbol,quantity:data.quantity,fee_pct:data.feePct,slippage_pct:data.slippagePct,proposal:found.data.proposal}).select("id").single();
  if (saved.error) {
    if (saved.error.code==="23505") { const existing=await context.supabase.from("ai_research_paper").select("id").eq("proposal_id",data.proposalId).eq("user_id",context.userId).single();if(existing.data)return {id:existing.data.id}; }
    throw new Error("Paper confirmation could not be saved");
  }
  return {id:saved.data.id};
});

export const refreshPaperResearch = createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).strict().parse(i)).handler(async({data,context})=>{
  // Owner recovery remains readable after downgrade; this action never invokes AI or trading.
  const paper=await context.supabase.from("ai_research_paper").select("*").eq("id",data.id).eq("user_id",context.userId).maybeSingle();
  if(paper.error||!paper.data)throw new Error("Owned paper scenario required");
  const {yahooChart}=await import("./exchange-adapters.server");
  const candles=await yahooChart(paper.data.symbol,"1d",2000);
  const result=observePaperResearch({proposal:paper.data.proposal,confirmedAt:Date.parse(paper.data.confirmed_at),quantity:Number(paper.data.quantity),feePct:Number(paper.data.fee_pct),slippagePct:Number(paper.data.slippage_pct)},candles);
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  const saved=await db.from("ai_research_paper_observations").insert({paper_id:data.id,user_id:context.userId,result,evidence:{provider:"Yahoo Finance",timeframe:"1d",candles:candles.map(c=>({t:c.t,o:c.o,h:c.h,l:c.l,c:c.c,v:c.v}))}});
  if(saved.error)throw new Error("Paper observation could not be saved");
  return {status:result.status};
});