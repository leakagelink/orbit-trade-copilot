// Central Risk Engine (shared by Engine A — research — and Engine B — Futures scalping). Pure and deterministic.
// A trade PROPOSAL plus a server-gathered risk context in → ACCEPT / REJECT / INSUFFICIENT_DATA out, with every check
// listed. The proposal schema has no quantity, notional, leverage or authorization field (strict: such fields are
// refused), so no AI output can size, lever or authorize a trade. Sizing, leverage and the liquidation buffer are
// computed here from limits the server read. ACCEPT means "within risk limits"; it is NOT an execution authorization
// and nothing in this module can place, route or convert to an order.
import { z } from "zod";

export const CENTRAL_RISK_VERSION = "central-risk-v1" as const;
export type RiskVerdict = "ACCEPT" | "REJECT" | "INSUFFICIENT_DATA";
export type CheckStatus = "pass" | "fail" | "missing" | "not_applicable";
export interface RiskCheck { id: string; status: CheckStatus; detail: string }

export const tradeProposalSchema = z.object({
  proposalId: z.string().min(8).max(200), // idempotency key: one evaluation authority per proposal
  engine: z.enum(["research", "scalp_intraday", "scalp_ultrafast"]),
  strategyId: z.string().min(1).max(200),
  symbol: z.string().regex(/^[A-Z0-9]{2,15}\/?[A-Z0-9]{2,10}$/),
  market: z.enum(["spot", "usdm_futures"]),
  environment: z.enum(["paper", "testnet", "live"]),
  side: z.enum(["LONG", "SHORT"]),
  referencePrice: z.number().positive().nullable(), // untrusted: never used for sizing
  stopPrice: z.number().positive().nullable(),       // required; null → REJECT
  takeProfitPrice: z.number().positive().nullable(),
  createdAt: z.number().int().positive(),
}).strict();
export type TradeProposal = z.infer<typeof tradeProposalSchema>;

export interface RiskLimits {
  maxExposure: number | null; maxDailyLoss: number | null; maxPositions: number | null;
  maxLossPerTrade: number | null; maxMarginPerTrade: number | null; maxLeverage: number | null;
  liquidationBufferPct: number | null; // minimum distance between stop and liquidation, % of entry
  maxDataAgeMs: number | null; maxProposalAgeMs: number | null;
  roundTripCostPct: number | null;     // fees + spread + slippage both sides, % of notional
}
export interface RiskContext {
  now: number;
  account: { equity: number | null; availableMargin: number | null; openExposure: number | null; openPositions: number | null; dayNet: number | null; halted: boolean | null; environmentHalted: boolean | null } | null;
  limits: RiskLimits | null;
  strategy: { budget: number | null; usedLoss: number | null } | null;
  market: { markPrice: number | null; markTimestamp: number | null; stepSize: number | null; minNotional: number | null; maintenanceMarginRate: number | null } | null;
  orders: { sameProposalSeen: boolean | null; unresolvedOrders: number | null; openPositionOnSymbol: boolean | null } | null;
}
export interface RiskSizing { qty: number; notional: number; margin: number; leverage: number; riskAmount: number; entryEstimate: number; liquidationPrice: number | null; binding: string }
export interface RiskDecision { version: typeof CENTRAL_RISK_VERSION; proposalId: string | null; verdict: RiskVerdict; checks: RiskCheck[]; sizing: RiskSizing | null; executionAuthorized: false; note: string }

const NOTE = "Risk evaluation only. ACCEPT is not an execution authorization; no order has been placed.";
const fin = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
export const floorStep = (q: number, step: number) => (step > 0 ? Math.floor(q / step + 1e-9) * step : q);

