import { z } from "zod";
export const SCORING_WEIGHTS = {performance:20,risk:20,robustness:15,execution:15,prediction:10,regime:10,integrity:10} as const;
export const evaluationEvidence = z.object({
  trades:z.array(z.object({entryT:z.number(),exitT:z.number(),entry:z.number().positive(),exit:z.number().positive(),qty:z.number().positive(),pnl:z.number(),fees:z.number().nonnegative(),reason:z.string()})),
  manifest:z.object({simulatorVersion:z.literal("next-bar-v2"),feePct:z.number().min(0).max(5),slippagePct:z.number().min(0).max(5),candles:z.array(z.object({t:z.number(),o:z.number().positive(),h:z.number().positive(),l:z.number().positive(),c:z.number().positive(),v:z.number().nonnegative()}))}).passthrough(),
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
  for(let i=0;i<e.manifest.candles.length;i++){
    const c=e.manifest.candles[i];if(!c)continue;
    if(c.h<Math.max(c.o,c.c,c.l)||c.l>Math.min(c.o,c.c,c.h))violations.push("Impossible candle price range");
    const previous=e.manifest.candles[i-1];if(previous&&c.t<=previous.t)violations.push("Candle chronology is duplicated or reversed");
  }
  if(e.manifest.candles.length<2)limitations.push("At least two chronological source candles are required.");
  const seen=new Set<string>();
  for(const t of e.trades){
    const key=`${t.entryT}:${t.exitT}:${t.qty}:${t.entry}`;
    if(seen.has(key))violations.push("Duplicate trade evidence detected");seen.add(key);
    if(t.exitT<t.entryT)violations.push("Trade exit precedes its entry");
    if(Math.abs(t.pnl-(t.exit-t.entry)*t.qty)>Math.max(0.01,Math.abs(t.pnl)*1e-8))violations.push("Trade profit does not reconcile with prices and quantity");
    const expectedFees=(t.entry+t.exit)*t.qty*e.manifest.feePct/100;
    if(Math.abs(t.fees-expectedFees)>Math.max(0.01,expectedFees*1e-8))violations.push("Trade fees do not reconcile with the cost manifest");
    if(e.manifest.candles.length && (!e.manifest.candles.some(c=>c.t===t.entryT)||!e.manifest.candles.some(c=>c.t===t.exitT)))violations.push("Trade timestamps are outside source candle evidence");
  }
  if(e.manifest.feePct===0||e.manifest.slippagePct===0)limitations.push("Zero-cost simulation is not eligible promotion evidence");
  limitations.push("No isolated holdout, paper/live fills, calibrated predictions or regime coverage supplied.","Utility anchors, sample precision thresholds and confidence interval methodology need configuration before scoring.");
  const net=e.trades.reduce((a,t)=>a+t.pnl-t.fees,0),fees=e.trades.reduce((a,t)=>a+t.fees,0);
  return {status:violations.length?"REJECTED" as const:"INSUFFICIENT_DATA" as const,composite:null,weights:SCORING_WEIGHTS,modelVersion:"initial-weights-v1",components:Object.keys(SCORING_WEIGHTS).map(key=>({key,score:null,confidenceInterval:null})),violations,limitations,metrics:{trades:e.trades.length,netProfit:net,totalFees:fees,grossProfit:net+fees,slippageTreatment:"Already embedded in simulated fill prices; not deducted twice",expectancy:e.trades.length?net/e.trades.length:null}};
}