import { futuresQuantity,futuresPrices,futuresLimitProblem,futuresRiskReserve,type FuturesTicket } from './futures';
import { futuresCall,futuresAccountState,futuresSymbol,futuresPositions,futuresOrder,futuresAlgo,futuresCancelAlgo,futuresCancelOrder,futuresEvidence,type FuturesAccount,type BrokerOrder,type BrokerPosition } from './binance-futures.server';
import {acquireExecution,type ExecutionLease} from './futures-lease.server';
import {activeOrder,terminalOrder,confirmedQuantity,validateOrder,settleOriginal,protectionProblem,attributeLedger,remainderQuantity} from './futures-execution';
import {sameEnvironment} from './trade-accounting';
import type {FaultPlan} from './futures-faults.server';
import type { Json } from '@/integrations/supabase/types';
type Admin=Awaited<typeof import('@/integrations/supabase/client.server')>['supabaseAdmin'];
export async function loadFuturesAccount(db:Admin,userId:string,id:string):Promise<FuturesAccount>{
 const {data:c,error}=await db.from('exchange_connections').select('id,user_id,exchange,status,is_testnet,account_type').eq('id',id).eq('user_id',userId).maybeSingle();
 if(error||!c||c.exchange!=='binance'||c.status!=='connected')throw new Error('Verified owner Binance account required');
 if(c.account_type!=='futures'&&c.account_type!=='both')throw new Error('Select Futures or Both on Exchanges first');
 const {data:k}=await db.from('connection_credentials').select('ciphertext,iv').eq('connection_id',id).eq('user_id',userId).maybeSingle();
 if(!k)throw new Error('Trading credentials unavailable');
 const {decryptJson}=await import('./crypto.server');
 return {connectionId:id,testnet:c.is_testnet,creds:await decryptJson(k.ciphertext,k.iv)};
}
export async function verifyFutures(db:Admin,userId:string,id:string){
 const a=await loadFuturesAccount(db,userId,id);const s=await futuresAccountState(a);
 const details={availableBalance:s.availableBalance,multiAssets:s.multiAssets,executionVerified:false};
 const saved=await db.from('futures_verifications').insert({user_id:userId,connection_id:id,read_access:true,can_trade:s.canTrade,hedge_mode:s.hedge,is_testnet:a.testnet,details});
 if(saved.error)throw new Error('Could not save Futures verification');
 return {readAccess:true,canTrade:s.canTrade,hedgeMode:s.hedge,multiAssets:s.multiAssets,testnet:a.testnet,availableBalance:s.availableBalance,executionVerified:false};
}

