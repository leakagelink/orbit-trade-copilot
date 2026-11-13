// Central Risk Engine — SHADOW MODE (Phase 4B). Pure and deterministic; browser-safe.
//
// Shadow mode OBSERVES a Futures entry ticket: it converts the ticket into a Central Risk proposal (read-only adapter),
// evaluates it against a SELECT-only context and produces a versioned, frozen shadow record. It is not imported by
// any order, claim, broker-setting or authorization path (import-graph test), returns a record instead of throwing,
// and every record carries executionAuthorized:false and affectsOrderPath:false. ACCEPT authorizes nothing, REJECT
// blocks nothing, and missing inputs stay missing (INSUFFICIENT_DATA) — no value is ever guessed.
// Persistence: in-memory/offline only. A database ledger needs its own migration and separate approval.
import { CENTRAL_RISK_VERSION, liquidationPrice, type RiskCheck, type RiskContext, type RiskDecision, type RiskVerdict, type TradeProposal } from "./central-risk";
import { evidenceHash } from "./evidence-hash";

export const SHADOW_RECORD_VERSION = "central-risk-shadow-v1" as const;
/** The policy values in use are PROPOSALS (Phase 4A). They are not approved and are not enforced anywhere. */
export const SHADOW_POLICY_VERSION = "central-risk-policy-proposal-2026-11-12 (NOT APPROVED)" as const;
export const SHADOW_NOTE = "Shadow evaluation only. It does not authorize, block, resize or change any order; no order was placed." as const;

/** Structural subset of the existing Futures ticket (`futuresTicket` in futures.ts). Declared here so this pure module
 *  never imports a Futures module; a test proves the shapes stay compatible. */
export interface ShadowTicket {
  connectionId: string; symbol: string; side: "buy" | "sell"; margin: number; leverage: number;
  slPct: number; tpPct: number; requestId: string; confirmation: "TESTNET" | "LIVE";
}
/** The connection's IMMUTABLE environment (from the stored connection), never from the ticket or the caller's label. */
export interface ShadowAccount { connectionId: string; testnet: boolean }
export type EnvironmentLabel = "LIVE" | "TESTNET";
export const environmentLabel = (a: ShadowAccount): EnvironmentLabel => (a.testnet ? "TESTNET" : "LIVE");

export type AdaptResult = { proposal: TradeProposal; problem: null } | { proposal: null; problem: { id: string; status: "fail" | "missing"; detail: string } };

/**
 * Read-only ticket → proposal adapter. Direction, stop and target are derived from the ticket percentages applied to
 * the VERIFIED mark price (the ticket carries no price). The ticket's margin and leverage never cross over: the Risk
 * Engine sizes independently and the two are only compared afterwards.
 */
export function ticketToProposal(t: ShadowTicket, account: ShadowAccount, verified: { markPrice: number; time: number } | null, strategyId: string, proposalCreatedAt: number): AdaptResult {
  if (t.connectionId !== account.connectionId) return { proposal: null, problem: { id: "account_binding", status: "fail", detail: "Ticket is for a different connection" } };
  if (t.confirmation !== environmentLabel(account)) return { proposal: null, problem: { id: "environment_label", status: "fail", detail: `Ticket says ${t.confirmation} but the connection is ${environmentLabel(account)}` } };
  if (!verified || !(verified.markPrice > 0) || !Number.isFinite(verified.time)) return { proposal: null, problem: { id: "market_data", status: "missing", detail: "No verified mark price; the stop cannot be placed" } };
  const long = t.side === "buy", p = verified.markPrice;
  return {
    proposal: {
      proposalId: t.requestId, engine: "futures_ticket", strategyId, symbol: t.symbol, market: "usdm_futures",
      environment: account.testnet ? "testnet" : "live", side: long ? "LONG" : "SHORT", referencePrice: null,
      stopPrice: p * (1 + (long ? -t.slPct : t.slPct) / 100), takeProfitPrice: p * (1 + (long ? t.tpPct : -t.tpPct) / 100), createdAt: proposalCreatedAt,
    },
    problem: null,
  };
}

export interface ReadProvenance { source: string; ok: boolean; detail: string; observedAt: number | null }

