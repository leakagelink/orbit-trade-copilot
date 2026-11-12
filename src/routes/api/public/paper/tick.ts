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
        return Response.json({ ok: true, enabled: r.enabled, strategies: r.results.length, committed: r.results.reduce((a, x) => a + x.committed, 0) });
      },
    },
  },
});
