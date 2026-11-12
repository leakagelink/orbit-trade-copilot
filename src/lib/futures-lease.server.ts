import type { Database, Json } from '@/integrations/supabase/types';
type Admin=Awaited<typeof import('@/integrations/supabase/client.server')>['supabaseAdmin'];
export async function acquireExecution(db:Admin,userId:string,connectionId:string,purpose:string) {
 const holder=crypto.randomUUID();
 const r=await db.rpc('futures_acquire_lease',{_connection:connectionId,_user:userId,_holder:holder,_purpose:purpose,_ttl_seconds:120});
 if(r.error||r.data==null)throw new Error('Futures account has another active writer; wait for recovery');
 const fence=r.data;
 async function assert(entry=false){
  const check=await db.rpc('futures_renew_lease',{_connection:connectionId,_holder:holder,_fence:fence,_ttl_seconds:120});
  if(check.error||check.data!==true)throw new Error('Execution fence lost; no further broker action permitted');
  if(entry){const risk=await db.from('risk_settings').select('trading_halted').eq('user_id',userId).maybeSingle();if(risk.error||!risk.data||risk.data.trading_halted)throw new Error('Trading halted or risk authority unavailable');}
 }
 async function position(id:string,patch:Database['public']['Tables']['positions']['Update']){
  await assert();
  const r=await db.rpc('futures_write_position',{_position:id,_holder:holder,_fence:fence,_patch:patch as Json});
  if(r.error||r.data!==true)throw new Error('Futures fenced position write failed');
 }
 async function release(){const r=await db.rpc('futures_release_lease',{_connection:connectionId,_holder:holder,_fence:fence});if(r.error)console.error('Futures lease release failed; expires automatically');}
 return {holder,fence,assert,position,release};
}
export type ExecutionLease=Awaited<ReturnType<typeof acquireExecution>>;