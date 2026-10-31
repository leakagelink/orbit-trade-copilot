import {createFileRoute} from "@tanstack/react-router";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Bell,CheckCheck,Trash2} from "lucide-react";
import {toast} from "sonner";
import {supabase} from "@/integrations/supabase/client";
import {PageHeader,EmptyState} from "@/components/app-shell";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {QueryError,toolkitHead} from "@/components/toolkit-shared";
export const Route=createFileRoute("/_authenticated/notifications")({head:()=>toolkitHead("Notifications","Trade updates, price alerts and connection warnings."),component:Notifications});
function Notifications(){
 const qc=useQueryClient();
 const q=useQuery({queryKey:["notifications"],queryFn:async()=>{const r=await supabase.from("notifications").select("*").order("created_at",{ascending:false}).limit(200);if(r.error)throw new Error("Notifications unavailable");return r.data;},refetchInterval:15000});
 async function act(fn:()=>PromiseLike<{error:unknown}>){const r=await fn();if(r.error)toast.error("Could not update notification");else qc.invalidateQueries({queryKey:["notifications"]});}
 return <div><PageHeader title="Notifications" description="Trading activity and market alerts." actions={<Button variant="outline" onClick={()=>act(()=>supabase.from("notifications").update({read_at:new Date().toISOString()}).is("read_at",null))}><CheckCheck className="h-4 w-4"/>Mark all read</Button>}/><div className="px-5 pb-8 md:px-7"><QueryError error={q.error}/>{q.isPending?<p>Loading…</p>:q.data?.length?<div className="divide-y border-y">{q.data.map(n=><article key={n.id} className={`flex items-start gap-3 py-5 ${n.read_at?"":"bg-primary/5"}`}><Bell className="mt-1 h-4 w-4 shrink-0 text-primary"/><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><h2 className="text-sm font-medium">{n.title}</h2>{!n.read_at&&<Badge variant="secondary">New</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{n.body}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(n.created_at).toLocaleString()}</p></div><div className="flex shrink-0">{!n.read_at&&<Button variant="ghost" size="icon" title="Mark read" aria-label="Mark read" onClick={()=>act(()=>supabase.from("notifications").update({read_at:new Date().toISOString()}).eq("id",n.id))}><CheckCheck className="h-4 w-4"/></Button>}<Button variant="ghost" size="icon" title="Delete notification" aria-label="Delete notification" onClick={()=>act(()=>supabase.from("notifications").delete().eq("id",n.id))}><Trash2 className="h-4 w-4"/></Button></div></article>)}</div>:<EmptyState icon={Bell} title="You're all caught up" body="No notifications yet."/>}</div></div>;
}