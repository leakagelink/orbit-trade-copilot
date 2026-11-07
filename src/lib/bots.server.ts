// Server-only paper-bot actions shared by the Bots page and the AI Autopilot. `supabase` is the caller's own client (RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { validateStrategy, type StrategyConfig } from "./strategy";

type Client = SupabaseClient<Database>;
export interface PaperBotRequest {
  name: string; strategyId: string; connectionId: string | null; exchange: "binance" | "bybit" | "okx" | "kucoin" | "coinbase"; pair: string;
  timeframe: string; capital: number; size: number; exposure: number; sl: number; tp: number | null; maxpos: number; dll: number | null;
}

export async function createPaperBotFor(supabase: Client, userId: string, data: PaperBotRequest, note = "Bot created in draft (paper mode)") {
  const strategy = await supabase.from("strategies").select("config").eq("id",data.strategyId).eq("user_id",userId).maybeSingle();
  if (strategy.error || !strategy.data || validateStrategy(strategy.data.config as unknown as StrategyConfig).length) throw new Error("Select your own validated strategy");
  if (data.connectionId) {
    const conn = await supabase.from("exchange_connections").select("exchange").eq("id",data.connectionId).eq("user_id",userId).maybeSingle();
    if (conn.error || !conn.data || conn.data.exchange !== data.exchange) throw new Error("Trading account does not belong to this bot owner or exchange");
  }
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const bot = await db.from("trading_bots").insert({ user_id:userId,name:data.name,strategy_id:data.strategyId,exchange_connection_id:data.connectionId,exchange:data.exchange,trading_pair:data.pair,timeframe:data.timeframe,allocated_capital:data.capital,mode:"paper",status:"draft" }).select("id").single();
  if (bot.error) throw new Error("Bot could not be created");
  const config = await db.from("bot_configurations").insert({user_id:userId,bot_id:bot.data.id,position_size_pct:data.size,max_exposure_pct:data.exposure,stop_loss_pct:data.sl,take_profit_pct:data.tp,max_open_positions:data.maxpos,daily_loss_limit_pct:data.dll});
  if (config.error) { await db.from("trading_bots").delete().eq("id",bot.data.id); throw new Error("Bot risk configuration could not be saved"); }
  await db.from("bot_logs").insert({user_id:userId,bot_id:bot.data.id,message:note});
  return { id:bot.data.id };
}

/** Starts a bot in paper mode after re-validating its strategy server-side. */
export async function startPaperBotFor(supabase: Client, userId: string, id: string, note = "Paper trading started — engine checks every minute") {
  const { data: bot } = await supabase.from("trading_bots").select("id,mode,strategies(config)").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!bot) throw new Error("Bot not found");
  if (bot.mode !== "paper") throw new Error("Live trading is not enabled yet");
  const cfg = (bot.strategies as { config: unknown } | null)?.config as StrategyConfig | undefined;
  if (!cfg || validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { error } = await db.from("trading_bots").update({ status: "paper_trading", status_reason: null }).eq("id", id).eq("user_id",userId);
  if (error) throw new Error(error.message);
  await supabase.from("bot_logs").insert({ bot_id: id, user_id: userId, message: note });
  return { ok: true };
}

/** Stops new entries for a bot; open positions keep being managed by the engine. */
export async function stopBotFor(supabase: Client, userId: string, id: string, status: "paused" | "stopped", reason = "User requested stop of new entries") {
  const own = await supabase.from("trading_bots").select("id").eq("id",id).eq("user_id",userId).maybeSingle();
  if (own.error || !own.data) throw new Error("Bot not found");
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const changed = await db.from("trading_bots").update({status,status_reason:reason}).eq("id",id).eq("user_id",userId);
  if (changed.error) throw new Error("Bot could not be stopped");
  await db.from("audit_logs").insert({user_id:userId,action:`bot.${status}`,entity_type:"trading_bot",entity_id:id});
  return { ok: true };
}
