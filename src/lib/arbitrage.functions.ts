import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ARBITRAGE_EXCHANGES, ARBITRAGE_PAIRS } from "./arbitrage";

const scanSchema = z.object({ pair: z.enum(ARBITRAGE_PAIRS), budget: z.number().min(10).max(100000),
  feeBps: z.number().min(10).max(200), slippageBps: z.number().min(5).max(200),
  exchanges: z.array(z.enum(ARBITRAGE_EXCHANGES)).min(2).max(4).refine((v) => new Set(v).size === v.length),
});
export const scanArbitrageFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => scanSchema.parse(i)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const { scanArbitrage } = await import("./arbitrage.server"); return scanArbitrage(data);
  });
export const executeArbitrageFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => scanSchema.extend({ requestKey: z.string().uuid(), buyExchange: z.enum(ARBITRAGE_EXCHANGES), sellExchange: z.enum(ARBITRAGE_EXCHANGES),
    buyConnectionId: z.string().uuid().nullable(), sellConnectionId: z.string().uuid().nullable(), mode: z.enum(["paper", "live"]), confirmation: z.string().max(4), minimumNetPct: z.number().min(0).max(100),
  }).parse(i)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { executeArbitrage } = await import("./arbitrage.server"); return executeArbitrage(supabaseAdmin, context.userId, data);
  });
export const arbitrageReviewFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => scanSchema.parse(i)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const { scanArbitrage } = await import("./arbitrage.server"); const scan = await scanArbitrage(data);
    if (!scan.opportunities.length) throw new Error("Not enough exchange data for AI review");
    const apiKey = process.env["LOVABLE_API_KEY"]; if (!apiKey) throw new Error("AI is not configured");
    const { createOpenAI } = await import("@ai-sdk/openai"); const { generateText } = await import("ai");
    const provider = createOpenAI({ baseURL: "https://ai.gateway.lovable.dev/v1", apiKey, headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" } });
    const { text } = await generateText({ model: provider.responses("openai/gpt-6-astra"),
      system: "Review cryptocurrency spot arbitrage using ONLY these server-fetched depth comparisons. Give 3 short sentences on best route, estimated fees/net, and prefunding/partial-fill risk. When all nets are negative, say do not execute. Never guarantee profits, invent balances, or suggest exchange withdrawals. You cannot place orders; user confirmation is required.",
      prompt: JSON.stringify({ pair: data.pair, feeBps: data.feeBps, slippageBps: data.slippageBps, opportunities: scan.opportunities.slice(0, 3), errors: scan.errors }),
      providerOptions: { openai: { reasoningEffort: "low" } },
    }); return { text, scannedAt: scan.scannedAt };
  });