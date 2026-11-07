/** Operational safety defaults, mirrored by the atomic claim RPC; not token billing. */
export function researchRunLimit(elite:boolean){return elite?30:10;}
export function researchCapacity(used:number,limit:number){
  if(!Number.isInteger(used)||!Number.isInteger(limit)||used<0||limit<1)throw new Error("Invalid research allowance");
  return Math.max(0,limit-used);
}