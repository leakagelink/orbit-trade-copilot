import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({ meta: [{ title: "AI Assistant — Quantra" }, { name: "description", content: "Chat with the AI about markets and strategies." }, { property: "og:title", content: "AI Assistant — Quantra" }, { property: "og:description", content: "Chat with the AI about markets and strategies." }] }),
  component: () => (
    <div>
      <PageHeader title="AI Assistant" description="Chat with the AI about markets and strategies." />
      <div className="p-6 text-sm text-muted-foreground">This screen is being built.</div>
    </div>
  ),
});
