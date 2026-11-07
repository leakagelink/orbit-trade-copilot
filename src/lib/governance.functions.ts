import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {requireSupabaseAuth} from "@/integrations/supabase/auth-middleware";
import {scoringPolicy,promotionChecklist} from "./governance";

export const listGovernance=createServerFn({method:"GET"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const [cases,events,policies,bots,reviews,risk,positions]=await Promise.all([
    context.supabase.from("strategy_integrity_cases").select("*,strategies(name)").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(100),
    context.supabase.from("strategy_integrity_events").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(200),
    context.supabase.from("strategy_scoring_policies").select("*").order("created_at",{ascending:false}).limit(1),
    context.supabase.from("trading_bots").select("id,name,strategy_id,mode").eq("user_id",context.userId).limit(100),
    context.supabase.from("strategy_promotion_reviews").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(30),
    context.supabase.from("risk_settings").select("max_open_exposure,trading_halted").eq("user_id",context.userId).maybeSingle(),
    context.supabase.from("positions").select("entry_price,quantity").eq("user_id",context.userId).eq("is_open",true),
  ]);
  if([cases,events,policies,bots,reviews,risk,positions].some(r=>r.error))throw new Error("Governance evidence unavailable");
  return {cases:cases.data??[],events:events.data??[],policies:policies.data??[],bots:bots.data??[],reviews:reviews.data??[],risk:risk.data,exposure:(positions.data??[]).reduce((a,p)=>a+Number(p.entry_price)*Number(p.quantity),0)};
});

export const appealIntegrity=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid(),message:z.string().trim().min(10).max(2000)}).parse(i)).handler(async({context,data})=>{
  const r=await context.supabase.rpc("appeal_strategy_integrity",{_case:data.id,_message:data.message});if(r.error)throw new Error(r.error.message);return {ok:true};
});
export const listIntegrityAdmin=createServerFn({method:"GET"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const role=await context.supabase.rpc("has_role",{_user_id:context.userId,_role:"admin"});if(role.error||role.data!==true)throw new Error("Administrator required");
  const [cases,events]=await Promise.all([context.supabase.from("strategy_integrity_cases").select("*,strategies(name)").order("created_at",{ascending:false}).limit(100),context.supabase.from("strategy_integrity_events").select("*").order("created_at",{ascending:false}).limit(200)]);
  if(cases.error||events.error)throw new Error("Integrity cases unavailable");return {cases:cases.data,events:events.data};
});
export const reviewIntegrity=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid(),decision:z.enum(["dismissed","upheld"]),message:z.string().trim().min(10).max(2000)}).parse(i)).handler(async({context,data})=>{
  const r=await context.supabase.rpc("review_strategy_integrity",{_case:data.id,_decision:data.decision,_message:data.message});if(r.error)throw new Error(r.error.message);return {ok:true};
});
export const saveScoringPolicy=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>scoringPolicy.parse(i)).handler(async({context,data})=>{
  const role=await context.supabase.rpc("has_role",{_user_id:context.userId,_role:"admin"});if(role.error||role.data!==true)throw new Error("Administrator required");
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  const r=await db.from("strategy_scoring_policies").insert({created_by:context.userId,version:data.version,config:data});if(r.error)throw new Error("Policy version could not be saved; use a new version name");return {ok:true};
});
export const checkPromotion=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).parse(i)).handler(async({context,data})=>{
  const {requirePro}=await import("./plan.server");await requirePro(context.supabase,context.userId);
  const bot=await context.supabase.from("trading_bots").select("id,strategy_id,exchange,exchange_connection_id").eq("id",data.id).eq("user_id",context.userId).maybeSingle();if(bot.error||!bot.data?.strategy_id)throw new Error("Owned strategy bot required");
  const b=bot.data;const strategyId=b.strategy_id;if(!strategyId)throw new Error("Strategy required");
  const [cases,orders,risk,connection]=await Promise.all([
    context.supabase.from("strategy_integrity_cases").select("id",{count:"exact",head:true}).eq("strategy_id",strategyId).eq("user_id",context.userId).in("status",["quarantined","appealed","upheld"]),
    context.supabase.from("orders").select("id",{count:"exact",head:true}).eq("user_id",context.userId).in("status",["pending","open","partially_filled"]),
    context.supabase.from("risk_settings").select("trading_halted").eq("user_id",context.userId).maybeSingle(),
    b.exchange_connection_id?context.supabase.from("exchange_connections").select("status,exchange,permissions").eq("id",b.exchange_connection_id).eq("user_id",context.userId).maybeSingle():Promise.resolve({data:null,error:null}),
  ]);
  if(cases.error||orders.error||risk.error||connection.error||cases.count===null||orders.count===null)throw new Error("Promotion checks unavailable");
  // Historical utilities and advisory paper reports are not independently certified promotion evidence.
  const checklist=promotionChecklist({quarantined:cases.count>0,unresolvedOrders:orders.count,halted:!risk.data||risk.data.trading_halted,verifiedConnection:connection.data?.status==="connected"&&connection.data.exchange===b.exchange,scored:false,holdout:false,paper:false,costs:false,independentReview:false});
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");const saved=await db.from("strategy_promotion_reviews").insert({user_id:context.userId,bot_id:b.id,strategy_id:strategyId,checklist,status:checklist.status});if(saved.error)throw new Error("Promotion review could not be saved");return checklist;
});