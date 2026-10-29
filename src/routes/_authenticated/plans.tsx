import { createFileRoute } from "@tanstack/react-router";
import { Check, Crown } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlan } from "@/hooks/use-plan";
import { PLAN_FEATURES, type PlanId } from "@/lib/plans";

const D = "Compare the Free and Pro plans and upgrade for AI and algo trading.";
export const Route = createFileRoute("/_authenticated/plans")({
  head: () => ({ meta: [{ title: "Plans — Quantra" }, { name: "description", content: D }, { property: "og:title", content: "Plans — Quantra" }, { property: "og:description", content: D }] }),
  component: PlansPage,
});

function PlansPage() {
  const plan = usePlan();
  const current: PlanId = plan.data?.pro ? "pro" : "free";
  return (
    <div>
      <PageHeader title="Plans" description={D} />
      <div className="grid max-w-4xl gap-4 p-4 md:grid-cols-2">
        {(["free", "pro"] as PlanId[]).map((id) => {
          const p = PLAN_FEATURES[id];
          const isCurrent = !plan.isLoading && current === id;
          return (
            <div key={id} className={`flex flex-col rounded-lg border bg-card p-5 ${id === "pro" ? "border-primary/50" : ""}`}>
              <div className="flex items-center gap-2">
                {id === "pro" && <Crown className="h-4 w-4 text-primary" />}
                <h2 className="text-lg font-semibold">{p.name}</h2>
                {isCurrent && <Badge>Current plan</Badge>}
              </div>
              <div className="mt-2 font-mono text-2xl">{id === "free" ? "$0" : <span className="text-base text-muted-foreground">Price coming soon</span>}</div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-gain" />{f}</li>)}
              </ul>
              {plan.isLoading ? <Skeleton className="mt-5 h-9" /> : id === "pro" && !isCurrent ? (
                <div className="mt-5 space-y-1.5">
                  <Button className="w-full" disabled>Upgrade to Pro</Button>
                  <p className="text-center text-xs text-muted-foreground">Online checkout is being set up.</p>
                </div>
              ) : (
                <Button className="mt-5 w-full" variant="outline" disabled>{isCurrent ? "Your plan" : "Included"}</Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
