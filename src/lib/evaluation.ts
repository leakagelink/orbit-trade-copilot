import { z } from "zod";
export const SCORING_WEIGHTS = {performance:20,risk:20,robustness:15,execution:15,prediction:10,regime:10,integrity:10} as const;
export const evaluationEvidence = z.object({
  trades:z.array(z.object({entryT:z.number(),exitT:z.number(),entry:z.number().positive(),exit:z.number().positive(),qty:z.number().positive(),pnl:z.number(),fees:z.number().nonnegative(),reason:z.string()})),
  manifest:z.object({simulatorVersion:z.literal("next-bar-v2"),feePct:z.number(),slippagePct:z.number(),candles:z.array(z.object({t:z.number(),o:z.number(),h:z.number(),l:z.number(),c:z.number(),v:z.number()}))}).passthrough(),
  evidenceHash:z.string().regex(/^[a-f0-9]{64}$/),
  equity:z.array(z.object({t:z.number(),v:z.number()})),
}).passthrough();

/** Independent observed facts only. No inferred predictive accuracy or unapproved utility anchors. */
export function evaluateHistoricalEvidence(input:unknown,hashMatches:boolean){
  const parsed=evaluationEvidence.safeParse(input);
  const violations:string[]=[],limitations:string[]=[];
  if(!parsed.success)return {status:"INSUFFICIENT_DATA" as const,composite:null,weights:SCORING_WEIGHTS,modelVersion:"initial-weights-v1",components:Object.keys(SCORING_WEIGHTS).map(key=>({key,score:null,confidenceInterval:null})),violations,limitations:["Complete next-bar simulation evidence is required."],metrics:null};
  const e=parsed.data;
  if(!hashMatches)violations.push("Evidence manifest hash does not match stored evidence");
  const seen=new Set<string>();
  for(const t of e.trades){
    const key=`${t.entryT}:${t.exitT}:${t.qty}:${t.entry}`;
    if(seen.has(key))violations.push("Duplicate trade evidence detected");seen.add(key);
    if(t.exitT<t.entryT)violations.push("Trade exit precedes its entry");
    if(Math.abs(t.pnl-(t.exit-t.entry)*t.qty)>Math.max(0.01,Math.abs(t.pnl)*1e-8))violations.push("Trade profit does not reconcile with prices and quantity");
  }
  if(e.manifest.feePct===0||e.manifest.slippagePct===0)limitations.push("Zero-cost simulation is not eligible promotion evidence");
  limitations.push("No isolated holdout, paper/live fills, calibrated predictions or regime coverage supplied.","Utility anchors, sample precision thresholds and confidence interval methodology need configuration before scoring.");
  const net=e.trades.reduce((a,t)=>a+t.pnl-t.fees,0);
  return {status:violations.length?"REJECTED" as const:"INSUFFICIENT_DATA" as const,composite:null,weights:SCORING_WEIGHTS,modelVersion:"initial-weights-v1",components:Object.keys(SCORING_WEIGHTS).map(key=>({key,score:null,confidenceInterval:null})),violations,limitations,metrics:{trades:e.trades.length,netProfit:net,expectancy:e.trades.length?net/e.trades.length:null}};
}