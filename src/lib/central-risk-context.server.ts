// Server-side context builder for the Central Risk Engine (Phase 4A: DESIGN + read-only implementation).
// Reads, with SELECT only: account risk limits, Futures limits, the strategy budget, open positions, open-order state,
// today's realized result, exposure and the emergency stop; mark price, lot rules and available margin come from
// injected read ports. Any critical read that fails leaves its section null/unknown, so evaluateProposal returns
// INSUFFICIENT_DATA — never a guessed value.
//
// NOT CONNECTED to order submission. Nothing in the app calls this yet; it imports no order, credential or exchange
// adapter module (import-graph test), cannot write (the db handle exposes only from().select()), and ACCEPT is never an
// execution authorization. See docs/design/central-risk-futures-integration.md for the proposed gate.
import { evaluateProposal, tradeProposalSchema, type RiskContext, type RiskDecision, type RiskLimits, type TradeProposal } from "./central-risk";
import { TESTNET_FUTURES_LIMITS } from "./futures-testnet-limits";
import { tradeNet } from "./trade-accounting";

/** Proposed policy values with no database home yet. Owner approval is required before any enforcement. */
export const CENTRAL_RISK_POLICY_PROPOSAL = Object.freeze({ liquidationBufferPct: 2, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 });

type Result = { data: unknown; error: unknown; count?: number | null };
export interface SelectQuery extends PromiseLike<Result> {
  eq(column: string, value: unknown): SelectQuery; in(column: string, values: unknown[]): SelectQuery; gte(column: string, value: unknown): SelectQuery;
  maybeSingle(): PromiseLike<Result>;
}
export interface SelectOnlyDb { from(table: string): { select(columns: string, options?: { count?: "exact"; head?: boolean }): SelectQuery } }
/** Narrows any Supabase-style client to SELECT. insert/update/upsert/delete/rpc are simply not reachable. */
export function selectOnly(db: { from(t: string): { select(c: string, o?: { count?: "exact"; head?: boolean }): unknown } }): SelectOnlyDb {
  return { from: (t) => ({ select: (c, o) => db.from(t).select(c, o) as SelectQuery }) };
}

export interface RiskReadPorts {
  db: SelectOnlyDb;
  now(): number;
  markPrice(symbol: string): Promise<{ markPrice: number; time: number } | null>;
  symbolRules(symbol: string): Promise<{ stepSize: number; minNotional: number; maintenanceMarginRate: number | null } | null>;
  /** Live/Testnet: the exchange's available balance via the existing signed GET (not wired in Phase 4A → null). */
  availableMargin(): Promise<number | null>;
  /** Losses already charged to the strategy today. No attribution exists for real trades yet → null. */
  strategyUsedLoss(strategyId: string): Promise<number | null>;
}
export interface ReadLog { source: string; ok: boolean; detail: string }

const n = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const pair = (s: string) => s.replace("/", "").toUpperCase();

