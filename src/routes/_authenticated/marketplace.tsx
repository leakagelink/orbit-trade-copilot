import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Store } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead, QueryError } from "@/components/toolkit-shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/marketplace")({
  head: () => toolkitHead("Strategy marketplace", "Browse and copy strategies shared by other Quantra traders, or publish your own."),
  component: Marketplace,
});

function Marketplace() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const market = useQuery({ queryKey: ["marketplace"], queryFn: async () => {
    const r = await supabase.rpc("marketplace_strategies");
    if (r.error) throw new Error("Marketplace unavailable");
    return r.data ?? [];
  } });
  const mine = useQuery({ queryKey: ["marketplace", "mine"], queryFn: async () => {
    const { data: u } = await supabase.auth.getUser();
    const r = await supabase.from("strategies").select("id, name, is_published, clone_count").eq("user_id", u.user!.id).neq("status", "archived").order("updated_at", { ascending: false });
    if (r.error) throw new Error("Your strategies are unavailable");
    return { userId: u.user!.id, rows: r.data ?? [] };
  } });

  async function publish(id: string, v: boolean) {
    const r = await supabase.from("strategies").update({ is_published: v, published_at: v ? new Date().toISOString() : null }).eq("id", id);
    if (r.error) { toast.error("Couldn't update — strategy changes need a Pro plan"); return; }
    toast.success(v ? "Published to the marketplace" : "Removed from the marketplace");
    qc.invalidateQueries({ queryKey: ["marketplace"] });
  }
  async function clone(s: { id: string; name: string; description: string | null; config: Json }) {
    const r = await supabase.from("strategies").insert({ user_id: mine.data!.userId, name: `${s.name} (copy)`.slice(0, 120), description: s.description, config: s.config, source: "marketplace" }).select("id").single();
    if (r.error) { toast.error("Couldn't copy — strategies need a Pro plan"); return; }
    await supabase.rpc("bump_strategy_clone", { _id: s.id });
    toast.success("Copied to your strategies");
    navigate({ to: "/strategies/$id", params: { id: r.data.id } });
  }

  return (
    <div>
      <PageHeader title="Strategy marketplace" description="Shared rules only — results are not verified and are not advice. Always backtest and paper trade first." />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <QueryError error={market.error ?? mine.error} />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(market.data ?? []).map(s => (
            <div key={s.id} className="flex flex-col rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{s.name}</h3><Badge variant="outline">{s.clone_count} copies</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">by {s.author}</p>
              <p className="mt-3 line-clamp-3 flex-1 text-sm text-muted-foreground">{s.description || "No description."}</p>
              <Button className="mt-4" variant="outline" disabled={!mine.data} onClick={() => clone(s)}><Copy className="h-4 w-4" />Copy to my strategies</Button>
            </div>
          ))}
          {market.data?.length === 0 && <div className="col-span-full flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground"><Store className="h-4 w-4" />No strategies published yet — be the first.</div>}
        </div>
        <div className="rounded-lg border bg-card">
          <div className="border-b p-4 text-sm font-medium">Publish your strategies</div>
          {(mine.data?.rows ?? []).length === 0 ? <p className="p-4 text-sm text-muted-foreground">You have no strategies yet.</p> :
            <ul className="divide-y">{mine.data!.rows.map(s => <li key={s.id} className="flex items-center justify-between gap-3 p-4 text-sm"><span className="min-w-0 truncate">{s.name} <span className="text-xs text-muted-foreground">· {s.clone_count} copies</span></span><Switch aria-label={`Publish ${s.name}`} checked={s.is_published} onCheckedChange={v => publish(s.id, v)} /></li>)}</ul>}
        </div>
      </div>
    </div>
  );
}
