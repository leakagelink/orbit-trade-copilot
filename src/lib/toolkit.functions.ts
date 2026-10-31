import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MARKETS } from "./markets";

const symbol = z.string().refine(s => MARKETS.some(m => m.symbol === s), "Unknown market");

export const addWatchlist = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ symbol }).parse(i)).handler(async ({ context, data }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const result = await context.supabase.from("watchlist_items").insert({ user_id: context.userId, symbol: data.symbol });
    if (result.error) throw new Error(result.error.code === "23505" ? "Already in your watchlist" : "Could not save market");
    return { ok: true };
  });

export const addPriceAlert = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ symbol, direction: z.enum(["above", "below"]), target: z.number().positive().max(1e12) }).parse(i)).handler(async ({ context, data }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const result = await context.supabase.from("price_alerts").insert({ ...data, user_id: context.userId });
    if (result.error) throw new Error("Could not save alert"); return { ok: true };
  });

export const saveJournal = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid().nullable(), trade_id: z.string().uuid().nullable(), symbol, thesis: z.string().trim().min(1).max(4000), lessons: z.string().max(4000), tags: z.string().max(200) }).parse(i)).handler(async ({ context, data }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const { id, ...entry } = data;
    const result = id ? await context.supabase.from("journal_entries").update(entry).eq("id", id).eq("user_id", context.userId).select("id").single() : await context.supabase.from("journal_entries").insert({ ...entry, user_id: context.userId }).select("id").single();
    if (result.error) throw new Error("Could not save journal entry; linked trades must belong to you"); return { id: result.data.id };
  });

export const exportTrades = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ from: z.string().datetime(), to: z.string().datetime() }).refine(d => d.from <= d.to, "Invalid date range").parse(i)).handler(async ({ context, data }) => {
    const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId);
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const r = await context.supabase.from("trades").select("id,trading_pair,side,mode,opened_at,closed_at,entry_price,exit_price,quantity,realized_pnl,fees,close_reason").eq("user_id",context.userId).gte("opened_at",data.from).lte("opened_at",data.to).order("opened_at",{ascending:false}).order("id").range(offset,offset+499);
      if(r.error) throw new Error("Trade export unavailable"); rows.push(...r.data); if(r.data.length<500) break;
      if(rows.length>=50000) throw new Error("Choose a shorter date range (under 50,000 trades)");
    }
    const { tradeCsv } = await import("./toolkit"); return { csv: tradeCsv(rows), count: rows.length };
  });

export const createTicket = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ subject: z.string().trim().min(1).max(160), message: z.string().trim().min(1).max(4000), category: z.enum(["trading","account","billing","other"]) }).parse(i)).handler(async ({ context, data }) => {
    const r = await context.supabase.from("support_tickets").insert({ ...data, user_id: context.userId }).select("id").single();
    if (r.error) throw new Error("Could not submit your request"); return { id: r.data.id };
  });

export const checkMyAlerts = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { requirePro } = await import("./plan.server"); await requirePro(context.supabase,context.userId);
  const { evaluateAlerts } = await import("./alerts.server"); return evaluateAlerts(context.userId);
});

export const replyTicket = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id:z.string().uuid(),response:z.string().trim().min(1).max(4000),status:z.enum(["open","in_progress","resolved"]) }).parse(i)).handler(async({context,data})=>{
    const [admin,superAdmin]=await Promise.all([context.supabase.rpc("has_role",{_user_id:context.userId,_role:"admin"}),context.supabase.rpc("has_role",{_user_id:context.userId,_role:"super_admin"})]);
    if(admin.error||superAdmin.error||(!admin.data&&!superAdmin.data))throw new Error("Only support operators can reply");
    const r=await context.supabase.from("support_tickets").update({response:data.response,status:data.status}).eq("id",data.id).select("id").single();
    if(r.error)throw new Error("Could not save reply");return {ok:true};
  });