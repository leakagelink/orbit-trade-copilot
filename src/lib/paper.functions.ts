// Owner-authenticated forward paper trading functions. Reads go through the caller's own client (row security);
// writes to the service-only paper tables happen only after the owner is verified. Nothing here can place an
// exchange order, touch the demo wallet, real positions, credentials, bots, Autopilot or Live Futures.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { paperAccountLimitsSchema, paperCostSchema, paperRiskPolicySchema } from "./paper-risk";

const NOT_ENABLED = "The paper trading ledger is not enabled yet: draft database change 0044 awaits owner approval. Nothing is running.";
const missing = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/.test(e.message ?? ""));
// The paper tables are not in the generated types until 0044 is applied.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = (c: unknown) => c as any;

export const getPaperDashboard = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const db = untyped(context.supabase);
  const own = await context.supabase.from("strategies").select("id,name,config").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100);
  const strategies = (own.data ?? []).map((s) => ({ id: s.id, name: s.name, pairs: ((s.config as { pairs?: string[] } | null)?.pairs ?? []), timeframe: (s.config as { timeframe?: string } | null)?.timeframe ?? "" }));
  const acc = await db.from("paper_accounts").select("*").eq("user_id", context.userId).maybeSingle();
  if (missing(acc.error)) return { enabled: false as const, notice: NOT_ENABLED, strategies };
  if (acc.error) throw new Error("Paper account could not be loaded");
  const [ps, bars, events, trades] = await Promise.all([
    db.from("paper_strategies").select("id,strategy_id,strategy_name,pair,timeframe,tf_ms,market,costs,risk,starting_capital,started_at,status,status_reason,cursor_t,state,cash,equity,open_exposure,open_positions,day_utc,day_net,last_checked_at,data_status,config_sha256,engine_version,data_source").eq("user_id", context.userId).order("created_at", { ascending: false }),
    db.from("paper_bars").select("paper_strategy_id,bar_t,candle,signal,decision,cash,equity,position_qty,unrealized,data_fetched_at,processed_at").eq("user_id", context.userId).order("bar_t", { ascending: false }).limit(5000),
    db.from("paper_order_events").select("paper_strategy_id,bar_t,seq,order_key,event,intent,kind,side,qty,price,fee,spread_cost,slippage_cost,cash_delta,reason,simulated").eq("user_id", context.userId).order("bar_t", { ascending: false }).order("seq", { ascending: false }).limit(1000),
    db.from("paper_trades").select("paper_strategy_id,position_key,opened_bar_t,closed_bar_t,qty,avg_entry,avg_exit,gross_pnl,fees,spread_cost,slippage_cost,net_pnl,close_reason,simulated").eq("user_id", context.userId).order("closed_bar_t", { ascending: false }).limit(5000),
  ]);
  if (ps.error || bars.error || events.error || trades.error) throw new Error("Paper trading history could not be loaded");
  return { enabled: true as const, account: acc.data, strategies, paper: ps.data, bars: bars.data, events: events.data, trades: trades.data, serverNow: Date.now() };
});

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return untyped(supabaseAdmin);
}
async function ownPaperStrategy(supabase: unknown, userId: string, id: string) {
  const r = await untyped(supabase).from("paper_strategies").select("id,status,open_positions").eq("id", id).eq("user_id", userId).maybeSingle();
  if (missing(r.error)) throw new Error(NOT_ENABLED);
  if (r.error || !r.data) throw new Error("Paper strategy not found");
  return r.data as { id: string; status: string; open_positions: number };
}

