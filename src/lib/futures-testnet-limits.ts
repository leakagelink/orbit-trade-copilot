// Fixed Binance Futures Testnet limits. Testnet operations never read or write the production
// futures_settings record; these values cannot be edited from the app.
import { futuresLimitProblem, futuresRiskReserve, type FuturesTicket } from "./futures";

export interface TestnetFuturesLimits {
  maxMargin: number; maxLossReserve: number; maxDailyLoss: number; maxExposure: number; maxOpenPositions: number; maxLeverage: number;
}
export const TESTNET_FUTURES_LIMITS: Readonly<TestnetFuturesLimits> = Object.freeze({
  maxMargin: 5, // USDT margin per trade
  maxLossReserve: 2, // USDT loss reserve per trade
  maxDailyLoss: 2, // USDT net loss per UTC day (Testnet trades only)
  maxExposure: 10, // USDT open notional (Testnet positions only)
  maxOpenPositions: 1,
  maxLeverage: 10,
});

/** Ticket-level check, before any exchange call. */
export function testnetTicketProblem(t: Pick<FuturesTicket, "margin" | "leverage" | "slPct">, L: Readonly<TestnetFuturesLimits>) {
  const p = futuresLimitProblem(t, { max_margin: L.maxMargin, max_leverage: L.maxLeverage, max_loss: L.maxLossReserve });
  return p ? `Testnet limit: ${p.replace(/^Futures /, "")}` : null;
}

export interface TestnetAccountState {
  halted: boolean | null; // production emergency stop (covers both environments); null = unavailable
  openPositions: number; exposure: number; dailyNet: number; newCost: number; slPct: number;
}
/** Account-level check using only Testnet positions/trades plus the production stop flag. */
export function testnetAccountProblem(s: TestnetAccountState, L: Readonly<TestnetFuturesLimits>): string | null {
  if (s.halted === null) return "Risk authority unavailable";
  if (s.halted) return "Trading halted by the emergency stop (it covers Testnet too)";
  if (![s.openPositions, s.exposure, s.dailyNet, s.newCost, s.slPct].every(Number.isFinite) || s.newCost <= 0) return "Testnet account evidence unavailable";
  if (s.openPositions >= L.maxOpenPositions) return "Testnet limit: open position limit reached";
  if (s.exposure + s.newCost > L.maxExposure + 1e-9) return "Testnet limit: maximum exposure exceeded";
  if (s.dailyNet <= -L.maxDailyLoss) return "Testnet limit: daily loss limit reached";
  if (s.dailyNet - futuresRiskReserve(s.newCost, s.slPct) < -L.maxDailyLoss - 1e-9) return "Testnet limit: loss reserve exceeds the remaining daily loss allowance";
  return null;
}
