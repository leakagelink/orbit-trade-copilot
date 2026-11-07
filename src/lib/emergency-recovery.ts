export interface EmergencyOperations {
  halt:()=>Promise<void>; stopBots:()=>Promise<void>; listOpen:()=>Promise<{id:string;pair:string}[]>;
  close:(id:string)=>Promise<void>; isOpen:(id:string)=>Promise<boolean>; unresolved:()=>Promise<number>;
}
/** Only verified read-back closure counts as success; uncertainty remains visible. */
export async function performEmergencyRecovery(ops:EmergencyOperations){
  await ops.halt(); // Never claim an emergency halt when persistence failed.
  const failed:string[]=[];let closed=0,botsStopped=true,remainingOrders:number|null=null;
  try{await ops.stopBots();}catch{botsStopped=false;failed.push("Bot stop could not be confirmed");}
  let positions:{id:string;pair:string}[]=[];
  try{positions=await ops.listOpen();}catch{failed.push("Open position inventory unavailable");}
  for(const p of positions){try{await ops.close(p.id);if(await ops.isOpen(p.id))failed.push(`${p.pair}: remains open (${p.id})`);else closed++;}catch{failed.push(`${p.pair}: closure unconfirmed (${p.id})`);}}
  try{remainingOrders=await ops.unresolved();if(remainingOrders>0)failed.push(`${remainingOrders} unresolved order intent(s) require review`);}catch{failed.push("Unresolved order inventory unavailable");}
  return {halted:true,botsStopped,closed,failed,remainingOrders,status:failed.length?"partial" as const:"completed" as const};
}