// Manual (user-placed) trades: open/close for paper crypto, live crypto spot and OANDA forex/commodities.
import { fetchCandles, floorToStep, getStepSize, oandaCloseTrade, oandaMarketOrder, oandaTrade, placeMarketOrder, type Creds } from "./exchange-adapters.server";
import { accountRiskBlock } from "./engine.server";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
const FEE = 0.001, SLIP = 0.0005;

export interface Account { connId: string | null; exchange: string; testnet: boolean; creds: Creds | null }

/** Loads a verified connection owned by userId (or a paper account when connId is null). */
export async function loadAccount(db: Admin, userId: string, connId: string | null, paperExchange = "binance"): Promise<Account> {
  if (!connId) return { connId: null, exchange: paperExchange, testnet: false, creds: null };
  const { data: conn } = await db.from("exchange_connections").select("id,user_id,exchange,status,is_testnet").eq("id", connId).maybeSingle();
  if (!conn || conn.user_id !== userId) throw new Error("Trading account not found");
  if (conn.status !== "connected") throw new Error("Verify this trading account on the Exchanges page first");
  const { data: sealed } = await db.from("connection_credentials").select("ciphertext,iv").eq("connection_id", conn.id).maybeSingle();
  if (!sealed) throw new Error("Trading account has no stored keys");
  const { decryptJson } = await import("./crypto.server");
  return { connId: conn.id, exchange: conn.exchange, testnet: conn.is_testnet, creds: await decryptJson<Creds>(sealed.ciphertext, sealed.iv) };
}

export async function lastPrice(a: Account, symbol: string) {
  if (a.exchange === "oanda") {
    const { oandaCandles } = await import("./exchange-adapters.server");
    const cs = await oandaCandles(a.creds!, a.testnet, symbol, "1m", 2);
    return cs[cs.length - 1]!.c;
  }
  const cs = await fetchCandles(a.exchange, symbol, "1m", a.testnet, 2);
  return cs[cs.length - 1]!.c;
}

export interface OpenInput { symbol: string; side: "buy" | "sell"; amount: number; sl: number | null; tp: number | null }

