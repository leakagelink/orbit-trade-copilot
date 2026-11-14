// Live-first milestones C/F — scalp pilot rules. Pure. Converts a server-recomputed live signal plus a Central Risk
// ACCEPT into an existing Futures ticket (so entry, exchange-side SL/TP, verification, recovery and the emergency stop all
// run through the protected `openFutures` path), and decides whether that ticket may be submitted.
//
// Nothing here is approved risk policy:
//  * Testnet uses the owner's fixed Testnet limits (futures-testnet-limits.ts) — set by the owner.
//  * PROPOSED_LIVE_PILOT is a proposal for owner review; it is NOT APPROVED and cannot authorize anything.
//  * Submission switches are code constants; changing one is a separately reviewed code change, never a setting.
import { z } from "zod";
import type { RiskDecision, RiskLimits, TradeProposal } from "./central-risk";
import { futuresRiskReserve, futuresTicket, type FuturesTicket } from "./futures";
import { TESTNET_FUTURES_LIMITS } from "./futures-testnet-limits";
import { LIVE_SYMBOLS, type LiveSymbol } from "./live-feed";
import type { LiveSignal } from "./live-scalp-signal";
import { OWNER_PROPOSED_PAPER_VALUES } from "./live-scalp-risk";
import { LIVE_ORDER_EXECUTION_ENABLED } from "./scalp-execution";

export const SCALP_PILOT_VERSION = "scalp-pilot-v1" as const;
/** Testnet scalp orders. OFF until the owner explicitly approves placing Testnet orders for verification. */
export const SCALP_PILOT_TESTNET_ORDERS_ENABLED = false as const;
/** Hash of the owner-approved live pilot configuration. null = no live pilot approved (live submission impossible). */
export const APPROVED_LIVE_PILOT_HASH: string | null = null;

export type PilotEnvironment = "testnet" | "live";
export const pilotConfigSchema = z.strictObject({
  environment: z.enum(["testnet", "live"]),
  symbols: z.array(z.enum(LIVE_SYMBOLS)).min(1).max(2),
  capitalCap: z.number().positive(),        // total USDT margin the pilot may ever have committed
  maxMarginPerTrade: z.number().positive(), maxLossPerTrade: z.number().positive(), maxDailyLoss: z.number().positive(),
  maxExposure: z.number().positive(), maxPositions: z.literal(1), maxLeverage: z.number().int().min(1).max(20),
  maxHoldMin: z.number().int().min(1).max(240),
  liquidationBufferPct: z.number().positive(), maxDataAgeMs: z.number().int().positive(), maxProposalAgeMs: z.number().int().positive(),
  roundTripCostPct: z.number().positive(),
});
export type PilotConfig = z.infer<typeof pilotConfigSchema>;

const ANCILLARY = { liquidationBufferPct: OWNER_PROPOSED_PAPER_VALUES.liquidationBufferPct, maxDataAgeMs: OWNER_PROPOSED_PAPER_VALUES.maxDataAgeMs, maxProposalAgeMs: OWNER_PROPOSED_PAPER_VALUES.maxProposalAgeMs, roundTripCostPct: OWNER_PROPOSED_PAPER_VALUES.roundTripCostPct };
/** Testnet: the owner's fixed Testnet limits + the owner's proposed buffer/age/cost values. */
export const TESTNET_PILOT: Readonly<PilotConfig> = Object.freeze({
  environment: "testnet", symbols: [...LIVE_SYMBOLS], capitalCap: TESTNET_FUTURES_LIMITS.maxMargin,
  maxMarginPerTrade: TESTNET_FUTURES_LIMITS.maxMargin, maxLossPerTrade: TESTNET_FUTURES_LIMITS.maxLossReserve, maxDailyLoss: TESTNET_FUTURES_LIMITS.maxDailyLoss,
  maxExposure: TESTNET_FUTURES_LIMITS.maxExposure, maxPositions: 1, maxLeverage: TESTNET_FUTURES_LIMITS.maxLeverage, maxHoldMin: 15, ...ANCILLARY,
}) as PilotConfig;
/** PROPOSAL for owner review — NOT APPROVED. Sized so one ETHUSDT position clears Binance's 20 USDT minimum. */
export const PROPOSED_LIVE_PILOT: Readonly<{ status: "PROPOSED — NOT APPROVED"; config: PilotConfig; rationale: Record<string, string> }> = Object.freeze({
  status: "PROPOSED — NOT APPROVED",
  config: { environment: "live", symbols: ["ETHUSDT"], capitalCap: 15, maxMarginPerTrade: 10, maxLossPerTrade: 1, maxDailyLoss: 3, maxExposure: 30, maxPositions: 1, maxLeverage: 3, maxHoldMin: 15, ...ANCILLARY } as PilotConfig,
  rationale: {
    symbols: "ETHUSDT only: 20 USDT minimum order (BTCUSDT needs 50). Most liquid after BTC.",
    capitalCap: "15 USDT total margin: one 10 USDT position plus headroom for fees; never increased automatically.",
    maxLeverage: "3×: 10 USDT margin → 30 USDT notional, enough for the 20 USDT minimum, liquidation far from a scalp stop.",
    maxLossPerTrade: "1 USDT per trade (~3 % of notional): typical scalp stops (0.2–0.6 %) risk 0.06–0.18 USDT.",
    maxDailyLoss: "3 USDT per UTC day, account level; reaching it blocks new entries until the next day.",
    maxHoldMin: "15 minutes, then the existing time-stop closes the position.",
    ancillary: "Liquidation buffer 5 %, price age 5 s, proposal expiry 60 s, cost 0.13 % — your earlier proposed paper values.",
  },
});