/** Every input the shadow evaluator needs, where it comes from today, and whether that source exists. */
export type SourceStatus = "READY" | "BLOCKED";
export interface SourceEntry { input: string; source: string; status: SourceStatus; blocker: string | null }
export const SHADOW_SOURCE_MATRIX: readonly SourceEntry[] = Object.freeze([
  { input: "account_risk_limits", source: "risk_settings (SELECT)", status: "READY", blocker: null },
  { input: "futures_limits", source: "futures_settings (SELECT, production) · fixed TESTNET_FUTURES_LIMITS (Testnet)", status: "READY", blocker: null },
  { input: "strategy_risk_budget", source: "strategy_risk_budgets (SELECT)", status: "BLOCKED", blocker: "Table is in draft migration 0045, not applied" },
  { input: "strategy_loss_attribution", source: "port strategyUsedLoss", status: "BLOCKED", blocker: "Real orders/positions/trades carry no strategy id; needs a new migration + order-path tagging" },
  { input: "open_futures_positions", source: "positions open, same execution_environment (SELECT)", status: "READY", blocker: null },
  { input: "current_exposure", source: "derived from open positions (entry × quantity)", status: "READY", blocker: null },
  { input: "pending_unknown_orders", source: "orders pending/open/partially_filled (SELECT; production account-wide, Testnet Testnet-only)", status: "READY", blocker: null },
  { input: "duplicate_proposal", source: "orders.idempotency_key = futures:<requestId> (SELECT)", status: "READY", blocker: null },
  { input: "daily_realized_unrealized_loss", source: "trades closed since 00:00 UTC (tradeNet) + negative unrealized on open positions", status: "READY", blocker: null },
  { input: "emergency_stop", source: "risk_settings.trading_halted (shared account stop; Testnet-only stop needs draft 0042)", status: "READY", blocker: null },
  { input: "mark_price_and_exchange_time", source: "Live: public GET /fapi/v1/premiumIndex · Testnet: none (production prices are never used for Testnet)", status: "READY", blocker: null },
  { input: "lot_size_min_notional", source: "Live: public GET /fapi/v1/exchangeInfo · Testnet: none", status: "READY", blocker: null },
  { input: "maintenance_margin_rate", source: "signed GET /fapi/v1/leverageBracket", status: "BLOCKED", blocker: "Endpoint is not on the frozen adapter allowlist; adding it needs separate approval" },
  { input: "available_margin", source: "existing signed GET /fapi/v3/account (futuresAccountState)", status: "BLOCKED", blocker: "Needs credential decryption inside the shadow path; not connected without separate approval" },
  { input: "proposal_timestamp_age", source: "ticket evaluation time (caller clock) vs. maxProposalAgeMs (proposed policy)", status: "READY", blocker: null },
  { input: "strategy_identity", source: "caller-supplied strategy id (manual tickets: 'manual-futures')", status: "READY", blocker: null },
] satisfies SourceEntry[]);

/** Field-level list of context inputs that are unknown. Independent from the check list so nothing is hidden by lumping. */
export function missingContextInputs(c: RiskContext, futures = true): string[] {
  const out: string[] = [];
  const miss = (name: string, v: unknown) => { if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) out.push(name); };
  if (!c.account) out.push("account"); else {
    miss("emergency_stop", c.account.halted); miss("open_exposure", c.account.openExposure); miss("open_positions", c.account.openPositions); miss("day_net_loss", c.account.dayNet);
    if (futures) { miss("available_margin", c.account.availableMargin); miss("environment_emergency_stop", c.account.environmentHalted); }
  }
  if (!c.limits) out.push("risk_limits"); else for (const [k, v] of Object.entries(c.limits)) { if (futures || !["maxMarginPerTrade", "maxLeverage", "liquidationBufferPct"].includes(k)) miss(`limit.${k}`, v); }
  if (!c.strategy) out.push("strategy_risk_budget"); else { miss("strategy_risk_budget", c.strategy.budget); miss("strategy_loss_attribution", c.strategy.usedLoss); }
  if (!c.market) out.push("market"); else { miss("mark_price", c.market.markPrice); miss("mark_timestamp", c.market.markTimestamp); miss("lot_step", c.market.stepSize); miss("min_notional", c.market.minNotional); if (futures) miss("maintenance_margin_rate", c.market.maintenanceMarginRate); }
  if (!c.orders) out.push("order_state"); else { miss("duplicate_status", c.orders.sameProposalSeen); miss("pending_unknown_orders", c.orders.unresolvedOrders); miss("open_position_on_symbol", c.orders.openPositionOnSymbol); }
  return [...new Set(out)];
}

