import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { TIMEFRAMES } from "./strategy";

// Live candles from the exchange's public API (no keys needed).
export const getCandles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      exchange: z.enum(["binance", "bybit", "okx", "kucoin", "coinbase"]),
      pair: z.string().regex(/^[A-Za-z0-9]{2,12}\/[A-Za-z0-9]{2,12}$/),
      timeframe: z.enum(TIMEFRAMES),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { fetchCandles } = await import("./exchange-adapters.server");
    try {
      return { candles: await fetchCandles(data.exchange, data.pair, data.timeframe, false, 300), error: null };
    } catch (e) {
      return { candles: [], error: e instanceof Error ? e.message : "Market data unavailable" };
    }
  });
