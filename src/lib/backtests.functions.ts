import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const input = z.object({
  strategyId: z.string().uuid(),
  exchange: z.enum(["binance", "bybit", "okx", "kucoin", "coinbase"]),
  days: z.number().int().min(1).max(365),
  capital: z.number().positive().max(1e9),
  feePct: z.number().min(0).max(2),
  slippagePct: z.number().min(0).max(2),
});

export const runBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => input.parse(i))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { runBacktestFor } = await import("./backtests.server");
    return runBacktestFor(context.supabase, context.userId, data);
  });
