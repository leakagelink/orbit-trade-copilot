import {tradeNet} from './trade-accounting';
// AI Autopilot tools. Every action is forced to the demo wallet / paper engine and goes through the same
// server paths as the UI (risk gate, plan checks, idempotent order claims). No tool accepts an account or mode.
import { tool, type ToolSet } from "ai";
import { futuresTicket } from "./futures";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { toolInputs, liveToolInputs, createRunBudget, type LiveAccounts } from "./autopilot-guard";
import { MARKETS, marketOf } from "./markets";
import { validateStrategy, type StrategyConfig } from "./strategy";

type Ctx = {
  supabase: SupabaseClient<Database>; userId: string; budget: ReturnType<typeof createRunBudget>; live?: LiveAccounts | null;
  /** Scheduled runs: run ID for deterministic request IDs, and a guard re-checking run/Autopilot authorization right before a submission. */
  runId?: string | undefined; guard?: (() => Promise<void>) | undefined;
};
type ToolOpts = { toolCallId?: string | undefined };

const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const priceSource = (sym: string, exchange = "binance") => (marketOf(sym)?.category === "crypto" ? exchange : "yahoo");
const num = (v: unknown) => (v == null ? null : Number(v));

function knownMarket(symbol: string) {
  const m = marketOf(symbol);
  if (!m) throw new Error(`Unknown market ${symbol}. Use list_markets.`);
  return m;
}

async function audit(ctx: Ctx, action: string, details: Record<string, unknown>, entity?: { type: string; id: string }) {
  await ctx.supabase.from("audit_logs").insert({ user_id: ctx.userId, action: `autopilot.${action}`, entity_type: entity?.type ?? "autopilot", entity_id: entity?.id ?? null, details: details as Json });
}

