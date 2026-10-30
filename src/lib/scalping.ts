// Pure scalping rules (browser + server). Scalps are short manual trades with a tight, automatic stop, target and time limit.
import { WALLET_FEE, WALLET_SLIP } from "./wallet-math";
import { emptyStrategyConfig, type StrategyConfig } from "./strategy";

export const SCALP_TIMEFRAMES = ["1m", "5m", "15m"] as const;
export const SCALP_LIMITS = { minPct: 0.05, maxPct: 5, maxHoldMin: 240 } as const;

/** Demo-wallet round-trip cost in % of the trade (fees both sides + slippage both sides). */
export const WALLET_ROUND_TRIP_PCT = (WALLET_FEE + WALLET_SLIP) * 2 * 100;

export interface ScalpSettings { tpPct: number; slPct: number; holdMin: number | null }
export const DEFAULT_SCALP: ScalpSettings = { tpPct: 0.5, slPct: 0.25, holdMin: 15 };

/** Returns an error message, or null when the settings are allowed. Demo-wallet targets must beat the round-trip cost. */
export function validateScalp(s: ScalpSettings, demoWallet: boolean): string | null {
  const { minPct, maxPct, maxHoldMin } = SCALP_LIMITS;
  if (!(s.tpPct >= minPct && s.tpPct <= maxPct)) return `Take profit must be between ${minPct}% and ${maxPct}%`;
  if (!(s.slPct >= minPct && s.slPct <= maxPct)) return `Stop loss must be between ${minPct}% and ${maxPct}%`;
  if (s.holdMin != null && !(Number.isInteger(s.holdMin) && s.holdMin >= 1 && s.holdMin <= maxHoldMin)) return `Time limit must be 1–${maxHoldMin} minutes`;
  if (demoWallet && s.tpPct <= WALLET_ROUND_TRIP_PCT) return `Take profit must be above ${WALLET_ROUND_TRIP_PCT.toFixed(2)}% — fees and slippage would eat the whole profit`;
  return null;
}

/** Stop and target prices for a scalp entered at `price`. */
export function scalpBracket(side: "buy" | "sell", price: number, tpPct: number, slPct: number) {
  const up = (pct: number) => price * (1 + pct / 100), down = (pct: number) => price * (1 - pct / 100);
  return side === "buy" ? { sl: down(slPct), tp: up(tpPct) } : { sl: up(slPct), tp: down(tpPct) };
}

export type ScalpExit = "stop_loss" | "take_profit" | "time_stop";

/** Which exit (if any) a position hits at `price` and time `now`. Stop loss wins over target; both win over the time limit. */
export function scalpExit(p: { side: "buy" | "sell"; stop_loss: number | null; take_profit: number | null; max_hold_until: string | null }, price: number, now: number): ScalpExit | null {
  const long = p.side === "buy";
  if (p.stop_loss != null && (long ? price <= p.stop_loss : price >= p.stop_loss)) return "stop_loss";
  if (p.take_profit != null && (long ? price >= p.take_profit : price <= p.take_profit)) return "take_profit";
  if (p.max_hold_until != null && now >= Date.parse(p.max_hold_until)) return "time_stop";
  return null;
}

/** Session stats from closed scalp trades (net of fees). */
export function scalpStats(trades: { realized_pnl: number; fees: number }[]) {
  const nets = trades.map((t) => Number(t.realized_pnl) - Number(t.fees));
  const wins = nets.filter((n) => n > 0).length;
  return { count: nets.length, wins, winRate: nets.length ? (wins / nets.length) * 100 : 0, net: nets.reduce((a, b) => a + b, 0) };
}

/** Ready-made scalping bot strategies (short timeframes, tight stops). */
export function scalpTemplates(pair = "BTC/USDT"): { name: string; description: string; config: StrategyConfig }[] {
  const base = (timeframe: string, sl: number, tp: number): StrategyConfig => ({
    ...emptyStrategyConfig(), pairs: [pair], timeframe,
    risk: { ...emptyStrategyConfig().risk, stop_loss_pct: sl, take_profit_pct: tp, position_size_pct: 10, max_open_positions: 1, daily_loss_limit_pct: 3 },
  });
  return [
    {
      name: "EMA 9/21 momentum scalp", description: "1-minute: buys when the fast EMA crosses above the slow EMA with RSI above 50.",
      config: { ...base("1m", 0.3, 0.6), indicators: [{ id: "ema_9", type: "EMA", params: { period: 9 } }, { id: "ema_21", type: "EMA", params: { period: 21 } }, { id: "rsi_7", type: "RSI", params: { period: 7 } }],
        entry: { logic: "all", conditions: [{ left: "ema_9", operator: "crosses_above", right: "ema_21" }, { left: "rsi_7", operator: ">", right: "50" }] },
        exit: { logic: "any", conditions: [{ left: "ema_9", operator: "crosses_below", right: "ema_21" }] } },
    },
    {
      name: "RSI dip scalp", description: "1-minute: buys a quick oversold bounce in an uptrend, exits when RSI is stretched.",
      config: { ...base("1m", 0.4, 0.7), indicators: [{ id: "rsi_7", type: "RSI", params: { period: 7 } }, { id: "ema_50", type: "EMA", params: { period: 50 } }],
        entry: { logic: "all", conditions: [{ left: "rsi_7", operator: "crosses_above", right: "25" }, { left: "price", operator: ">", right: "ema_50" }] },
        exit: { logic: "any", conditions: [{ left: "rsi_7", operator: ">", right: "70" }] } },
    },
    {
      name: "Stoch RSI bounce scalp", description: "5-minute: buys when Stochastic RSI turns up from oversold above the 100 EMA.",
      config: { ...base("5m", 0.5, 0.9), indicators: [{ id: "stoch_14", type: "STOCH_RSI", params: { period: 14, k: 3, d: 3 } }, { id: "ema_100", type: "EMA", params: { period: 100 } }],
        entry: { logic: "all", conditions: [{ left: "stoch_14", operator: "crosses_above", right: "20" }, { left: "price", operator: ">", right: "ema_100" }] },
        exit: { logic: "any", conditions: [{ left: "stoch_14", operator: ">", right: "80" }] } },
    },
  ];
}
