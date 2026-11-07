import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { TIMEFRAMES } from "./strategy";

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
    const { createPaperBotFor } = await import("./bots.server");
    return createPaperBotFor(context.supabase, context.userId, data);
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
      await db.from("audit_logs").insert({user_id:context.userId,action:"bot.delete",entity_type:"trading_bot",entity_id:data.id});
      return {ok:true};
    }
    const { stopBotFor } = await import("./bots.server");
    return stopBotFor(context.supabase, context.userId, data.id, data.action);
  });

// Starts a bot in paper mode after re-validating its strategy server-side.
export const startPaperBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { startPaperBotFor } = await import("./bots.server");
    return startPaperBotFor(context.supabase, context.userId, data.id);
  });

// Switches a bot to LIVE (real orders). Requires typed confirmation and a verified trading account.
export const enableLiveTrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), confirm: z.literal("LIVE") }).parse(input))
  .handler(async ({ data, context }): Promise<{ok:true;testnet:boolean}> => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { data: bot } = await context.supabase.from("trading_bots").select("id,exchange,exchange_connection_id,strategies(config)").eq("id", data.id).maybeSingle();
    if (!bot) throw new Error("Bot not found");
    // Promotion is fail-closed until the independently evaluated policy is configured.
    throw new Error("New live activation is paused until independent holdout, paper-trading and risk-review promotion requirements are configured. Existing position recovery remains available.");
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
    const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
    const audit=await db.from("trading_safety_events").insert({user_id:context.userId,action:"risk.emergency_stop",details:r});
    return {...r,auditRecorded:!audit.error};
  });
