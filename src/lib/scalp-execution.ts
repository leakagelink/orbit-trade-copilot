// Phase 4H.8 — Binance USD-M real-money/Testnet execution adapter for scalping: PREPARED and DISABLED. Pure: it builds
// order plans, deterministic client order ids, protection checks and reconciliation decisions, and evaluates the hard
// execution gate. It has no transport: nothing here (or in scalp-execution.server.ts) can sign or send a request. The
// gate's first check is the code constant below, so no configuration, environment variable, request field or UI control
// can enable execution — only a reviewed code change with separate owner approval.
import { FUTURES_ENDPOINTS } from "./binance-futures-env";
import { confirmedQuantity, terminalOrder, type FillOrder } from "./futures-execution";
import { floorStep, type RiskDecision, type TradeProposal } from "./central-risk";

export const LIVE_ORDER_EXECUTION_ENABLED = false as const;
export const SCALP_EXEC_VERSION = "scalp-exec-v1" as const;
export type ExecEnvironment = "testnet" | "live";
export const EXEC_ENVIRONMENTS: readonly ExecEnvironment[] = Object.freeze(["testnet", "live"]);
/** Exact endpoints this adapter would use, per purpose; every one must also be in the shared USD-M allowlist. */
export const SCALP_EXEC_ENDPOINTS = Object.freeze({
  submitEntry: { method: "POST", path: "/fapi/v1/order" }, queryOrder: { method: "GET", path: "/fapi/v1/order" }, openOrders: { method: "GET", path: "/fapi/v1/openOrders" },
  submitProtection: { method: "POST", path: "/fapi/v1/algoOrder" }, openProtection: { method: "GET", path: "/fapi/v1/openAlgoOrders" },
  positions: { method: "GET", path: "/fapi/v3/positionRisk" }, account: { method: "GET", path: "/fapi/v3/account" }, fills: { method: "GET", path: "/fapi/v1/userTrades" },
} as const);
export function endpointsAllowed(): boolean { return Object.values(SCALP_EXEC_ENDPOINTS).every((e) => (FUTURES_ENDPOINTS[e.path] ?? []).includes(e.method)); }

function h32(s: string, seed: number) { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36).padStart(7, "0"); }
export const CLIENT_ID_RE = /^[.A-Z:/a-z0-9_-]{1,36}$/;
/** Deterministic, environment-tagged id (≤ 36 chars): the same proposal and leg always yield the same id, so a resubmit
 *  of an uncertain order is recognised by the exchange as a duplicate instead of opening a second position. */
export function clientOrderId(proposalId: string, env: ExecEnvironment, leg: "E" | "S" | "T"): string {
  const id = `ots${env === "live" ? "L" : "T"}${leg}-${h32(proposalId, 0x811c9dc5)}${h32(proposalId, 0x9e3779b9)}`;
  if (!CLIENT_ID_RE.test(id)) throw new Error("client order id format");
  return id;
}
export interface OrderPlan {
  version: typeof SCALP_EXEC_VERSION; environment: ExecEnvironment; proposalId: string; symbol: string; side: "BUY" | "SELL"; qty: number; leverage: number;
  entry: { method: "POST"; path: "/fapi/v1/order"; environment: ExecEnvironment; params: Record<string, string> };
  protection: { method: "POST"; path: "/fapi/v1/algoOrder"; environment: ExecEnvironment; params: Record<string, string> }[];
}
/** Only an ACCEPTED risk decision for a proposal of the SAME environment can become a plan; a paper proposal never can. */
export function buildOrderPlan(p: TradeProposal, d: RiskDecision, env: ExecEnvironment, f: { stepSize: number; tickSize: number }): OrderPlan | { error: string } {
  if (!EXEC_ENVIRONMENTS.includes(env)) return { error: "unknown environment" };
  if (p.environment !== env) return { error: `a ${p.environment} proposal cannot become a ${env} order (no conversion path)` };
  if (p.market !== "usdm_futures") return { error: "USD-M Futures only" };
  if (d.verdict !== "ACCEPT" || !d.sizing || d.proposalId !== p.proposalId) return { error: "an ACCEPT risk decision for this proposal is required" };
  if (p.stopPrice === null) return { error: "a stop-loss is required" };
  const qty = floorStep(d.sizing.qty, f.stepSize), tick = (x: number) => (Math.round(x / f.tickSize) * f.tickSize).toFixed(Math.max(0, Math.round(-Math.log10(f.tickSize))));
  if (!(qty > 0)) return { error: "quantity rounds to zero" };
  const symbol = p.symbol.replace("/", ""), side = p.side === "LONG" ? "BUY" : "SELL", exit = side === "BUY" ? "SELL" : "BUY";
  const prot = (leg: "S" | "T", type: string, trigger: number) => ({ method: "POST" as const, path: "/fapi/v1/algoOrder" as const, environment: env,
    params: { algoType: "CONDITIONAL", symbol, side: exit, type, triggerPrice: tick(trigger), closePosition: "true", workingType: "MARK_PRICE", priceProtect: "TRUE", clientAlgoId: clientOrderId(p.proposalId, env, leg) } });
  return { version: SCALP_EXEC_VERSION, environment: env, proposalId: p.proposalId, symbol, side, qty, leverage: d.sizing.leverage,
    entry: { method: "POST", path: "/fapi/v1/order", environment: env, params: { symbol, side, type: "MARKET", quantity: String(qty), newClientOrderId: clientOrderId(p.proposalId, env, "E"), newOrderRespType: "RESULT" } },
    protection: [prot("S", "STOP_MARKET", p.stopPrice), ...(p.takeProfitPrice !== null ? [prot("T", "TAKE_PROFIT_MARKET", p.takeProfitPrice)] : [])] };
}

