import { compareBooks, executionAllowed, ARBITRAGE_EXCHANGES, type ArbitrageExchange, type Opportunity } from "./arbitrage";
import { fetchArbitrageBook, fetchBalances, floorToStep, getStepSize, placeMarketOrder, lookupArbitrageOrder, type Fill } from "./exchange-adapters.server";
import { recoveryDecision, type OrderEvidence } from "./arbitrage-recovery";
import { loadAccount } from "./manual.server";
import { accountRiskBlock } from "./engine.server";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
export interface ScanInput { pair: string; budget: number; feeBps: number; slippageBps: number; exchanges: ArbitrageExchange[] }
export async function scanArbitrage(input: ScanInput) {
  const errors: string[] = [];
  const results = await Promise.all(input.exchanges.map(async (exchange) => {
    try { return await fetchArbitrageBook(exchange, input.pair); }
    catch { errors.push(`${exchange}: market data unavailable`); return null; }
  }));
  const books = results.filter((b) => b !== null);
  return { books, opportunities: compareBooks(books, input.budget, input.feeBps, input.slippageBps), errors, scannedAt: Date.now() };
}

export interface ExecuteInput extends ScanInput {
  requestKey: string; buyExchange: ArbitrageExchange; sellExchange: ArbitrageExchange;
  buyConnectionId: string | null; sellConnectionId: string | null;
  mode: "paper" | "live"; confirmation: string; minimumNetPct: number;
}

export async function reconcileArbitrage(db: Admin, userId: string, runId: string) {
  const { data: run, error } = await db.from("arbitrage_runs").select("*").eq("id", runId).eq("user_id", userId).single();
  if (error || !run) throw new Error("Execution not found");
  if (!["claimed", "buy_filled", "needs_review"].includes(run.status)) return run;
  const idle = Date.now() - Date.parse(run.updated_at);
  if (!Number.isFinite(idle) || idle < (run.status === "needs_review" ? 60000 : 600000)) throw new Error("Execution may still be running. Check again later; no orders were sent.");
  if (run.mode === "paper") throw new Error("Interrupted paper simulation needs review; no exchange funds moved");
  const { data: orders, error: orderError } = await db.from("orders").select("id,side,exchange,exchange_connection_id,idempotency_key").eq("user_id", userId).in("idempotency_key", [`arb:${run.id}:buy`, `arb:${run.id}:sell`]);
  if (orderError) throw new Error("Unable to read original order intents");
  const evidence = await Promise.all((["buy", "sell"] as const).map(async (side): Promise<OrderEvidence | null> => {
    const connectionId = side === "buy" ? run.buy_connection_id : run.sell_connection_id;
    const exchange = side === "buy" ? run.buy_exchange : run.sell_exchange;
    const intent = orders?.find((o) => o.idempotency_key === `arb:${run.id}:${side}` && o.side === side && o.exchange === exchange && o.exchange_connection_id === connectionId);
    if (!intent || !connectionId) return null;
    try {
      const account = await loadAccount(db, userId, connectionId);
      if (!account.creds || account.exchange !== exchange || account.testnet !== (run.mode === "testnet")) return null;
      const result = await lookupArbitrageOrder(exchange, account.creds, account.testnet, run.trading_pair, side, intent.id);
      if (![result.qty, result.avgPrice, result.quoteValue].every(Number.isFinite) || result.qty < 0 || result.quoteValue < 0 || (result.qty > 0 && result.avgPrice <= 0) || (result.feeQuote != null && !Number.isFinite(result.feeQuote))) return null;
      return result;
    } catch { return null; }
  }));
  const buy = evidence[0] ?? null, sell = evidence[1] ?? null;
  const decision = recoveryDecision(buy, sell);
  const { data: saved, error: saveError } = await db.from("arbitrage_runs").update({ status: decision.status, realized_net: decision.realizedNet,
    buy_fill: buy ? { ...buy } : run.buy_fill, sell_fill: sell ? { ...sell } : run.sell_fill,
    message: decision.message, updated_at: new Date().toISOString(),
  }).eq("id", run.id).eq("user_id", userId).eq("updated_at", run.updated_at).select("*").maybeSingle();
  if (saveError || !saved) throw new Error("Execution changed during verification. Refresh history; no orders were sent.");
  return saved;
}