/** Wraps an executor so errors become a readable tool result the model can react to. */
function safe<I>(fn: (input: I, opts: ToolOpts) => Promise<unknown>) {
  return async (input: I, opts?: ToolOpts) => {
    try { return await fn(input, opts ?? {}); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
}

export function autopilotTools(ctx: Ctx): ToolSet {
  const { supabase, userId } = ctx;
  return { ...paperTools(ctx), ...(ctx.live ? liveTools(ctx, ctx.live) : {}) };
}

function paperTools(ctx: Ctx): ToolSet {
  const { supabase, userId } = ctx;
  return {
    get_account_overview: tool({
      description: "Demo wallet balance, plan, risk settings, open positions (paper and live), bots and recent results.",
      inputSchema: toolInputs.overview,
      execute: safe(async () => {
        const [wallet, risk, positions, bots, trades, pro, elite] = await Promise.all([
          supabase.from("wallets").select("balance,currency").eq("user_id", userId).maybeSingle(),
          supabase.from("risk_settings").select("max_daily_loss,max_open_exposure,max_total_positions,trading_halted").eq("user_id", userId).maybeSingle(),
          supabase.from("positions").select("id,trading_pair,side,quantity,entry_price,current_price,unrealized_pnl,mode,bot_id,is_scalp,stop_loss,take_profit,opened_at").eq("user_id", userId).eq("is_open", true).limit(50),
          supabase.from("trading_bots").select("id,name,status,mode,trading_pair,timeframe,exchange,allocated_capital").eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
          supabase.from("trades").select("trading_pair,side,realized_pnl,fees,funding_pnl,execution_environment,close_reason,closed_at,mode").eq("user_id", userId).order("closed_at", { ascending: false }).limit(30),
          supabase.rpc("has_pro_access", { _uid: userId }),
          supabase.rpc("has_elite_access", { _uid: userId }),
        ]);
        const recent = (trades.data ?? []).filter((t) => t.mode === "paper").slice(0, 20);
        const liveRecent = (trades.data ?? []).filter((t) => t.execution_environment === "production").slice(0, 20);
        return {
          plan: elite.data ? "elite" : pro.data ? "pro" : "free",
          wallet: wallet.data ? { balance: Number(wallet.data.balance), currency: wallet.data.currency } : { balance: 0, currency: "USD", note: "No demo wallet yet — deposit on the Wallet page" },
          riskSettings: risk.data ?? "defaults (no account-wide limits set)",
          openPositions: positions.data ?? [],
          bots: bots.data ?? [],
          recentPaperTrades: recent,
          recentPaperNetPnl: recent.reduce((s, t) => s + tradeNet(t), 0),
          ...(ctx.live ? { realMoneyAccounts: ctx.live, recentLiveTrades: liveRecent, recentLiveNetPnl: liveRecent.reduce((s, t) => s + tradeNet(t), 0) } : { realMoney: "disabled" }),
        };
      }),
    }),

    list_markets: tool({
      description: "Tradable market symbols by category.",
      inputSchema: toolInputs.listMarkets,
      execute: safe(async ({ category }) => MARKETS.filter((m) => m.category === category).map((m) => m.symbol)),
    }),

    get_market_snapshot: tool({
      description: "Live price and indicators (RSI, EMA 20/50/200, ATR, MACD histogram, Bollinger %B) from real candles.",
      inputSchema: toolInputs.marketSnapshot,
      execute: safe(async ({ symbol, timeframe }) => {
        knownMarket(symbol);
        const { fetchCandles } = await import("./exchange-adapters.server");
        const cs = await fetchCandles(priceSource(symbol), symbol, timeframe, false, 300);
        const { marketFacts } = await import("./market-facts");
        return marketFacts(cs, symbol, timeframe);
      }),
    }),

    create_strategy: tool({
      description: "Save a StrategyConfig as the user's strategy. Returns id and validation issues.",
      inputSchema: toolInputs.createStrategy,
      execute: safe(async ({ name, description, config }) => {
        const cfg = config as unknown as StrategyConfig;
        const issues = validateStrategy(cfg);
        const { data, error } = await supabase.from("strategies").insert({
          user_id: userId, name, description: description ?? "Created by AI Autopilot", source: "ai", config: cfg as unknown as Json,
          status: issues.length ? "draft" : "validated", validation_errors: issues as unknown as Json,
        }).select("id").single();
        if (error) throw new Error(error.message);
        await supabase.from("strategy_versions").insert({ strategy_id: data.id, user_id: userId, version: 1, config: cfg as unknown as Json, notes: "Created by AI Autopilot" });
        await audit(ctx, "create_strategy", { name, issues: issues.length }, { type: "strategy", id: data.id });
        return { ok: true, strategyId: data.id, validationIssues: issues };
      }),
    }),

    run_backtest: tool({
      description: "Backtest a saved strategy on real exchange history (next-bar fills). Returns key stats.",
      inputSchema: toolInputs.runBacktest,
      execute: safe(async (input) => {
        const { runBacktestFor } = await import("./backtests.server");
        const r = await runBacktestFor(supabase, userId, input);
        if (r.error) return { ok: false, backtestId: r.id, error: r.error };
        const { data } = await supabase.from("backtest_results").select("net_profit,total_return_pct,max_drawdown_pct,win_rate_pct,profit_factor,total_trades").eq("backtest_id", r.id).maybeSingle();
        await audit(ctx, "run_backtest", { strategyId: input.strategyId, ...(data ?? {}) }, { type: "backtest", id: r.id });
        return { ok: true, backtestId: r.id, stats: data };
      }),
    }),

    start_paper_bot: tool({
      description: "Create a PAPER bot for a validated strategy and start it. The engine then trades it automatically every minute (simulated).",
      inputSchema: toolInputs.startPaperBot,
      execute: safe(async (input) => {
        ctx.budget.claim("bots");
        await ctx.guard?.();
        const { createPaperBotFor, startPaperBotFor } = await import("./bots.server");
        const { id } = await createPaperBotFor(supabase, userId, { ...input, connectionId: null }, "Bot created by AI Autopilot (paper mode)");
        await startPaperBotFor(supabase, userId, id, "Paper trading started by AI Autopilot — engine checks every minute");
        await audit(ctx, "start_paper_bot", { name: input.name, pair: input.pair }, { type: "trading_bot", id });
        return { ok: true, botId: id, status: "paper_trading" };
      }),
    }),

    stop_bot: tool({
      description: "Pause or stop a bot's new entries. Open positions are still managed by the engine.",
      inputSchema: toolInputs.stopBot,
      execute: safe(async ({ id, status }) => {
        const { stopBotFor } = await import("./bots.server");
        await stopBotFor(supabase, userId, id, status, "Stopped by AI Autopilot");
        await audit(ctx, "stop_bot", { status }, { type: "trading_bot", id });
        return { ok: true, botId: id, status };
      }),
    }),

    open_paper_trade: tool({
      description: "Open a demo-wallet trade (crypto, forex or commodities) with a stop loss. amountUsd is the margin taken from the demo wallet.",
      inputSchema: toolInputs.openPaperTrade,
      execute: safe(async ({ symbol, side, amountUsd, stopLoss, takeProfit }) => {
        knownMarket(symbol);
        ctx.budget.claim("entries");
        const db = await admin();
        const { loadAccount, openManual } = await import("./manual.server");
        const a = await loadAccount(db, userId, null, priceSource(symbol));
        await ctx.guard?.();
        const r = await openManual(db, userId, a, { symbol, side, amount: amountUsd, sl: stopLoss, tp: takeProfit });
        await audit(ctx, "open_paper_trade", { symbol, side, amountUsd }, { type: "position", id: r.positionId });
        return { ok: true, ...r };
      }),
    }),

    open_paper_scalp: tool({
      description: "Elite: open a demo-wallet scalp; the server sets stop/target from the live price and closes it at the time limit.",
      inputSchema: toolInputs.openPaperScalp,
      execute: safe(async ({ symbol, side, amountUsd, tpPct, slPct, holdMin }) => {
        knownMarket(symbol);
        const { requireElite } = await import("./plan.server");
        await requireElite(supabase, userId);
        ctx.budget.claim("entries");
        const db = await admin();
        const { loadAccount, openManual } = await import("./manual.server");
        const a = await loadAccount(db, userId, null, priceSource(symbol));
        await ctx.guard?.();
        const r = await openManual(db, userId, a, { symbol, side, amount: amountUsd, sl: null, tp: null, scalp: { tpPct, slPct, holdMin } });
        await audit(ctx, "open_paper_scalp", { symbol, side, amountUsd, tpPct, slPct, holdMin }, { type: "position", id: r.positionId });
        return { ok: true, ...r };
      }),
    }),

    close_paper_position: tool({
      description: "Close one of the user's open demo-wallet (manual or scalp) positions at market.",
      inputSchema: toolInputs.closePaperPosition,
      execute: safe(async ({ positionId }) => {
        const db = await admin();
        const { data: p } = await db.from("positions").select("*").eq("id", positionId).eq("user_id", userId).eq("is_open", true).is("bot_id", null).maybeSingle();
        if (!p) throw new Error("Open manual position not found");
        if (p.mode !== "paper" || p.exchange_connection_id) throw new Error("Autopilot only closes demo/paper positions");
        const { closeManual } = await import("./manual.server");
        const r = await closeManual(db, p, "autopilot");
        await audit(ctx, "close_paper_position", { pnl: r.pnl }, { type: "position", id: positionId });
        return { ok: true, exit: r.exit, netPnl: r.pnl };
      }),
    }),

    scan_arbitrage: tool({
      description: "Elite: compare live order-book depth across exchanges and estimate net after fees (0.1%) and slippage (0.05%).",
      inputSchema: toolInputs.scanArbitrage,
      execute: safe(async ({ pair, budget, exchanges }) => {
        const { requireElite } = await import("./plan.server");
        await requireElite(supabase, userId);
        const { scanArbitrage } = await import("./arbitrage.server");
        const s = await scanArbitrage({ pair, budget, exchanges, feeBps: 10, slippageBps: 5 });
        return { opportunities: s.opportunities.slice(0, 5).map((o) => ({ buyExchange: o.buyExchange, sellExchange: o.sellExchange, buyPrice: o.buyPrice, sellPrice: o.sellPrice, net: o.net, netPct: o.netPct })), errors: s.errors };
      }),
    }),

    run_paper_arbitrage: tool({
      description: "Elite: simulate one arbitrage round at current depth (paper; no exchange orders or wallet money move).",
      inputSchema: toolInputs.runPaperArbitrage,
      execute: safe(async (input) => {
        const { requireElite } = await import("./plan.server");
        await requireElite(supabase, userId);
        ctx.budget.claim("entries");
        const db = await admin();
        const { executeArbitrage } = await import("./arbitrage.server");
        await ctx.guard?.();
        const run = await executeArbitrage(db, userId, {
          ...input, exchanges: [input.buyExchange, input.sellExchange], feeBps: 10, slippageBps: 5,
          requestKey: crypto.randomUUID(), buyConnectionId: null, sellConnectionId: null, mode: "paper", confirmation: "",
        });
        await audit(ctx, "run_paper_arbitrage", { pair: input.pair, net: num(run.realized_net) }, { type: "arbitrage_run", id: run.id });
        return { ok: true, runId: run.id, status: run.status, estimatedNet: num(run.estimated_net), message: run.message };
      }),
    }),
  };
}

/** Real-money tools — only built when the owner enabled live Autopilot and the accounts are still verified. */
function liveTools(ctx: Ctx, live: LiveAccounts): ToolSet {
  const { userId } = ctx;
  const t: ToolSet = {
    live_account_balances: tool({
      description: "Real balances of the live-enabled accounts (Binance spot assets, Deriv Options account).",
      inputSchema: toolInputs.overview,
      execute: safe(async () => {
        const db = await admin();
        const { loadAccount } = await import("./manual.server");
        const { fetchBalances } = await import("./exchange-adapters.server");
        const out: Record<string, unknown> = {};
        for (const [name, acc] of [["binance", live.binance], ["deriv", live.deriv]] as const) {
          if (!acc || typeof acc !== "object") continue;
          try {
            const a = await loadAccount(db, userId, acc.id);
            const b = await fetchBalances(a.exchange, a.creds!, a.testnet);
            out[name] = { label: acc.label, testnet: acc.testnet, balances: b.filter((x) => x.free + x.locked > 0).slice(0, 15) };
          } catch (e) { out[name] = { error: e instanceof Error ? e.message : String(e) }; }
        }
        return out;
      }),
    }),
    live_close_position: tool({
      description: "Close one open REAL-MONEY position (Binance spot or Deriv contract) that belongs to a live-enabled account.",
      inputSchema: liveToolInputs.closePosition,
      execute: safe(async ({ positionId }) => {
        const db = await admin();
        const { data: p } = await db.from("positions").select("*").eq("id", positionId).eq("user_id", userId).eq("is_open", true).is("bot_id", null).maybeSingle();
        const allowed = [live.binance?.id, live.deriv?.id].filter((x): x is string => !!x);
        if (!p || p.mode !== "live" || !p.exchange_connection_id || !allowed.includes(p.exchange_connection_id)) throw new Error("Open live position on a live-enabled account not found");
        const { closeManual } = await import("./manual.server");
        const r = await closeManual(db, p, "autopilot");
        await audit(ctx, "live_close_position", { exchange: p.exchange, pnl: r.pnl }, { type: "position", id: positionId });
        return { ok: true, exit: r.exit, netPnl: r.pnl };
      }),
    }),
  };
  if (live.binance) {
    const acc = live.binance;
    t["live_futures_snapshot"] = tool({
      description: "Read Binance USD-M Futures market and Futures settings. No orders or settings changes.",
      inputSchema: toolInputs.marketSnapshot,
      execute: safe(async ({symbol})=>{const db=await admin();const {loadFuturesAccount}=await import("./futures.server");const {futuresSymbol,futuresAccountState}=await import("./binance-futures.server");const a=await loadFuturesAccount(db,userId,acc.id);const limits=a.testnet?{data:(await import("./futures-testnet-limits")).TESTNET_FUTURES_LIMITS}:await db.from("futures_settings").select("*").eq("user_id",userId).maybeSingle();return {environment:a.testnet?"TESTNET":"PRODUCTION",market:await futuresSymbol(a,symbol),account:await futuresAccountState(a),limits:limits.data};}),
    });
    // Entry executor rechecks the separate Futures opt-in, certification, plan and risk limits on every call.
    if(live.futures) t["live_open_futures_scalp"] = tool({
      description: "USD-M Futures scalp only after separate Futures live opt-in and independent testnet certification. Bounded by saved margin, leverage and loss limits; broker protection required.",
      inputSchema: futuresTicket.omit({connectionId:true,confirmation:true,requestId:true}),
      execute: safe(async (input, opts) => {
        ctx.budget.claim("entries");
        const db = await admin();
        // Same authority as manual entries: current PASS certification bound to this account, never the legacy timestamp.
        if (!acc.testnet) { const { assertProductionFutures } = await import("./futures-authorization.server"); await assertProductionFutures(db, userId, acc.id); }
        await ctx.guard?.();
        const { autopilotRequestId } = await import("./autopilot-fence");
        // Deterministic per run + tool call: a duplicate execution hits the same idempotency claim instead of a second order.
        const requestId = ctx.runId && opts.toolCallId ? await autopilotRequestId(ctx.runId, opts.toolCallId) : crypto.randomUUID();
        const { openFutures } = await import("./futures.server");
        return openFutures(db, userId, { ...input, connectionId: acc.id, confirmation: acc.testnet ? "TESTNET" : "LIVE", requestId }, { beforeSubmit: ctx.guard });
      }),
    });

    t["live_open_binance_trade"] = tool({
      description: `REAL ${acc.testnet ? "testnet " : ""}order: market BUY on Binance spot account "${acc.label}" with a stop price (checked every minute) and optional take profit.`,
      inputSchema: liveToolInputs.openBinance,
      execute: safe(async ({ symbol, amountUsd, stopLoss, takeProfit }) => {
        if (marketOf(symbol)?.category !== "crypto") throw new Error("Binance live trades are crypto pairs only");
        ctx.budget.claim("entries");
        const db = await admin();
        const { loadAccount, openManual } = await import("./manual.server");
        const a = await loadAccount(db, userId, acc.id);
        if (a.exchange !== "binance") throw new Error("Live Binance account mismatch");
        await ctx.guard?.();
        const r = await openManual(db, userId, a, { symbol, side: "buy", amount: amountUsd, sl: stopLoss, tp: takeProfit });
        await audit(ctx, "live_open_binance_trade", { symbol, amountUsd, stopLoss, takeProfit, testnet: a.testnet }, { type: "position", id: r.positionId });
        return { ok: true, ...r };
      }),
    });
  }
  if (live.deriv) {
    const acc = live.deriv;
    t["live_deriv_symbols"] = tool({
      description: "Deriv instruments for a market (symbol codes for Multipliers).",
      inputSchema: liveToolInputs.derivSymbols,
      execute: safe(async ({ market }) => (await import("./deriv-trade.server")).derivSymbols(market)),
    });
    t["live_deriv_snapshot"] = tool({
      description: "Deriv price and indicators from real Deriv candles.",
      inputSchema: liveToolInputs.derivSnapshot,
      execute: safe(async ({ symbol, timeframe }) => {
        const { derivCandles } = await import("./deriv-trade.server");
        const { marketFacts } = await import("./market-facts");
        return marketFacts(await derivCandles(symbol, timeframe, 300), symbol, timeframe);
      }),
    });
    t["live_deriv_quote"] = tool({
      description: "Price check for a Deriv Multiplier WITHOUT buying: confirms the symbol/multiplier are valid and shows cost, commission and the account balance.",
      inputSchema: liveToolInputs.openDeriv,
      execute: safe(async (input) => {
        const db = await admin();
        const { loadAccount } = await import("./manual.server");
        const a = await loadAccount(db, userId, acc.id, "deriv");
        if (a.exchange !== "deriv" || !a.creds) throw new Error("Live Deriv account mismatch");
        const { quoteDerivMultiplier } = await import("./deriv-trade.server");
        return { ok: true, ...(await quoteDerivMultiplier(a.creds, a.testnet, input)) };
      }),
    });
    t["live_open_deriv_multiplier"] = tool({
      description: `REAL ${acc.testnet ? "demo-account " : "MONEY "}Deriv Multiplier on "${acc.label}": up/down, stake, multiplier, money stop loss (required) and optional take profit; Deriv closes it at those levels.`,
      inputSchema: liveToolInputs.openDeriv,
      execute: safe(async (input) => {
        ctx.budget.claim("entries");
        const db = await admin();
        const { loadAccount } = await import("./manual.server");
        const a = await loadAccount(db, userId, acc.id, "deriv");
        if (a.exchange !== "deriv" || !a.connId || !a.creds) throw new Error("Live Deriv account mismatch");
        const { openDerivMultiplier } = await import("./deriv-trade.server");
        await ctx.guard?.();
        const r = await openDerivMultiplier(db, userId, { connId: a.connId, testnet: a.testnet, creds: a.creds }, input);
        await audit(ctx, "live_open_deriv_multiplier", { ...input, contractId: r.contractId }, { type: "position", id: r.positionId });
        return { ok: true, ...r };
      }),
    });
  }
  return t;
}
