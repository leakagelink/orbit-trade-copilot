// Scheduled trading engine (paper + live). Runs only from the cron endpoint / server functions, never from the browser.
import { computeAll, evalRules } from "./indicators";
import { fetchCandles, floorToStep, getStepSize, placeMarketOrder, timeframeMs, type Creds } from "./exchange-adapters.server";
import { validateStrategy, type StrategyConfig } from "./strategy";

const FEE = 0.001; // 0.1% simulated taker fee (paper)
const SLIP = 0.0005; // 0.05% simulated slippage (paper)

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function runEngineTick() {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { data: bots, error } = await db
    .from("trading_bots")
    .select("*, bot_configurations(*), strategies(config)")
    .in("status", ["paper_trading", "running"]);
  if (error) throw new Error(error.message);
  const results: { bot: string; result: string }[] = [];
  for (const bot of bots ?? []) {
    try {
      results.push({ bot: bot.id, result: await tickBot(db, bot) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logTo(db, bot, `Tick failed: ${msg}`, undefined, "error");
      await db.from("trading_bots").update({ last_heartbeat_at: new Date().toISOString(), status_reason: msg.slice(0, 300) }).eq("id", bot.id);
      results.push({ bot: bot.id, result: `error: ${msg}` });
    }
  }
  const { manageManualPositions } = await import("./manual.server");
  await manageManualPositions(db);
  if (new Date().getUTCMinutes() % 15 === 0) await snapshots(db, [...new Set((bots ?? []).map((b) => b.user_id))]);
  return results;
}

const logTo = (db: Admin, bot: Row, message: string, data?: object, level = "info") =>
  db.from("bot_logs").insert({ bot_id: bot.id, user_id: bot.user_id, level, message, data: (data ?? null) as never });

interface Venue { live: boolean; testnet: boolean; creds: Creds | null; connId: string | null }

/** Resolves where a bot trades. Live bots need a verified connection; returns an error string otherwise. */
async function venueFor(db: Admin, bot: Row): Promise<Venue | string> {
  if (bot.mode !== "live") return { live: false, testnet: false, creds: null, connId: bot.exchange_connection_id };
  if (!bot.exchange_connection_id) return "Live bot has no trading account";
  const { data: conn } = await db.from("exchange_connections").select("id,status,is_testnet,exchange").eq("id", bot.exchange_connection_id).maybeSingle();
  if (!conn || conn.status !== "connected") return "Trading account is not verified — click Verify on the Exchanges page";
  if (conn.exchange !== bot.exchange) return "Bot exchange does not match its trading account";
  const { data: sealed } = await db.from("connection_credentials").select("ciphertext,iv").eq("connection_id", conn.id).maybeSingle();
  if (!sealed) return "Trading account has no stored keys";
  const { decryptJson } = await import("./crypto.server");
  return { live: true, testnet: conn.is_testnet, creds: await decryptJson<Creds>(sealed.ciphertext, sealed.iv), connId: conn.id };
}

async function tickBot(db: Admin, bot: Row): Promise<string> {
  const log = (m: string, d?: object, l = "info") => logTo(db, bot, m, d, l);
  const halt = async (status: "paused" | "error", reason: string) => {
    await db.from("trading_bots").update({ status, status_reason: reason }).eq("id", bot.id);
    await log(`${status === "error" ? "Stopped" : "Paused"}: ${reason}`, undefined, status === "error" ? "error" : "warn");
    return reason;
  };
  const venue = await venueFor(db, bot);
  if (typeof venue === "string") return halt("paused", venue);
  const cfg = bot.strategies?.config as StrategyConfig | undefined;
  if (!cfg || validateStrategy(cfg).length) return halt("error", "Strategy is missing or invalid");

  const bc = Array.isArray(bot.bot_configurations) ? bot.bot_configurations[0] : bot.bot_configurations;
  const sizePct = Number(bc?.position_size_pct ?? cfg.risk.position_size_pct);
  const slPct = bc?.stop_loss_pct != null ? Number(bc.stop_loss_pct) : cfg.risk.stop_loss_pct;
  const tpPct = bc?.take_profit_pct != null ? Number(bc.take_profit_pct) : cfg.risk.take_profit_pct;
  const maxPos = Number(bc?.max_open_positions ?? 1);
  const dll = bc?.daily_loss_limit_pct != null ? Number(bc.daily_loss_limit_pct) : cfg.risk.daily_loss_limit_pct;
  const capital = Number(bot.allocated_capital);

  const all = await fetchCandles(bot.exchange, bot.trading_pair, bot.timeframe, venue.testnet);
  const now = Date.now();
  const closed = all.filter((c) => c.t + timeframeMs(bot.timeframe) <= now);
  if (closed.length < 60) return "not enough data";
  const live = all[all.length - 1]!.c;
  const i = closed.length - 1;
  const series = computeAll(cfg, closed);
  await db.from("trading_bots").update({ last_heartbeat_at: new Date().toISOString(), status_reason: null }).eq("id", bot.id);

  // Automatic position management: stop loss / take profit on live price, exit rules on the closed candle.
  const { data: open } = await db.from("positions").select("*").eq("bot_id", bot.id).eq("is_open", true);
  const exitSig = evalRules(cfg.exit, series, i);
  for (const p of open ?? []) {
    let reason: string | null = null;
    if (p.stop_loss != null && live <= Number(p.stop_loss)) reason = "stop_loss";
    else if (p.take_profit != null && live >= Number(p.take_profit)) reason = "take_profit";
    else if (exitSig) reason = "exit_signal";
    if (reason) await closePosition(db, bot, venue, p, live, reason);
    else await db.from("positions").update({ current_price: live, unrealized_pnl: (live - Number(p.entry_price)) * Number(p.quantity) }).eq("id", p.id);
  }

  if (dll != null) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const { data: today } = await db.from("trades").select("realized_pnl,fees").eq("bot_id", bot.id).gte("closed_at", start.toISOString());
    const pnl = (today ?? []).reduce((a, t) => a + Number(t.realized_pnl) - Number(t.fees), 0);
    if (pnl <= -(capital * dll) / 100) return halt("paused", `Daily loss limit reached (${pnl.toFixed(2)})`);
  }

  const { count } = await db.from("positions").select("id", { count: "exact", head: true }).eq("bot_id", bot.id).eq("is_open", true);
  if ((count ?? 0) >= maxPos || !evalRules(cfg.entry, series, i)) return "no entry";
  const cost = (capital * sizePct) / 100;
  const block = await accountRiskBlock(db, bot.user_id, cost);
  if (block) { await log(`Entry skipped: ${block}`, undefined, "warn"); return `risk: ${block}`; }

  // Claim the candle with a unique order row before touching the exchange: prevents duplicate orders.
  const key = `${bot.id}:entry:${closed[i]!.t}`;
  const { data: ord, error } = await db.from("orders").insert({
    user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, exchange_connection_id: venue.connId, trading_pair: bot.trading_pair,
    side: "buy", order_type: "market", quantity: cost / live, status: "pending", mode: venue.live ? "live" : "paper", idempotency_key: key,
  }).select("id").single();
  if (error) return "entry already taken this candle";

  let qty: number, fill: number, fee: number, exOrderId: string | null = null;
  if (venue.live) {
    try {
      const f = await placeMarketOrder(bot.exchange, venue.creds!, venue.testnet, bot.trading_pair, "buy", cost, ord.id);
      ({ qty, avgPrice: fill, feeQuote: fee } = f); exOrderId = f.orderId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("orders").update({ status: "rejected", reject_reason: msg.slice(0, 500) }).eq("id", ord.id);
      return halt("paused", `Buy order rejected: ${msg.slice(0, 200)}`);
    }
  } else {
    fill = live * (1 + SLIP); qty = cost / fill; fee = fill * qty * FEE;
  }
  await db.from("orders").update({ status: "filled", quantity: qty, filled_quantity: qty, avg_fill_price: fill, exchange_order_id: exOrderId }).eq("id", ord.id);
  await db.from("positions").insert({
    user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, exchange_connection_id: venue.connId, trading_pair: bot.trading_pair,
    side: "buy", quantity: qty, entry_price: fill, current_price: live, mode: venue.live ? "live" : "paper", unrealized_pnl: 0,
    stop_loss: slPct != null ? fill * (1 - slPct / 100) : null, take_profit: tpPct != null ? fill * (1 + tpPct / 100) : null,
  });
  await log(`${venue.live ? "LIVE " : ""}Bought ${qty.toPrecision(6)} ${bot.trading_pair} at ${fill.toFixed(4)}`, { order: ord.id, entry_fee: fee, exchange_order_id: exOrderId });
  return "entered";
}

/** Sells an open position (paper: simulated; live: market order) and records the trade. */
async function closePosition(db: Admin, bot: Row, venue: Venue, p: Row, price: number, reason: string) {
  const key = `${bot.id}:exit:${p.id}`;
  const entry = Number(p.entry_price);
  let qty = Number(p.quantity);
  const { data: ord, error } = await db.from("orders").insert({
    user_id: bot.user_id, bot_id: bot.id, exchange: bot.exchange, exchange_connection_id: venue.connId, trading_pair: bot.trading_pair,
    side: "sell", order_type: "market", quantity: qty, status: "pending", mode: venue.live ? "live" : "paper", idempotency_key: key,
  }).select("id").single();
  if (error) return; // already being closed
  let fill: number, exitFee: number, exOrderId: string | null = null;
  if (venue.live) {
    try {
      qty = floorToStep(qty, await getStepSize(bot.exchange, bot.trading_pair, venue.testnet));
      const f = await placeMarketOrder(bot.exchange, venue.creds!, venue.testnet, bot.trading_pair, "sell", qty, ord.id);
      fill = f.avgPrice; exitFee = f.feeQuote; qty = f.qty; exOrderId = f.orderId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Free the idempotency key so the next tick retries the exit.
      await db.from("orders").update({ status: "rejected", reject_reason: msg.slice(0, 500), idempotency_key: `${key}:failed:${Date.now()}` }).eq("id", ord.id);
      await logTo(db, bot, `Sell order rejected (will retry next minute): ${msg.slice(0, 200)}`, undefined, "error");
      return;
    }
  } else {
    fill = price * (1 - SLIP); exitFee = fill * qty * FEE;
  }
  const nowIso = new Date().toISOString();
  const entryFee = venue.live ? 0 : entry * qty * FEE;
  const pnl = (fill - entry) * qty; // gross; fees stored separately
  await db.from("orders").update({ status: "filled", quantity: qty, filled_quantity: qty, avg_fill_price: fill, exchange_order_id: exOrderId }).eq("id", ord.id);
  await db.from("positions").update({ is_open: false, closed_at: nowIso, current_price: fill, unrealized_pnl: 0 }).eq("id", p.id);
  await db.from("trades").insert({
    user_id: bot.user_id, bot_id: bot.id, strategy_id: bot.strategy_id, order_id: ord.id, exchange: bot.exchange, exchange_connection_id: venue.connId,
    trading_pair: bot.trading_pair, side: "buy", quantity: qty, entry_price: entry, exit_price: fill, fees: exitFee + entryFee,
    slippage: venue.live ? 0 : price * SLIP * qty, realized_pnl: pnl, mode: venue.live ? "live" : "paper", opened_at: p.opened_at, closed_at: nowIso, close_reason: reason,
  });
  await logTo(db, bot, `${venue.live ? "LIVE " : ""}Sold ${qty.toPrecision(6)} ${bot.trading_pair} at ${fill.toFixed(4)} (${reason.replace("_", " ")}), net PnL ${(pnl - exitFee - entryFee).toFixed(2)}`, { reason, pnl });
}

/** Emergency stop: halt the account, stop every bot and close every open position now. */
export async function emergencyCloseAll(userId: string) {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  await db.from("risk_settings").upsert({ user_id: userId, trading_halted: true, updated_at: new Date().toISOString() });
  await db.from("trading_bots").update({ status: "stopped", status_reason: "Emergency stop" }).eq("user_id", userId).in("status", ["paper_trading", "running", "paused", "error"]);
  const { data: open } = await db.from("positions").select("*, trading_bots(*)").eq("user_id", userId).eq("is_open", true);
  let closed = 0; const failed: string[] = [];
  for (const p of open ?? []) {
    const bot = p.trading_bots;
    if (!bot) {
      try { const { closeManual } = await import("./manual.server"); await closeManual(db, p, "emergency_stop"); closed++; }
      catch (e) { failed.push(`${p.trading_pair}: ${e instanceof Error ? e.message : e}`); }
      continue;
    }
    try {
      const venue = await venueFor(db, bot);
      if (typeof venue === "string") throw new Error(venue);
      const cs = await fetchCandles(bot.exchange, bot.trading_pair, "1m", venue.testnet, 2);
      await closePosition(db, bot, venue, p, cs[cs.length - 1]!.c, "emergency_stop");
      const { data: still } = await db.from("positions").select("is_open").eq("id", p.id).single();
      if (still?.is_open) failed.push(bot.trading_pair); else closed++;
    } catch (e) {
      failed.push(`${bot.trading_pair}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { closed, failed };
}

/** Account-wide limits from risk_settings. Returns a reason when a new entry must be blocked. */
export async function accountRiskBlock(db: Admin, userId: string, newCost: number): Promise<string | null> {
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

async function snapshots(db: Admin, users: string[]) {
  for (const u of users) {
    for (const mode of ["paper", "live"] as const) {
      const [b, t, p] = await Promise.all([
        db.from("trading_bots").select("allocated_capital").eq("user_id", u).eq("mode", mode).neq("status", "draft"),
        db.from("trades").select("realized_pnl,fees").eq("user_id", u).eq("mode", mode),
        db.from("positions").select("unrealized_pnl,entry_price,quantity").eq("user_id", u).eq("mode", mode).eq("is_open", true),
      ]);
      if (!b.data?.length) continue;
      const cap = b.data.reduce((a, x) => a + Number(x.allocated_capital), 0);
      const real = (t.data ?? []).reduce((a, x) => a + Number(x.realized_pnl) - Number(x.fees), 0);
      const unreal = (p.data ?? []).reduce((a, x) => a + Number(x.unrealized_pnl), 0);
      const inUse = (p.data ?? []).reduce((a, x) => a + Number(x.entry_price) * Number(x.quantity), 0);
      await db.from("portfolio_snapshots").insert({ user_id: u, mode, total_value: cap + real + unreal, available_capital: cap + real - inUse, unrealized_pnl: unreal });
    }
  }
}
