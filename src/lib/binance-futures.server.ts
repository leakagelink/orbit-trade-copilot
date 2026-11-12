// Binance USD-M only; never fall back to Spot hosts or change account-wide position mode.
import type { Creds } from './exchange-adapters.server';
import type { FaultPlan } from './futures-faults.server';
import { testnetFuturesAdapter } from './binance-futures-testnet.server';
import { liveFuturesAdapter } from './binance-futures-live.server';
import type { FuturesAdapter } from './binance-futures-core.server';
// `faults` is attached only by the Testnet certification harness; production accounts refuse it.
export type FuturesAccount={connectionId:string;testnet:boolean;creds:Creds;faults?:FaultPlan};
/** The only two adapters. Each validates environment, endpoint and credential binding itself on every request. */
export const futuresAdapter=(testnet:boolean):FuturesAdapter=>testnet===true?testnetFuturesAdapter:liveFuturesAdapter;
export function futuresHost(testnet:boolean){return futuresAdapter(testnet).baseUrl;}
export function futuresCall<T>(a:Pick<FuturesAccount,'testnet'|'creds'|'faults'>,method:'GET'|'POST'|'DELETE',path:string,params:Record<string,string|number>={},signed=true):Promise<T>{
 return futuresAdapter(a.testnet).call<T>(a,method,path,params,signed);
}
export type BrokerPosition={symbol:string;positionAmt:string;entryPrice:string;markPrice:string;unRealizedProfit:string;positionSide:string;leverage?:string;marginType?:string};
export type BrokerOrder=import('./futures-execution').FillOrder & {time?:number;updateTime?:number};
export type AlgoOrder=import('./futures-execution').ProtectionOrder;
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
export async function futuresPositions(a:FuturesAccount,symbol:string){
 const active=await futuresCall<BrokerPosition[]>(a,'GET','/fapi/v3/positionRisk',{symbol});
 if(active.some(p=>p.symbol===symbol&&p.positionSide==='BOTH'))return active;
 // V3 omits symbols with neither exposure nor orders. Absence alone is not proof of flat.
 const explicit=await futuresCall<BrokerPosition[]>(a,'GET','/fapi/v2/positionRisk',{symbol});
 const row=explicit.find(p=>p.symbol===symbol&&p.positionSide==='BOTH');
 if(!row||!Number.isFinite(Number(row.positionAmt)))throw new Error('Explicit broker inventory unavailable; recovery remains locked');
 return explicit;
}
export const futuresOrder=(a:FuturesAccount,symbol:string,clientId:string)=>futuresCall<BrokerOrder>(a,'GET','/fapi/v1/order',{symbol,origClientOrderId:clientId});
export const futuresAlgo=(a:FuturesAccount,clientId:string)=>futuresCall<AlgoOrder>(a,'GET','/fapi/v1/algoOrder',{clientAlgoId:clientId});
export const futuresCancelAlgo=(a:FuturesAccount,clientId:string)=>futuresCall(a,'DELETE','/fapi/v1/algoOrder',{clientAlgoId:clientId});
export const futuresCancelOrder=(a:FuturesAccount,symbol:string,clientId:string)=>futuresCall(a,'DELETE','/fapi/v1/order',{symbol,origClientOrderId:clientId});
/** Bounded historical pagination. Exhaustion is unavailable evidence, never a fabricated total. */
export async function futuresEvidence(a:FuturesAccount,symbol:string,start:number,end:number) {
 const fills:import('./futures-execution').BrokerFill[]=[],income:import('./futures-execution').FundingEvent[]=[];
 const window=7*86400000;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>30*86400000)throw new Error('Historical evidence interval requires operator reconciliation');
 for(let from=start;from<=end;from+=window){
  const to=Math.min(end,from+window-1);
  const trades=await futuresCall<import('./futures-execution').BrokerFill[]>(a,'GET','/fapi/v1/userTrades',{symbol,startTime:from,endTime:to,limit:1000});
  if(trades.length>=1000)throw new Error('Fill history page saturated; reconciliation remains locked');
  fills.push(...trades);
  for(let page=1;page<=10;page++){
   const rows=await futuresCall<import('./futures-execution').FundingEvent[]>(a,'GET','/fapi/v1/income',{symbol,incomeType:'FUNDING_FEE',startTime:from,endTime:to,limit:1000,page});
   income.push(...rows);if(rows.length<1000)break;
   if(page===10)throw new Error('Funding history pagination exhausted');
  }
 }
 return {fills,income};
}