export interface GateContext {
  requestedEnvironment: unknown; credentialEnvironment: ExecEnvironment | null; liveOptIn: boolean | null; emergencyStop: boolean | null; certificationPass: boolean | null;
  decision: RiskDecision | null; decisionAgeMs: number | null; maxDecisionAgeMs: number; unresolvedOrders: number | null; protectionVerified: boolean | null;
}
export interface GateCheck { id: string; ok: boolean; detail: string }
export interface GateResult { allowed: boolean; code: string; environment: ExecEnvironment | null; checks: GateCheck[] }
/** The hard execution gate. Every check is listed; allowed requires ALL of them, the first being the code constant. */
export function executionGate(c: GateContext): GateResult {
  const env = EXEC_ENVIRONMENTS.includes(c.requestedEnvironment as ExecEnvironment) ? (c.requestedEnvironment as ExecEnvironment) : null;
  const checks: GateCheck[] = [
    { id: "code_flag", ok: LIVE_ORDER_EXECUTION_ENABLED, detail: "LIVE_ORDER_EXECUTION_ENABLED is false in code (Phase 4H.8): no order of any environment may be submitted" },
    { id: "environment_explicit", ok: env !== null, detail: env ? `environment ${env} stated explicitly` : "request must state testnet or live" },
    { id: "credentials_same_environment", ok: env !== null && c.credentialEnvironment === env, detail: c.credentialEnvironment === null ? "no credentials bound to the requested environment (none are loaded by this adapter)" : c.credentialEnvironment === env ? "credentials bound to the requested environment" : `credentials belong to ${c.credentialEnvironment}; no fallback between environments` },
    { id: "live_opt_in", ok: env === "testnet" || c.liveOptIn === true, detail: env === "testnet" ? "not required for Testnet" : c.liveOptIn === true ? "live opt-in present" : "live opt-in absent or unknown" },
    { id: "emergency_stop", ok: c.emergencyStop === false, detail: c.emergencyStop === null ? "emergency-stop state unknown" : c.emergencyStop ? "emergency stop is on" : "no emergency stop" },
    { id: "certification", ok: c.certificationPass === true, detail: c.certificationPass === true ? "current PASS certification" : "no current PASS certification for this account and revision" },
    { id: "risk_accept", ok: c.decision?.verdict === "ACCEPT" && c.decision.sizing !== null, detail: c.decision ? `Central Risk verdict ${c.decision.verdict}` : "no Central Risk decision" },
    { id: "risk_fresh", ok: c.decisionAgeMs !== null && c.decisionAgeMs >= 0 && c.decisionAgeMs <= c.maxDecisionAgeMs, detail: c.decisionAgeMs === null ? "decision age unknown" : `decision age ${c.decisionAgeMs} ms (max ${c.maxDecisionAgeMs})` },
    { id: "no_unresolved_orders", ok: c.unresolvedOrders === 0, detail: c.unresolvedOrders === null ? "order history unknown" : `${c.unresolvedOrders} unresolved order(s)` },
    { id: "protection_verifiable", ok: c.protectionVerified === true, detail: c.protectionVerified ? "exchange-side protection can be verified" : "exchange-side protection verification unavailable" },
  ];
  const allowed = checks.every((x) => x.ok);
  return { allowed, code: allowed ? "ALLOWED" : checks.find((x) => !x.ok)!.id === "code_flag" ? "LIVE_ORDER_EXECUTION_DISABLED" : `REFUSED_${checks.find((x) => !x.ok)!.id.toUpperCase()}`, environment: env, checks };
}

