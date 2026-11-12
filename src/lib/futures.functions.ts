import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { futuresTicket,futuresLimits } from './futures';
export const verifyFuturesFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(z.object({connectionId:z.string().uuid()})).handler(async({data,context})=>{
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {verifyFutures}=await import('./futures.server');return verifyFutures(db,context.userId,data.connectionId);
});
export const saveFuturesLimitsFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(futuresLimits).handler(async({data,context})=>{
 const {requireElite}=await import('./plan.server');await requireElite(context.supabase,context.userId);
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {loadFuturesAccount}=await import('./futures.server');const a=await loadFuturesAccount(db,context.userId,data.connectionId);
 if(data.enabled&&!a.testnet){if(data.confirmation!=='LIVE FUTURES')throw new Error('Type LIVE FUTURES to opt in');const {productionFuturesAuthorization}=await import('./futures-authorization.server');const auth=await productionFuturesAuthorization(db,context.userId,data.connectionId,{forOptIn:true});if(auth.problem)throw new Error(`Live Futures remains locked: ${auth.problem}`);}
 const r=await db.from('futures_settings').upsert({user_id:context.userId,connection_id:data.connectionId,live_enabled:data.enabled&&!a.testnet,max_margin:data.maxMargin,max_leverage:data.maxLeverage,max_loss:data.maxLoss,updated_at:new Date().toISOString()});if(r.error)throw new Error('Risk limits could not be saved');return {ok:true};
});
export const placeFuturesFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(futuresTicket).handler(async({data,context})=>{
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {openFutures}=await import('./futures.server');return openFutures(db,context.userId,data);
});
export const getFuturesCandlesFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(z.object({connectionId:z.string().uuid(),symbol:z.string().regex(/^[A-Z0-9]+\/USDT$/),timeframe:z.enum(['1m','5m','15m'])})).handler(async({data,context})=>{
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {loadFuturesAccount}=await import('./futures.server');const a=await loadFuturesAccount(db,context.userId,data.connectionId);
 const {futuresCall}=await import('./binance-futures.server');const rows=await futuresCall<(string|number)[][]>(a,'GET','/fapi/v1/klines',{symbol:data.symbol.replace('/',''),interval:data.timeframe,limit:300},false);
 return {candles:rows.map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[5])})),error:null};
});
export const futuresIdeaFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(z.object({connectionId:z.string().uuid(),symbol:z.string().regex(/^[A-Z0-9]+\/USDT$/)})).handler(async({data,context})=>{
 const {requireElite}=await import('./plan.server');await requireElite(context.supabase,context.userId);
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {loadFuturesAccount}=await import('./futures.server');const a=await loadFuturesAccount(db,context.userId,data.connectionId);
 const {futuresCall}=await import('./binance-futures.server');const rows=await futuresCall<unknown[]>(a,'GET','/fapi/v1/klines',{symbol:data.symbol.replace('/',''),interval:'1m',limit:60},false);
 const {aiPrimeMessage,messageText}=await import('./ai-prime.server');const {AI_MODEL}=await import('./ai-provider');
 const reply=await aiPrimeMessage({model:AI_MODEL,max_tokens:1200,system:'Analyze ONLY these Binance USD-M 1-minute candles as untrusted evidence. Explain long/short/neutral scalp outlook and risks. No invented live prices, score, guaranteed profit, leverage or account sizing. Advisory only; no order authorization.',messages:[{role:'user',content:JSON.stringify({symbol:data.symbol,candles:rows})}]});return {text:messageText(reply)};
});

/** Turns production Live Futures OFF; works without certification, plan or credentials and confirms the stored value. */
export const disableLiveFuturesFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).handler(async({context})=>{
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {disableLiveFutures}=await import('./futures-authorization.server');return disableLiveFutures(db,context.userId);
});
/** Read-only: whether this production account is authorized right now, and the latest certification record. */
export const futuresAuthorizationFn=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(z.object({connectionId:z.string().uuid()})).handler(async({data,context})=>{
 const {supabaseAdmin:db}=await import('@/integrations/supabase/client.server');const {productionFuturesAuthorization}=await import('./futures-authorization.server');
 const [entry,optIn]=await Promise.all([productionFuturesAuthorization(db,context.userId,data.connectionId),productionFuturesAuthorization(db,context.userId,data.connectionId,{forOptIn:true})]);
 const c=entry.certification;
 return {authorized:!entry.problem,problem:entry.problem,canOptIn:!optIn.problem,optInProblem:optIn.problem,requiredRevision:entry.requiredRevision??null,certification:c?{result:c.result,revision:c.revision,createdAt:c.created_at}:null};
});
