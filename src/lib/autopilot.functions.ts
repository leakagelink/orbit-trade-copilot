import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { liveEnableProblems } from "./autopilot-guard";

/** Whether the AI Prime Tech connection is linked (never returns credentials). */
export const autopilotStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { aiPrimeReady } = await import("./ai-prime.server");
    return { claudeReady: aiPrimeReady() };
  });

const db = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

export const saveAutopilotSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ enabled: z.boolean(), interval: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(240)]), goal: z.string().max(1000) }))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { aiPrimeReady } = await import("./ai-prime.server");
    if (data.enabled && !aiPrimeReady()) throw new Error("Connect AI Prime Tech before switching on automatic runs");
    const admin = await db();
    const now = new Date().toISOString();
    const { error } = await admin.from("autopilot_settings").upsert({ user_id: context.userId, enabled: data.enabled, interval_minutes: data.interval, goal: data.goal.trim(), next_run_at: data.enabled ? now : null, updated_at: now });
    if (error) throw new Error(error.message);
    if (!data.enabled) await stopActive(admin, context.userId, "Automatic Autopilot was switched off");
    await admin.from("audit_logs").insert({ user_id: context.userId, action: data.enabled ? "autopilot.automatic_on" : "autopilot.automatic_off", entity_type: "autopilot", details: { interval: data.interval } });
    return { ok: true };
  });

export const enableLiveAutopilot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ binanceId: z.string().uuid().nullable(), derivId: z.string().uuid().nullable(), confirm: z.string().max(10) }))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const admin = await db();
    const ids = [data.binanceId, data.derivId].filter((x): x is string => !!x);
    const { data: conns } = ids.length ? await admin.from("exchange_connections").select("id,user_id,exchange,status").in("id", ids) : { data: [] };
    const ok = (id: string | null, ex: string) => !id || (conns ?? []).some((c) => c.id === id && c.user_id === context.userId && c.exchange === ex && c.status === "connected");
    if (!ok(data.binanceId, "binance")) throw new Error("Choose a verified Binance account you own");
    if (!ok(data.derivId, "deriv")) throw new Error("Choose a verified Deriv account you own");
    const { data: risk } = await admin.from("risk_settings").select("max_daily_loss,max_open_exposure,trading_halted").eq("user_id", context.userId).maybeSingle();
    const problems = liveEnableProblems({ confirm: data.confirm, risk: risk ? { ...risk, max_daily_loss: risk.max_daily_loss == null ? null : Number(risk.max_daily_loss), max_open_exposure: risk.max_open_exposure == null ? null : Number(risk.max_open_exposure) } : null, binanceId: data.binanceId, derivId: data.derivId });
    if (problems.length) throw new Error(problems.join(". "));
    const now = new Date().toISOString();
    const { error } = await admin.from("autopilot_settings").upsert({ user_id: context.userId, live_enabled: true, live_confirmed_at: now, binance_connection_id: data.binanceId, deriv_connection_id: data.derivId, updated_at: now });
    if (error) throw new Error(error.message);
    await admin.from("trading_safety_events").insert({ user_id: context.userId, action: "autopilot.live_enabled", details: { binance: data.binanceId, deriv: data.derivId } });
    return { ok: true };
  });

export const disableLiveAutopilot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await db();
    const { error } = await admin.from("autopilot_settings").upsert({ user_id: context.userId, live_enabled: false, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    await admin.from("trading_safety_events").insert({ user_id: context.userId, action: "autopilot.live_disabled", details: {} });
    return { ok: true };
  });

/** Starts an automatic run on the next scheduler tick (about a minute). */
export const runAutopilotNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await db();
    const { data } = await admin.from("autopilot_settings").select("enabled").eq("user_id", context.userId).maybeSingle();
    if (!data?.enabled) throw new Error("Switch on automatic runs first");
    await admin.from("autopilot_settings").update({ next_run_at: new Date().toISOString() }).eq("user_id", context.userId);
    return { ok: true };
  });

type Admin = Awaited<ReturnType<typeof db>>;
export async function stopActive(admin: Admin, userId: string, reason: string) {
  const { data: runs } = await admin.from("autopilot_runs").select("id").eq("user_id", userId).in("status", ["waiting_model", "executing"]);
  if (!runs?.length) return;
  // A model reply still in flight is ignored once the run is stopped; it can never trigger an action.
  await admin.from("autopilot_runs").update({ status: "stopped", error: reason, finished_at: new Date().toISOString(), lease_until: null }).in("id", runs.map((r) => r.id));
}