export interface ShadowRecord {
  recordVersion: typeof SHADOW_RECORD_VERSION; riskEngineVersion: typeof CENTRAL_RISK_VERSION; policyVersion: typeof SHADOW_POLICY_VERSION;
  proposalId: string | null; correlationId: string | null; accountId: string; strategyId: string; environmentLabel: EnvironmentLabel;
  symbol: string; direction: "LONG" | "SHORT"; proposalTimestamp: number; evaluationTimestamp: number; marketDataTimestamp: number | null;
  verdict: RiskVerdict; failedChecks: RiskCheck[]; missingInputs: string[]; checks: RiskCheck[];
  sizing: { qty: number; notional: number; margin: number; riskAmount: number; binding: string } | null;
  proposedLeverage: number | null; proposedLiquidationBufferPct: number | null; liquidationPriceEstimate: number | null;
  /** Ticket vs. the engine's own sizing. Informational: shadow mode never resizes or refuses the ticket. */
  ticketComparison: { ticketNotional: number; ticketLeverage: number; withinEngineSize: boolean | null; withinEngineLeverage: boolean | null };
  reads: ReadProvenance[]; contextSnapshotHash: string | null; evaluationDurationMs: number; internalError: ShadowErrorCode | null;
  executionAuthorized: false; affectsOrderPath: false; shadowOnly: true; note: typeof SHADOW_NOTE;
}