/** Canonical SHA-256 of a pilot configuration (key-sorted JSON). An approval binds to this hash; any change voids it. */
export async function pilotConfigHash(cfg: PilotConfig): Promise<string> {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canon(pilotConfigSchema.parse(cfg))));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function pilotLimits(c: PilotConfig): RiskLimits {
  return { maxExposure: c.maxExposure, maxDailyLoss: c.maxDailyLoss, maxPositions: c.maxPositions, maxLossPerTrade: c.maxLossPerTrade, maxMarginPerTrade: c.maxMarginPerTrade, maxLeverage: c.maxLeverage, liquidationBufferPct: c.liquidationBufferPct, maxDataAgeMs: c.maxDataAgeMs, maxProposalAgeMs: c.maxProposalAgeMs, roundTripCostPct: c.roundTripCostPct };
}

/** Deterministic UUID (v5-style from SHA-256) so one signal can produce at most one order intent per environment. */
export async function pilotRequestId(signalId: string, env: PilotEnvironment): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SCALP_PILOT_VERSION}|${env}|${signalId}`))).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const floorTo = (x: number, d: number) => Math.floor(x * 10 ** d + 1e-9) / 10 ** d;
/** Stop/target distances of the signal as % of its entry reference (venue-portable: Testnet prices differ). */
export function signalDistances(sig: LiveSignal): { slPct: number; tpPct: number } | null {
  if ((sig.action !== "LONG" && sig.action !== "SHORT") || sig.entryReference === null || sig.stopReference === null || sig.takeProfitReference === null) return null;
  const e = sig.entryReference, long = sig.action === "LONG";
  const sl = ((long ? e - sig.stopReference : sig.stopReference - e) / e) * 100, tp = ((long ? sig.takeProfitReference - e : e - sig.takeProfitReference) / e) * 100;
  return sl > 0 && tp > 0 ? { slPct: sl, tpPct: tp } : null;
}
/** The proposal the Central Risk Engine evaluates: venue mark price as reference, the signal's distances applied to it. */
export function pilotProposal(sig: LiveSignal, env: PilotEnvironment, venueMark: number, now: number): TradeProposal | null {
  const d = signalDistances(sig); if (!d || !(venueMark > 0)) return null;
  const long = sig.action === "LONG";
  return { proposalId: `${sig.id}:${env}`, engine: "scalp_intraday", strategyId: `${sig.strategyId}:${sig.strategyVersion}`, symbol: sig.symbol, market: "usdm_futures", environment: env, side: long ? "LONG" : "SHORT",
    referencePrice: venueMark, stopPrice: venueMark * (1 + (long ? -d.slPct : d.slPct) / 100), takeProfitPrice: venueMark * (1 + (long ? d.tpPct : -d.tpPct) / 100), createdAt: now };
}

/** Central Risk ACCEPT → Futures ticket. Never larger than the decision's sizing; stops never wider than the signal's. */
export function decisionToTicket(sig: LiveSignal, decision: RiskDecision, cfg: PilotConfig, ids: { connectionId: string; requestId: string }): { ticket: FuturesTicket } | { error: string } {
  if (decision.verdict !== "ACCEPT" || !decision.sizing) return { error: `Central Risk verdict ${decision.verdict}; no ticket` };
  const d = signalDistances(sig); if (!d) return { error: "signal has no direction or references" };
  if (!cfg.symbols.includes(sig.symbol)) return { error: `${sig.symbol} is not in the pilot symbols` };
  const s = decision.sizing, leverage = Math.floor(s.leverage), margin = floorTo(s.margin, 2);
  const slPct = floorTo(d.slPct, 3), tpPct = floorTo(d.tpPct, 3); // tighter, never wider, than the evaluated stop/target
  if (leverage < 1 || leverage !== s.leverage) return { error: "sized leverage is not a whole number" };
  const parsed = futuresTicket.safeParse({ connectionId: ids.connectionId, symbol: `${sig.symbol.replace("USDT", "")}/USDT`, side: sig.action === "LONG" ? "buy" : "sell", margin, leverage, slPct, tpPct, holdMin: cfg.maxHoldMin, requestId: ids.requestId, confirmation: cfg.environment === "testnet" ? "TESTNET" : "LIVE" });
  if (!parsed.success) return { error: `ticket outside the order path's bounds: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  const problem = pilotTicketProblem(parsed.data, cfg); if (problem) return { error: problem };
  return { ticket: parsed.data };
}
/** Pilot-level limits on a ticket (the order path applies its own Testnet / production limits as well). */
export function pilotTicketProblem(t: FuturesTicket, c: PilotConfig): string | null {
  const sym = t.symbol.replace("/", "") as LiveSymbol;
  if (!c.symbols.includes(sym)) return "symbol not in pilot";
  if (t.confirmation !== (c.environment === "testnet" ? "TESTNET" : "LIVE")) return "ticket environment differs from the pilot environment";
  if (t.margin > c.maxMarginPerTrade + 1e-9 || t.margin > c.capitalCap + 1e-9) return "margin above the pilot limit";
  if (t.leverage > c.maxLeverage) return "leverage above the pilot ceiling";
  if (t.margin * t.leverage > c.maxExposure + 1e-9) return "notional above the pilot exposure limit";
  if (futuresRiskReserve(t.margin * t.leverage, t.slPct) > c.maxLossPerTrade + 1e-9) return "loss reserve above the pilot per-trade loss";
  if (t.holdMin > c.maxHoldMin) return "hold time above the pilot limit";
  return null;
}

