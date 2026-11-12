import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FlaskConical } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { PaperStartDialog } from "@/components/paper/paper-start-dialog";
import { Enabled, NotEnabled } from "@/components/paper/paper-report";
import { getPaperDashboard } from "@/lib/paper.functions";

const D = "Forward paper trading: your strategies on live public prices with simulated fills, costs and risk limits — no exchange orders.";
export const Route = createFileRoute("/_authenticated/paper")({
  head: () => ({ meta: [{ title: "Forward paper trading — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Forward paper trading — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: PaperPage,
});

function PaperPage() {
  const load = useServerFn(getPaperDashboard);
  const q = useQuery({ queryKey: ["paper-dashboard"], queryFn: () => load(), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <div>
      <PageHeader title="Forward paper trading" description={D} actions={d?.enabled ? <PaperStartDialog strategies={d.strategies} disabled={d.account?.halted ? "Lift the emergency paper stop first" : null} /> : undefined} />
      <div className="space-y-5 px-5 pb-8 md:px-7">
        <p className="flex gap-2 rounded-lg border bg-card p-3 text-xs text-muted-foreground"><FlaskConical className="h-4 w-4 shrink-0 text-primary" />Every fill on this page is simulated from public Binance Spot candles. Nothing is sent to an exchange, and no wallet, real position, bot or Autopilot setting is touched. Results here are kept separate from historical backtests.</p>
        {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <p className="text-sm text-loss">Paper trading could not be loaded.</p> : !d ? null : !d.enabled ? <NotEnabled notice={d.notice} strategies={d.strategies.length} /> : <Enabled d={d} />}
      </div>
    </div>
  );
}