/** Isolated-margin liquidation estimate (ignores fees/funding): long entry·(1 − 1/L + mmr), short entry·(1 + 1/L − mmr). */
export function liquidationPrice(side: "LONG" | "SHORT", entry: number, leverage: number, mmr: number) {
  return side === "LONG" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function evaluateProposal(raw: unknown, ctx: RiskContext): RiskDecision {
  const checks: RiskCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => { checks.push({ id, status, detail }); };
  const done = (sizing: RiskSizing | null, proposalId: string | null): RiskDecision => {
    const verdict: RiskVerdict = checks.some((c) => c.status === "fail") ? "REJECT" : checks.some((c) => c.status === "missing") ? "INSUFFICIENT_DATA" : "ACCEPT";
    return { version: CENTRAL_RISK_VERSION, proposalId, verdict, checks, sizing: verdict === "ACCEPT" ? sizing : null, executionAuthorized: false, note: NOTE };
  };
  const parsed = tradeProposalSchema.safeParse(raw);
  if (!parsed.success) { add("proposal_schema", "fail", `Proposal refused: ${parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"} ${i.message}`).join("; ")}`); return done(null, null); }
  const p = parsed.data; add("proposal_schema", "pass", "Proposal is well-formed and carries no quantity, leverage or authorization");
  const { account: a, limits: l, market: m, orders: o, strategy: s } = ctx;
  if (!a || !l || !m || !o) { add("context", "missing", "Account, limits, market or order state could not be read"); return done(null, p.proposalId); }
  const futures = p.market === "usdm_futures";

  // Emergency stop and duplicate / unknown-outcome checks first: they never depend on prices.
  if (a.halted === null || (futures && a.environmentHalted === null)) add("emergency_stop", "missing", "Emergency-stop state unknown");
  else add("emergency_stop", a.halted || a.environmentHalted ? "fail" : "pass", a.halted ? "Account emergency stop is on" : a.environmentHalted ? `Emergency stop is on for ${p.environment}` : "No emergency stop");
  if (o.sameProposalSeen === null) add("duplicate", "missing", "Cannot confirm the proposal is new"); else add("duplicate", o.sameProposalSeen ? "fail" : "pass", o.sameProposalSeen ? "This proposal was already evaluated or submitted" : "New proposal");
  if (o.unresolvedOrders === null) add("unknown_outcomes", "missing", "Order history unavailable");
  else add("unknown_outcomes", o.unresolvedOrders > 0 ? "fail" : "pass", o.unresolvedOrders > 0 ? `${o.unresolvedOrders} order(s) with an unknown outcome must be reconciled first` : "No unresolved orders");
  if (o.openPositionOnSymbol === null) add("one_position_per_symbol", "missing", "Open positions unknown");
  else add("one_position_per_symbol", o.openPositionOnSymbol ? "fail" : "pass", o.openPositionOnSymbol ? `A position on ${p.symbol} is already open` : "No position on this symbol");

  // Freshness: proposal and market data.
  if (!fin(l.maxProposalAgeMs)) add("proposal_fresh", "missing", "No maximum proposal age configured");
  else add("proposal_fresh", ctx.now - p.createdAt > l.maxProposalAgeMs || p.createdAt > ctx.now + 5_000 ? "fail" : "pass", `Proposal age ${Math.round((ctx.now - p.createdAt) / 1000)} s (max ${Math.round(l.maxProposalAgeMs / 1000)} s)`);
  if (!fin(m.markPrice) || m.markPrice <= 0 || !fin(m.markTimestamp)) add("market_data", "missing", "No verified market price with a timestamp");
  else if (!fin(l.maxDataAgeMs)) add("market_data", "missing", "No maximum data age configured");
  else add("market_data", ctx.now - m.markTimestamp > l.maxDataAgeMs ? "fail" : "pass", `Price age ${ctx.now - m.markTimestamp} ms (max ${l.maxDataAgeMs} ms); AI reference prices are ignored`);

  // Stop-loss requirement, against the verified price (not the AI reference price).
  const mark = fin(m.markPrice) ? m.markPrice : null;
  if (p.stopPrice === null) add("stop_loss", "fail", "A stop-loss is required");
  else if (mark === null) add("stop_loss", "missing", "Cannot validate the stop without a verified price");
  else {
    const ok = p.side === "LONG" ? p.stopPrice < mark : p.stopPrice > mark;
    add("stop_loss", ok ? "pass" : "fail", ok ? `Stop ${((Math.abs(mark - p.stopPrice) / mark) * 100).toFixed(3)}% from the verified price` : "Stop is on the wrong side of the verified price");
  }
  if (p.takeProfitPrice !== null && mark !== null) {
    const ok = p.side === "LONG" ? p.takeProfitPrice > mark : p.takeProfitPrice < mark;
    add("take_profit", ok ? "pass" : "fail", ok ? "Target is beyond the verified price" : "Target is on the wrong side of the verified price");
  }

  // Loss budgets: account daily loss, strategy budget, per-trade maximum. Remaining room = the smallest.
  const missingNums = (id: string, xs: (number | null | undefined)[], what: string) => { if (xs.some((x) => !fin(x))) { add(id, "missing", what); return true; } return false; };
  let room = Infinity, binding = "";
  const bind = (name: string, v: number) => { if (v < room) { room = v; binding = name; } };
  if (!missingNums("daily_loss", [l.maxDailyLoss, a.dayNet], "Daily loss limit or today's result unknown")) {
    const left = l.maxDailyLoss! + Math.min(0, a.dayNet!);
    add("daily_loss", left > 0 ? "pass" : "fail", left > 0 ? `${left.toFixed(2)} of daily loss allowance left` : "Daily loss limit reached");
    bind("daily loss allowance", left);
  }
  if (!s || !fin(s.budget) || !fin(s.usedLoss)) add("strategy_budget", "missing", "No risk budget configured for this strategy");
  else { const left = s.budget - s.usedLoss; add("strategy_budget", left > 0 ? "pass" : "fail", left > 0 ? `${left.toFixed(2)} of strategy risk budget left` : "Strategy risk budget used up"); bind("strategy risk budget", left); }
  if (!missingNums("loss_per_trade", [l.maxLossPerTrade], "No maximum loss per trade configured")) { add("loss_per_trade", "pass", `Max loss per trade ${l.maxLossPerTrade}`); bind("max loss per trade", l.maxLossPerTrade!); }
  if (!missingNums("position_count", [l.maxPositions, a.openPositions], "Position limit or open positions unknown")) {
    add("position_count", a.openPositions! + 1 > l.maxPositions! ? "fail" : "pass", `${a.openPositions} open of ${l.maxPositions} allowed`);
  }
  let exposureRoom = Infinity;
  if (!missingNums("exposure", [l.maxExposure, a.openExposure], "Exposure limit or open exposure unknown")) {
    exposureRoom = l.maxExposure! - a.openExposure!;
    add("exposure", exposureRoom > 0 ? "pass" : "fail", `${Math.max(0, exposureRoom).toFixed(2)} of account exposure left`);
  }
  if (missingNums("costs", [l.roundTripCostPct], "No cost assumption configured")) { /* recorded */ }
  if (futures) missingNums("margin_inputs", [a.availableMargin, l.maxMarginPerTrade, l.maxLeverage, l.liquidationBufferPct, m.maintenanceMarginRate], "Margin, leverage, liquidation-buffer or maintenance-margin inputs unknown");
  missingNums("lot_rules", [m.stepSize, m.minNotional], "Exchange lot size or minimum notional unknown");
  if (checks.some((c) => c.status !== "pass" && c.status !== "not_applicable")) return done(null, p.proposalId);

  // Sizing from the stop distance plus round-trip costs; then exposure, margin and leverage caps.
  const entry = mark!, stop = p.stopPrice!;
  const perUnitLoss = Math.abs(entry - stop) + entry * (l.roundTripCostPct! / 100);
  let notional = (room / perUnitLoss) * entry;
  if (exposureRoom < notional) { notional = exposureRoom; binding = "account exposure"; }
  let leverage = 1, liq: number | null = null;
  if (futures) {
    const marginRoom = Math.min(a.availableMargin!, l.maxMarginPerTrade!);
    if (notional / l.maxLeverage! > marginRoom) { notional = marginRoom * l.maxLeverage!; binding = "available margin × max leverage"; }
    leverage = Math.max(1, Math.min(l.maxLeverage!, Math.ceil(notional / marginRoom)));
    // Liquidation buffer: the stop must trigger well before liquidation. If it does not, step leverage DOWN (shrinking
    // the size to what the margin allows at that leverage); leverage is never raised to make a trade fit.
    const gap = (L: number) => ((p.side === "LONG" ? stop - liquidationPrice(p.side, entry, L, m.maintenanceMarginRate!) : liquidationPrice(p.side, entry, L, m.maintenanceMarginRate!) - stop) / entry) * 100;
    let L = leverage;
    while (L > 1 && gap(L) < l.liquidationBufferPct!) L--;
    if (gap(L) < l.liquidationBufferPct!) { add("liquidation_buffer", "fail", `Stop is ${gap(L).toFixed(2)}% from estimated liquidation even at 1× (minimum ${l.liquidationBufferPct}%)`); return done(null, p.proposalId); }
    if (L < leverage) { notional = Math.min(notional, marginRoom * L); binding = "liquidation buffer"; leverage = L; }
    liq = liquidationPrice(p.side, entry, leverage, m.maintenanceMarginRate!);
    add("liquidation_buffer", "pass", `Stop ${gap(leverage).toFixed(2)}% before estimated liquidation at ${leverage}×`);
    add("leverage", "pass", `${leverage}× (maximum ${l.maxLeverage}×), chosen by the Risk Engine`);
  } else { add("liquidation_buffer", "not_applicable", "Spot: no leverage"); add("leverage", "not_applicable", "Spot: 1×"); }
  const qty = floorStep(notional / entry, m.stepSize!);
  const real = qty * entry;
  if (!(qty > 0) || real < m.minNotional!) { add("min_notional", "fail", `Size ${real.toFixed(2)} is below the exchange minimum ${m.minNotional} (limited by ${binding})`); return done(null, p.proposalId); }
  add("min_notional", "pass", `Size ${real.toFixed(2)} meets the exchange minimum`);
  return done({ qty, notional: real, margin: real / leverage, leverage, riskAmount: (real / entry) * perUnitLoss, entryEstimate: entry, liquidationPrice: liq, binding }, p.proposalId);
}
