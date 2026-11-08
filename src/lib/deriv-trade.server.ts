// Deriv Options API (Multipliers): REST for accounts + one-time WebSocket URL, then proposal/buy/sell/contract over WebSocket.
// Real-money orders: every buy first claims an orders row; unknown outcomes stay pending for reconciliation (never retried blindly).
import type { Creds } from "./exchange-adapters.server";
import { DERIV_API, DERIV_GRANULARITY, DERIV_PUBLIC_WS, derivAppId, derivCloseRecord, derivContractClosed, derivOpenContract, parseDerivCandles, type DerivOpenContract, type DerivTimeframe } from "./deriv";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
type Json = Record<string, unknown>;

interface Sock { send(d: string): void; close(): void; addEventListener(t: string, f: (e: { data?: unknown }) => void): void }

async function openSocket(url: string): Promise<Sock> {
  // Worker runtime: outbound WebSockets use a fetch upgrade. Elsewhere (dev) the global WebSocket client.
  if (typeof (globalThis as Json)["WebSocketPair"] !== "undefined") {
    const resp = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
    const ws = (resp as unknown as { webSocket?: Sock & { accept(): void } }).webSocket;
    if (!ws) throw new Error(`Deriv connection failed (${resp.status})`);
    ws.accept();
    return ws;
  }
  const ws = new WebSocket(url);
  await new Promise<void>((ok, fail) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => fail(new Error("Deriv connection failed")));
  });
  return ws as unknown as Sock;
}

