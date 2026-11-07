import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateStrategy, TIMEFRAMES, type StrategyConfig } from "./strategy";

export const createPaperBot = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    name: z.string().trim().min(1).max(60), strategyId: z.string().uuid(), connectionId: z.string().uuid().nullable(),
    exchange: z.enum(["binance","bybit","okx","kucoin","coinbase"]), pair: z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/),
    timeframe: z.enum(TIMEFRAMES), capital: z.number().positive().max(1e9),
    size: z.number().positive().max(100), exposure: z.number().positive().max(100),
    sl: z.number().positive().max(99), tp: z.number().positive().nullable(), maxpos: z.number().int().positive().max(100), dll: z.number().positive().max(100).nullable(),
  }).parse(input)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const strategy = await context.supabase.from("strategies").select("config").eq("id",data.strategyId).eq("user_id",context.userId).maybeSingle();
    if (strategy.error || !strategy.data || validateStrategy(strategy.data.config as unknown as StrategyConfig).length) throw new Error("Select your own validated strategy");
    if (data.connectionId) {
      const conn = await context.supabase.from("exchange_connections").select("exchange").eq("id",data.connectionId).eq("user_id",context.userId).maybeSingle();
      if (conn.error || !conn.data || conn.data.exchange !== data.exchange) throw new Error("Trading account does not belong to this bot owner or exchange");
    }
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const bot = await db.from("trading_bots").insert({ user_id:context.userId,name:data.name,strategy_id:data.strategyId,exchange_connection_id:data.connectionId,exchange:data.exchange,trading_pair:data.pair,timeframe:data.timeframe,allocated_capital:data.capital,mode:"paper",status:"draft" }).select("id").single();
    if (bot.error) throw new Error("Bot could not be created");
    const config = await db.from("bot_configurations").insert({user_id:context.userId,bot_id:bot.data.id,position_size_pct:data.size,max_exposure_pct:data.exposure,stop_loss_pct:data.sl,take_profit_pct:data.tp,max_open_positions:data.maxpos,daily_loss_limit_pct:data.dll});
    if (config.error) { await db.from("trading_bots").delete().eq("id",bot.data.id); throw new Error("Bot risk configuration could not be saved"); }
    await db.from("bot_logs").insert({user_id:context.userId,bot_id:bot.data.id,message:"Bot created in draft (paper mode)"});
    return { id:bot.data.id };
  });

export const manageBot = createServerFn({ method:"POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input:unknown)=>z.object({id:z.string().uuid(),action:z.enum(["paused","stopped","delete"])}).parse(input))
  .handler(async({data,context})=>{
    const own=await context.supabase.from("trading_bots").select("id").eq("id",data.id).eq("user_id",context.userId).maybeSingle();
    if(own.error||!own.data)throw new Error("Bot not found");
    const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
    if(data.action==="delete"){
      const positions=await db.from("positions").select("id",{count:"exact",head:true}).eq("bot_id",data.id).eq("is_open",true);
      const orders=await db.from("orders").select("id",{count:"exact",head:true}).eq("bot_id",data.id).in("status",["pending","open","partially_filled"]);
      if(positions.error||orders.error||positions.count||orders.count)throw new Error("Close positions and reconcile pending orders before deleting this bot");
      const removed=await db.from("trading_bots").delete().eq("id",data.id).eq("user_id",context.userId);
      if(removed.error)throw new Error("Bot could not be deleted");
    }else{
      const changed=await db.from("trading_bots").update({status:data.action,status_reason:"User requested stop of new entries"}).eq("id",data.id).eq("user_id",context.userId);
      if(changed.error)throw new Error("Bot could not be stopped");
    }
    await db.from("audit_logs").insert({user_id:context.userId,action:`bot.${data.action}`,entity_type:"trading_bot",entity_id:data.id});
    return {ok:true};
  });

// Starts a bot in paper mode after re-validating its strategy server-side.
export const startPaperBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { data: bot } = await context.supabase.from("trading_bots").select("id,mode,strategies(config)").eq("id", data.id).maybeSingle();
    if (!bot) throw new Error("Bot not found");
    if (bot.mode !== "paper") throw new Error("Live trading is not enabled yet");
    const cfg = (bot.strategies as { config: unknown } | null)?.config as StrategyConfig | undefined;
    if (!cfg || validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { error } = await db.from("trading_bots").update({ status: "paper_trading", status_reason: null }).eq("id", data.id).eq("user_id",context.userId);
    if (error) throw new Error(error.message);
    await context.supabase.from("bot_logs").insert({ bot_id: data.id, user_id: context.userId, message: "Paper trading started — engine checks every minute" });
    return { ok: true };
  });

// Switches a bot to LIVE (real orders). Requires typed confirmation and a verified trading account.
export const enableLiveTrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), confirm: z.literal("LIVE") }).parse(input))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { data: bot } = await context.supabase.from("trading_bots").select("id,exchange,exchange_connection_id,strategies(config)").eq("id", data.id).maybeSingle();
    if (!bot) throw new Error("Bot not found");
    if (!["binance", "bybit", "okx", "kucoin"].includes(bot.exchange)) throw new Error("Live trading is not supported on this exchange yet");
    if (!bot.exchange_connection_id) throw new Error("Attach a trading account to this bot first");
    const { data: conn } = await context.supabase.from("exchange_connections").select("status,exchange,is_testnet").eq("id", bot.exchange_connection_id).eq("user_id",context.userId).maybeSingle();
    if (!conn || conn.status !== "connected" || conn.exchange !== bot.exchange) throw new Error("Verify a matching owned trading account on the Exchanges page first");
    const cfg = (bot.strategies as { config: unknown } | null)?.config as StrategyConfig | undefined;
    if (!cfg || validateStrategy(cfg).length) throw new Error("Fix the strategy's validation issues first");
    const { data: risk, error: riskError } = await context.supabase.from("risk_settings").select("trading_halted").eq("user_id", context.userId).maybeSingle();
    if (riskError || !risk) throw new Error("Save account risk settings before enabling live trading");
    if (risk.trading_halted) throw new Error("Trading is halted — resume it on the Risk page first");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { error } = await db.from("trading_bots").update({ mode: "live", status: "running", status_reason: null }).eq("id", data.id).eq("user_id",context.userId);
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
    const own = await context.supabase.from("trading_bots").select("id").eq("id",data.id).eq("user_id",context.userId).maybeSingle();
    if (own.error || !own.data) throw new Error("Bot not found");
    const { count, error: positionError } = await context.supabase.from("positions").select("id", { count: "exact", head: true }).eq("bot_id", data.id).eq("is_open", true).eq("mode", "live");
    if (positionError) throw new Error("Open positions could not be checked");
    if (count) throw new Error("This bot still has open live positions — close them first (Risk → Close everything)");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const unresolved = await db.from("orders").select("id",{count:"exact",head:true}).eq("bot_id",data.id).in("status",["pending","open","partially_filled"]);
    if (unresolved.error || unresolved.count) throw new Error("Reconcile pending orders before changing trading mode");
    const { error } = await db.from("trading_bots").update({ mode: "paper", status: "stopped" }).eq("id", data.id).eq("user_id",context.userId);
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
