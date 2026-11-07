import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateHistoricalEvidence, evaluationEvidence } from "./evaluation";
import { evidenceHash } from "./evidence-hash";
export const listEvaluations=createServerFn({method:"GET"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const {requirePro}=await import("./plan.server");await requirePro(context.supabase,context.userId);
  const [evaluations,backtests]=await Promise.all([context.supabase.from("strategy_evaluations").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(100),context.supabase.from("backtests").select("id,trading_pair,created_at,strategies(name)").eq("user_id",context.userId).eq("status","completed").order("created_at",{ascending:false}).limit(100)]);
  if(evaluations.error||backtests.error)throw new Error("Evaluation evidence unavailable");return {evaluations:evaluations.data,backtests:backtests.data};
});
export const evaluateBacktest=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).parse(i)).handler(async({context,data})=>{
  const {requirePro}=await import("./plan.server");await requirePro(context.supabase,context.userId);
  const bt=await context.supabase.from("backtests").select("id,strategy_id,backtest_results(trade_log)").eq("id",data.id).eq("user_id",context.userId).eq("status","completed").maybeSingle();
  if(bt.error||!bt.data)throw new Error("Completed owned backtest required");
  const evidence=bt.data.backtest_results?.trade_log;const parsed=evaluationEvidence.safeParse(evidence);let hashMatches=false;
  if(parsed.success)hashMatches=await evidenceHash({manifest:parsed.data.manifest,trades:parsed.data.trades,equity:parsed.data.equity})===parsed.data.evidenceHash;
  const report=evaluateHistoricalEvidence(evidence,hashMatches);
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  const saved=await db.from("strategy_evaluations").insert({user_id:context.userId,strategy_id:bt.data.strategy_id,backtest_id:data.id,mode:"backtest",status:report.status,model_version:report.modelVersion,evidence_hash:parsed.success?parsed.data.evidenceHash:null,report});
  if(saved.error)throw new Error("Evaluation could not be saved");return {status:report.status};
});