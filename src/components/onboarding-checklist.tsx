import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, X, Rocket } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

async function count(table: "wallet_transactions" | "trades" | "exchange_connections", filter?: (q: any) => any) {
  let q: any = supabase.from(table).select("id", { count: "exact", head: true });
  if (filter) q = filter(q);
  const r = await q;
  return r.error ? 0 : (r.count ?? 0);
}

export function OnboardingChecklist({ force = false }: { force?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["onboarding"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const prof = u.user ? await supabase.from("profiles").select("onboarding_dismissed").eq("id", u.user.id).maybeSingle() : null;
      const [deposits, trades, positions, conns] = await Promise.all([
        count("wallet_transactions", q => q.eq("kind", "deposit")),
        count("trades"),
        supabase.from("positions").select("id", { count: "exact", head: true }).not("stop_loss", "is", null).then(r => r.count ?? 0),
        count("exchange_connections"),
      ]);
      return { userId: u.user?.id, dismissed: prof?.data?.onboarding_dismissed ?? false, deposits, trades, positions, conns };
    },
  });
  if (!q.data || (q.data.dismissed && !force)) return null;
  const d = q.data;
  const steps = [
    { done: d.deposits > 0, label: "Add demo funds to your wallet", to: "/wallet" },
    { done: d.positions > 0 || d.trades > 0, label: "Place your first trade with a stop loss", to: "/trade" },
    { done: d.trades > 0, label: "Close a trade and review the result", to: "/trade" },
    { done: d.conns > 0, label: "Connect an exchange or broker (optional)", to: "/exchanges" },
    { done: false, label: "Read the beginner lessons", to: "/learn" },
  ] as const;
  const done = steps.filter(s => s.done).length;
  async function dismiss() {
    if (!d.userId) return;
    await supabase.from("profiles").update({ onboarding_dismissed: true }).eq("id", d.userId);
    qc.invalidateQueries({ queryKey: ["onboarding"] });
  }
  return (
    <section className="rounded-lg border bg-card p-4" aria-label="Getting started">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2"><Rocket className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Getting started · {done}/{steps.length}</h2></div>
        {!force && <Button variant="ghost" size="icon" aria-label="Hide getting started" onClick={dismiss}><X className="h-4 w-4" /></Button>}
      </div>
      <Progress value={(done / steps.length) * 100} className="mt-3 h-1.5" />
      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {steps.map(s => (
          <li key={s.label}><Link to={s.to} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent">
            {s.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className={s.done ? "text-muted-foreground line-through" : ""}>{s.label}</span>
          </Link></li>
        ))}
      </ul>
    </section>
  );
}