class Session {
  private id = 0;
  private waiting = new Map<number, { ok: (v: Json) => void; fail: (e: Error) => void }>();
  constructor(private ws: Sock) {
    ws.addEventListener("message", (e) => {
      let m: Json;
      try { m = JSON.parse(String(e.data)) as Json; } catch { return; }
      const w = this.waiting.get(Number(m["req_id"]));
      if (!w) return;
      this.waiting.delete(Number(m["req_id"]));
      const err = m["error"] as { message?: string; code?: string } | undefined;
      if (err) w.fail(new Error(`Deriv: ${err.message ?? err.code ?? "request failed"}`));
      else w.ok(m);
    });
    ws.addEventListener("close", () => { for (const w of this.waiting.values()) w.fail(new Error("Deriv connection closed")); this.waiting.clear(); });
  }
  call(req: Json, timeoutMs = 10_000): Promise<Json> {
    const req_id = ++this.id;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { this.waiting.delete(req_id); fail(new Error("Deriv did not answer in time")); }, timeoutMs);
      this.waiting.set(req_id, { ok: (v) => { clearTimeout(t); ok(v); }, fail: (e) => { clearTimeout(t); fail(e); } });
      this.ws.send(JSON.stringify({ ...req, req_id }));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function rest(c: Creds, path: string, method = "GET") {
  const r = await fetch(`${DERIV_API}${path}`, { method, headers: { Authorization: `Bearer ${c.apiKey}`, "Deriv-App-ID": derivAppId.parse(c.apiSecret), Accept: "application/json" } });
  if (!r.ok) throw new Error(`Deriv request failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Json;
}

/** The Options account matching the connection type (demo for practice connections, real otherwise). */
export async function derivAccount(c: Creds, demo: boolean) {
  const j = await rest(c, "/trading/v1/options/accounts");
  const list = (j["data"] as { account_id: string; account_type: string; currency: string; balance: number }[] | undefined) ?? [];
  const a = list.find((x) => x.account_type === (demo ? "demo" : "real"));
  if (!a) throw new Error(`No Deriv ${demo ? "demo" : "real"} Options account found`);
  return { id: a.account_id, currency: a.currency, balance: Number(a.balance) };
}

async function withSession<T>(c: Creds, demo: boolean, fn: (s: Session, acct: Awaited<ReturnType<typeof derivAccount>>) => Promise<T>) {
  const acct = await derivAccount(c, demo);
  const otp = await rest(c, `/trading/v1/options/accounts/${encodeURIComponent(acct.id)}/otp`, "POST");
  const url = (otp["data"] as { url?: string } | undefined)?.url;
  if (!url || !/^wss:\/\/[a-z0-9.-]*derivws\.com\//i.test(url)) throw new Error("Deriv did not return a trading connection");
  const s = new Session(await openSocket(url));
  try { return await fn(s, acct); } finally { s.close(); }
}

async function withPublic<T>(fn: (s: Session) => Promise<T>) {
  const s = new Session(await openSocket(DERIV_PUBLIC_WS));
  try { return await fn(s); } finally { s.close(); }
}

export async function derivSymbols(market?: string) {
  const r = await withPublic((s) => s.call({ active_symbols: "brief" }));
  const rows = (r["active_symbols"] as Json[] | undefined) ?? [];
  return rows
    .filter((x) => !market || x["market"] === market)
    .map((x) => ({ symbol: String(x["underlying_symbol"] ?? x["symbol"]), name: String(x["underlying_symbol_name"] ?? x["display_name"] ?? ""), market: String(x["market"] ?? ""), open: x["exchange_is_open"] === 1 }))
    .slice(0, 80);
}

export async function derivCandles(symbol: string, tf: DerivTimeframe, count = 300) {
  const r = await withPublic((s) => s.call({ ticks_history: symbol, end: "latest", count, style: "candles", granularity: DERIV_GRANULARITY[tf], adjust_start_time: 1 }));
  return parseDerivCandles(r);
}

async function openContract(s: Session, id: number): Promise<DerivOpenContract> {
  const r = await s.call({ proposal_open_contract: 1, contract_id: id });
  return derivOpenContract.parse(r["proposal_open_contract"]);
}

export interface MultiplierInput { symbol: string; direction: "up" | "down"; stake: number; multiplier: number; stopLossAmount: number; takeProfitAmount: number | null }

/** Opens a real (or demo-account) Deriv Multiplier contract for a verified connection, recorded as a live position. */
export async function openDerivMultiplier(db: Admin, userId: string, a: { connId: string; testnet: boolean; creds: Creds }, input: MultiplierInput) {
  if (input.stopLossAmount > input.stake) throw new Error("Stop loss amount cannot exceed the stake");
  const { accountRiskBlock } = await import("./engine.server");
  const unresolved = await db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("mode", "live").in("status", ["pending", "open", "partially_filled"]);
  if (unresolved.error || unresolved.count) throw new Error("Pending orders require reconciliation before another entry");
  const block = await accountRiskBlock(db, userId, input.stake);
  if (block) throw new Error(`Blocked by risk settings: ${block}`);

  const positionId = crypto.randomUUID();
  const side = input.direction === "up" ? "buy" : "sell";
  const { data: ord, error } = await db.from("orders").insert({
    user_id: userId, exchange: "deriv", exchange_connection_id: a.connId, trading_pair: input.symbol, side, order_type: "market",
    quantity: input.stake, status: "pending", mode: "live", idempotency_key: `deriv:${positionId}`,
  }).select("id").single();
  if (error) throw new Error(error.message);

  let bought: { id: number; price: number; spot: number; currency: string };
  try {
    bought = await withSession(a.creds, a.testnet, async (s, acct) => {
      const limit: Json = { stop_loss: input.stopLossAmount };
      if (input.takeProfitAmount != null) limit["take_profit"] = input.takeProfitAmount;
      const p = await s.call({ proposal: 1, amount: input.stake, basis: "stake", contract_type: input.direction === "up" ? "MULTUP" : "MULTDOWN", currency: acct.currency, multiplier: input.multiplier, underlying_symbol: input.symbol, limit_order: limit });
      const prop = p["proposal"] as { id: string; ask_price: number; spot: number };
      const b = await s.call({ buy: prop.id, price: prop.ask_price });
      const buy = b["buy"] as { contract_id: number; buy_price: number };
      return { id: buy.contract_id, price: Number(buy.buy_price), spot: Number(prop.spot), currency: acct.currency };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A rejected proposal never reached a buy; anything else is an unknown outcome kept for reconciliation.
    const rejected = /Deriv:/.test(msg) && !/did not answer|closed/.test(msg);
    await db.from("orders").update(rejected ? { status: "rejected", reject_reason: msg.slice(0, 500), idempotency_key: `deriv:${positionId}:rejected` } : { status: "pending", reject_reason: "Outcome unknown; check Deriv and reconcile" }).eq("id", ord.id);
    throw new Error(msg);
  }
  const qty = bought.price / bought.spot;
  await db.from("orders").update({ status: "filled", quantity: qty, filled_quantity: qty, avg_fill_price: bought.spot, exchange_order_id: String(bought.id) }).eq("id", ord.id);
  await db.from("positions").insert({
    id: positionId, user_id: userId, exchange: "deriv", exchange_connection_id: a.connId, trading_pair: input.symbol, side, quantity: qty,
    entry_price: bought.spot, current_price: bought.spot, mode: "live", unrealized_pnl: 0, external_ref: String(bought.id), entry_fee_quote: 0, entry_order_id: ord.id,
  });
  await db.from("audit_logs").insert({ user_id: userId, action: "trade.deriv_multiplier_open", entity_type: "position", entity_id: positionId, details: { ...input, contractId: bought.id, buyPrice: bought.price, currency: bought.currency, demoAccount: a.testnet } });
  return { positionId, contractId: bought.id, stake: bought.price, entrySpot: bought.spot, currency: bought.currency };
}

async function recordClose(db: Admin, p: Row, c: DerivOpenContract, reason: string) {
  const r = derivCloseRecord(c, Number(p.current_price ?? p.entry_price));
  const nowIso = new Date().toISOString();
  const { data: claimed } = await db.from("positions").update({ is_open: false, closed_at: nowIso, current_price: r.exit, unrealized_pnl: 0 }).eq("id", p.id).eq("is_open", true).select("id");
  if (!claimed?.length) return { exit: r.exit, pnl: r.net };
  await db.from("trades").insert({
    user_id: p.user_id, order_id: p.entry_order_id, exchange: "deriv", exchange_connection_id: p.exchange_connection_id, trading_pair: p.trading_pair,
    side: p.side, quantity: p.quantity, entry_price: p.entry_price, exit_price: r.exit, fees: r.fees, realized_pnl: r.gross, mode: "live",
    opened_at: p.opened_at, closed_at: nowIso, close_reason: reason, is_scalp: false,
  });
  return { exit: r.exit, pnl: r.net };
}

async function creds(db: Admin, p: Row) {
  const { loadAccount } = await import("./manual.server");
  const a = await loadAccount(db, p.user_id, p.exchange_connection_id, "deriv");
  if (!a.creds) throw new Error("Deriv account keys unavailable");
  return a;
}

/** Sells a Deriv contract at market (or records it if Deriv already closed it via stop loss / take profit). */
export async function closeDerivPosition(db: Admin, p: Row, reason: string) {
  const a = await creds(db, p);
  const id = Number(p.external_ref);
  const c = await withSession(a.creds!, a.testnet, async (s) => {
    const before = await openContract(s, id);
    if (derivContractClosed(before)) { reason = reason === "manual" ? "broker_closed" : reason; return before; }
    await s.call({ sell: id, price: 0 });
    return openContract(s, id);
  });
  return recordClose(db, p, c, reason);
}

/** Engine hook: syncs one Deriv contract (records it when Deriv closed it, otherwise updates live profit). */
export async function checkDerivPosition(db: Admin, p: Row): Promise<string | null> {
  const a = await creds(db, p);
  const c = await withSession(a.creds!, a.testnet, (s) => openContract(s, Number(p.external_ref)));
  if (derivContractClosed(c)) { await recordClose(db, p, c, "broker_closed"); return "broker_closed"; }
  await db.from("positions").update({ current_price: c.current_spot ?? p.current_price, unrealized_pnl: c.profit ?? 0 }).eq("id", p.id);
  return null;
}
