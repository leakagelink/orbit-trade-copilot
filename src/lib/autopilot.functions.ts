import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Whether the owner's Claude key is configured (never returns the key). */
export const autopilotStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ claudeReady: !!process.env["ANTHROPIC_API_KEY"] }));
