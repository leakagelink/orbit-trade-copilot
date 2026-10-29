import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Quantra" }, { name: "description", content: "Portfolio metrics computed from your trade records." }, { property: "og:title", content: "Dashboard — Quantra" }, { property: "og:description", content: "Portfolio metrics computed from your trade records." }] }),
  component: () => (
    <div>
      <PageHeader title="Dashboard" description="Portfolio metrics computed from your trade records." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
