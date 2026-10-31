import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select";
import { MARKETS } from "@/lib/markets";
import { AlertCircle } from "lucide-react";
export function MarketSelect({value,onChange}:{value:string;onChange:(v:string)=>void}){
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label="Market"><SelectValue/></SelectTrigger><SelectContent>{MARKETS.map(m=><SelectItem key={m.symbol} value={m.symbol}>{m.symbol} · {m.name}</SelectItem>)}</SelectContent></Select>;
}
export function QueryError({error}:{error:unknown}){return error?<p role="alert" className="flex items-center gap-2 py-3 text-sm text-destructive"><AlertCircle className="h-4 w-4"/>{error instanceof Error?error.message:"Unable to load data"}</p>:null;}
export function toolkitHead(title:string,description:string){return {meta:[{title:`${title} — Quantra`},{name:"description",content:description},{property:"og:title",content:`${title} — Quantra`},{property:"og:description",content:description},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary_large_image"}]};}