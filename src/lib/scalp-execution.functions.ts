import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { endpointsAllowed, LIVE_ORDER_EXECUTION_ENABLED, SCALP_EXEC_VERSION } from "./scalp-execution";

/** Read-only gate status for the Command Center. */
export const getScalpExecutionGate = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Read-only: the owner's own account emergency stop (null = unknown, which the risk engine treats as INSUFFICIENT_DATA).
    const r = await context.supabase.from("risk_settings").select("trading_halted").eq("user_id", context.userId).maybeSingle();
    const accountEmergencyStop: boolean | null = r.error ? null : r.data ? Boolean(r.data.trading_halted) : null;
    return { enabled: LIVE_ORDER_EXECUTION_ENABLED, version: SCALP_EXEC_VERSION, endpointsInAllowlist: endpointsAllowed(), transport: "not connected" as const, accountEmergencyStop };
  });

/** Every request is refused by the server-side gate in Phase 4H.8; it returns the audit record. No UI control calls it. */
export const requestScalpLiveOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => d)
  .handler(async ({ data, context }) => {
    const { requestScalpOrder } = await import("./scalp-execution.server");
    return requestScalpOrder(data, {
      now: () => Date.now(),
      readEmergencyStop: async () => { const r = await context.supabase.from("risk_settings").select("trading_halted").eq("user_id", context.userId).maybeSingle(); return r.error ? null : r.data ? Boolean(r.data.trading_halted) : null; },
      log: (line) => console.info(line),
    });
  });