export interface PilotGateInput {
  environment: PilotEnvironment; configHash: string; decision: RiskDecision | null; ticket: FuturesTicket | null;
  signalFresh: boolean; emergencyStop: boolean | null; committedMargin: number | null; config: PilotConfig;
}
export interface PilotGate { allowed: boolean; code: string; checks: { id: string; ok: boolean; detail: string }[] }
/** Whether a pilot ticket may be handed to the order path. Every check is reported; any failure refuses. */
export function pilotGate(i: PilotGateInput): PilotGate {
  const checks: PilotGate["checks"] = [], add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  if (i.environment === "testnet") add("testnet_orders_enabled", SCALP_PILOT_TESTNET_ORDERS_ENABLED, SCALP_PILOT_TESTNET_ORDERS_ENABLED ? "Testnet scalp orders approved" : "Testnet scalp orders are OFF (needs the owner's approval)");
  else {
    add("live_execution_enabled", LIVE_ORDER_EXECUTION_ENABLED, LIVE_ORDER_EXECUTION_ENABLED ? "live execution enabled in code" : "Real-money execution is disabled in code");
    add("live_pilot_approved", APPROVED_LIVE_PILOT_HASH !== null && APPROVED_LIVE_PILOT_HASH === i.configHash, APPROVED_LIVE_PILOT_HASH === null ? "No live pilot configuration is approved" : APPROVED_LIVE_PILOT_HASH === i.configHash ? "Configuration matches the approved hash" : "Configuration differs from the approved one (capital/leverage can never rise automatically)");
  }
  add("config_environment", i.config.environment === i.environment, `pilot configuration is for ${i.config.environment}`);
  add("emergency_stop", i.emergencyStop === false, i.emergencyStop === null ? "Emergency stop state unknown" : i.emergencyStop ? "Emergency stop is ON" : "Emergency stop off");
  add("risk_accept", i.decision?.verdict === "ACCEPT", `Central Risk: ${i.decision?.verdict ?? "not evaluated"}`);
  add("ticket", i.ticket !== null, i.ticket ? "ticket within pilot and order-path limits" : "no valid ticket");
  add("signal_fresh", i.signalFresh, i.signalFresh ? "signal not expired" : "signal expired");
  add("capital_cap", i.committedMargin !== null && i.ticket !== null && i.committedMargin + i.ticket.margin <= i.config.capitalCap + 1e-9, i.committedMargin === null ? "committed margin unknown" : `committed ${i.committedMargin} + new ${i.ticket?.margin ?? 0} ≤ cap ${i.config.capitalCap}`);
  const allowed = checks.every((c) => c.ok);
  return { allowed, code: allowed ? "ALLOWED" : (checks.find((c) => !c.ok)!.id.toUpperCase()), checks };
}
