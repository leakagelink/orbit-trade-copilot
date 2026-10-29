import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — Quantra" }, { name: "description", content: "Profile and account settings." }, { property: "og:title", content: "Settings — Quantra" }, { property: "og:description", content: "Profile and account settings." }] }),
  component: () => (
    <div>
      <PageHeader title="Settings" description="Profile and account settings." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
