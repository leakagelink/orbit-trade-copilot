import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/exchanges")({
  head: () => ({ meta: [{ title: "Exchanges — Quantra" }, { name: "description", content: "Connect your exchange accounts." }, { property: "og:title", content: "Exchanges — Quantra" }, { property: "og:description", content: "Connect your exchange accounts." }] }),
  component: () => (
    <div>
      <PageHeader title="Exchanges" description="Connect your exchange accounts." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