export const startPaperStrategy = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    strategyId: z.string().uuid(), pair: z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/),
    startingCapital: z.number().positive().max(1_000_000), costs: paperCostSchema, policy: paperRiskPolicySchema,
  }).strict().parse(input))
  .handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const s = await context.supabase.from("strategies").select("id,name,config").eq("id", data.strategyId).eq("user_id", context.userId).maybeSingle();
    if (s.error || !s.data) throw new Error("Strategy not found");
    const { validateStrategy } = await import("./strategy");
    const cfg = s.data.config as unknown as import("./strategy").StrategyConfig;
    const issues = validateStrategy(cfg);
    if (issues.length) throw new Error(`Strategy is not valid: ${issues[0]!.message}`);
    if (!cfg.pairs.includes(data.pair)) throw new Error("That pair is not part of this strategy");
    if (data.policy.strategyBudget > data.startingCapital) throw new Error("The strategy budget cannot exceed its starting paper capital");
    const { PAPER_ENGINE_VERSION, initialPaperState } = await import("./paper-engine");
    const { PAPER_DATA_SOURCE } = await import("./paper-market-data.server");
    const db = await admin();
    const probe = await db.from("paper_accounts").select("user_id").eq("user_id", context.userId).maybeSingle();
    if (missing(probe.error)) throw new Error(NOT_ENABLED);
    if (!probe.data) { const a = await db.from("paper_accounts").insert({ user_id: context.userId }); if (a.error) throw new Error("Paper account could not be created"); }
    const ins = await db.from("paper_strategies").insert({
      user_id: context.userId, strategy_id: s.data.id, strategy_name: s.data.name, config: cfg, engine_version: PAPER_ENGINE_VERSION, data_source: PAPER_DATA_SOURCE,
      pair: data.pair, timeframe: cfg.timeframe, market: "spot", costs: data.costs, risk: data.policy, starting_capital: data.startingCapital, state: initialPaperState(data.startingCapital),
    }).select("id,started_at,cursor_t").single();
    if (ins.error) throw new Error(/duplicate key/.test(ins.error.message) ? "This strategy is already paper trading on that pair" : "Paper strategy could not be started");
    return ins.data as { id: string; started_at: string; cursor_t: number };
  });

export const setPaperStrategyStatus = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), status: z.enum(["active", "paused", "stopped"]) }).strict().parse(input))
  .handler(async ({ data, context }) => {
    const own = await ownPaperStrategy(context.supabase, context.userId, data.id);
    if (data.status === "active") { const { requirePro } = await import("./plan.server"); await requirePro(context.supabase, context.userId); }
    if (data.status === "stopped" && own.open_positions > 0) throw new Error("Pause the strategy and wait for its paper position to close, or use the emergency paper stop, before stopping it");
    const r = await (await admin()).from("paper_strategies").update({ status: data.status, status_reason: data.status === "active" ? null : `Set to ${data.status} by owner` }).eq("id", own.id).eq("user_id", context.userId);
    if (r.error) throw new Error(r.error.message.includes("stopped") ? "A stopped paper strategy cannot restart" : "Status could not be changed");
    return { ok: true };
  });

export const setPaperEmergencyStop = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ on: z.boolean(), confirm: z.string().max(40).optional() }).strict().parse(input))
  .handler(async ({ data, context }) => {
    if (!data.on && data.confirm !== "RESUME PAPER") throw new Error('Type RESUME PAPER to lift the emergency paper stop');
    const db = await admin();
    const probe = await db.from("paper_accounts").select("user_id").eq("user_id", context.userId).maybeSingle();
    if (missing(probe.error)) throw new Error(NOT_ENABLED);
    const row = { user_id: context.userId, halted: data.on, halt_reason: data.on ? "Emergency paper stop by owner" : null };
    const r = probe.data ? await db.from("paper_accounts").update(row).eq("user_id", context.userId) : await db.from("paper_accounts").insert(row);
    if (r.error) throw new Error("Emergency paper stop could not be saved");
    return { ok: true, halted: data.on };
  });

export const savePaperLimits = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => paperAccountLimitsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const probe = await db.from("paper_accounts").select("user_id").eq("user_id", context.userId).maybeSingle();
    if (missing(probe.error)) throw new Error(NOT_ENABLED);
    const row = { user_id: context.userId, max_exposure: data.maxExposure, max_daily_loss: data.maxDailyLoss, max_open_positions: data.maxOpenPositions, max_position_notional: data.maxPositionNotional };
    const r = probe.data ? await db.from("paper_accounts").update(row).eq("user_id", context.userId) : await db.from("paper_accounts").insert(row);
    if (r.error) throw new Error("Paper limits could not be saved");
    return { ok: true };
  });
