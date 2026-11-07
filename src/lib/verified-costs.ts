/** Gross realized PnL uses net position quantity; value base fees once to reconcile cash spent. */
export function spotFeeCosts(side:"buy"|"sell",base:string,quote:string,avgPrice:number,commissions:{amount:number;asset:string}[]){
  if(!Number.isFinite(avgPrice)||avgPrice<=0||commissions.some(c=>!Number.isFinite(c.amount)||c.amount<0))throw new Error("Invalid exchange fee evidence");
  let baseFee=0,quoteFee=0;
  for(const c of commissions){if(c.asset===base)baseFee+=c.amount;else if(c.asset===quote)quoteFee+=c.amount;else if(c.amount>0)throw new Error("Fee currency valuation unavailable; reconciliation required");}
  return {baseFee,quoteFee:quoteFee+baseFee*avgPrice};
}
export function reconciledRoundTripFees(entry:number|null,exit:number){
  if(entry===null||![entry,exit].every(Number.isFinite))throw new Error("Historical entry fee unknown; reconcile ledger, do not resubmit");
  return entry+exit;
}