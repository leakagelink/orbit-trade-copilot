import { z } from "zod";
import { researchProposal } from "./research-proposal";
import type { Candle } from "./indicators";

export const paperResearchInput = z.object({
  proposalId: z.string().uuid(), confirm: z.literal("PAPER"),
  quantity: z.number().positive().max(1e6),
  feePct: z.number().min(0.01).max(5), slippagePct: z.number().min(0.01).max(5),
}).strict();

export function paperScenario(proposal: unknown) {
  const p = researchProposal.parse(proposal);
  if (p.status !== "scenario" || p.direction === "none" || p.hypotheticalEntry === null || p.stopLoss === null || p.takeProfit === null) throw new Error("An available directional research scenario is required");
  const stopDistance = Math.abs(p.hypotheticalEntry - p.stopLoss);
  const targetDistance = Math.abs(p.takeProfit - p.hypotheticalEntry);
  if (!(stopDistance > 0 && targetDistance > 0)) throw new Error("Valid scenario distances are required");
  return { direction: p.direction, stopDistance, targetDistance };
}

/** Forward-only daily paper observations. No accounts, wallets, credentials or orders. */
export function observePaperResearch(input: {
  proposal: unknown; confirmedAt: number; quantity: number; feePct: number; slippagePct: number;
}, candles: Candle[], now = Date.now()) {
  const scenario = paperScenario(input.proposal);
  if (![input.confirmedAt, input.quantity, input.feePct, input.slippagePct].every(Number.isFinite) || input.quantity <= 0 || input.feePct <= 0 || input.slippagePct <= 0) throw new Error("Valid paper parameters required");
  const bars = candles.filter(c => c.t > input.confirmedAt && c.t + 86400000 <= now).sort((a,b) => a.t-b.t);
  const first = bars[0];
  if (!first) return { status: "waiting" as const, entry: null, exit: null, grossPnl: null, fees: null, netPnl: null, reason: "Awaiting the next completed daily bar after confirmation", bars: 0 };
  for (let i=0;i<bars.length;i++) {
    const c=bars[i];
    if (!c || ![c.t,c.o,c.h,c.l,c.c].every(Number.isFinite) || Math.min(c.o,c.h,c.l,c.c)<=0 || c.h<Math.max(c.o,c.c,c.l) || c.l>Math.min(c.o,c.c,c.h) || (i>0 && c.t===(bars[i-1]?.t))) throw new Error("Invalid or duplicate daily paper evidence");
  }
  const sign=scenario.direction==="long"?1:-1, slip=input.slippagePct/100;
  const entry=first.o*(1+sign*slip), stop=entry-sign*scenario.stopDistance, target=entry+sign*scenario.targetDistance;
  if (Math.min(entry,stop,target)<=0) throw new Error("Scenario distances are incompatible with the forward price");
  let exit: number | null=null, reason="Marked at latest daily close", observed=0;
  for (const c of bars) {
    observed++;
    const stopHit=sign===1?c.l<=stop:c.h>=stop, targetHit=sign===1?c.h>=target:c.l<=target;
    if (stopHit) { exit=(sign===1?Math.min(c.o,stop):Math.max(c.o,stop))*(1-sign*slip); reason="stop_loss"; break; }
    if (targetHit) { exit=target*(1-sign*slip); reason="take_profit"; break; }
  }
  const mark=exit??(bars.at(-1)?.c??entry)*(1-sign*slip);
  const grossPnl=sign*(mark-entry)*input.quantity, fees=(entry+mark)*input.quantity*input.feePct/100;
  return { status:exit===null?"open" as const:"closed" as const, entry, exit, grossPnl, fees, netPnl:grossPnl-fees, reason, bars:observed };
}