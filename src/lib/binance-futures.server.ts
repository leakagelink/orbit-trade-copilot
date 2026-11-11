// Binance USD-M only; never fall back to Spot hosts or change account-wide position mode.
import type { Creds } from './exchange-adapters.server';
export type FuturesAccount={connectionId:string;testnet:boolean;creds:Creds};
export function futuresHost(testnet:boolean){return testnet?'https://testnet.binancefuture.com':'https://fapi.binance.com';}
export async function futuresCall<T>(a:Pick<FuturesAccount,'testnet'|'creds'>,method:'GET'|'POST'|'DELETE',path:string,params:Record<string,string|number>={},signed=true):Promise<T>{
 const qs=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
 if(signed){
  qs.set('timestamp',String(Date.now()));qs.set('recvWindow','10000');
  const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(a.creds.apiSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(qs.toString())));
  qs.set('signature',Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''));
 }
 const r=await fetch(`${futuresHost(a.testnet)}${path}?${qs}`,{method,headers:signed?{'X-MBX-APIKEY':a.creds.apiKey}:{},signal:AbortSignal.timeout(12000)});
 if(!r.ok){let j:{code?:number;msg?:string}={};try{j=await r.json();}catch{};throw new Error(`Binance Futures ${r.status}${j.code?` (${j.code})`:''}: ${j.msg??'request unavailable'}`);}
 return await r.json() as T;
}
export type BrokerPosition={symbol:string;positionAmt:string;entryPrice:string;markPrice:string;unRealizedProfit:string;positionSide:string;leverage?:string;marginType?:string};
export type BrokerOrder={orderId:number;clientOrderId:string;status:string;executedQty:string;avgPrice:string;side:string};
export type AlgoOrder={algoId:number;clientAlgoId:string;algoStatus?:string;actualOrderId?:number;triggerPrice?:string};
export async function futuresAccountState(a:FuturesAccount){
 const [account,config,mode,multi]=await Promise.all([
 futuresCall<{availableBalance:string}>(a,'GET','/fapi/v3/account'),
 futuresCall<{canTrade:boolean}>(a,'GET','/fapi/v1/accountConfig'),
 futuresCall<{dualSidePosition:boolean}>(a,'GET','/fapi/v1/positionSide/dual'),
 futuresCall<{multiAssetsMargin:boolean}>(a,'GET','/fapi/v1/multiAssetsMargin'),]);
 return {...account,canTrade:config.canTrade===true,hedge:mode.dualSidePosition,multiAssets:multi.multiAssetsMargin};
}
export async function futuresSymbol(a:FuturesAccount,pair:string){
 const symbol=pair.replace('/','');
 const [info,mark]=await Promise.all([
 futuresCall<{symbols:{symbol:string;status:string;contractType:string;filters:{filterType:string;stepSize?:string;minQty?:string;tickSize?:string;notional?:string}[]}[]}>(a,'GET','/fapi/v1/exchangeInfo',{},false),
 futuresCall<{markPrice:string}>(a,'GET','/fapi/v1/premiumIndex',{symbol},false)]);
 const s=info.symbols.find(s=>s.symbol===symbol&&s.status==='TRADING'&&s.contractType==='PERPETUAL');
 const lot=s?.filters.find(f=>f.filterType==='MARKET_LOT_SIZE');const px=s?.filters.find(f=>f.filterType==='PRICE_FILTER');const mn=s?.filters.find(f=>f.filterType==='MIN_NOTIONAL');
 const price=Number(mark.markPrice),step=Number(lot?.stepSize),tick=Number(px?.tickSize);
 if(!s||![price,step,tick].every(n=>Number.isFinite(n)&&n>0))throw new Error('Futures symbol is unavailable');
 return {symbol,price,step,tick,minQty:Number(lot?.minQty??0),minNotional:Number(mn?.notional??0)};
}
export const futuresPositions=(a:FuturesAccount,symbol:string)=>futuresCall<BrokerPosition[]>(a,'GET','/fapi/v3/positionRisk',{symbol});
export const futuresOrder=(a:FuturesAccount,symbol:string,clientId:string)=>futuresCall<BrokerOrder>(a,'GET','/fapi/v1/order',{symbol,origClientOrderId:clientId});
export const futuresAlgo=(a:FuturesAccount,clientId:string)=>futuresCall<AlgoOrder>(a,'GET','/fapi/v1/algoOrder',{clientAlgoId:clientId});
export const futuresCancelAlgo=(a:FuturesAccount,clientId:string)=>futuresCall(a,'DELETE','/fapi/v1/algoOrder',{clientAlgoId:clientId});