/** Builds the RiskContext for a live or Testnet USD-M proposal. Paper proposals use the paper engine's own context. */
export async function buildFuturesRiskContext(ports: RiskReadPorts, userId: string, proposal: TradeProposal): Promise<{ context: RiskContext; reads: ReadLog[] }> {
  const reads: ReadLog[] = [];
  const log = (source: string, ok: boolean, detail: string) => { reads.push({ source, ok, detail }); return ok; };
  const now = ports.now();
  const empty: RiskContext = { now, account: null, limits: null, strategy: null, market: null, orders: null };
  if (proposal.market !== "usdm_futures" || proposal.environment === "paper") { log("scope", false, "Only live/Testnet USD-M proposals are built here"); return { context: empty, reads }; }
  const env = proposal.environment === "testnet" ? "testnet" : "production";
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const q = ports.db;
  const [risk, fut, budget, pos, unresolved, same, trades] = await Promise.all([
    q.from("risk_settings").select("max_daily_loss,max_open_exposure,max_total_positions,trading_halted").eq("user_id", userId).maybeSingle(),
    env === "production" ? q.from("futures_settings").select("max_leverage,max_loss,max_margin").eq("user_id", userId).maybeSingle() : Promise.resolve({ data: null, error: null } as Result),
    q.from("strategy_risk_budgets").select("max_loss").eq("user_id", userId).eq("strategy_id", proposal.strategyId).eq("environment", env).maybeSingle(),
    q.from("positions").select("trading_pair,entry_price,quantity,unrealized_pnl").eq("user_id", userId).eq("is_open", true).eq("execution_environment", env),
    // Production keeps the existing account-wide pending check; Testnet checks Testnet intents only.
    (env === "production" ? q.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId) : q.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("execution_environment", "testnet")).in("status", ["pending", "open", "partially_filled"]),
    q.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("idempotency_key", `futures:${proposal.proposalId}`),
    q.from("trades").select("realized_pnl,fees,funding_pnl,costs_verified").eq("user_id", userId).eq("execution_environment", env).gte("closed_at", dayStart.toISOString()),
  ]);
  const [mark, rules, margin, used] = await Promise.all([ports.markPrice(pair(proposal.symbol)), ports.symbolRules(pair(proposal.symbol)), ports.availableMargin(), ports.strategyUsedLoss(proposal.strategyId)]);

  const r = (log("risk_settings", !risk.error && !!risk.data, risk.error ? "read failed" : risk.data ? "read" : "not saved") ? risk.data : null) as Record<string, unknown> | null;
  const f = env === "production" ? ((log("futures_settings", !fut.error && !!fut.data, fut.error ? "read failed" : fut.data ? "read" : "not saved") ? fut.data : null) as Record<string, unknown> | null) : null;
  if (env === "testnet") log("testnet_limits", true, "fixed code limits");
  const b = (log("strategy_budget", !budget.error && !!budget.data, budget.error ? "read failed (table may not exist yet)" : budget.data ? "read" : "no budget configured") ? budget.data : null) as Record<string, unknown> | null;
  const positions = (log("positions", !pos.error && Array.isArray(pos.data), pos.error ? "read failed" : "read") ? pos.data : null) as Record<string, unknown>[] | null;
  const pendingCount = log("open_orders", !unresolved.error && typeof unresolved.count === "number", unresolved.error ? "read failed" : "read") ? unresolved.count! : null;
  const seen = log("duplicate_check", !same.error && typeof same.count === "number", same.error ? "read failed" : "read") ? same.count! > 0 : null;
  const tr = (log("today_trades", !trades.error && Array.isArray(trades.data), trades.error ? "read failed" : "read") ? trades.data : null) as Parameters<typeof tradeNet>[0][] | null;
  log("mark_price", !!mark, mark ? `exchange time ${mark.time}` : "unavailable");
  log("symbol_rules", !!rules, rules ? (rules.maintenanceMarginRate === null ? "lot rules read; maintenance margin unavailable" : "read") : "unavailable");
  log("available_margin", margin !== null, margin !== null ? "read" : "unavailable (not wired)");
  log("strategy_used_loss", used !== null, used !== null ? "read" : "no per-strategy attribution for real trades yet");

  const exposure = positions ? positions.reduce((a, p) => a + Number(p["entry_price"]) * Number(p["quantity"]), 0) : null;
  const realized = tr ? tr.reduce((a, t) => a + tradeNet(t), 0) : null;
  const negUnreal = positions ? positions.reduce((a, p) => a + Math.min(0, Number(p["unrealized_pnl"] ?? 0)), 0) : null;
  const dayNet = realized !== null && negUnreal !== null && Number.isFinite(realized + negUnreal) ? realized + negUnreal : null;
  const halted = r ? Boolean(r["trading_halted"]) : null;
  const T = TESTNET_FUTURES_LIMITS;
  const limits: RiskLimits | null = r ? {
    maxExposure: env === "testnet" ? T.maxExposure : n(r["max_open_exposure"]),
    maxDailyLoss: env === "testnet" ? T.maxDailyLoss : n(r["max_daily_loss"]),
    maxPositions: env === "testnet" ? T.maxOpenPositions : n(r["max_total_positions"]),
    maxLossPerTrade: env === "testnet" ? T.maxLossReserve : n(f?.["max_loss"]),
    maxMarginPerTrade: env === "testnet" ? T.maxMargin : n(f?.["max_margin"]),
    maxLeverage: env === "testnet" ? T.maxLeverage : n(f?.["max_leverage"]),
    ...CENTRAL_RISK_POLICY_PROPOSAL,
  } : null;
  const context: RiskContext = {
    now,
    // The Testnet-only emergency stop does not exist until draft 0042 is applied: the shared account stop applies to both.
    account: { equity: null, availableMargin: margin, openExposure: exposure, openPositions: positions ? positions.length : null, dayNet, halted, environmentHalted: halted },
    limits,
    strategy: b ? { budget: n(b["max_loss"]), usedLoss: used } : null,
    market: { markPrice: mark?.markPrice ?? null, markTimestamp: mark?.time ?? null, stepSize: rules?.stepSize ?? null, minNotional: rules?.minNotional ?? null, maintenanceMarginRate: rules?.maintenanceMarginRate ?? null },
    orders: { sameProposalSeen: seen, unresolvedOrders: pendingCount, openPositionOnSymbol: positions ? positions.some((p) => pair(String(p["trading_pair"])) === pair(proposal.symbol)) : null },
  };
  return { context, reads };
}

/** Read-only evaluation for shadow comparison / previews. Returns a decision; it never authorizes, claims or submits. */
export async function evaluateFuturesProposalReadOnly(ports: RiskReadPorts, userId: string, raw: unknown): Promise<{ decision: RiskDecision; reads: ReadLog[] }> {
  const parsed = tradeProposalSchema.safeParse(raw);
  if (!parsed.success) return { decision: evaluateProposal(raw, { now: ports.now(), account: null, limits: null, strategy: null, market: null, orders: null }), reads: [] };
  try {
    const { context, reads } = await buildFuturesRiskContext(ports, userId, parsed.data);
    return { decision: evaluateProposal(parsed.data, context), reads };
  } catch {
    return { decision: evaluateProposal(parsed.data, { now: ports.now(), account: null, limits: null, strategy: null, market: null, orders: null }), reads: [{ source: "context", ok: false, detail: "context read threw" }] };
  }
}