/** Recursively freezes every nested object and array (used for normal AND last-resort records). */
export function deepFreeze<T>(o: T): T { if (o && typeof o === "object") { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; }

/** Bounded internal error codes. Raw exception text is never copied into a record (it can carry secrets). */
export const SHADOW_ERROR_CODES = ["SHADOW_EVALUATION_FAILED", "SHADOW_RECORD_BUILD_FAILED"] as const;
export type ShadowErrorCode = (typeof SHADOW_ERROR_CODES)[number];
/** Record text must be one of the engine's own short phrases; anything else is replaced, never copied. */
const SAFE_TEXT = /^[A-Za-z0-9 _.,:;()'\/+\-]{1,200}$/;
const SECRETISH = /(secret|password|passwd|token|bearer|authorization|api[_-]?key|x-mbx|signature|postgres(ql)?:|sb_secret|service_role|ciphertext|BEGIN [A-Z ]*KEY)/i;
export function safeText(x: unknown, fallback = "redacted"): string { return typeof x === "string" && SAFE_TEXT.test(x) && !SECRETISH.test(x) ? x : fallback; }
function safeReads(rs: ReadProvenance[]): ReadProvenance[] {
  return rs.map((r) => ({ source: safeText(r.source, "unknown_source"), ok: r.ok === true, detail: safeText(r.detail), observedAt: typeof r.observedAt === "number" && Number.isFinite(r.observedAt) ? r.observedAt : null }));
}
function safeChecks(cs: RiskCheck[]): RiskCheck[] { return cs.map((c) => ({ id: safeText(c.id, "check"), status: c.status, detail: safeText(String(c.detail).replace(/[^\x20-\x7e]/g, " "), "detail withheld") })); }

export interface RecordInput {
  ticket: ShadowTicket; account: ShadowAccount; strategyId: string; proposalCreatedAt: number;
  startedAt: number; finishedAt: number; proposal: TradeProposal | null; decision: RiskDecision | null;
  context: RiskContext | null; reads: ReadProvenance[]; adaptProblem: { id: string; status: "fail" | "missing"; detail: string } | null; internalError: ShadowErrorCode | null;
  /** Time of the mark price that was read (also when it was refused as stale). */
  marketDataTimestamp?: number | null;
}
/** Builds the frozen shadow record. Holds no credentials, keys or exchange account identifiers beyond the connection id. */
export async function buildShadowRecord(x: RecordInput): Promise<ShadowRecord> {
  const direction = x.ticket.side === "buy" ? "LONG" : "SHORT";
  let checks: RiskCheck[], verdict: RiskVerdict;
  if (x.internalError) { checks = [{ id: "shadow_internal", status: "missing", detail: "Shadow evaluation failed internally; nothing is known" }]; verdict = "INSUFFICIENT_DATA"; }
  else if (x.adaptProblem) { checks = [x.adaptProblem]; verdict = x.adaptProblem.status === "fail" ? "REJECT" : "INSUFFICIENT_DATA"; }
  else {
    checks = x.decision ? x.decision.checks : [{ id: "decision", status: "missing", detail: "No decision" }];
    // Missing or stale market data is missing evidence, never a proven violation: market_data is never a REJECT reason.
    checks = checks.map((c) => (c.id === "market_data" && c.status === "fail" ? { ...c, status: "missing" as const, detail: `Stale market data treated as unavailable: ${c.detail}` } : c));
    verdict = !x.decision ? "INSUFFICIENT_DATA" : checks.some((c) => c.status === "fail") ? "REJECT" : checks.some((c) => c.status === "missing") ? "INSUFFICIENT_DATA" : x.decision.verdict;
  }
  checks = safeChecks(checks);
  const missing = [...new Set([...checks.filter((c) => c.status === "missing").map((c) => c.id), ...(x.context ? missingContextInputs(x.context) : []), ...x.reads.filter((r) => !r.ok).map((r) => safeText(r.source, "unknown_source"))])].sort();
  const s = verdict === "ACCEPT" ? x.decision?.sizing ?? null : null;
  const stop = x.proposal?.stopPrice ?? null;
  const buffer = s && s.liquidationPrice !== null && stop !== null ? ((direction === "LONG" ? stop - s.liquidationPrice : s.liquidationPrice - stop) / s.entryEstimate) * 100 : null;
  const ticketNotional = x.ticket.margin * x.ticket.leverage;
  const rec: ShadowRecord = {
    recordVersion: SHADOW_RECORD_VERSION, riskEngineVersion: CENTRAL_RISK_VERSION, policyVersion: SHADOW_POLICY_VERSION,
    proposalId: x.proposal?.proposalId ?? null, correlationId: `futures:${x.ticket.requestId}`, accountId: x.account.connectionId, strategyId: x.strategyId,
    environmentLabel: environmentLabel(x.account), symbol: x.ticket.symbol, direction, proposalTimestamp: x.proposalCreatedAt, evaluationTimestamp: x.finishedAt,
    marketDataTimestamp: x.context?.market?.markTimestamp ?? x.marketDataTimestamp ?? null,
    verdict, failedChecks: checks.filter((c) => c.status === "fail"), missingInputs: missing, checks,
    sizing: s ? { qty: s.qty, notional: s.notional, margin: s.margin, riskAmount: s.riskAmount, binding: s.binding } : null,
    proposedLeverage: s ? s.leverage : null, proposedLiquidationBufferPct: buffer, liquidationPriceEstimate: s?.liquidationPrice ?? null,
    ticketComparison: { ticketNotional, ticketLeverage: x.ticket.leverage, withinEngineSize: s ? ticketNotional <= s.notional + 1e-9 : null, withinEngineLeverage: s ? x.ticket.leverage <= s.leverage : null },
    reads: safeReads(x.reads), contextSnapshotHash: x.context ? await evidenceHash(x.context) : null, evaluationDurationMs: Math.max(0, x.finishedAt - x.startedAt),
    internalError: x.internalError ? ((SHADOW_ERROR_CODES as readonly string[]).includes(x.internalError) ? x.internalError : "SHADOW_EVALUATION_FAILED") : null, executionAuthorized: false, affectsOrderPath: false, shadowOnly: true, note: SHADOW_NOTE,
  };
  return deepFreeze(rec);
}

/** Liquidation estimate for an arbitrary leverage (used by the policy review; the engine chooses the real leverage). */
export const liquidationAt = liquidationPrice;

/** In-memory, append-only shadow log. Records are frozen; a proposal id seen before is flagged, never overwritten. */
export function createShadowLog() {
  const rows: ShadowRecord[] = [];
  return {
    append(r: ShadowRecord) {
      const duplicateOf = r.proposalId ? rows.findIndex((x) => x.proposalId === r.proposalId) : -1;
      rows.push(r);
      return { index: rows.length - 1, duplicate: duplicateOf >= 0, duplicateOf: duplicateOf >= 0 ? duplicateOf : null };
    },
    all: (): readonly ShadowRecord[] => Object.freeze([...rows]),
    summary() {
      const by = (v: RiskVerdict) => rows.filter((r) => r.verdict === v).length;
      return { total: rows.length, accept: by("ACCEPT"), reject: by("REJECT"), insufficient: by("INSUFFICIENT_DATA"), duplicates: rows.length - new Set(rows.map((r) => r.proposalId)).size };
    },
  };
}

/** Maintenance-margin bracket contract for the future signed leverageBracket read. Pure; not connected to any source. */
export interface LeverageBracket { notionalFloor: number; notionalCap: number; maintMarginRatio: number; initialLeverage: number }
/** The rate of the bracket containing `notional`; null when brackets are absent, malformed or do not cover it. */
export function maintenanceMarginRateFor(brackets: LeverageBracket[] | null, notional: number): number | null {
  if (!brackets?.length || !(notional >= 0)) return null;
  const b = brackets.find((x) => notional >= x.notionalFloor && notional < x.notionalCap);
  return b && b.maintMarginRatio > 0 && b.maintMarginRatio < 1 ? b.maintMarginRatio : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pre-claim / post-claim order snapshot semantics (Phase 4D: design + pure classifier; NOT wired to any order path).
// Pre-claim (taken before the order path claims its intent): ANY order carrying this proposal's correlation key means
// the proposal was already claimed → duplicate. Post-claim (taken after the claim): EXACTLY ONE order with the own key is
// expected and is identified by that exact key — it is not silently excluded. A second own-key row is a duplicate; no
// own-key row is an inconsistent snapshot (unknown → INSUFFICIENT_DATA); every other pending order still counts as
// unresolved, so unrelated duplicates and unknown outcomes are never suppressed.
// ---------------------------------------------------------------------------------------------------------------------
export type SnapshotPhase = "pre_claim" | "post_claim";
export interface SnapshotOrder { idempotencyKey: string | null; status: string }
export interface SnapshotClassification {
  phase: SnapshotPhase; ownOrders: number; sameProposalSeen: boolean | null; unresolvedOrders: number | null;
  outcome: "CLEAN" | "DUPLICATE" | "INCONSISTENT"; detail: string;
}
const UNRESOLVED_STATUSES = new Set(["pending", "open", "partially_filled"]);
export function classifyOrderSnapshot(phase: SnapshotPhase, ownCorrelationId: string, orders: SnapshotOrder[] | null): SnapshotClassification {
  if (!Array.isArray(orders) || typeof ownCorrelationId !== "string" || !ownCorrelationId) return { phase, ownOrders: 0, sameProposalSeen: null, unresolvedOrders: null, outcome: "INCONSISTENT", detail: "Order snapshot unavailable" };
  const own = orders.filter((o) => o.idempotencyKey === ownCorrelationId);
  const otherUnresolved = orders.filter((o) => o.idempotencyKey !== ownCorrelationId && UNRESOLVED_STATUSES.has(o.status)).length;
  const ownUnresolved = own.filter((o) => UNRESOLVED_STATUSES.has(o.status)).length;
  if (phase === "pre_claim") {
    return own.length > 0
      ? { phase, ownOrders: own.length, sameProposalSeen: true, unresolvedOrders: otherUnresolved + ownUnresolved, outcome: "DUPLICATE", detail: "Proposal already claimed before this observation" }
      : { phase, ownOrders: 0, sameProposalSeen: false, unresolvedOrders: otherUnresolved, outcome: "CLEAN", detail: "No order carries this proposal's key" };
  }
  if (own.length === 0) return { phase, ownOrders: 0, sameProposalSeen: null, unresolvedOrders: null, outcome: "INCONSISTENT", detail: "Post-claim snapshot does not contain the claimed order" };
  if (own.length > 1) return { phase, ownOrders: own.length, sameProposalSeen: true, unresolvedOrders: otherUnresolved + ownUnresolved, outcome: "DUPLICATE", detail: "More than one order carries this proposal's key" };
  return { phase, ownOrders: 1, sameProposalSeen: false, unresolvedOrders: otherUnresolved, outcome: "CLEAN", detail: "Exactly one claimed order matches by correlation key; all other orders are counted as usual" };
}
