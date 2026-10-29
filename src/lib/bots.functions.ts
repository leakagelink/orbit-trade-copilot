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

// Switches a bot to LIVE (real orders). Requires typed confirmation and a verified trading account.
export const enableLiveTrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), confirm: z.literal("LIVE") }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: bot } = await context.supabase.from("trading_bots").select("id,exchange,exchange_connection_id,strategies(config)").eq("id", data.id).maybeSingle();
    if (!bot) throw new Error("Bot not found");
    if (!["binance", "bybit", "okx", "kucoin"].includes(bot.exchange)) throw new Error("Live trading is not supported on this exchange yet");
    if (!bot.exchange_connection_id) throw new Error("Attach a trading account to this bot first");
    const { data: conn } = await context.supabase.from("exchange_connections").select("status,exchange,is_testnet").eq("id", bot.exchange_connection_id).maybeSingle();
    if (!conn || conn.status !== "connected") throw new Error("Verify the trading account on the Exchanges page first");
    const cfg = (bot.strategies as { config: unknown } | null)?.config as StrategyConfig | undefined;
    if (!cfg || validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
    const { data: risk } = await context.supabase.from("risk_settings").select("trading_halted").eq("user_id", context.userId).maybeSingle();
    if (risk?.trading_halted) throw new Error("Trading is halted — resume it on the Risk page first");
    const { error } = await context.supabase.from("trading_bots").update({ mode: "live", status: "running", status_reason: null }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await context.supabase.from("bot_logs").insert({ bot_id: data.id, user_id: context.userId, level: "warn", message: `LIVE trading enabled${conn.is_testnet ? " (testnet)" : ""} — real orders will be placed` });
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "bot.live_enabled", entity_type: "trading_bot", entity_id: data.id, details: { testnet: conn.is_testnet } });
    return { ok: true, testnet: conn.is_testnet };
  });

// Moves a bot back to paper mode (stopped). Open live positions keep being managed until closed.
export const switchToPaper = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { count } = await context.supabase.from("positions").select("id", { count: "exact", head: true }).eq("bot_id", data.id).eq("is_open", true).eq("mode", "live");
    if (count) throw new Error("This bot still has open live positions — close them first (Risk → Close everything)");
    const { error } = await context.supabase.from("trading_bots").update({ mode: "paper", status: "stopped" }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Emergency stop: halts the account, stops all bots and closes every open position immediately.
export const emergencyStop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { emergencyCloseAll } = await import("./engine.server");
    const r = await emergencyCloseAll(context.userId);
    await context.supabase.from("audit_logs").insert({ user_id: context.userId, action: "risk.emergency_stop", entity_type: "account", details: r });
    return r;
  });
