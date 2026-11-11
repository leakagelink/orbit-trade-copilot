import { useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { toast } from 'sonner';
import { ShieldCheck,RefreshCw,Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { verifyFuturesFn,saveFuturesLimitsFn,futuresIdeaFn } from '@/lib/futures.functions';
export function FuturesControls({connectionId,symbol,testnet,leverage,onLeverage,confirmation,onConfirmation}:{connectionId:string;symbol:string;testnet:boolean;leverage:string;onLeverage:(v:string)=>void;confirmation:string;onConfirmation:(v:string)=>void}){
 const qc=useQueryClient();const verify=useServerFn(verifyFuturesFn),save=useServerFn(saveFuturesLimitsFn),idea=useServerFn(futuresIdeaFn);
 const [busy,setBusy]=useState(false),[margin,setMargin]=useState(''),[loss,setLoss]=useState(''),[report,setReport]=useState('');
 const state=useQuery({queryKey:['futures_limits'],queryFn:async()=>{const r=await supabase.from('futures_settings').select('*').maybeSingle();if(r.error)throw r.error;return r.data;}});
 const verified=useQuery({queryKey:['futures_verification',connectionId],queryFn:async()=>{const r=await supabase.from('futures_verifications').select('*').eq('connection_id',connectionId).order('created_at',{ascending:false}).limit(1);if(r.error)throw r.error;return r.data[0]??null;}});
 async function act(fn:()=>Promise<unknown>){setBusy(true);try{await fn();qc.invalidateQueries({queryKey:['futures_limits']});qc.invalidateQueries({queryKey:['futures_verification']});}catch(e){toast.error(e instanceof Error?e.message:'Futures request failed');}finally{setBusy(false);}}
 return <div className="space-y-3 border-t pt-3">
 <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">USD-M Futures · {testnet?'Testnet':'Real money'}</span><Button size="icon" variant="outline" title="Verify Futures access" aria-label="Verify Futures access" disabled={busy} onClick={()=>act(async()=>{const r=await verify({data:{connectionId}});toast.success(r.canTrade?'Futures read access and trading permission verified':'Read access verified; trading permission unavailable');})}><RefreshCw className="h-4 w-4"/></Button></div>
 {verified.data&&<p className="text-xs text-muted-foreground">Read: {verified.data.read_access?'verified':'unavailable'} · Trading permission: {verified.data.can_trade?'yes':'no'} · {verified.data.hedge_mode?'Hedge mode':'One-way mode'} · Execution: not certified</p>}
 <div className="grid grid-cols-2 gap-2"><div><Label>Leverage</Label><Input aria-label="Futures leverage" type="number" min="1" max="20" value={leverage} onChange={e=>onLeverage(e.target.value)}/></div><div><Label>Maximum margin (USDT)</Label><Input aria-label="Maximum Futures margin" type="number" value={margin} placeholder={state.data?.max_margin?.toString()??''} onChange={e=>setMargin(e.target.value)}/></div></div>
 <div><Label>Maximum loss reserve (USDT)</Label><Input aria-label="Maximum Futures loss" type="number" value={loss} placeholder={state.data?.max_loss?.toString()??''} onChange={e=>setLoss(e.target.value)}/></div>
 <Button variant="outline" size="sm" disabled={busy} onClick={()=>act(async()=>{await save({data:{connectionId,enabled:false,maxMargin:Number(margin||state.data?.max_margin),maxLeverage:Number(leverage),maxLoss:Number(loss||state.data?.max_loss),confirmation:''}});toast.success('Futures risk limits saved');})}><ShieldCheck className="mr-2 h-4 w-4"/>Save Futures limits</Button>
 {!testnet&&<><p className="text-xs text-warning">Live entries locked until testnet entry, broker protection, close and recovery are independently verified.</p><Button size="sm" variant="outline" disabled={busy||!state.data?.testnet_certified_at} onClick={()=>act(async()=>{await save({data:{connectionId,enabled:!state.data?.live_enabled,maxMargin:Number(margin||state.data?.max_margin),maxLeverage:Number(leverage),maxLoss:Number(loss||state.data?.max_loss),confirmation}});toast.success('Futures live setting saved');})}>{state.data?.live_enabled?'Disable live Futures':'Enable live Futures'}</Button></>}
 <Label>{testnet?'Type TESTNET':'Type LIVE for orders / LIVE FUTURES for opt-in'}</Label><Input aria-label="Futures confirmation" value={confirmation} onChange={e=>onConfirmation(e.target.value)}/>
 <Button size="sm" variant="outline" disabled={busy} onClick={()=>act(async()=>{const r=await idea({data:{connectionId,symbol}});setReport(r.text);})}><Brain className="mr-2 h-4 w-4"/>AI Futures review</Button>{report&&<p className="whitespace-pre-wrap text-sm">{report}</p>}
 </div>;
}
