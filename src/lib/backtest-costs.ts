// Pure trading-cost model for historical simulation: fees, bid/ask spread, slippage, liquidity cap and funding.
// Spread and slippage are embedded in fill prices (never deducted twice); they are also reported separately.

export interface CostModel {
  /** Commission per side, % of fill notional. */ feePct: number;
  /** Full bid/ask spread, % of the reference price; half is paid on each side. */ spreadPct: number;
  /** Adverse slippage per side, % of the reference price. */ slippagePct: number;
  /** Max share of a bar's traded volume one fill may take (null = no cap). */ maxParticipationPct: number | null;
}
export type Side = "buy" | "sell";
export interface FundingRate { t: number; rate: number }

export function validateCosts(c: CostModel) {
  const bad = [c.feePct, c.spreadPct, c.slippagePct].some((x) => !Number.isFinite(x) || x < 0 || x > 5)
    || (c.maxParticipationPct !== null && (!Number.isFinite(c.maxParticipationPct) || c.maxParticipationPct <= 0 || c.maxParticipationPct > 100));
  if (bad) throw new Error("Cost assumptions must be between 0% and 5% (participation between 0% and 100%)");
}

/** Buy fills above the reference price, sell fills below it, by half the spread plus slippage. */
export function fillAt(side: Side, ref: number, qty: number, c: CostModel) {
  const half = c.spreadPct / 200, slip = c.slippagePct / 100, sign = side === "buy" ? 1 : -1;
  const price = ref * (1 + sign * (half + slip));
  return { price, fee: price * qty * (c.feePct / 100), spreadCost: ref * qty * half, slippageCost: ref * qty * slip };
}

/** Caps a fill at the configured share of the bar's volume (base units). */
export function liquidityCap(qty: number, barVolume: number, c: CostModel) {
  if (c.maxParticipationPct === null) return qty;
  return Math.max(0, Math.min(qty, barVolume * (c.maxParticipationPct / 100)));
}

/** Cash change from one funding event: positive rate → longs pay, shorts receive. */
export function fundingCashFlow(direction: 1 | -1, qty: number, markPrice: number, rate: number) {
  return -direction * qty * markPrice * rate;
}

/**
 * Funding history must cover the whole simulated period with no gap longer than 1.5 intervals; otherwise the
 * Futures backtest is rejected rather than assuming zero funding.
 */
export function checkFundingCoverage(rates: FundingRate[] | undefined, start: number, end: number, intervalMs: number) {
  if (!rates?.length) return "Futures backtest rejected: no reliable funding-rate history is available, and zero funding is never assumed.";
  const sorted = [...rates].sort((a, b) => a.t - b.t);
  if (sorted.some((r) => !Number.isFinite(r.t) || !Number.isFinite(r.rate) || Math.abs(r.rate) > 0.05)) return "Futures backtest rejected: funding-rate history contains invalid values.";
  const first = sorted[0]!, last = sorted.at(-1)!;
  if (first.t > start + intervalMs * 1.5 || last.t < end - intervalMs * 1.5) return "Futures backtest rejected: funding-rate history does not cover the whole period.";
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.t - sorted[i - 1]!.t > intervalMs * 1.5) return "Futures backtest rejected: funding-rate history has a gap.";
  return null;
}
