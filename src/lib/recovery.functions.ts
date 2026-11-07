import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
/** Read-only recovery inventory remains owner-accessible after plan downgrade. */
export const listRecovery = createServerFn({method:"GET"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const [orders,positions,events]=await Promise.all([
    context.supabase.from("orders").select("id,trading_pair,exchange,mode,status,created_at,reject_reason").eq("user_id",context.userId).in("status",["pending","open","partially_filled"]).order("created_at",{ascending:false}).limit(100),
    context.supabase.from("positions").select("id,trading_pair,mode,quantity,entry_price").eq("user_id",context.userId).eq("is_open",true).limit(100),
    context.supabase.from("trading_safety_events").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(50),
  ]);
  if(orders.error||positions.error||events.error)throw new Error("Recovery inventory unavailable. Do not assume that positions are closed.");
  return {orders:orders.data,positions:positions.data,events:events.data};
});