import { z } from "zod";

export const scoringPolicy = z.object({
  version: z.string().trim().min(3).max(60),
  minimumTrades: z.number().int().min(30).max(10000),
  minimumDays: z.number().int().min(30).max(3650),
  expectancyTargetPct: z.number().positive().max(100),
  maximumDrawdownPct: z.number().positive().max(100),
  weights: z.object({ performance:z.number().min(0),risk:z.number().min(0),robustness:z.number().min(0),execution:z.number().min(0),prediction:z.number().min(0),regime:z.number().min(0),integrity:z.number().min(0) }).refine(w=>Object.values(w).reduce((a,b)=>a+b,0)===100,"Weights must total 100"),
});
export type ScoringPolicy = z.infer<typeof scoringPolicy>;
const clamp=(v:number)=>Math.max(0,Math.min(100,v));

/** Experimental historical utilities, not live qualification. Normal interval assumes independent trades. */
export function historicalUtilities(net:number[],equity:{t:number;v:number}[],capital:number,days:number,policy:ScoringPolicy){
  const insufficient=net.length<policy.minimumTrades||days<policy.minimumDays||equity.length<2||!Number.isFinite(capital)||capital<=0||net.some(x=>!Number.isFinite(x));
  if(insufficient)return {performance:null,risk:null,expectancyInterval:null,drawdownPct:null};
  const mean=net.reduce((a,b)=>a+b,0)/net.length;
  const variance=net.reduce((a,b)=>a+(b-mean)**2,0)/(net.length-1);
  const margin=1.96*Math.sqrt(variance/net.length);
  let peak=capital,drawdown=0;
  for(const p of equity){if(!Number.isFinite(p.v)||p.v<0)return {performance:null,risk:null,expectancyInterval:null,drawdownPct:null};peak=Math.max(peak,p.v);drawdown=Math.max(drawdown,100*(peak-p.v)/peak);}
  const utility=(x:number)=>clamp(100*x/capital*100/policy.expectancyTargetPct);
  return {performance:utility(mean),risk:clamp(100*(1-drawdown/policy.maximumDrawdownPct)),expectancyInterval:[utility(mean-margin),utility(mean+margin)],drawdownPct:drawdown};
}

export function promotionChecklist(input:{quarantined:boolean;verifiedConnection:boolean;unresolvedOrders:number;halted:boolean;scored:boolean;holdout:boolean;paper:boolean;costs:boolean;independentReview:boolean}){
  const checks=[
    {key:"integrity",passed:!input.quarantined},
    {key:"connection",passed:input.verifiedConnection},
    {key:"unresolved_orders",passed:input.unresolvedOrders===0},
    {key:"account_risk",passed:!input.halted},
    {key:"complete_scoring",passed:input.scored},
    {key:"independent_holdout",passed:input.holdout},
    {key:"forward_paper",passed:input.paper},
    {key:"verified_costs",passed:input.costs},
    {key:"independent_risk_review",passed:input.independentReview},
  ];
  return {checks,status:checks.every(c=>c.passed)?"review_required" as const:"blocked" as const,authorizesTrading:false};
}

export function allocationGuard(budget:number,exposure:number,maxExposure:number|null,eligible:number){
  if(![budget,exposure].every(Number.isFinite)||budget<0||exposure<0||maxExposure===null||!Number.isFinite(maxExposure)||maxExposure<0||!Number.isInteger(eligible)||eligible<0)return {status:"unavailable",deployable:null,reserve:null};
  if(eligible===0)return {status:"insufficient_evidence",deployable:0,reserve:budget};
  const deployable=Math.max(0,Math.min(budget,maxExposure-exposure));
  return {status:"review_required",deployable,reserve:budget-deployable};
}

export const initialWeights={performance:20,risk:20,robustness:15,execution:15,prediction:10,regime:10,integrity:10} as const;