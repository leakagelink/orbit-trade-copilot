// Independent, read-only position-size preview. Pure and browser-safe.
// Inputs come only from market data and the account's saved risk limits; no AI output is accepted,
// so model text can never set entry, quantity, size, leverage, stop-loss or take-profit.
export interface PreviewCandle { t: number; o: number; h: number; l: number; c: number }
export interface AccountLimits { maxOpenExposure: number | null; maxDailyLoss: number | null; maxTotalPositions: number | null; halted: boolean }
export interface AccountState { openExposure: number; openPositions: number; dailyNet: number }
export interface RiskPreviewInput {
  referencePrice: number | null; // last completed daily close from market data
  asOf: string | null;
  candles: PreviewCandle[];
  limits: AccountLimits | null; // null = risk settings missing/unreadable
  account: AccountState | null; // null = positions/trades unreadable
}
export interface RiskPreview {
  status: "estimate" | "blocked" | "unavailable";
  basis: "risk_engine";
  referencePrice: number | null; asOf: string | null;
  stopDistance: number | null; // 1 x 14-day ATR
  quantity: number | null; positionValue: number | null; maxLossAtStop: number | null;
  leverage: "1x (spot research estimate)";
  bindingLimit: "exposure" | "daily_loss" | null;
  remaining: { exposure: number | null; dailyLoss: number | null; positions: number | null };
  blockReason: string | null;
  unavailable: string[];
  labels: string[];
}

/** 14-day average true range over completed candles (same method as the research scenario). */
export function atr14(candles: PreviewCandle[]): number | null {
  const c = candles.slice(-15);
  if (c.length !== 15) return null;
  const ranges = c.slice(1).map((x, i) => { const prev = c[i]!.c; return Math.max(x.h - x.l, Math.abs(x.h - prev), Math.abs(x.l - prev)); });
  const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

const LABELS = [
  "Estimate only — calculated by the Risk Engine from your saved limits, not by AI. Nothing is ordered.",
  "Reference price is the last completed daily close, not a live quote. Fees, slippage and spread are not included.",
  "Stop distance is one 14-day average true range from market data.",
];

export function riskPreview(i: RiskPreviewInput): RiskPreview {
  const unavailable: string[] = [];
  const price = i.referencePrice !== null && Number.isFinite(i.referencePrice) && i.referencePrice > 0 ? i.referencePrice : null;
  if (price === null) unavailable.push("Reference price unavailable");
  const stop = atr14(i.candles);
  if (stop === null) unavailable.push("14-day volatility unavailable");
  else if (price !== null && stop >= price / 2) unavailable.push("Volatility too large relative to price for a stop estimate");
  if (!i.limits) unavailable.push("Account risk settings unavailable — save risk settings first");
  if (!i.account) unavailable.push("Account exposure or daily results unavailable");
  const L = i.limits, A = i.account;
  if (L && L.maxOpenExposure === null) unavailable.push("Maximum open exposure is not set");
  if (L && L.maxDailyLoss === null) unavailable.push("Daily loss limit is not set");
  const remainingExposure = L?.maxOpenExposure != null && A ? Math.max(0, L.maxOpenExposure - A.openExposure) : null;
  const remainingLoss = L?.maxDailyLoss != null && A ? Math.max(0, L.maxDailyLoss + Math.min(0, A.dailyNet)) : null;
  const remainingPositions = L?.maxTotalPositions != null && A ? Math.max(0, L.maxTotalPositions - A.openPositions) : null;
  const base = { basis: "risk_engine" as const, referencePrice: price, asOf: i.asOf, stopDistance: stop, leverage: "1x (spot research estimate)" as const, remaining: { exposure: remainingExposure, dailyLoss: remainingLoss, positions: remainingPositions }, labels: LABELS };
  const empty = { quantity: null, positionValue: null, maxLossAtStop: null, bindingLimit: null };
  let block: string | null = null;
  if (L?.halted) block = "Trading is halted by the emergency stop";
  else if (remainingPositions === 0) block = "Maximum open positions reached";
  else if (remainingExposure === 0) block = "Maximum open exposure reached";
  else if (remainingLoss === 0) block = "Daily loss limit reached";
  if (block) return { ...base, ...empty, status: "blocked", blockReason: block, unavailable };
  if (unavailable.length || price === null || stop === null || remainingExposure === null || remainingLoss === null) return { ...base, ...empty, status: "unavailable", blockReason: null, unavailable };
  const byExposure = remainingExposure / price, byLoss = remainingLoss / stop;
  const quantity = Math.min(byExposure, byLoss);
  return { ...base, status: "estimate", quantity, positionValue: quantity * price, maxLossAtStop: quantity * stop, bindingLimit: byExposure <= byLoss ? "exposure" : "daily_loss", blockReason: null, unavailable };
}