export async function openManual(db: Admin, userId: string, a: Account, inp: OpenInput) {
  const isOanda = a.exchange === "oanda";
  const live = !!a.connId;
  if (live && !isOanda && inp.side === "sell") throw new Error("Spot crypto accounts can only open buy positions. Use paper mode or OANDA to go short.");
  const price = await lastPrice(a, inp.symbol);
  if (inp.sl != null && (inp.side === "buy" ? inp.sl >= price : inp.sl <= price)) throw new Error(`Stop loss must be ${inp.side === "buy" ? "below" : "above"} the current price (${price})`);
  if (inp.tp != null && (inp.side === "buy" ? inp.tp <= price : inp.tp >= price)) throw new Error(`Take profit must be ${inp.side === "buy" ? "above" : "below"} the current price (${price})`);
  const notional = isOanda ? inp.amount * price : inp.amount;
  const block = await accountRiskBlock(db, userId, notional);
  if (block) throw new Error(`Blocked by risk settings: ${block}`);

  const { data: ord, error } = await db.from("orders").insert({
    user_id: userId, exchange: a.exchange, exchange_connection_id: a.connId, trading_pair: inp.symbol, side: inp.side, order_type: "market",
    quantity: isOanda ? inp.amount : inp.amount / price, status: "pending", mode: live ? "live" : "paper", idempotency_key: `manual:${crypto.randomUUID()}`,
  }).select("id").single();
  if (error) throw new Error(error.message);

  let qty: number, fill: number, fee = 0, extId: string | null = null, extRef: string | null = null;
  try {
    if (isOanda) {
      const r = await oandaMarketOrder(a.creds!, a.testnet, inp.symbol, inp.side === "buy" ? inp.amount : -inp.amount, inp.sl, inp.tp);
      qty = r.units; fill = r.price; fee = r.fee; extId = r.orderId; extRef = r.tradeId;
    } else if (live) {
      const r = await placeMarketOrder(a.exchange, a.creds!, a.testnet, inp.symbol, "buy", inp.amount, ord.id);
      qty = r.qty; fill = r.avgPrice; fee = r.feeQuote; extId = r.orderId;
    } else {
      fill = price * (inp.side === "buy" ? 1 + SLIP : 1 - SLIP); qty = inp.amount / fill; fee = inp.amount * FEE;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("orders").update({ status: "rejected", reject_reason: msg.slice(0, 500) }).eq("id", ord.id);
    throw new Error(msg);
  }
  await db.from("orders").update({ status: "filled", quantity: qty, filled_quantity: qty, avg_fill_price: fill, exchange_order_id: extId }).eq("id", ord.id);
  const { data: pos } = await db.from("positions").insert({
    user_id: userId, exchange: a.exchange, exchange_connection_id: a.connId, trading_pair: inp.symbol, side: inp.side, quantity: qty,
    entry_price: fill, current_price: price, mode: live ? "live" : "paper", unrealized_pnl: -fee, stop_loss: inp.sl, take_profit: inp.tp, external_ref: extRef,
  }).select("id").single();
  await db.from("audit_logs").insert({ user_id: userId, action: "trade.manual_open", entity_type: "position", entity_id: pos?.id ?? null, details: { symbol: inp.symbol, side: inp.side, amount: inp.amount, live, entry_fee: fee } });
  return { positionId: pos?.id, price: fill, qty };
}

/** Closes a manual position at market. `reason` is stored on the trade. */
export async function closeManual(db: Admin, p: Row, reason: string) {
  const a = await loadAccount(db, p.user_id, p.exchange_connection_id, p.exchange);
  const entry = Number(p.entry_price), sign = p.side === "buy" ? 1 : -1;
  let qty = Number(p.quantity), exit: number, fees: number, pnl: number;
  const key = `manual:exit:${p.id}`;
  const { data: ord, error } = await db.from("orders").insert({
    user_id: p.user_id, exchange: p.exchange, exchange_connection_id: p.exchange_connection_id, trading_pair: p.trading_pair,
    side: p.side === "buy" ? "sell" : "buy", order_type: "market", quantity: qty, status: "pending", mode: p.mode, idempotency_key: key,
  }).select("id").single();
  if (error) throw new Error("This position is already being closed");
  try {
    if (a.exchange === "oanda") {
      const t = await oandaTrade(a.creds!, a.testnet, p.external_ref);
      if (t.state === "CLOSED") { exit = t.exit ?? entry; pnl = t.realized; fees = t.fees; reason = reason === "manual" ? "broker_closed" : reason; }
      else { const r = await oandaCloseTrade(a.creds!, a.testnet, p.external_ref); exit = r.price; pnl = r.realized; fees = r.fee; }
    } else if (a.connId) {
      qty = floorToStep(qty, await getStepSize(a.exchange, p.trading_pair, a.testnet));
      const r = await placeMarketOrder(a.exchange, a.creds!, a.testnet, p.trading_pair, "sell", qty, ord.id);
      exit = r.avgPrice; fees = r.feeQuote; qty = r.qty; pnl = (exit - entry) * qty;
    } else {
      const px = await lastPrice(a, p.trading_pair);
      exit = px * (p.side === "buy" ? 1 - SLIP : 1 + SLIP); fees = entry * qty * FEE + exit * qty * FEE; pnl = sign * (exit - entry) * qty;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("orders").update({ status: "rejected", reject_reason: msg.slice(0, 500), idempotency_key: `${key}:failed:${Date.now()}` }).eq("id", ord.id);
    throw new Error(msg);
  }
  const nowIso = new Date().toISOString();
  await db.from("orders").update({ status: "filled", filled_quantity: qty, avg_fill_price: exit }).eq("id", ord.id);
  await db.from("positions").update({ is_open: false, closed_at: nowIso, current_price: exit, unrealized_pnl: 0 }).eq("id", p.id);
  await db.from("trades").insert({
    user_id: p.user_id, order_id: ord.id, exchange: p.exchange, exchange_connection_id: p.exchange_connection_id, trading_pair: p.trading_pair,
    side: p.side, quantity: qty, entry_price: entry, exit_price: exit, fees, realized_pnl: pnl, mode: p.mode, opened_at: p.opened_at, closed_at: nowIso, close_reason: reason,
  });
  return { exit, pnl: pnl - fees };
}

/** Engine hook: SL/TP for manual crypto positions, sync broker-closed OANDA trades, refresh unrealized PnL. */
export async function manageManualPositions(db: Admin) {
  const { data: open } = await db.from("positions").select("*").is("bot_id", null).eq("is_open", true).limit(500);
  for (const p of open ?? []) {
    try {
      const a = await loadAccount(db, p.user_id, p.exchange_connection_id, p.exchange);
      if (a.exchange === "oanda") {
        const t = await oandaTrade(a.creds!, a.testnet, p.external_ref ?? "");
        if (t.state === "CLOSED") await closeManual(db, p, "broker_closed");
        else await db.from("positions").update({ unrealized_pnl: t.unrealized }).eq("id", p.id);
        continue;
      }
      const px = await lastPrice(a, p.trading_pair);
      const long = p.side === "buy";
      const hitSl = p.stop_loss != null && (long ? px <= +p.stop_loss : px >= +p.stop_loss);
      const hitTp = p.take_profit != null && (long ? px >= +p.take_profit : px <= +p.take_profit);
      if (hitSl || hitTp) await closeManual(db, p, hitSl ? "stop_loss" : "take_profit");
      else await db.from("positions").update({ current_price: px, unrealized_pnl: (long ? 1 : -1) * (px - +p.entry_price) * +p.quantity }).eq("id", p.id);
    } catch {
      /* retried next minute */
    }
  }
}
