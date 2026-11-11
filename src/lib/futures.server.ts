import { futuresQuantity,futuresPrices,futuresLimitProblem,futuresRiskReserve,type FuturesTicket } from './futures';
import { futuresCall,futuresAccountState,futuresSymbol,futuresPositions,futuresOrder,futuresAlgo,futuresCancelAlgo,type FuturesAccount,type BrokerOrder,type BrokerPosition } from './binance-futures.server';
import type { Database, Json } from '@/integrations/supabase/types';
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
async function write(db:Admin,id:string,patch:Database["public"]["Tables"]["positions"]["Update"]){const r=await db.from('positions').update(patch).eq('id',id);if(r.error)throw new Error('Futures position state could not be saved');}
export async function openFutures(db:Admin,userId:string,t:FuturesTicket){
 const {requireElite}=await import('./plan.server');await requireElite(db,userId);
 const a=await loadFuturesAccount(db,userId,t.connectionId);
 if(t.confirmation!==(a.testnet?'TESTNET':'LIVE'))throw new Error('Confirm the selected Futures trading mode');
 const {data:s}=await db.from('futures_settings').select('*').eq('user_id',userId).maybeSingle();
 if(!s)throw new Error('Save explicit Futures risk limits first');
 const problem=futuresLimitProblem(t,s);if(problem)throw new Error(problem);
 if(!a.testnet&&(!s.live_enabled||s.connection_id!==a.connectionId||!s.testnet_certified_at))throw new Error('Live Futures requires separate opt-in and independently observed testnet verification');
 let state=await futuresAccountState(a);
 if(!state.canTrade)throw new Error('Futures trading permission is unavailable on this API key');
 if(state.hedge||state.multiAssets){
  const all=await futuresCall<BrokerPosition[]>(a,'GET','/fapi/v3/positionRisk');
  const open=await futuresCall<unknown[]>(a,'GET','/fapi/v1/openOrders');
  if(all.some(p=>Number(p.positionAmt)!==0)||open.length)throw new Error('Close all Futures positions and orders so AlgoVirt can switch to one-way, single-asset mode');
  if(state.hedge)await futuresCall(a,'POST','/fapi/v1/positionSide/dual',{dualSidePosition:'false'});
  if(state.multiAssets)await futuresCall(a,'POST','/fapi/v1/multiAssetsMargin',{multiAssetsMargin:'false'});
  state=await futuresAccountState(a);
  if(state.hedge||state.multiAssets)throw new Error('Binance did not confirm one-way, single-asset mode');
 }
 if(Number(state.availableBalance)<t.margin)throw new Error('Not enough available Futures margin');
 const m=await futuresSymbol(a,t.symbol);
 const existing=await futuresPositions(a,m.symbol);
 if(existing.some(p=>Number(p.positionAmt)!==0))throw new Error('Existing broker position on this symbol must be managed separately');
 const [orders,algos]=await Promise.all([futuresCall<unknown[]>(a,'GET','/fapi/v1/openOrders',{symbol:m.symbol}),futuresCall<unknown[]>(a,'GET','/fapi/v1/openAlgoOrders',{symbol:m.symbol})]);
 if(orders.length||algos.length)throw new Error('Existing broker orders on this symbol prevent a new managed scalp');
 const configs=await futuresCall<{symbol:string;marginType:string;leverage:number}[]>(a,'GET','/fapi/v1/symbolConfig',{symbol:m.symbol});
 const row=configs.find(p=>p.symbol===m.symbol);
 if(row?.marginType?.toLowerCase()!=='isolated'){
  try{await futuresCall(a,'POST','/fapi/v1/marginType',{symbol:m.symbol,marginType:'ISOLATED'});}catch(e){if(!String(e).includes('-4046'))throw e;}
 }
 if(Number(row?.leverage)!==t.leverage)await futuresCall(a,'POST','/fapi/v1/leverage',{symbol:m.symbol,leverage:t.leverage});
 const check=(await futuresCall<{symbol:string;marginType:string;leverage:number}[]>(a,'GET','/fapi/v1/symbolConfig',{symbol:m.symbol})).find(p=>p.symbol===m.symbol);
 if(check?.marginType?.toLowerCase()!=='isolated'||Number(check?.leverage)!==t.leverage)throw new Error('Binance did not confirm isolated margin and the selected leverage');
 const {data:risk}=await db.from('risk_settings').select('max_daily_loss,max_open_exposure').eq('user_id',userId).maybeSingle();
 if(!risk?.max_daily_loss||!risk.max_open_exposure)throw new Error('Save account maximum daily loss and exposure before Futures entries');
 const qty=futuresQuantity(t.margin,t.leverage,m.price,m.step,m.minQty,m.minNotional);
 const bracket=futuresPrices(t.side,m.price,t.slPct,t.tpPct,m.tick);
 if(futuresRiskReserve(qty*m.price,t.slPct)>risk.max_daily_loss)throw new Error('Scalp loss reserve exceeds account daily loss cap');
 const {accountRiskBlock}=await import('./engine.server');const block=await accountRiskBlock(db,userId,qty*m.price);if(block)throw new Error(block);
 const pending=await db.from('orders').select('id',{count:'exact',head:true}).eq('user_id',userId).in('status',['pending','open','partially_filled']);
 if(pending.error||pending.count)throw new Error('Pending orders need reconciliation first');
 const {data:ord,error}=await db.from('orders').insert({user_id:userId,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:t.symbol,side:t.side,order_type:'market',price:m.price,quantity:qty,status:'pending',mode:'live',market_type:'usd_m_futures',idempotency_key:`futures:${t.requestId}`}).select('id').single();
 if(error||!ord)throw new Error('Entry already claimed or risk limit blocked it');
 const id=t.requestId;const client=`fv-${ord.id.slice(0,28)}`;const slId=`fs-${id.slice(0,28)}`,tpId=`ft-${id.slice(0,28)}`;
 const details={entryClient:client,slClient:slId,tpClient:tpId,leverage:t.leverage,margin:t.margin,testnet:a.testnet,protection:'pending',recovery:null as string|null};
 const saved=await db.from('positions').insert({id,user_id:userId,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:t.symbol,side:t.side,quantity:qty,entry_price:m.price,current_price:m.price,mode:'live',market_type:'usd_m_futures',is_scalp:true,stop_loss:bracket.sl,take_profit:bracket.tp,max_hold_until:new Date(Date.now()+t.holdMin*60000).toISOString(),entry_order_id:ord.id,futures_details:details});
 if(saved.error)throw new Error('Entry intent retained; position record unavailable, do not retry');
 try{
  const fill=await futuresCall<BrokerOrder>(a,'POST','/fapi/v1/order',{symbol:m.symbol,side:t.side==='buy'?'BUY':'SELL',positionSide:'BOTH',type:'MARKET',quantity:qty,newClientOrderId:client,newOrderRespType:'RESULT'});
  if(fill.status!=='FILLED'||Number(fill.executedQty)!==qty||!(Number(fill.avgPrice)>0))throw new Error('Entry fill incomplete; lookup required');
  const update=await db.from('orders').update({status:'filled',filled_quantity:Number(fill.executedQty),avg_fill_price:Number(fill.avgPrice),exchange_order_id:String(fill.orderId)}).eq('id',ord.id);if(update.error)throw new Error('Fill ledger unavailable');
  await write(db,id,{entry_price:Number(fill.avgPrice),quantity:Number(fill.executedQty)});
  const stops=futuresPrices(t.side,Number(fill.avgPrice),t.slPct,t.tpPct,m.tick);
  for(const [type,triggerPrice,clientAlgoId] of [['STOP_MARKET',stops.sl,slId],['TAKE_PROFIT_MARKET',stops.tp,tpId]] as const){
   await futuresCall(a,'POST','/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:m.symbol,side:t.side==='buy'?'SELL':'BUY',positionSide:'BOTH',type,triggerPrice,closePosition:'true',workingType:'MARK_PRICE',clientAlgoId});
   const ack=await futuresAlgo(a,clientAlgoId);if(!ack.algoId)throw new Error('Broker protection not confirmed');
  }
  await write(db,id,{stop_loss:stops.sl,take_profit:stops.tp,futures_details:{...details,protection:'confirmed'}});
  return {positionId:id,price:Number(fill.avgPrice),qty,sl:stops.sl,tp:stops.tp};
 }catch(e){
  const message=e instanceof Error?e.message:'Futures execution interrupted';
  await write(db,id,{futures_details:{...details,protection:'unverified',recovery:message}});
  throw new Error(`Futures outcome needs recovery; entry/protection was not fully verified. Do not resubmit. ${message}`);
 }
}
type FPosition={id:string;user_id:string;exchange_connection_id:string|null;trading_pair:string;side:"buy"|"sell";quantity:number;entry_price:number;opened_at:string;max_hold_until:string|null;entry_order_id:string|null;futures_details:Json|null};
function detail(p:FPosition){return (p.futures_details&&typeof p.futures_details==='object'&&!Array.isArray(p.futures_details)?p.futures_details:{}) as Record<string,Json|undefined>;}
export async function closeFutures(db:Admin,p:FPosition,reason:string){
 if(!p.exchange_connection_id)throw new Error('Futures account reference missing');
 const a=await loadFuturesAccount(db,p.user_id,p.exchange_connection_id);const symbol=p.trading_pair.replace('/','');const d=detail(p);
 const broker=(await futuresPositions(a,symbol)).find(p=>p.positionSide==='BOTH');
 if(!broker)throw new Error('Broker position unavailable');
 const entryClient=d['entryClient'];if(typeof entryClient!=='string')throw new Error('Original entry intent unavailable');
 const original=await futuresOrder(a,symbol,entryClient);
 if(original.status!=='FILLED'||!(Number(original.executedQty)>0))throw new Error('Original entry is not fully filled; manual reconciliation required');
 if(p.entry_order_id){const r=await db.from('orders').update({status:'filled',filled_quantity:Number(original.executedQty),avg_fill_price:Number(original.avgPrice),exchange_order_id:String(original.orderId)}).eq('id',p.entry_order_id);if(r.error)throw new Error('Entry fill reconciliation unavailable');}
 if(Math.abs(Number(original.executedQty)-p.quantity)>1e-8)throw new Error('Partial entry requires independent inventory reconciliation');
 const qty=Math.abs(Number(broker.positionAmt));
 if(qty>0){
  if(qty>Number(p.quantity)*(1+1e-8)||(Number(broker.positionAmt)>0)!==(p.side==='buy'))throw new Error('Broker inventory changed externally; manual reconciliation required');
  const key=`futures:exit:${p.id}`;
  const {data:old}=await db.from('orders').select('id,status').eq('idempotency_key',key).maybeSingle();
  let id=old?.id;
  if(!id){const r=await db.from('orders').insert({user_id:p.user_id,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:p.trading_pair,side:p.side==='buy'?'sell':'buy',order_type:'market',quantity:qty,status:'pending',mode:'live',market_type:'usd_m_futures',idempotency_key:key}).select('id').single();if(r.error||!r.data)throw new Error('Exit already claimed');id=r.data.id;
   // Persisted intent first. An interrupted submit is never resent; subsequent checks use this client id only.
   await futuresCall(a,'POST','/fapi/v1/order',{symbol,side:p.side==='buy'?'SELL':'BUY',type:'MARKET',quantity:qty,reduceOnly:'true',newClientOrderId:`fx-${id.slice(0,28)}`,newOrderRespType:'RESULT'});
  }
  const fill=await futuresOrder(a,symbol,`fx-${id.slice(0,28)}`);
  if(fill.status!=='FILLED')throw new Error('Exit incomplete; original intent retained');
  await db.from('orders').update({status:'filled',filled_quantity:Number(fill.executedQty),avg_fill_price:Number(fill.avgPrice),exchange_order_id:String(fill.orderId)}).eq('id',id);
  if((await futuresPositions(a,symbol)).some(x=>Number(x.positionAmt)!==0))throw new Error('Broker still holds inventory; do not repeat the exit');
 }
 for(const k of ['slClient','tpClient'])if(typeof d[k]==='string'){try{await futuresCancelAlgo(a,d[k] as string);}catch{
  const open=await futuresCall<{clientAlgoId:string}[]>(a,'GET','/fapi/v1/openAlgoOrders',{symbol});if(open.some(o=>o.clientAlgoId===d[k]))throw new Error('Stale broker protection could not be cancelled');
 }}
 // Reconcile actual commissions, realized PnL and funding; never fabricate unknown costs.
 const fills=await futuresCall<{orderId:number;qty:string;price:string;commission:string;commissionAsset:string;realizedPnl:string;side:string}[]>(a,'GET','/fapi/v1/userTrades',{symbol,startTime:Date.parse(p.opened_at),limit:1000});
 const income=await futuresCall<{income:string;asset:string;incomeType:string}[]>(a,'GET','/fapi/v1/income',{symbol,incomeType:'FUNDING_FEE',startTime:Date.parse(p.opened_at),limit:1000});
 if(fills.length===1000||income.length===1000||fills.some(f=>f.commissionAsset!=='USDT')||income.some(i=>i.asset!=='USDT'))throw new Error('Futures cost evidence incomplete; broker flat, ledger reconciliation pending');
 const entry=await db.from('orders').select('exchange_order_id').eq('id',p.entry_order_id??'').maybeSingle();
 if(!entry.data?.exchange_order_id)throw new Error('Original entry fill not reconciled; check intent before ledger changes');
 const entryFills=fills.filter(f=>String(f.orderId)===entry.data?.exchange_order_id);
 const exits=fills.filter(f=>f.side===(p.side==='buy'?'SELL':'BUY'));
 if(Math.abs(entryFills.reduce((s,f)=>s+Number(f.qty),0)-p.quantity)>1e-8||Math.abs(exits.reduce((s,f)=>s+Number(f.qty),0)-p.quantity)>1e-8)throw new Error('Trade fills unavailable; broker flat, ledger reconciliation pending');
 const fees=fills.reduce((s,f)=>s+Number(f.commission),0),gross=fills.reduce((s,f)=>s+Number(f.realizedPnl),0),funding=income.reduce((s,i)=>s+Number(i.income),0);
 const exitQty=exits.reduce((s,f)=>s+Number(f.qty),0),exit=exits.reduce((s,f)=>s+Number(f.qty)*Number(f.price),0)/exitQty;
 const {data:prior}=await db.from('trades').select('id').eq('order_id',p.entry_order_id??'').maybeSingle();
 if(!prior){const t=await db.from('trades').insert({user_id:p.user_id,order_id:p.entry_order_id,exchange:'binance',exchange_connection_id:a.connectionId,trading_pair:p.trading_pair,side:p.side,quantity:p.quantity,entry_price:p.entry_price,exit_price:exit,realized_pnl:gross+funding,fees,funding_pnl:funding,costs_verified:true,mode:'live',market_type:'usd_m_futures',opened_at:p.opened_at,closed_at:new Date().toISOString(),close_reason:reason,is_scalp:true});if(t.error)throw new Error('Futures history write unavailable');}
 await write(db,p.id,{is_open:false,closed_at:new Date().toISOString(),current_price:exit,unrealized_pnl:0,futures_details:{...d,protection:'closed',recovery:null}});
 return {exit,pnl:gross+funding-fees};
}
export async function checkFutures(db:Admin,p:FPosition){
 if(!p.exchange_connection_id)throw new Error('Missing Futures connection');
 const a=await loadFuturesAccount(db,p.user_id,p.exchange_connection_id);const symbol=p.trading_pair.replace('/','');const d=detail(p);
 const broker=(await futuresPositions(a,symbol)).find(x=>x.positionSide==='BOTH');if(!broker)throw new Error('Broker inventory unavailable');
 if(Number(broker.positionAmt)===0){await closeFutures(db,p,'broker_closed');return 'broker_closed';}
 if(d['protection']!=='confirmed'){await closeFutures(db,p,'protection_failure');return 'protection_failure';}
 const open=await futuresCall<{clientAlgoId:string}[]>(a,'GET','/fapi/v1/openAlgoOrders',{symbol});
 if(!['slClient','tpClient'].every(k=>typeof d[k]==='string'&&open.some(o=>o.clientAlgoId===d[k]))){await closeFutures(db,p,'protection_missing');return 'protection_missing';}
 if(p.max_hold_until&&Date.now()>=Date.parse(p.max_hold_until)){await closeFutures(db,p,'time_stop');return 'time_stop';}
 await write(db,p.id,{current_price:Number(broker.markPrice),unrealized_pnl:Number(broker.unRealizedProfit)});return null;
}
