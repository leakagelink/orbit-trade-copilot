import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Blocks, Copy, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { emptyStrategyConfig, type StrategyConfig } from "@/lib/strategy";
import { createStrategy } from "@/lib/strategies.api";

const D = "Build, validate, version and clone rule-based trading strategies.";
export const Route = createFileRoute("/_authenticated/strategies/")({
  head: () => ({ meta: [{ title: "Strategies — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Strategies — Quantra" }, { property: "og:description", content: D }] }),
  component: Strategies,
});

const STATUS: Record<string, "default" | "secondary" | "destructive" | "outline"> = { validated: "default", deployed: "default", draft: "secondary", invalid: "destructive", archived: "outline" };

function Strategies() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["strategies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("strategies").select("*").order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
  });

  async function create() {
    try {
      const id = await createStrategy("Untitled strategy", emptyStrategyConfig());
      navigate({ to: "/strategies/$id", params: { id } });
    } catch (e) { toast.error((e as Error).message); }
  }
  async function clone(s: { name: string; config: unknown; description: string | null }) {
    try {
      await createStrategy(`${s.name} (copy)`, s.config as StrategyConfig, "clone", s.description ?? undefined);
      toast.success("Strategy cloned");
      qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) { toast.error((e as Error).message); }
  }
  async function remove(id: string) {
    if (!confirm("Delete this strategy and all its versions?")) return;
    const { error } = await supabase.from("strategies").delete().eq("id", id);
    if (error) return void toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["strategies"] });
  }

  return (
    <div>
      <PageHeader title="Strategies" description={D} actions={<><Button variant="outline" asChild><Link to="/assistant">Generate with AI</Link></Button><Button onClick={create}><Plus className="mr-1 h-4 w-4" />New strategy</Button></>} />
      <div className="p-6">
        {q.isLoading ? <Skeleton className="h-40" /> : q.isError ? <p className="text-sm text-destructive">{q.error.message}</p> : !q.data?.length ? (
          <EmptyState icon={Blocks} title="No strategies yet" body="Create one manually or ask the AI assistant to draft one for you." action={<Button onClick={create}><Plus className="mr-1 h-4 w-4" />New strategy</Button>} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {q.data.map((s) => {
              const cfg = s.config as unknown as StrategyConfig;
              return (
                <div key={s.id} className="flex flex-col rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <Link to="/strategies/$id" params={{ id: s.id }} className="font-medium hover:text-primary">{s.name}</Link>
                    <Badge variant={STATUS[s.status]}>{s.status}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{s.description || "No description"}</p>
                  <div className="mt-3 font-mono text-xs text-muted-foreground">{cfg.pairs?.join(", ")} · {cfg.timeframe} · {cfg.indicators?.length ?? 0} indicators · v{s.current_version} · {s.source}</div>
                  <div className="mt-4 flex gap-1">
                    <Button size="sm" variant="outline" asChild><Link to="/strategies/$id" params={{ id: s.id }}>Edit</Link></Button>
                    <Button size="sm" variant="ghost" onClick={() => clone(s)}><Copy className="mr-1 h-3.5 w-3.5" />Clone</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(s.id)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
