import { compareBooks, executionAllowed, ARBITRAGE_EXCHANGES, type ArbitrageExchange, type Opportunity } from "./arbitrage";
import { fetchArbitrageBook, fetchBalances, floorToStep, getStepSize, placeMarketOrder, type Fill } from "./exchange-adapters.server";
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
    const matched = Math.abs(sell.qty - buy.qty) <= step * 1.01;
    // Net buy quantity already excludes base fees; subtracting reported fees is conservative.
    const net = sell.avgPrice * sell.qty - buy.avgPrice * buy.qty - buy.feeQuote - sell.feeQuote;
    await persist({ status: matched ? "completed" : "needs_review", realized_net: matched ? net : null,
      message: matched ? "Both legs filled. Inventory moved between prefunded accounts; residual dust and fee conversions may affect net." : "Unequal fills: inspect both exchanges. Further executions are locked.",
    });
  } catch {
    await persist({ status: sent ? "needs_review" : "blocked", message: sent ? "An order may have filled. Check BOTH exchanges and reconcile orders; do not retry. Further arbitrage is locked." : "Preflight failed; no exchange order was submitted." });
  }
  const { data: result, error } = await db.from("arbitrage_runs").select("*").eq("id", run.id).single();
  if (error) throw new Error("Unable to read execution result; inspect history and exchange accounts");
  return result;
}