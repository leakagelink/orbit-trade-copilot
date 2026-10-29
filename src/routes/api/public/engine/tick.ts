import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

export const Route = createFileRoute("/api/public/engine/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runEngineTick } = await import("@/lib/engine.server");
        const results = await runEngineTick();
        return Response.json({ ok: true, bots: results.length });
      },
    },
  },
});
