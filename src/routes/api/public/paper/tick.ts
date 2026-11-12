import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Forward paper trading tick: simulated fills only. Not scheduled until draft migration 0044 is approved and applied.
export const Route = createFileRoute("/api/public/paper/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runScheduledPaperTick } = await import("@/lib/paper.server");
        const r = await runScheduledPaperTick();
        const outcomes: Record<string, number> = {};
        for (const x of r.results) outcomes[x.outcome] = (outcomes[x.outcome] ?? 0) + 1;
        const failed = r.results.filter((x) => ["data_outage", "data_gap", "invalid_data", "commit_failed"].includes(x.outcome));
        // Server log for monitoring; owners see the same reason on the Paper trading page. No ids of other users are returned.
        if (failed.length) console.error("paper tick: strategies needing attention", JSON.stringify(failed.map((x) => ({ id: x.id, outcome: x.outcome, detail: x.detail?.slice(0, 200) }))));
        return Response.json({ ok: true, enabled: r.enabled, strategies: r.results.length, committed: r.results.reduce((a, x) => a + x.committed, 0), outcomes });
      },
    },
  },
});
