import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/bots")({
  head: () => ({ meta: [{ title: "Trading Bots — Quantra" }, { name: "description", content: "Configure and monitor automated bots." }, { property: "og:title", content: "Trading Bots — Quantra" }, { property: "og:description", content: "Configure and monitor automated bots." }] }),
  component: () => (
    <div>
      <PageHeader title="Trading Bots" description="Configure and monitor automated bots." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