// ---------- reconciliation (lookup-only; never resubmits) ----------
export type LookupResult = { kind: "FOUND"; order: FillOrder } | { kind: "NOT_FOUND"; at: number } | { kind: "ERROR"; at: number };
export type SettleState = "FILLED" | "PARTIALLY_FILLED" | "OPEN" | "CLOSED_UNFILLED" | "NOT_FOUND_CONFIRMED" | "UNKNOWN_LOCKED";
/** Decides an uncertain submit from lookups by client order id. Resubmission is never allowed by this adapter. */
export function settleUncertainSubmit(clientId: string, lookups: LookupResult[], submittedAt: number, cooldownMs: number): { state: SettleState; filledQty: number; resubmitAllowed: false; detail: string } {
  const found = lookups.filter((l): l is Extract<LookupResult, { kind: "FOUND" }> => l.kind === "FOUND").at(-1);
  if (found) {
    if (found.order.clientOrderId !== clientId) return { state: "UNKNOWN_LOCKED", filledQty: 0, resubmitAllowed: false, detail: "lookup returned a different client order id" };
    let q: number; try { q = confirmedQuantity(found.order); } catch { return { state: "UNKNOWN_LOCKED", filledQty: 0, resubmitAllowed: false, detail: "invalid executed quantity" }; }
    if (found.order.status === "FILLED") return { state: "FILLED", filledQty: q, resubmitAllowed: false, detail: "filled" };
    if (terminalOrder(found.order.status)) return { state: q > 0 ? "PARTIALLY_FILLED" : "CLOSED_UNFILLED", filledQty: q, resubmitAllowed: false, detail: `terminal ${found.order.status}` };
    return { state: q > 0 ? "PARTIALLY_FILLED" : "OPEN", filledQty: q, resubmitAllowed: false, detail: `active ${found.order.status}` };
  }
  const nf = lookups.filter((l) => l.kind === "NOT_FOUND" && l.at - submittedAt >= cooldownMs);
  if (nf.length >= 2) return { state: "NOT_FOUND_CONFIRMED", filledQty: 0, resubmitAllowed: false, detail: "absent in two lookups after the cool-down; a NEW proposal is required to trade again" };
  return { state: "UNKNOWN_LOCKED", filledQty: 0, resubmitAllowed: false, detail: "outcome unknown: symbol stays locked until reconciled" };
}
export interface ExchangePosition { symbol: string; positionAmt: number; entryPrice: number }
export interface ExchangeAlgoOrder { symbol: string; side: string; type: string; closePosition: boolean; triggerPrice: number; status: string }
export type ProtectionState = "PROTECTED" | "NO_POSITION" | "MISSING_STOP" | "WRONG_SIDE" | "TRIGGER_MISMATCH" | "UNVERIFIABLE";
/** Exchange-side protection check against the plan: a position without a verified close-position stop must be contained. */
export function verifyProtection(pos: ExchangePosition | null | undefined, algos: ExchangeAlgoOrder[] | null, plan: OrderPlan, tolerance: number): { state: ProtectionState; action: "NONE" | "CONTAIN_REDUCE_ONLY" } {
  if (algos === null || pos === undefined) return { state: "UNVERIFIABLE", action: "CONTAIN_REDUCE_ONLY" };
  if (!pos || pos.positionAmt === 0) return { state: "NO_POSITION", action: "NONE" };
  const exit = pos.positionAmt > 0 ? "SELL" : "BUY", want = plan.protection.find((p) => p.params["type"] === "STOP_MARKET");
  const stops = algos.filter((a) => a.symbol === plan.symbol && a.type === "STOP_MARKET" && a.closePosition && !terminalOrder(a.status));
  if (!stops.length) return { state: "MISSING_STOP", action: "CONTAIN_REDUCE_ONLY" };
  if (!stops.some((a) => a.side === exit)) return { state: "WRONG_SIDE", action: "CONTAIN_REDUCE_ONLY" };
  if (want && !stops.some((a) => Math.abs(a.triggerPrice - Number(want.params["triggerPrice"])) <= tolerance)) return { state: "TRIGGER_MISMATCH", action: "CONTAIN_REDUCE_ONLY" };
  return { state: "PROTECTED", action: "NONE" };
}
/** Exchange vs local ledger: positions, fills and balance. Any mismatch locks the symbol for review. */
export function reconcileExchange(local: { symbol: string; qty: number; fillsQty: number; balance: number | null }, exch: { positionAmt: number | null; fillsQty: number | null; balance: number | null }, tol = 1e-8): string[] {
  const m: string[] = [];
  if (exch.positionAmt === null) m.push("exchange position unavailable"); else if (Math.abs(exch.positionAmt - local.qty) > tol) m.push(`position ${exch.positionAmt} ≠ local ${local.qty}`);
  if (exch.fillsQty === null) m.push("exchange fills unavailable"); else if (Math.abs(exch.fillsQty - local.fillsQty) > tol) m.push(`fills ${exch.fillsQty} ≠ local ${local.fillsQty}`);
  if (exch.balance === null || local.balance === null) m.push("balance unavailable"); else if (Math.abs(exch.balance - local.balance) > Math.max(tol, 1e-6 * Math.abs(local.balance))) m.push(`balance ${exch.balance} ≠ local ${local.balance}`);
  return m;
}
