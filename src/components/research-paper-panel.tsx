import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { confirmPaperResearch, listPaperResearch, refreshPaperResearch } from "@/lib/research-paper.functions";
import { researchProposal } from "@/lib/research-proposal";
const resultSchema=z.object({status:z.string(),entry:z.number().nullable(),netPnl:z.number().nullable(),reason:z.string()});
export function ResearchPaperPanel({proposalId,proposal}:{proposalId:string|undefined;proposal:unknown}) {
  const qc=useQueryClient(), confirm=useServerFn(confirmPaperResearch),refresh=useServerFn(refreshPaperResearch);
  const history=useQuery({queryKey:["research-paper"],queryFn:()=>listPaperResearch(),retry:false});
  const [open,setOpen]=useState(false),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const parsed=researchProposal.safeParse(proposal);
  async function submit(e:React.FormEvent<HTMLFormElement>){e.preventDefault();if(!proposalId||!accepted)return;const f=new FormData(e.currentTarget);setBusy(true);try{await confirm({data:{proposalId,confirm:"PAPER",quantity:Number(f.get("qty")),feePct:Number(f.get("fee")),slippagePct:Number(f.get("slip"))}});toast.success("Forward paper scenario saved");setOpen(false);await qc.invalidateQueries({queryKey:["research-paper"]});}catch(e){toast.error(e instanceof Error?e.message:"Paper confirmation unavailable");}finally{setBusy(false);}}
  async function observe(id:string){setBusy(true);try{const r=await refresh({data:{id}});toast.success(`Paper scenario: ${r.status}`);await qc.invalidateQueries({queryKey:["research-paper"]});}catch(e){toast.error(e instanceof Error?e.message:"Paper observation unavailable");}finally{setBusy(false);}}
  return <section className="space-y-4 border-y py-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><FlaskConical className="h-5 w-5 text-primary"/>Forward paper desk</h3>{history.data&&<span className="text-xs text-muted-foreground">Research runs: {history.data.used} / {history.data.limit} · UTC month</span>}</div>
    {proposalId&&parsed.success&&parsed.data.status==="scenario"&&<Button variant="outline" disabled={busy||history.data?.papers.some(p=>p.proposal_id===proposalId)} onClick={()=>{setAccepted(false);setOpen(true);}}><FlaskConical className="mr-2 h-4 w-4"/>Confirm paper scenario</Button>}
    {history.error&&<p className="text-sm text-destructive">Paper history unavailable</p>}
    {history.data?.papers.length===0&&<p className="text-sm text-muted-foreground">No confirmed paper scenarios.</p>}
    {history.data?.papers.map(p=>{const latest=history.data.observations.find(o=>o.paper_id===p.id),result=resultSchema.safeParse(latest?.result);return <article key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b py-3"><div><p className="text-sm font-medium">{p.symbol} · Paper only · {result.success?result.data.status:"waiting"}</p><p className="mt-1 text-xs text-muted-foreground">{Number(p.quantity)} units · Fee {Number(p.fee_pct)}% · Slippage {Number(p.slippage_pct)}% · {new Date(p.confirmed_at).toLocaleDateString()}</p>{result.success&&<p className="mt-1 text-xs text-muted-foreground">{result.data.reason} · Net {result.data.netPnl===null?"unavailable":result.data.netPnl.toFixed(4)} · Native quote currency</p>}</div><Button aria-label={`Observe paper ${p.symbol}`} title="Observe completed daily bars" variant="outline" size="icon" disabled={busy} onClick={()=>observe(p.id)}><RefreshCw className="h-4 w-4"/></Button></article>;})}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Confirm forward paper scenario</DialogTitle></DialogHeader><form onSubmit={submit} className="space-y-4"><p className="text-sm text-muted-foreground">Simulated daily bars after confirmation only. No wallet balance changes or exchange orders. Historical levels are translated into stop/target distances at the next open.</p><div className="space-y-2"><Label htmlFor="paper-qty">Your hypothetical quantity (units)</Label><Input id="paper-qty" name="qty" type="number" min="0.000001" max="1000000" step="any" required/></div><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="paper-fee">Fee per side (%)</Label><Input id="paper-fee" name="fee" type="number" min="0.01" max="5" step="0.01" defaultValue="0.1" required/></div><div className="space-y-2"><Label htmlFor="paper-slip">Slippage per side (%)</Label><Input id="paper-slip" name="slip" type="number" min="0.01" max="5" step="0.01" defaultValue="0.05" required/></div></div><div className="flex items-start gap-3"><Checkbox id="paper-agree" checked={accepted} onCheckedChange={v=>setAccepted(v===true)}/><Label htmlFor="paper-agree" className="text-sm leading-5">I confirm this is a hypothetical paper scenario, not a live trade or performance guarantee.</Label></div><Button disabled={!accepted||busy} type="submit">{busy?"Saving…":"Save paper confirmation"}</Button></form></DialogContent></Dialog>
  </section>;
}