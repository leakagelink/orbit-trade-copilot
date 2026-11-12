// Deterministic paper Risk Engine (Phase 3). Pure: decides whether a paper entry may be placed and how large it is.
// Inputs come only from the frozen paper policy, the paper account limits and the paper ledger — never from AI output,
// so no AI-suggested quantity or leverage can reach a paper order. Spot, long-only, no leverage.
import { z } from "zod";
import type { CostModel } from "./backtest-costs";

export const PAPER_MIN_NOTIONAL = 1; // smallest paper order, in quote currency

export const paperRiskPolicySchema = z.object({
  riskPerTradePct: z.number().gt(0).max(5),
  positionSizePct: z.number().gt(0).max(100),
  maxPositionNotional: z.number().gt(0).max(1_000_000),
  stopLossPct: z.number().gt(0).max(50), // stop-loss is mandatory for every paper entry
  takeProfitPct: z.number().gt(0).max(500).nullable(),
  dailyLossLimit: z.number().gt(0).max(1_000_000),
  strategyBudget: z.number().gt(0).max(1_000_000),
  entryOrder: z.enum(["market", "limit"]),
  limitOffsetPct: z.number().min(0).max(10),
  orderTtlBars: z.number().int().min(1).max(10),
}).strict();
export type PaperRiskPolicy = z.infer<typeof paperRiskPolicySchema>;

export const paperCostSchema = z.object({
  feePct: z.number().min(0).max(1), spreadPct: z.number().min(0).max(1), slippagePct: z.number().min(0).max(1),
  maxParticipationPct: z.number().gt(0).max(100).nullable(),
}).strict();

export const paperAccountLimitsSchema = z.object({
  maxExposure: z.number().gt(0).max(10_000_000), maxDailyLoss: z.number().gt(0).max(10_000_000),
  maxOpenPositions: z.number().int().min(1).max(50), maxPositionNotional: z.number().gt(0).max(10_000_000),
}).strict();
export type PaperAccountLimits = z.infer<typeof paperAccountLimitsSchema>;

/** Paper account limits plus what the owner's other paper strategies currently hold (read from the paper ledger). */
export interface PaperAccountContext extends PaperAccountLimits { otherExposure: number; otherOpenPositions: number; otherDayNet: number }

export type PaperSizing =
  | { ok: true; qty: number; notional: number; estPrice: number; riskAmount: number; perUnitRiskPct: number; binding: string; caps: Record<string, number> }
  | { ok: false; reason: string; caps?: Record<string, number> };

export const floorQty = (q: number) => (q > 0 && Number.isFinite(q) ? Math.floor(q * 1e8 + 1e-6) / 1e8 : 0);

/**
 * Size a long spot paper entry. `estPrice` is the expected fill (signal close plus half-spread and slippage for market
 * orders, the limit price for limit orders). `dayNet` is today's realized paper net plus any unrealized loss.
 */
export function sizePaperEntry(i: { estPrice: number; equity: number; cash: number; dayNet: number; costs: CostModel; policy: PaperRiskPolicy; account: PaperAccountContext }): PaperSizing {
  const { policy: p, account: a, costs: c } = i;
  if (!(i.estPrice > 0) || !Number.isFinite(i.estPrice)) return { ok: false, reason: "No valid reference price" };
  if (!(p.stopLossPct > 0)) return { ok: false, reason: "A stop-loss is required for every paper entry" };
  if (!Number.isFinite(i.equity) || i.equity <= 0) return { ok: false, reason: "Paper strategy equity is exhausted" };
  if (i.dayNet <= -p.dailyLossLimit) return { ok: false, reason: `Strategy daily loss stop reached (${i.dayNet.toFixed(2)})` };
  if (a.otherDayNet + i.dayNet <= -a.maxDailyLoss) return { ok: false, reason: `Account daily paper loss stop reached (${(a.otherDayNet + i.dayNet).toFixed(2)})` };
  if (a.otherOpenPositions + 1 > a.maxOpenPositions) return { ok: false, reason: "Account maximum open paper positions reached" };
  // Loss per unit of notional if the stop is hit: the stop distance plus a full round trip of costs.
  const perUnitRiskPct = p.stopLossPct + 2 * c.feePct + c.spreadPct + 2 * c.slippagePct;
  const entryCostPct = c.feePct + c.spreadPct / 2 + c.slippagePct;
  const caps: Record<string, number> = {
    "risk per trade": (i.equity * p.riskPerTradePct) / 100 / (perUnitRiskPct / 100),
    "position size %": (i.equity * p.positionSizePct) / 100,
    "max position size": Math.min(p.maxPositionNotional, a.maxPositionNotional),
    "strategy budget": p.strategyBudget,
    "account exposure": a.maxExposure - a.otherExposure,
    "available cash": i.cash / (1 + entryCostPct / 100),
  };
  let binding = "", notional = Infinity;
  for (const [k, v] of Object.entries(caps)) if (v < notional) { notional = v; binding = k; }
  const qty = floorQty(notional / i.estPrice);
  const real = qty * i.estPrice;
  if (!(real >= PAPER_MIN_NOTIONAL)) return { ok: false, reason: `Below the minimum paper order (${PAPER_MIN_NOTIONAL}); limited by ${binding}`, caps };
  return { ok: true, qty, notional: real, estPrice: i.estPrice, riskAmount: (real * perUnitRiskPct) / 100, perUnitRiskPct, binding, caps };
}
