// AI Autopilot rules (pure). The autopilot acts only on the demo wallet / paper engine: tool inputs have no
// account, connection or mode fields, and strict schemas reject any attempt to pass them.
import { z } from "zod";
import { TIMEFRAMES } from "./strategy";
import { ARBITRAGE_EXCHANGES, ARBITRAGE_PAIRS } from "./arbitrage";

export const AUTOPILOT_MODEL = "claude-sonnet-5-5";
/** Model/tool round-trips per user message. */
export const AUTOPILOT_MAX_STEPS = 16;
/** Per user message: new paper entries (trades, scalps, arbitrage runs) and new bots. */
export const AUTOPILOT_LIMITS = { entries: 5, bots: 3 } as const;

export type BudgetKind = keyof typeof AUTOPILOT_LIMITS;
export function createRunBudget(limits: Record<BudgetKind, number> = AUTOPILOT_LIMITS) {
  const used: Record<BudgetKind, number> = { entries: 0, bots: 0 };
  return {
    claim(kind: BudgetKind) {
      if (used[kind] >= limits[kind]) throw new Error(`Autopilot limit reached: at most ${limits[kind]} new ${kind} per request. Ask again to continue.`);
      used[kind] += 1;
    },
    used: () => ({ ...used }),
  };
}

const PAPER_EXCHANGES = ["binance", "bybit", "okx", "kucoin", "coinbase"] as const;
const pair = z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/, "Use a pair like BTC/USDT");

export const toolInputs = {
  overview: z.strictObject({}),
  listMarkets: z.strictObject({ category: z.enum(["crypto", "forex", "commodities"]) }),
  marketSnapshot: z.strictObject({ symbol: z.string().min(3).max(20), timeframe: z.enum(TIMEFRAMES) }),
  createStrategy: z.strictObject({
    name: z.string().trim().min(1).max(60),
    description: z.string().max(500).optional(),
    config: z.record(z.string(), z.unknown()).describe("StrategyConfig JSON"),
  }),
  runBacktest: z.strictObject({
    strategyId: z.string().uuid(), exchange: z.enum(PAPER_EXCHANGES), days: z.number().int().min(7).max(365),
    capital: z.number().positive().max(1e7), feePct: z.number().min(0.01).max(2), slippagePct: z.number().min(0.01).max(2),
  }),
  startPaperBot: z.strictObject({
    name: z.string().trim().min(1).max(60), strategyId: z.string().uuid(), exchange: z.enum(PAPER_EXCHANGES), pair,
    timeframe: z.enum(TIMEFRAMES), capital: z.number().positive().max(1e7),
    size: z.number().positive().max(100), exposure: z.number().positive().max(100),
    sl: z.number().positive().max(99), tp: z.number().positive().nullable(), maxpos: z.number().int().positive().max(20), dll: z.number().positive().max(100).nullable(),
  }),
  stopBot: z.strictObject({ id: z.string().uuid(), status: z.enum(["paused", "stopped"]) }),
  openPaperTrade: z.strictObject({
    symbol: z.string().min(3).max(20), side: z.enum(["buy", "sell"]), amountUsd: z.number().min(1).max(1e6),
    stopLoss: z.number().positive(), takeProfit: z.number().positive().nullable(),
  }),
  openPaperScalp: z.strictObject({
    symbol: z.string().min(3).max(20), side: z.enum(["buy", "sell"]), amountUsd: z.number().min(1).max(1e6),
    tpPct: z.number().positive().max(10), slPct: z.number().positive().max(10), holdMin: z.number().int().min(1).max(240).nullable(),
  }),
  closePaperPosition: z.strictObject({ positionId: z.string().uuid() }),
  scanArbitrage: z.strictObject({
    pair: z.enum(ARBITRAGE_PAIRS), budget: z.number().min(10).max(100000),
    exchanges: z.array(z.enum(ARBITRAGE_EXCHANGES)).min(2).max(4).refine((v) => new Set(v).size === v.length, "Exchanges must be different"),
  }),
  runPaperArbitrage: z.strictObject({
    pair: z.enum(ARBITRAGE_PAIRS), budget: z.number().min(10).max(100000),
    buyExchange: z.enum(ARBITRAGE_EXCHANGES), sellExchange: z.enum(ARBITRAGE_EXCHANGES), minimumNetPct: z.number().min(0).max(100),
  }),
};

export const AUTOPILOT_SYSTEM = `You are AlgoVirt Autopilot, an AI trading operator for the signed-in user. Paper tools act on the demo wallet / paper engine. Real money is possible ONLY through the live_* tools, which exist only when the user enabled real-money Autopilot. You can never withdraw, transfer funds, change API keys, security or admin settings — say so if asked.
How to work:
- Use tools for every fact. Call get_account_overview first in a new task. Never invent prices, balances or results; use get_market_snapshot for prices/indicators.
- Algo workflow: design a StrategyConfig -> create_strategy -> run_backtest (realistic costs: feePct >= 0.1, slippagePct >= 0.05, 90+ days) -> only start_paper_bot when the backtest has >= 10 trades, positive net profit and max drawdown under 25%. Otherwise explain and iterate at most twice.
- Every trade needs a stop loss. Size small: one trade <= 10% of the wallet balance unless the user asks otherwise. The account's risk settings are enforced by the server; if a tool says "Blocked by risk settings", stop opening trades and report it.
- Scalping and arbitrage need the Elite plan; if a tool says the plan is missing, tell the user.
- Arbitrage: scan_arbitrage first; run_paper_arbitrage only when the best route's net after fees is positive.
- Past or simulated results never guarantee profit; say this once when reporting performance.
- Finish with a short summary: actions taken (with ids), results, and what the user should watch. Reply in the user's language (Hindi/Hinglish if they write that way). Be concise.
StrategyConfig example: {"pairs":["BTC/USDT"],"timeframe":"1h","indicators":[{"id":"rsi_1","type":"RSI","params":{"period":14}}],"entry":{"logic":"all","conditions":[{"left":"rsi_1","operator":"<","right":"30"}]},"exit":{"logic":"any","conditions":[{"left":"rsi_1","operator":">","right":"70"}]},"risk":{"stop_loss_pct":2,"take_profit_pct":4,"trailing_stop_pct":null,"position_size_pct":10,"capital_allocation":1000,"max_open_positions":1,"daily_loss_limit_pct":5}}
Indicator types: RSI, MACD, EMA, SMA, BBANDS, ATR, STOCH_RSI, VOLUME. Operators: <, >, <=, >=, crosses_above, crosses_below. Condition sides: indicator id, "price" or a number string. Timeframes: 1m, 5m, 15m, 30m, 1h, 4h, 1d. Strategy bots trade crypto pairs only.`;


