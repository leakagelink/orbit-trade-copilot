import type {OrderEvidence} from "./arbitrage-recovery";
/** Verified provider evidence is an observation, never permission to retry. */
export function orderRecoveryStatus(e:OrderEvidence|null){
  if(!e)return "unavailable" as const;
  if(!e.orderId||![e.qty,e.avgPrice,e.quoteValue].every(Number.isFinite)||e.qty<0||e.quoteValue<0||e.feeQuote===null||!Number.isFinite(e.feeQuote))return "needs_review" as const;
  if(e.state==="cancelled"&&e.qty===0&&e.quoteValue===0)return "verified_zero_fill" as const;
  if(e.state==="filled"&&e.qty>0&&e.avgPrice>0&&e.quoteValue>0)return "verified_fill" as const;
  return "needs_review" as const;
}