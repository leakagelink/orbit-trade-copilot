import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Crown, Zap, CandlestickChart, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlan } from "@/hooks/use-plan";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PLAN_FEATURES, PLAN_IDS, type BillingInterval } from "@/lib/plans";

const D = "Free manual trading, Pro AI and trading bots, or Elite scalping and arbitrage. Compare monthly and yearly plans.";
export const Route = createFileRoute("/_authenticated/plans")({
  head: () => ({ meta: [{ title: "Free, Pro & Elite Plans — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Free, Pro & Elite Plans — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: PlansPage,
});

function PlansPage() {
  const plan = usePlan();
  const current = plan.data?.plan ?? "free";
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const icons = { free: CandlestickChart, pro: Zap, elite: Crown };
  return (
    <div>
      <PageHeader title="Plans" description="Manual. Automated. Advanced." />
      <div className="max-w-6xl space-y-6 px-4 pb-8 md:px-7">
      <div className="flex flex-wrap items-center justify-between gap-4 border-y py-4">
        <div className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-primary" />{plan.isLoading ? "Loading your plan…" : plan.isError ? "Plan unavailable" : `${PLAN_FEATURES[current].name} workspace`}</div>
        <Tabs value={interval} onValueChange={v => { if (v === "monthly" || v === "yearly") setInterval(v); }}>
          <TabsList aria-label="Billing interval" className="h-auto"><TabsTrigger value="monthly" className="min-h-11">Monthly</TabsTrigger><TabsTrigger value="yearly" className="min-h-11">Yearly</TabsTrigger></TabsList>
        </Tabs>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = PLAN_FEATURES[id];
          const Icon = icons[id];
          const isCurrent = !plan.isLoading && !plan.isError && current === id;
          return (
            <Card key={id} className={`flex min-w-0 flex-col p-5 md:p-6 ${id === "pro" ? "border-primary/50" : id === "elite" ? "border-warning/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Icon className={`h-5 w-5 ${id === "elite" ? "text-warning" : "text-primary"}`} />
                <h2 className="text-xl font-semibold">{p.name}</h2>
                {isCurrent && <Badge>Current plan</Badge>}
              </div>
              <p className="mt-2 min-h-10 text-sm text-muted-foreground">{p.summary}</p>
              <div className="my-5 min-h-16 border-b pb-5">{id === "free" ? <><span className="font-mono text-3xl">$0</span><span className="ml-2 text-xs text-muted-foreground">Always free</span></> : <><div className="text-xl font-semibold">Price pending</div><div className="mt-1 text-xs text-muted-foreground">{interval === "monthly" ? "Monthly subscription" : "Yearly subscription · billed annually"}</div></>}</div>
              <ul className="flex-1 space-y-3 text-sm">
                {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-gain" />{f}</li>)}
              </ul>
              {plan.isLoading ? <Skeleton className="mt-6 h-11" /> : id !== "free" && !isCurrent ? (
                <div className="mt-5 space-y-1.5">
                  <Button className="h-11 w-full" variant={id === "elite" ? "outline" : "default"} disabled>{p.name} · {interval === "monthly" ? "Monthly" : "Yearly"}</Button>
                </div>
              ) : (
                <Button className="mt-6 h-11 w-full" variant="outline" disabled>{isCurrent ? "Your plan" : "Included"}</Button>
              )}
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Paid checkout is not available yet; prices are awaiting confirmation. Wallet funds are virtual. Live trades use your own connected exchange or broker. Trading profits are not guaranteed.</p>
      </div>
    </div>
  );
}
