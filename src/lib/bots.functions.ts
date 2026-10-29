import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateStrategy, type StrategyConfig } from "./strategy";

// Starts a bot in paper mode after re-validating its strategy server-side.
export const startPaperBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: bot } = await context.supabase.from("trading_bots").select("id,mode,strategies(config)").eq("id", data.id).maybeSingle();
    if (!bot) throw new Error("Bot not found");
    if (bot.mode !== "paper") throw new Error("Live trading is not enabled yet");
    const cfg = (bot.strategies as { config: unknown } | null)?.config as StrategyConfig | undefined;
    if (!cfg || validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
    const { error } = await context.supabase.from("trading_bots").update({ status: "paper_trading", status_reason: null }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await context.supabase.from("bot_logs").insert({ bot_id: data.id, user_id: context.userId, message: "Paper trading started — engine checks every minute" });
    return { ok: true };
  });
