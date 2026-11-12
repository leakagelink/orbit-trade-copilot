/** Canonical cash-flow contract: gross excludes funding and commissions. */
export interface AccountedTrade {
  realized_pnl: number | string | null;
  fees: number | string | null;
  funding_pnl?: number | string | null;
  costs_verified?: boolean;
}
export function tradeNet(t: AccountedTrade): number {
  if (t.costs_verified === false || t.realized_pnl == null || t.fees == null) return NaN;
  const gross = Number(t.realized_pnl), fees = Number(t.fees), funding = Number(t.funding_pnl ?? 0);
  if (![gross, fees, funding].every(Number.isFinite) || fees < 0) return NaN;
  return gross + funding - fees;
}
export type ExecutionEnvironment = 'paper' | 'testnet' | 'production' | 'legacy_unknown';
export function sameEnvironment(recorded: string | null | undefined, testnet: boolean) {
  return recorded === (testnet ? 'testnet' : 'production');
}