import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const input = z.strictObject({ connectionId: z.string().uuid(), symbol: z.enum(["BTCUSDT", "ETHUSDT"]) });
/** Read-only: server-recomputed signal, Central Risk decision, ticket and gate for the owner's Futures account. No order. */
export const previewScalpPilotFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(input).handler(async ({ data, context }) => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { previewPilot } = await import("./scalp-pilot.server");
  return JSON.parse(JSON.stringify(await previewPilot(db, context.userId, data))) as Awaited<ReturnType<typeof previewPilot>>;
});
/** Re-evaluates server-side; refused unless every pilot gate check passes (Testnet and live are OFF in code). */
export const submitScalpPilotFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(input).handler(async ({ data, context }) => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { submitPilot } = await import("./scalp-pilot.server");
  return JSON.parse(JSON.stringify(await submitPilot(db, context.userId, data))) as { status: "REFUSED" | "SUBMITTED"; correlationId: string; code?: string };
});
