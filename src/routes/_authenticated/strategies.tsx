import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/strategies")({
  head: () => ({ meta: [{ title: "Strategies — Quantra" }, { name: "description", content: "Build and validate rule-based strategies." }, { property: "og:title", content: "Strategies — Quantra" }, { property: "og:description", content: "Build and validate rule-based strategies." }] }),
  component: () => (
    <div>
      <PageHeader title="Strategies" description="Build and validate rule-based strategies." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