export async function executeArbitrage(db: Admin, userId: string, input: ExecuteInput) {
  if (input.buyExchange === input.sellExchange) throw new Error("Choose two different exchanges");
  if (!ARBITRAGE_EXCHANGES.includes(input.buyExchange) || !ARBITRAGE_EXCHANGES.includes(input.sellExchange)) throw new Error("Unsupported exchange");
  const { data: existing, error: readError } = await db.from("arbitrage_runs").select("*").eq("user_id", userId).eq("request_key", input.requestKey).maybeSingle();
  if (readError) throw new Error("Unable to check previous execution");
  if (existing) return existing;
  let opportunity: Opportunity | undefined;
  let buyAccount = null, sellAccount = null;
  if (input.mode === "live") {
    if (input.confirmation !== "LIVE") throw new Error("Type LIVE to confirm real exchange orders");
    if (!input.buyConnectionId || !input.sellConnectionId) throw new Error("Select verified accounts on both exchanges");
    // Only adapters whose available spot balances and fills can currently be verified safely.
    if (![input.buyExchange, input.sellExchange].every((e) => e === "binance" || e === "okx")) throw new Error("Live arbitrage currently supports Binance and OKX; other venues are scan/paper only");
    [buyAccount, sellAccount] = await Promise.all([
      loadAccount(db, userId, input.buyConnectionId), loadAccount(db, userId, input.sellConnectionId),
    ]);
    if (buyAccount.exchange !== input.buyExchange || sellAccount.exchange !== input.sellExchange) throw new Error("Selected account does not match its exchange");
    if (buyAccount.testnet !== sellAccount.testnet) throw new Error("Do not mix testnet and real-money accounts");
    const { data: accounts, error } = await db.from("exchange_connections").select("id,account_type").in("id", [input.buyConnectionId, input.sellConnectionId]);
    if (error || accounts?.length !== 2 || accounts.some((a) => a.account_type !== "spot")) throw new Error("Arbitrage requires two verified spot accounts");
    const books = await Promise.all([
      fetchArbitrageBook(input.buyExchange, input.pair, buyAccount.testnet),
      fetchArbitrageBook(input.sellExchange, input.pair, sellAccount.testnet),
    ]);
    opportunity = compareBooks(books, input.budget, input.feeBps, input.slippageBps).find((o) => o.buyExchange === input.buyExchange && o.sellExchange === input.sellExchange);
    if (!buyAccount.creds || !sellAccount.creds) throw new Error("Missing exchange credentials");
    const balances = await Promise.all([
      fetchBalances(buyAccount.exchange, buyAccount.creds, buyAccount.testnet),
      fetchBalances(sellAccount.exchange, sellAccount.creds, sellAccount.testnet),
    ]);
    const [base, quote] = input.pair.split("/");
    if ((balances[0]?.find((b) => b.asset === quote)?.free ?? 0) < input.budget * (1 + input.feeBps / 10000)) throw new Error(`Prefund the buy account with ${quote}`);
    if (!opportunity || (balances[1]?.find((b) => b.asset === base)?.free ?? 0) < opportunity.quantity * (1 + input.feeBps / 10000)) throw new Error(`Prefund the sell account with ${base}; no exchange transfers are made`);
  } else {
    const scan = await scanArbitrage({ ...input, exchanges: [input.buyExchange, input.sellExchange] });
    opportunity = scan.opportunities.find((o) => o.buyExchange === input.buyExchange && o.sellExchange === input.sellExchange);
  }
  if (!opportunity || !executionAllowed(opportunity, input.minimumNetPct)) throw new Error("No positive opportunity meets your minimum after fees and slippage");
  const risk = await accountRiskBlock(db, userId, input.budget);
  if (risk) throw new Error(`Blocked by risk settings: ${risk}`);
  if (Date.now() - opportunity.fetchedAt > 15000) throw new Error("Quotes expired; scan again");
  const { data: run, error: claimError } = await db.from("arbitrage_runs").insert({
    user_id: userId, request_key: input.requestKey, trading_pair: input.pair, buy_exchange: input.buyExchange, sell_exchange: input.sellExchange,
    buy_connection_id: input.mode === "live" ? input.buyConnectionId : null, sell_connection_id: input.mode === "live" ? input.sellConnectionId : null,
    mode: input.mode === "paper" ? "paper" : buyAccount?.testnet ? "testnet" : "live", budget: input.budget, estimated_net: opportunity.net,
  }).select("*").single();
  if (claimError || !run) throw new Error("Execution already claimed, or a previous run needs review. No new orders sent.");
  if (input.mode === "paper") {
    const { data, error } = await db.from("arbitrage_runs").update({ status: "completed", realized_net: opportunity.net,
      buy_fill: { qty: opportunity.quantity, avgPrice: opportunity.buyPrice }, sell_fill: { qty: opportunity.quantity, avgPrice: opportunity.sellPrice },
      message: "Simulation at current depth; no exchange orders or demo wallet money moved.", updated_at: new Date().toISOString(),
    }).eq("id", run.id).select("*").single();
    if (error) throw new Error("Simulation result could not be saved");
    return data;
  }
  if (!buyAccount?.creds || !sellAccount?.creds) throw new Error("Missing verified accounts");
  const persist = async (patch: import("@/integrations/supabase/types").Database["public"]["Tables"]["arbitrage_runs"]["Update"]) => {
    const { error } = await db.from("arbitrage_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", run.id);
    if (error) throw new Error("Execution state could not be saved; check both exchange accounts");
  };
  let sent = false;
  try {
    const buyId = crypto.randomUUID(), sellId = crypto.randomUUID();
    const { error } = await db.from("orders").insert([
      { id: buyId, user_id: userId, exchange: input.buyExchange, exchange_connection_id: input.buyConnectionId, trading_pair: input.pair, mode: "live", side: "buy", order_type: "market", quantity: opportunity.quantity, idempotency_key: `arb:${run.id}:buy` },
      { id: sellId, user_id: userId, exchange: input.sellExchange, exchange_connection_id: input.sellConnectionId, trading_pair: input.pair, mode: "live", side: "sell", order_type: "market", quantity: opportunity.quantity, idempotency_key: `arb:${run.id}:sell` },
    ]);
    if (error) throw new Error("Unable to claim both exchange orders");
    const step = await getStepSize(input.sellExchange, input.pair, sellAccount.testnet);
    if (!(step > 0)) throw new Error("Unable to validate sell quantity precision");
    const latest = await Promise.all([fetchArbitrageBook(input.buyExchange, input.pair, buyAccount.testnet), fetchArbitrageBook(input.sellExchange, input.pair, sellAccount.testnet)]);
    const fresh = compareBooks(latest, input.budget, input.feeBps, input.slippageBps).find((o) => o.buyExchange === input.buyExchange && o.sellExchange === input.sellExchange);
    if (!fresh || !executionAllowed(fresh, input.minimumNetPct)) throw new Error("Spread disappeared before submission; no orders sent");
    const lastRisk = await accountRiskBlock(db, userId, input.budget);
    if (lastRisk) throw new Error(`Blocked by risk settings: ${lastRisk}`);
    sent = true;
    const buy = await placeMarketOrder(buyAccount.exchange, buyAccount.creds, buyAccount.testnet, input.pair, "buy", input.budget, buyId);
    await persist({ status: "buy_filled", buy_fill: { ...buy } });
    const record = async (id: string, fill: Fill) => {
      const { error } = await db.from("orders").update({ status: "filled", filled_quantity: fill.qty, avg_fill_price: fill.avgPrice, exchange_order_id: fill.orderId }).eq("id", id);
      if (error) throw new Error("Order filled but local record needs review");
    };
    await record(buyId, buy);
    const sellQty = floorToStep(buy.qty, step);
    if (!(sellQty > 0) || sellQty > opportunity.quantity * (1 + input.feeBps / 10000)) throw new Error("Buy fill changed; inspect inventory before selling");
    const sell = await placeMarketOrder(sellAccount.exchange, sellAccount.creds, sellAccount.testnet, input.pair, "sell", sellQty, sellId);
    await persist({ sell_fill: { ...sell } });
    await record(sellId, sell);
    const [verifiedBuy, verifiedSell] = await Promise.all([
      lookupArbitrageOrder(buyAccount.exchange, buyAccount.creds, buyAccount.testnet, input.pair, "buy", buyId),
      lookupArbitrageOrder(sellAccount.exchange, sellAccount.creds, sellAccount.testnet, input.pair, "sell", sellId),
    ]);
    const outcome = recoveryDecision(verifiedBuy, verifiedSell);
    await persist({ status: outcome.status, realized_net: outcome.realizedNet, buy_fill: { ...verifiedBuy }, sell_fill: { ...verifiedSell }, message: outcome.message });
  } catch {
    await persist({ status: sent ? "needs_review" : "blocked", message: sent ? "An order may have filled. Check BOTH exchanges and reconcile orders; do not retry. Further arbitrage is locked." : "Preflight failed; no exchange order was submitted." });
  }
  const { data: result, error } = await db.from("arbitrage_runs").select("*").eq("id", run.id).single();
  if (error) throw new Error("Unable to read execution result; inspect history and exchange accounts");
  return result;
}