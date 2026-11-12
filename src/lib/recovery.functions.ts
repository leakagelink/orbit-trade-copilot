import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {z} from "zod";
import {orderRecoveryStatus} from "./order-recovery";
/** Read-only recovery inventory remains owner-accessible after plan downgrade. */
export const listRecovery = createServerFn({method:"GET"}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const [orders,positions,events,observations]=await Promise.all([
    context.supabase.from("orders").select("id,trading_pair,exchange,mode,status,created_at,reject_reason").eq("user_id",context.userId).in("status",["pending","open","partially_filled"]).order("created_at",{ascending:false}).limit(100),
    context.supabase.from("positions").select("id,trading_pair,mode,quantity,entry_price").eq("user_id",context.userId).eq("is_open",true).limit(100),
    context.supabase.from("trading_safety_events").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(50),
    context.supabase.from("order_recovery_observations").select("*").eq("user_id",context.userId).order("created_at",{ascending:false}).limit(100),
  ]);
  if(orders.error||positions.error||events.error||observations.error)throw new Error("Recovery inventory unavailable. Do not assume that positions are closed.");
  return {orders:orders.data,positions:positions.data,events:events.data,observations:observations.data};
});
export const verifyRecoveryOrder=createServerFn({method:"POST"}).middleware([requireSupabaseAuth]).inputValidator((i:unknown)=>z.object({id:z.string().uuid()}).parse(i)).handler(async({context,data})=>{
  const read=await context.supabase.from("orders").select("*").eq("id",data.id).eq("user_id",context.userId).eq("mode","live").in("status",["pending","open","partially_filled"]).maybeSingle();
  if(read.error||!read.data)throw new Error("Unresolved owned live order required");const o=read.data;
  if(!["binance","okx"].includes(o.exchange)||!o.exchange_connection_id)throw new Error("Read-only lookup currently supports Binance and OKX; inspect other venues directly");
  if(Date.now()-Date.parse(o.created_at)<60000)throw new Error("Wait one minute for provider settlement before verification");
  const conn=await context.supabase.from("exchange_connections").select("id,exchange,status,is_testnet").eq("id",o.exchange_connection_id).eq("user_id",context.userId).maybeSingle();
  if(conn.error||!conn.data||conn.data.exchange!==o.exchange||conn.data.status!=="connected")throw new Error("Original verified trading account required");
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  if(o.market_type === "usd_m_futures") {
    const {loadFuturesAccount}=await import("./futures.server");const {futuresOrder}=await import("./binance-futures.server");
    const a=await loadFuturesAccount(db,context.userId,o.exchange_connection_id);
    const exit=o.idempotency_key.includes(":exit:");const clientId=o.client_order_id??`${exit?"fx":"fv"}-${o.id.slice(0,28)}`;
    if(o.execution_environment!==(a.testnet?"testnet":"production"))throw new Error("Original Futures environment mismatch");
    let evidence: { status:string;qty:number;price:number;orderId:string } | null=null;
    try { const r=await futuresOrder(a,o.trading_pair.replace("/",""),clientId);evidence={status:r.status,qty:Number(r.executedQty),price:Number(r.avgPrice),orderId:String(r.orderId)}; } catch {}
    const status=evidence?.status==="FILLED"?"needs_review":"unavailable";
    const saved=await db.from("order_recovery_observations").insert({user_id:context.userId,order_id:o.id,status,evidence:evidence?{...evidence,marketType:"usd_m_futures",noOrdersSent:true}:null});if(saved.error)throw new Error("Recovery observation could not be saved");
    return {status,noOrdersSent:true,lockRetained:true};
  }
  const sealed=await db.from("connection_credentials").select("ciphertext,iv").eq("connection_id",conn.data.id).eq("user_id",context.userId).maybeSingle();if(sealed.error||!sealed.data)throw new Error("Original account credentials unavailable");
  const {openCredentials}=await import("./credential-environment.server");const {lookupArbitrageOrder}=await import("./exchange-adapters.server");
  const creds=await openCredentials(sealed.data,conn.data.is_testnet);
  let evidence:import("./arbitrage-recovery").OrderEvidence|null=null;
  try{evidence=await lookupArbitrageOrder(o.exchange,creds,conn.data.is_testnet,o.trading_pair,o.side==="buy"?"buy":"sell",o.id);}catch{/* Provider responses and credentials never persist. */}
  const status=orderRecoveryStatus(evidence);
  const saved=await db.from("order_recovery_observations").insert({user_id:context.userId,order_id:o.id,status,evidence:evidence?{...evidence,originalIntent:o.id,noOrdersSent:true}:null});if(saved.error)throw new Error("Recovery observation could not be saved");
  return {status,noOrdersSent:true,lockRetained:true};
});