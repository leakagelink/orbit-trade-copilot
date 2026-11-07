import { z } from "zod";
import {historicalUtilities,observedDrawdown,initialWeights,type ScoringPolicy} from "./governance";
export const SCORING_WEIGHTS = initialWeights;
export const evaluationEvidence = z.object({
  trades:z.array(z.object({entryT:z.number(),exitT:z.number(),entry:z.number().positive(),exit:z.number().positive(),qty:z.number().positive(),pnl:z.number(),fees:z.number().nonnegative(),reason:z.string()})),
  manifest:z.object({simulatorVersion:z.literal("next-bar-v2"),feePct:z.number().min(0).max(5),slippagePct:z.number().min(0).max(5),candles:z.array(z.object({t:z.number(),o:z.number().positive(),h:z.number().positive(),l:z.number().positive(),c:z.number().positive(),v:z.number().nonnegative()}))}).passthrough(),
  evidenceHash:z.string().regex(/^[a-f0-9]{64}$/),
  equity:z.array(z.object({t:z.number(),v:z.number()})),
}).passthrough();

/** Independent observed facts only. No inferred predictive accuracy or unapproved utility anchors. */
export function evaluateHistoricalEvidence(input:unknown,hashMatches:boolean,policy?:ScoringPolicy,startingCapital?:number){
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
  limitations.push("No isolated holdout, paper/live fills, calibrated predictions or regime coverage supplied.");
  if(!policy)limitations.push("Administrator-authored utility policy is missing; historical utility scores are unavailable.");
  else limitations.push("Administrator authorship is not independent methodology validation; confidence precision and dependence assumptions remain unvalidated.");
  const net=e.trades.reduce((a,t)=>a+t.pnl-t.fees,0),fees=e.trades.reduce((a,t)=>a+t.fees,0);
  for(let i=0;i<e.equity.length;i++){const p=e.equity[i],prior=e.equity[i-1];if(!p)continue;if(!Number.isFinite(p.v)||p.v<0)violations.push("Invalid equity evidence");if(prior&&p.t<=prior.t)violations.push("Equity chronology is duplicated or reversed");}
  const first=e.manifest.candles[0],last=e.manifest.candles.at(-1),days=first&&last?(last.t-first.t)/86400000:0;
  const utilities=policy&&violations.length===0?historicalUtilities(e.trades.map(t=>t.pnl-t.fees),e.equity,startingCapital??NaN,days,policy):null;
  const evidenceState={scope:"historical_only",observedTrades:e.trades.length,observedDays:days,minimumTrades:policy?.minimumTrades??null,minimumDays:policy?.minimumDays??null,policy:policy??null};
  const componentState=(key:string)=>violations.length?"rejected_evidence":!["performance","risk"].includes(key)?"unavailable_evidence":!policy?"missing_policy":e.trades.length<policy.minimumTrades||days<policy.minimumDays?"below_sample_floor":utilities?.performance==null?"invalid_inputs":"historical_only";
  if(policy)limitations.push("Experimental historical utility only, not live qualification. Expectancy interval: 95% normal approximation assuming independent trade outcomes; serial dependence can invalidate it. Drawdown is observed, not a forecast or confidence interval.");
  return {status:violations.length?"REJECTED" as const:"INSUFFICIENT_DATA" as const,composite:null,weights:policy?.weights??SCORING_WEIGHTS,modelVersion:policy?.version??"initial-weights-v1",evidenceState,components:Object.keys(SCORING_WEIGHTS).map(key=>({key,evidenceState:componentState(key),score:key==="performance"?utilities?.performance??null:key==="risk"?utilities?.risk??null:null,confidenceInterval:key==="performance"?utilities?.expectancyInterval??null:null})),violations:[...new Set(violations)],limitations,metrics:{trades:e.trades.length,netProfit:net,totalFees:fees,grossProfit:net+fees,slippageTreatment:"Already embedded in simulated fill prices; not deducted twice",expectancy:e.trades.length?net/e.trades.length:null,observedDrawdownPct:violations.length?null:observedDrawdown(e.equity,startingCapital??NaN)}};
}