type FPosition={id:string;user_id:string;exchange_connection_id:string|null;trading_pair:string;side:"buy"|"sell";quantity:number;entry_price:number;opened_at:string;max_hold_until:string|null;entry_order_id:string|null;futures_details:Json|null;execution_environment?:string;stop_loss?:number|null;take_profit?:number|null};
function detail(p:FPosition){return (p.futures_details&&typeof p.futures_details==='object'&&!Array.isArray(p.futures_details)?p.futures_details:{}) as Record<string,Json|undefined>;}
async function reload(db:Admin,id:string):Promise<FPosition>{const r=await db.from('positions').select('*').eq('id',id).eq('market_type','usd_m_futures').single();if(r.error||!r.data)throw new Error('Futures position read-back unavailable');return r.data;}
async function event(db:Admin,p:FPosition,type:'entry_fill'|'exit_fill'|'funding'|'order_status'|'protection_status'|'containment',id:string,payload:Json){
 if(!p.exchange_connection_id)throw new Error('Account reference unavailable');
 const r=await db.from('futures_broker_events').insert({user_id:p.user_id,connection_id:p.exchange_connection_id,position_id:p.id,event_type:type,broker_event_id:id,payload});
 if(r.error&&r.error.code!=='23505')throw new Error('Broker evidence could not be saved');
 if(r.error){const old=await db.from('futures_broker_events').select('position_id,payload').eq('connection_id',p.exchange_connection_id).eq('event_type',type).eq('broker_event_id',id).single();if(old.error||!old.data||old.data.position_id!==p.id||JSON.stringify(old.data.payload)!==JSON.stringify(payload))throw new Error('Conflicting broker evidence; reconciliation required');}
}
async function saveOrder(db:Admin,lease:ExecutionLease,id:string,o:BrokerOrder){
 await lease.assert();
 const status=o.status==='FILLED'?'filled':activeOrder(o.status)?(confirmedQuantity(o)>0?'partially_filled':'open'):o.status==='REJECTED'?'rejected':'cancelled';
 const r=await db.from('orders').update({status,filled_quantity:confirmedQuantity(o),avg_fill_price:Number(o.avgPrice)||null,exchange_order_id:String(o.orderId)}).eq('id',id);
 if(r.error)throw new Error('Broker order ledger write failed');
}
async function regulars(a:FuturesAccount,symbol?:string){return futuresCall<BrokerOrder[]>(a,'GET','/fapi/v1/openOrders',symbol?{symbol}:{});}
async function algos(a:FuturesAccount,symbol?:string){return futuresCall<import('./binance-futures.server').AlgoOrder[]>(a,'GET','/fapi/v1/openAlgoOrders',symbol?{symbol}:{});}
async function confirmProtections(db:Admin,p:FPosition,a:FuturesAccount,tick:number){
 const d=detail(p),side=p.side==='buy'?'SELL':'BUY',symbol=p.trading_pair.replace('/','');
 for(const [key,type,trigger] of [['slClient','STOP_MARKET',p.stop_loss],['tpClient','TAKE_PROFIT_MARKET',p.take_profit]] as const){
  const client=d[key];if(typeof client!=='string'||trigger==null)throw new Error('Protection intent unavailable');
  let problem='Broker protection lookup unavailable';
  for(let i=0;i<3;i++){
   try{const o=await futuresAlgo(a,client);problem=protectionProblem(o,{client,symbol,side,type,trigger,qty:p.quantity,tick})??'';if(!problem){await event(db,p,'protection_status',`${client}:${o.algoStatus}`,o as unknown as Json);break;}}catch(e){problem=e instanceof Error?e.message:problem;}
   if(i<2)await new Promise(r=>setTimeout(r,200));
  }
  if(problem)throw new Error(problem);
 }
 const broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH');
 if(!broker||Math.abs(Math.abs(Number(broker.positionAmt))-p.quantity)>1e-8||(Number(broker.positionAmt)>0)!==(p.side==='buy'))throw new Error('Protected quantity differs from actual broker exposure');
}
async function cancelProtections(a:FuturesAccount,p:FPosition,lease:ExecutionLease){
 const d=detail(p),symbol=p.trading_pair.replace('/','');
 for(const key of ['slClient','tpClient']){const client=d[key];if(typeof client!=='string')continue;await lease.assert();try{await futuresCancelAlgo(a,client);}catch{/* confirm actual removal below */}}
 const open=await algos(a,symbol);if(open.some(o=>o.clientAlgoId===d['slClient']||o.clientAlgoId===d['tpClient']))throw new Error('Protection cancellation unconfirmed; account remains locked');
}
async function settle(a:FuturesAccount,symbol:string,client:string,side:string,lease:ExecutionLease):Promise<BrokerOrder>{
 return settleOriginal<BrokerOrder>({lookup:()=>futuresOrder(a,symbol,client),cancel:async()=>{await lease.assert();return futuresCancelOrder(a,symbol,client);}},o=>validateOrder(o,symbol,client,side));
}
const missing=(e:unknown)=>String(e).includes('(-2013)');
const emergencyClient=(id:string)=>`fe-${id.slice(0,28)}`;
/** Database-independent last resort: one deterministic reduce-only close of exposure confirmed on the symbol. */
async function emergencyContain(a:FuturesAccount,p:FPosition,cap:number){
 const symbol=p.trading_pair.replace('/',''),broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH'),amt=Number(broker?.positionAmt??NaN);
 if(!Number.isFinite(amt)||amt===0||(amt>0)!==(p.side==='buy'))return false;
 await futuresCall(a,'POST','/fapi/v1/order',{symbol,side:p.side==='buy'?'SELL':'BUY',positionSide:'BOTH',type:'MARKET',quantity:Math.min(Math.abs(amt),cap),reduceOnly:'true',newClientOrderId:emergencyClient(p.id),newOrderRespType:'RESULT'});
 return true;
}
async function finalize(db:Admin,p:FPosition,lease:ExecutionLease,trade:Json|null){
 await lease.assert();const r=await db.rpc('futures_finalize_position',{_position:p.id,_holder:lease.holder,_fence:lease.fence,_trade:trade as Json});if(r.error)throw new Error('Atomic Futures trade ledger failed; broker outcome retained for recovery');return r.data;
}
/** Entry preflight claims central risk and an account writer BEFORE any configuration mutation. */
/** Production entries re-check the current PASS certification (never the legacy timestamp) before any account mutation and again immediately before submission. */
async function authorizeEntry(db:Admin,userId:string,a:FuturesAccount,beforeSubmit?:()=>Promise<void>){
 if(!a.testnet){const {assertProductionFutures}=await import('./futures-authorization.server');await assertProductionFutures(db,userId,a.connectionId);}
 await beforeSubmit?.();
}
/** Named points where the Testnet harness may force-kill the process to prove crash recovery. */
export type FuturesCheckpoint='after_claim'|'after_submit_started'|'after_entry_submit'|'after_protection_submit';
export async function openFutures(db:Admin,userId:string,t:FuturesTicket,opts:{beforeSubmit?:(()=>Promise<void>)|undefined;faults?:FaultPlan;checkpoint?:(name:FuturesCheckpoint)=>Promise<void>|void}={}){
 const {requireElite}=await import('./plan.server');await requireElite(db,userId);
 const a=await loadFuturesAccount(db,userId,t.connectionId),env=a.testnet?'testnet':'production';
 if((opts.faults||opts.checkpoint)&&!a.testnet)throw new Error('Fault injection and crash checkpoints are Testnet-only');
 if(opts.faults)a.faults=opts.faults;
 if(t.confirmation!==(a.testnet?'TESTNET':'LIVE'))throw new Error('Confirm the selected Futures trading mode');
 const limits=await db.from('futures_settings').select('*').eq('user_id',userId).maybeSingle();const s=limits.data;
 if(limits.error||!s)throw new Error('Save explicit Futures risk limits first');
 const problem=futuresLimitProblem(t,s);if(problem)throw new Error(problem);
 await authorizeEntry(db,userId,a,opts.beforeSubmit);
 const m=await futuresSymbol(a,t.symbol),qty=futuresQuantity(t.margin,t.leverage,m.price,m.step,m.minQty,m.minNotional),bracket=futuresPrices(t.side,m.price,t.slPct,t.tpPct,m.tick);
 const {accountRiskBlock}=await import('./engine.server');const block=await accountRiskBlock(db,userId,qty*m.price,env);if(block)throw new Error(block);
 const risk=await db.from('risk_settings').select('max_daily_loss,max_open_exposure').eq('user_id',userId).maybeSingle();if(risk.error||!risk.data?.max_daily_loss||!risk.data.max_open_exposure)throw new Error('Save account risk limits first');
 if(futuresRiskReserve(qty*m.price,t.slPct)>risk.data.max_daily_loss)throw new Error('Scalp reserve exceeds daily loss cap');
 const lease=await acquireExecution(db,userId,a.connectionId,'entry');let claimed:string|null=null;let positionId:string|null=null;let submitted=false;
 try{
  const again=await accountRiskBlock(db,userId,qty*m.price,env);if(again)throw new Error(again);
  const pending=await db.from('orders').select('id',{count:'exact',head:true}).eq('user_id',userId).in('status',['pending','open','partially_filled']);if(pending.error||pending.count)throw new Error('Pending orders require reconciliation');
  const state=await futuresAccountState(a);if(!state.canTrade)throw new Error('Futures trading permission unavailable');
  if(Number(state.availableBalance)<t.margin)throw new Error('Not enough available Futures margin');
  const all=await futuresCall<BrokerPosition[]>(a,'GET','/fapi/v3/positionRisk');const [open,conditional]=await Promise.all([regulars(a),algos(a)]);
  if((state.hedge||state.multiAssets)&&(all.some(x=>Number(x.positionAmt)!==0)||open.length||conditional.length))throw new Error('Account mode changes require all positions and regular/algo orders to be empty');
  if(all.some(x=>x.symbol===m.symbol&&Number(x.positionAmt)!==0)||open.some(x=>x.symbol===m.symbol)||conditional.some(x=>x.symbol===m.symbol))throw new Error('Existing symbol exposure or orders require separate reconciliation');
  const id=crypto.randomUUID(),client=`fv-${id.slice(0,28)}`;
  const ord=await db.from('orders').insert({id,user_id:userId,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:t.symbol,side:t.side,order_type:'market',price:m.price,quantity:qty,status:'pending',mode:'live',market_type:'usd_m_futures',execution_environment:env,client_order_id:client,idempotency_key:`futures:${t.requestId}`});if(ord.error)throw new Error('Entry duplicate or central risk gate rejected it');claimed=id;
  const details={entryClient:client,slClient:`fs-${t.requestId.slice(0,28)}`,tpClient:`ft-${t.requestId.slice(0,28)}`,leverage:t.leverage,margin:t.margin,testnet:a.testnet,protection:'pending',state:'claimed',recovery:null};
  const created=await db.from('positions').insert({id:t.requestId,user_id:userId,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:t.symbol,side:t.side,quantity:qty,entry_price:m.price,current_price:m.price,mode:'live',market_type:'usd_m_futures',execution_environment:env,is_scalp:true,stop_loss:bracket.sl,take_profit:bracket.tp,max_hold_until:new Date(Date.now()+t.holdMin*60000).toISOString(),entry_order_id:id,futures_details:details});if(created.error)throw new Error('Position intent persistence failed');positionId=t.requestId;
  await opts.checkpoint?.('after_claim');
  await authorizeEntry(db,userId,a,opts.beforeSubmit);
  // Re-read actual account state after the atomic risk claim and before settings mutations.
  const positions=await futuresCall<BrokerPosition[]>(a,'GET','/fapi/v3/positionRisk');const [regular,algo]=await Promise.all([regulars(a),algos(a)]);
  if((state.hedge||state.multiAssets)&&(positions.some(x=>Number(x.positionAmt)!==0)||regular.length||algo.length))throw new Error('Account changed during preflight');
  if(positions.some(x=>x.symbol===m.symbol&&Number(x.positionAmt)!==0)||regular.some(x=>x.symbol===m.symbol)||algo.some(x=>x.symbol===m.symbol))throw new Error('Symbol changed during preflight');
  if(state.hedge){await lease.assert(true);await futuresCall(a,'POST','/fapi/v1/positionSide/dual',{dualSidePosition:'false'});}
  if(state.multiAssets){await lease.assert(true);await futuresCall(a,'POST','/fapi/v1/multiAssetsMargin',{multiAssetsMargin:'false'});}
  const mode=await futuresAccountState(a);if(mode.hedge||mode.multiAssets||!mode.canTrade)throw new Error('One-way single-asset trading not confirmed');
  const config=(await futuresCall<{symbol:string;marginType:string;leverage:number}[]>(a,'GET','/fapi/v1/symbolConfig',{symbol:m.symbol})).find(x=>x.symbol===m.symbol);
  if(config?.marginType?.toLowerCase()!=='isolated'){await lease.assert(true);try{await futuresCall(a,'POST','/fapi/v1/marginType',{symbol:m.symbol,marginType:'ISOLATED'});}catch(e){if(!String(e).includes('-4046'))throw e;}}
  if(Number(config?.leverage)!==t.leverage){await lease.assert(true);await futuresCall(a,'POST','/fapi/v1/leverage',{symbol:m.symbol,leverage:t.leverage});}
  const check=(await futuresCall<{symbol:string;marginType:string;leverage:number}[]>(a,'GET','/fapi/v1/symbolConfig',{symbol:m.symbol})).find(x=>x.symbol===m.symbol);
  if(check?.marginType?.toLowerCase()!=='isolated'||Number(check.leverage)!==t.leverage)throw new Error('Isolated leverage not confirmed');
  await authorizeEntry(db,userId,a,opts.beforeSubmit);
  await lease.position(t.requestId,{futures_details:{...details,state:'submit_started'}});
  await opts.checkpoint?.('after_submit_started');
  await lease.assert(true);submitted=true;
  // An acknowledgement/timeout is not proof either way: settle only by looking up this original client ID.
  try{await futuresCall<BrokerOrder>(a,'POST','/fapi/v1/order',{symbol:m.symbol,side:t.side==='buy'?'BUY':'SELL',positionSide:'BOTH',type:'MARKET',quantity:qty,newClientOrderId:client,newOrderRespType:'RESULT'});}catch(e){console.error('Futures entry submit outcome uncertain; lookup only',String(e).slice(0,200));}
  await opts.checkpoint?.('after_entry_submit');
  const fill=await settle(a,m.symbol,client,t.side==='buy'?'BUY':'SELL',lease);await saveOrder(db,lease,id,fill);
  const filled=confirmedQuantity(fill);if(filled!==qty||fill.status!=='FILLED'||!(Number(fill.avgPrice)>0))throw new Error('Partial entry: immediate containment required');
  const stops=futuresPrices(t.side,Number(fill.avgPrice),t.slPct,t.tpPct,m.tick);
  await lease.position(t.requestId,{entry_price:Number(fill.avgPrice),quantity:filled,stop_loss:stops.sl,take_profit:stops.tp,futures_details:{...details,state:'protecting'}});
  for(const [type,triggerPrice,clientAlgoId] of [['STOP_MARKET',stops.sl,details.slClient],['TAKE_PROFIT_MARKET',stops.tp,details.tpClient]] as const){await lease.assert();try{await futuresCall(a,'POST','/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:m.symbol,side:t.side==='buy'?'SELL':'BUY',positionSide:'BOTH',type,triggerPrice,closePosition:'true',workingType:'MARK_PRICE',clientAlgoId});}catch(e){console.error('Futures protection acknowledgement unavailable; verifying actual broker order',String(e).slice(0,200));}}
  await opts.checkpoint?.('after_protection_submit');
  const p=await reload(db,t.requestId);await confirmProtections(db,p,a,m.tick);
  await lease.position(p.id,{futures_details:{...details,state:'protected',protection:'confirmed'}});
  return {positionId:p.id,price:Number(fill.avgPrice),qty:filled,sl:stops.sl,tp:stops.tp};
 }catch(e){
  const message=e instanceof Error?e.message:'Futures execution interrupted';
  if(positionId){
   if(submitted){
    // Containment must not depend on a successful diagnostic database write.
    try{await closeLocked(db,await reload(db,positionId),a,'entry_containment',lease);}catch(recovery){
     try{const p=await reload(db,positionId).catch(()=>({id:positionId,side:t.side,trading_pair:t.symbol} as FPosition));if(await emergencyContain(a,p,qty))console.error('Futures emergency reduce-only containment submitted; ledger recovery remains locked');}catch{console.error('Futures emergency containment unconfirmed; entries remain blocked');}
     try{const p=await reload(db,positionId);await lease.position(positionId,{futures_details:{...detail(p),protection:'unverified',state:'recovery',recovery:`${message}; ${String(recovery)}`.slice(0,800)}});}catch{console.error('Futures recovery state write failed; original intent remains locked');}
    }
   }else{
    await lease.assert();const cancelled=await db.from('orders').update({status:'cancelled',reject_reason:message.slice(0,500)}).eq('id',claimed??'');if(cancelled.error)throw new Error('Pre-submit cancellation ledger unavailable; no order sent');
    await finalize(db,await reload(db,positionId),lease,null);
   }
  }else if(claimed&&!submitted){const r=await db.from('orders').update({status:'cancelled',reject_reason:'Position persistence failed before submit'}).eq('id',claimed);if(r.error)throw new Error('Unsubmitted entry intent retained; manual recovery required');}
  throw new Error(`Futures entry did not complete. Original intent retained; do not resubmit. ${message}`);
 }finally{await lease.release();}
}
/** Fenced close/recovery, also used immediately on an entry/protection failure. */
async function closeLocked(db:Admin,p:FPosition,a:FuturesAccount,reason:string,lease:ExecutionLease){
 if(!sameEnvironment(p.execution_environment,a.testnet))throw new Error('Immutable Futures environment does not match original account');
 const symbol=p.trading_pair.replace('/',''),d=detail(p),client=d['entryClient'];
 if(typeof client!=='string'||!p.entry_order_id)throw new Error('Original entry intent unavailable');
 let original:BrokerOrder;
 try{original=await settle(a,symbol,client,p.side==='buy'?'BUY':'SELL',lease);}catch(e){
  // Only a durable pre-submit/submit-started intent older than the settlement window may prove "never accepted".
  if(!missing(e)||!['claimed','submit_started'].includes(String(d['state']))||Date.now()-Date.parse(p.opened_at)<120000)throw e;
  original={orderId:0,clientOrderId:client,symbol,side:p.side==='buy'?'BUY':'SELL',positionSide:'BOTH',status:'EXPIRED',executedQty:'0',avgPrice:'0'};
 }
 const entryQty=confirmedQuantity(original);
 // Read exact original exit/protective identities, never every opposite-side fill.
 const exits=await db.from('orders').select('*').eq('exchange_connection_id',a.connectionId).like('idempotency_key',`futures:exit:${p.id}%`).order('created_at');if(exits.error)throw new Error('Exit intents unavailable');
 const known:BrokerOrder[]=[],exitIds:string[]=[];
 for(const o of exits.data??[]){if(!o.client_order_id)throw new Error('Durable exit client ID missing');const fill=await settle(a,symbol,o.client_order_id,p.side==='buy'?'SELL':'BUY',lease);known.push(fill);exitIds.push(String(fill.orderId));await saveOrder(db,lease,o.id,fill);}
 for(const key of ['slClient','tpClient']){const c=d[key];if(typeof c!=='string')continue;try{const algo=await futuresAlgo(a,c);if(algo.symbol!==symbol||algo.positionSide!=='BOTH')throw new Error('Protection identity mismatch');if(algo.actualOrderId){const o=await futuresCall<BrokerOrder>(a,'GET','/fapi/v1/order',{symbol,orderId:algo.actualOrderId});validateOrder(o,symbol,o.clientOrderId,p.side==='buy'?'SELL':'BUY');if(!terminalOrder(o.status))throw new Error('Triggered protection not settled');known.push(o);exitIds.push(String(o.orderId));}}catch(e){if(!String(e).includes('-2013')&&!String(e).includes('-2011'))throw e;}}
 try{const o=await futuresOrder(a,symbol,emergencyClient(p.id));validateOrder(o,symbol,emergencyClient(p.id),p.side==='buy'?'SELL':'BUY');if(!terminalOrder(o.status))throw new Error('Emergency containment not settled');known.push(o);exitIds.push(String(o.orderId));}catch(e){if(!missing(e))throw e;}
 let broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH');if(!broker)throw new Error('Broker position unavailable');
 const remaining=remainderQuantity(entryQty,Number(broker.positionAmt),p.side,known);
 if(remaining>1e-8){
  const id=crypto.randomUUID(),exitClient=`fx-${id.slice(0,28)}`,sequence=(exits.data??[]).length,key=`futures:exit:${p.id}${sequence?`:remainder:${sequence}`:''}`;
  await lease.assert();
  const r=await db.from('orders').insert({id,user_id:p.user_id,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:p.trading_pair,side:p.side==='buy'?'sell':'buy',order_type:'market',quantity:remaining,status:'pending',mode:'live',market_type:'usd_m_futures',execution_environment:a.testnet?'testnet':'production',client_order_id:exitClient,idempotency_key:key});if(r.error)throw new Error('Exit claim failed; no second order sent');
  await lease.assert();
  // Once claimed, even a timeout is lookup-only on later invocations.
  try{await futuresCall(a,'POST','/fapi/v1/order',{symbol,side:p.side==='buy'?'SELL':'BUY',positionSide:'BOTH',type:'MARKET',quantity:remaining,reduceOnly:'true',newClientOrderId:exitClient,newOrderRespType:'RESULT'});}catch(e){console.error('Futures exit submit outcome uncertain; lookup only',String(e).slice(0,200));}
  const fill=await settle(a,symbol,exitClient,p.side==='buy'?'SELL':'BUY',lease);known.push(fill);exitIds.push(String(fill.orderId));await saveOrder(db,lease,id,fill);
  broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH');if(!broker)throw new Error('Broker close read-back unavailable');
  if(Math.abs(Number(broker.positionAmt))>1e-8)throw new Error('Partial exit terminal; remainder requires the next fenced recovery step');
 }
 // Containment succeeded before any cost/ledger writes, even if those writes fail.
 if((await futuresPositions(a,symbol)).some(x=>Number(x.positionAmt)!==0))throw new Error('Broker exposure remains unresolved');
 await cancelProtections(a,p,lease);
 if(original.orderId)await saveOrder(db,lease,p.entry_order_id,original);
 else{await lease.assert();const r=await db.from('orders').update({status:'cancelled',reject_reason:'Broker has no record after settlement window; never resubmitted'}).eq('id',p.entry_order_id);if(r.error)throw new Error('Entry intent reconciliation unavailable');}
 if(entryQty===0){await finalize(db,p,lease,null);return {exit:p.entry_price,pnl:0};}
 const start=Number(original.time??Date.parse(p.opened_at)),end=known.reduce((s,o)=>Math.max(s,Number(o.updateTime??0)),0);
 if(!Number.isFinite(start)||end<start)throw new Error('Exact holding interval unavailable');
 const evidence=await futuresEvidence(a,symbol,start,end);
 const ledger=attributeLedger({fills:evidence.fills,funding:evidence.income,entryOrderId:String(original.orderId),exitOrderIds:exitIds,symbol,side:p.side,openedAt:start,closedAt:end});
 if(Math.abs(ledger.qty-entryQty)>1e-8)throw new Error('Entry fill ledger differs from broker order');
 for(const f of ledger.entryFills)await event(db,p,'entry_fill',`${symbol}:${f.id}`,f as unknown as Json);
 for(const f of ledger.exitFills)await event(db,p,'exit_fill',`${symbol}:${f.id}`,f as unknown as Json);
 for(const f of ledger.fundingEvents)await event(db,p,'funding',String(f.tranId),f as unknown as Json);
 await finalize(db,p,lease,{quantity:ledger.qty,entry_price:ledger.entry,exit_price:ledger.exit,gross:ledger.gross,fees:ledger.fees,funding:ledger.funding,reason});
 return {exit:ledger.exit,pnl:ledger.net};
}
export async function closeFutures(db:Admin,input:FPosition,reason:string){
 if(!input.exchange_connection_id)throw new Error('Futures account reference missing');
 const a=await loadFuturesAccount(db,input.user_id,input.exchange_connection_id);let lease:ExecutionLease|null=null;
 // Kill switch waits briefly for the current single writer; it never bypasses its fence.
 for(let i=0;i<(reason==='emergency_stop'?8:1)&&!lease;i++){try{lease=await acquireExecution(db,input.user_id,a.connectionId,'close');}catch(e){if(i===(reason==='emergency_stop'?7:0))throw e;await new Promise(r=>setTimeout(r,1000));}}
 if(!lease)throw new Error('Futures account writer unavailable');
 try{return await closeLocked(db,await reload(db,input.id),a,reason,lease);}finally{await lease.release();}
}
export async function checkFutures(db:Admin,input:FPosition){
 if(!input.exchange_connection_id)throw new Error('Missing Futures connection');
 const a=await loadFuturesAccount(db,input.user_id,input.exchange_connection_id),lease=await acquireExecution(db,input.user_id,a.connectionId,'check');
 try{
  const p=await reload(db,input.id);if(!sameEnvironment(p.execution_environment,a.testnet))throw new Error('Historical execution environment mismatch');
  const symbol=p.trading_pair.replace('/',''),d=detail(p),broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH');if(!broker)throw new Error('Broker inventory unavailable');
  const risk=await db.from('risk_settings').select('trading_halted').eq('user_id',p.user_id).maybeSingle();if(risk.error||!risk.data)throw new Error('Risk authority unavailable');
  let reason:string|null=null;
  if(Number(broker.positionAmt)===0)reason='broker_closed';
  else if(risk.data.trading_halted)reason='emergency_stop';
  else if(d['protection']!=='confirmed')reason='protection_failure';
  else if(p.max_hold_until&&Date.now()>=Date.parse(p.max_hold_until))reason='time_stop';
  else{try{const m=await futuresSymbol(a,p.trading_pair);await confirmProtections(db,p,a,m.tick);}catch{reason='protection_missing';}}
  if(reason){await closeLocked(db,p,a,reason,lease);return reason;}
  await lease.position(p.id,{current_price:Number(broker.markPrice),unrealized_pnl:Number(broker.unRealizedProfit)});return null;
 }finally{await lease.release();}
}
