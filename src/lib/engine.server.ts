// Scheduled paper-trading engine. Runs only from the cron endpoint, never from the browser.
import { computeAll, evalRules } from "./indicators";
import { fetchCandles, timeframeMs } from "./exchange-adapters.server";
import { validateStrategy, type StrategyConfig } from "./strategy";

const FEE = 0.001; // 0.1% simulated taker fee
const SLIP = 0.0005; // 0.05% simulated slippage

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export async function runEngineTick() {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { data: bots, error } = await db
    .from("trading_bots")
    .select("*, bot_configurations(*), strategies(config)")
    .eq("status", "paper_trading");
  if (error) throw new Error(error.message);
  const results: { bot: string; result: string }[] = [];
  for (const bot of bots ?? []) {
    try {
      results.push({ bot: bot.id, result: await tickBot(db, bot) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("bot_logs").insert({ bot_id: bot.id, user_id: bot.user_id, level: "error", message: `Tick failed: ${msg}` });
      await db.from("trading_bots").update({ last_heartbeat_at: new Date().toISOString(), status_reason: msg.slice(0, 300) }).eq("id", bot.id);
      results.push({ bot: bot.id, result: `error: ${msg}` });
    }
  }
  if (new Date().getUTCMinutes() % 15 === 0) await snapshots(db, [...new Set((bots ?? []).map((b) => b.user_id))]);
  return results;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tickBot(db: Admin, bot: any): Promise<string> {
  const log = (message: string, data?: object, level = "info") =>
    db.from("bot_logs").insert({ bot_id: bot.id, user_id: bot.user_id, level, message, data: (data ?? null) as never });
  if (bot.mode !== "paper") {
    await db.from("trading_bots").update({ status: "paused", status_reason: "Live trading is not enabled yet" }).eq("id", bot.id);
    await log("Paused: live trading is not enabled yet", undefined, "warn");
    return "paused (live)";
  }
  const cfg = bot.strategies?.config as StrategyConfig | undefined;
  if (!cfg || validateStrategy(cfg).length) {
    await db.from("trading_bots").update({ status: "error", status_reason: "Strategy is missing or invalid" }).eq("id", bot.id);
    await log("Stopped: strategy is missing or invalid", undefined, "error");
    return "invalid strategy";
  }
  const bc = Array.isArray(bot.bot_configurations) ? bot.bot_configurations[0] : bot.bot_configurations;
  const sizePct = Number(bc?.position_size_pct ?? cfg.risk.position_size_pct);
  const slPct = bc?.stop_loss_pct != null ? Number(bc.stop_loss_pct) : cfg.risk.stop_loss_pct;
  const tpPct = bc?.take_profit_pct != null ? Number(bc.take_profit_pct) : cfg.risk.take_profit_pct;
  const maxPos = Number(bc?.max_open_positions ?? 1);
  const dll = bc?.daily_loss_limit_pct != null ? Number(bc.daily_loss_limit_pct) : cfg.risk.daily_loss_limit_pct;
  const capital = Number(bot.allocated_capital);

  const all = await fetchCandles(bot.exchange, bot.trading_pair, bot.timeframe, false);
  const now = Date.now();
  const closed = all.filter((c) => c.t + timeframeMs(bot.timeframe) <= now);
  if (closed.length < 60) return "not enough data";
  const live = all[all.length - 1]!.c;
  const i = closed.length - 1;
  const candleT = closed[i]!.t;
  const series = computeAll(cfg, closed);
  const nowIso = new Date().toISOString();
  await db.from("trading_bots").update({ last_heartbeat_at: nowIso, status_reason: null }).eq("id", bot.id);

  const { data: open } = await db.from("positions").select("*").eq("bot_id", bot.id).eq("is_open", true);

  // Exits: stop loss / take profit on live price, exit rules on closed candle.
  for (const p of open ?? []) {
    const entry = Number(p.entry_price);
    let reason: string | null = null;
    if (p.stop_loss != null && live <= Number(p.stop_loss)) reason = "stop_loss";
    else if (p.take_profit != null && live >= Number(p.take_profit)) reason = "take_profit";
    else if (evalRules(cfg.exit, series, i)) reason = "exit_signal";
    const qty = Number(p.quantity);
    if (!reason) {
      await db.from("positions").update({ current_price: live, unrealized_pnl: (live - entry) * qty }).eq("id", p.id);
      continue;
    }
    const key = `${bot.id}:exit:${p.id}`;
    const fill = live * (1 - SLIP);
    const fees = fill * qty * FEE + entry * qty * FEE;
    const pnl = (fill - entry) * qty; // gross; fees stored separately
    const { data: ord, error } = await db.from("orders").insert({
      user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, trading_pair: bot.trading_pair, side: "sell",
      order_type: "market", quantity: qty, filled_quantity: qty, avg_fill_price: fill, status: "filled", mode: "paper", idempotency_key: key,
    }).select("id").single();
    if (error) continue; // already processed
    await db.from("positions").update({ is_open: false, closed_at: nowIso, current_price: fill, unrealized_pnl: 0 }).eq("id", p.id);
    await db.from("trades").insert({
      user_id: bot.user_id, bot_id: bot.id, strategy_id: bot.strategy_id, order_id: ord.id, exchange: bot.exchange, trading_pair: bot.trading_pair,
      side: "buy", quantity: qty, entry_price: entry, exit_price: fill, fees, slippage: live * SLIP * qty, realized_pnl: pnl,
      mode: "paper", opened_at: p.opened_at, closed_at: nowIso, close_reason: reason,
    });
    await log(`Closed ${bot.trading_pair} at ${fill.toFixed(4)} (${reason}), net PnL ${(pnl - fees).toFixed(2)}`, { reason, pnl });
  }

  // Daily loss limit guard.
  if (dll != null) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const { data: today } = await db.from("trades").select("realized_pnl,fees").eq("bot_id", bot.id).gte("closed_at", start.toISOString());
    const pnl = (today ?? []).reduce((a, t) => a + Number(t.realized_pnl) - Number(t.fees), 0);
    if (pnl <= -(capital * dll) / 100) {
      await db.from("trading_bots").update({ status: "paused", status_reason: "Daily loss limit reached" }).eq("id", bot.id);
      await log(`Paused: daily loss limit reached (${pnl.toFixed(2)})`, undefined, "warn");
      return "daily loss limit";
    }
  }

  const { count } = await db.from("positions").select("id", { count: "exact", head: true }).eq("bot_id", bot.id).eq("is_open", true);
  if ((count ?? 0) >= maxPos || !evalRules(cfg.entry, series, i)) return "no entry";
  const block = await accountRiskBlock(db, bot.user_id, (capital * sizePct) / 100);
  if (block) { await log(`Entry skipped: ${block}`, undefined, "warn"); return `risk: ${block}`; }

  const key = `${bot.id}:entry:${candleT}`;
  const fill = live * (1 + SLIP);
  const qty = (capital * sizePct) / 100 / fill;
  const { error } = await db.from("orders").insert({
    user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, trading_pair: bot.trading_pair, side: "buy",
    order_type: "market", quantity: qty, filled_quantity: qty, avg_fill_price: fill, status: "filled", mode: "paper", idempotency_key: key,
  });
  if (error) return "entry already taken this candle";
  await db.from("positions").insert({
    user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, trading_pair: bot.trading_pair, side: "buy", quantity: qty,
    entry_price: fill, current_price: live, mode: "paper", unrealized_pnl: 0,
    stop_loss: slPct != null ? fill * (1 - slPct / 100) : null, take_profit: tpPct != null ? fill * (1 + tpPct / 100) : null,
  });
  await log(`Opened ${bot.trading_pair} at ${fill.toFixed(4)}, qty ${qty.toPrecision(6)}`, { candle: candleT });
  return "entered";
}

async function snapshots(db: Admin, users: string[]) {
  for (const u of users) {
    const [b, t, p] = await Promise.all([
      db.from("trading_bots").select("allocated_capital").eq("user_id", u).eq("mode", "paper").neq("status", "draft"),
      db.from("trades").select("realized_pnl").eq("user_id", u).eq("mode", "paper"),
      db.from("positions").select("unrealized_pnl,entry_price,quantity").eq("user_id", u).eq("mode", "paper").eq("is_open", true),
    ]);
    const cap = (b.data ?? []).reduce((a, x) => a + Number(x.allocated_capital), 0);
    const real = (t.data ?? []).reduce((a, x) => a + Number(x.realized_pnl), 0);
    const unreal = (p.data ?? []).reduce((a, x) => a + Number(x.unrealized_pnl), 0);
    const inUse = (p.data ?? []).reduce((a, x) => a + Number(x.entry_price) * Number(x.quantity), 0);
    await db.from("portfolio_snapshots").insert({ user_id: u, mode: "paper", total_value: cap + real + unreal, available_capital: cap + real - inUse, unrealized_pnl: unreal });
  }
}

/** Account-wide limits from risk_settings. Returns a reason when a new entry must be blocked. */
async function accountRiskBlock(db: Admin, userId: string, newCost: number): Promise<string | null> {
  const { data: r } = await db.from("risk_settings").select("*").eq("user_id", userId).maybeSingle();
  if (!r) return null;
  if (r.trading_halted) return "trading halted (emergency stop)";
  const { data: pos } = await db.from("positions").select("entry_price,quantity").eq("user_id", userId).eq("is_open", true);
  if (r.max_total_positions != null && (pos?.length ?? 0) >= r.max_total_positions) return "account max open positions reached";
  const exposure = (pos ?? []).reduce((a, p) => a + Number(p.entry_price) * Number(p.quantity), 0);
  if (r.max_open_exposure != null && exposure + newCost > Number(r.max_open_exposure)) return "account max exposure reached";
  if (r.max_daily_loss != null) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const { data: t } = await db.from("trades").select("realized_pnl,fees").eq("user_id", userId).gte("closed_at", start.toISOString());
    const pnl = (t ?? []).reduce((a, x) => a + Number(x.realized_pnl) - Number(x.fees), 0);
    if (pnl <= -Number(r.max_daily_loss)) return "account daily loss limit reached";
  }
  return null;
}