// ---- Real-money Autopilot (only when the owner enabled it with typed confirmation) ----
const derivSymbol = z.string().regex(/^[A-Za-z0-9_]{2,24}$/, "Use a Deriv symbol from live_deriv_symbols");
export const DERIV_MARKETS = ["synthetic_index", "forex", "indices", "commodities", "cryptocurrency"] as const;

export const liveToolInputs = {
  openBinance: z.strictObject({
    symbol: pair, amountUsd: z.number().min(5).max(1e6).describe("USDT spent on this spot buy"),
    stopLoss: z.number().positive().describe("Absolute stop price below the current price"), takeProfit: z.number().positive().nullable(),
  }),
  closePosition: z.strictObject({ positionId: z.string().uuid() }),
  derivSymbols: z.strictObject({ market: z.enum(DERIV_MARKETS) }),
  derivSnapshot: z.strictObject({ symbol: derivSymbol, timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]) }),
  openDeriv: z.strictObject({
    symbol: derivSymbol, direction: z.enum(["up", "down"]),
    stake: z.number().min(1).max(100000).describe("Money put into the contract (the most it can lose)"),
    multiplier: z.number().int().min(1).max(2000),
    stopLossAmount: z.number().positive().describe("Close when the loss reaches this money amount (<= stake)"),
    takeProfitAmount: z.number().positive().nullable().describe("Close when the profit reaches this money amount"),
  }).refine((v) => v.stopLossAmount <= v.stake, { message: "stopLossAmount cannot exceed stake", path: ["stopLossAmount"] }),
};

export interface LiveAccounts { futures?: boolean; binance: { id: string; label: string; testnet: boolean } | null; deriv: { id: string; label: string; testnet: boolean } | null }
export interface RiskRow { max_daily_loss: number | null; max_open_exposure: number | null; trading_halted: boolean }

/** Reasons real-money Autopilot cannot be switched on. Empty = allowed. */
export function liveEnableProblems(input: { confirm: string; risk: RiskRow | null; binanceId: string | null; derivId: string | null }) {
  const out: string[] = [];
  if (input.confirm !== "LIVE") out.push("Type LIVE to confirm real-money trading");
  if (!input.binanceId && !input.derivId) out.push("Choose at least one connected account (Binance or Deriv)");
  if (!input.risk) out.push("Save your risk settings first (Risk page)");
  else {
    if (input.risk.trading_halted) out.push("Trading is halted by emergency stop — resume it on the Risk page first");
    if (input.risk.max_daily_loss == null || !(Number(input.risk.max_daily_loss) > 0)) out.push("Set a maximum daily loss on the Risk page");
    if (input.risk.max_open_exposure == null || !(Number(input.risk.max_open_exposure) > 0)) out.push("Set a maximum open exposure on the Risk page");
  }
  return out;
}

export function liveRules(acc: LiveAccounts) {
  const list = [acc.binance && `Binance spot "${acc.binance.label}"${acc.binance.testnet ? " (testnet)" : " (REAL MONEY)"}`, acc.deriv && `Deriv Multipliers "${acc.deriv.label}"${acc.deriv.testnet ? " (demo account)" : " (REAL MONEY)"}`].filter(Boolean).join(" and ");
  return `
REAL-MONEY TRADING IS ENABLED on: ${list}. live_* tools place real orders that can lose real money.
- You decide trade size yourself, but the server enforces the user's risk settings (max daily loss, max open exposure, max positions) and rejects anything above them. Risk at most ~2% of the account balance per trade and keep total open risk modest.
- Only enter with a clear, explained edge from live_deriv_snapshot / get_market_snapshot. Doing nothing is a valid, often best, decision. Never average down, never revenge-trade after a loss.
- Binance live is spot BUY only; always give a stop price below the current price. Deriv: use live_deriv_symbols then live_deriv_snapshot; every contract needs stopLossAmount (<= stake). Multipliers amplify moves; prefer low multipliers.
- If any tool says Blocked, halted or pending reconciliation, stop new entries and report it.`;
}

export function automaticRunPrompt(goal: string, live: boolean) {
  return `Automatic scheduled run (no human is watching in real time). ${goal.trim() ? `The user's standing goal: """${goal.trim()}"""` : "No specific goal set: look for careful, high-quality opportunities."}
1) get_account_overview. 2) Review and manage open ${live ? "live and paper" : "paper"} positions first (close ones whose thesis broke). 3) Only then consider at most a few new entries. 4) End with a 3-5 line summary of what you did and why.`;
}
