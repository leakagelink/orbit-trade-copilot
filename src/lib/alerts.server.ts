import { supabaseAdmin as db } from "@/integrations/supabase/client.server";
import { fetchCandles } from "./exchange-adapters.server";
import { marketOf } from "./markets";
import { alertHit } from "./toolkit";

export async function evaluateAlerts(userId?: string) {
  let query = db.from("price_alerts").select("*").eq("state","active").order("last_checked_at",{ascending:true,nullsFirst:true}).limit(100);
  if(userId) query=query.eq("user_id",userId);
  const r=await query; if(r.error) throw new Error("Alerts unavailable");
  const groups=new Map<string,typeof r.data>();
  for(const a of r.data){ const group=groups.get(a.symbol)??[]; group.push(a); groups.set(a.symbol,group); }
  let triggered=0,failed=0;
  for(const [symbol,alerts] of groups){
    try {
      const candles=await fetchCandles(marketOf(symbol)?.category==="crypto"?"binance":"yahoo",symbol,"1m",false,2);
      const last=candles.at(-1);
      if(!last || !Number.isFinite(last.c) || last.c<=0 || Date.now()/1000-last.t>180) throw new Error("No fresh quote; market may be closed");
      for(const a of alerts){
        if(alertHit(a.direction as "above"|"below",a.target,last.c)) {
          const result=await db.rpc("trigger_price_alert",{_id:a.id,_price:last.c});
          if(result.error) throw new Error("Alert delivery failed"); if(result.data) triggered++;
        } else await db.from("price_alerts").update({last_checked_at:new Date().toISOString(),last_price:last.c,last_error:null}).eq("id",a.id).eq("state","active");
      }
    } catch {
      failed+=alerts.length;
      await db.from("price_alerts").update({last_checked_at:new Date().toISOString(),last_error:"Fresh quote unavailable; alert remains active"}).in("id",alerts.map(a=>a.id)).eq("state","active");
    }
  }
  return { checked:r.data.length,triggered,failed };
}