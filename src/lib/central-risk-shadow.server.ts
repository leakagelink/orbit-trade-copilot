// Central Risk SHADOW evaluator (Phase 4B). Server-side, read-only, NOT CONNECTED to any order path.
//
// existing ticket → ticketToProposal (read-only adapter) → buildFuturesRiskContext (SELECT-only) → evaluateProposal
//   → ACCEPT / REJECT / INSUFFICIENT_DATA → frozen shadow record (in memory).
//
// Guarantees (import-graph + behaviour tests in src/test/central-risk-shadow.test.ts):
//  * imports no order, claim, broker-setting, authorization, credential, exchange-adapter, wallet or AI module;
//  * the database handle is narrowed to from().select(); exchange reads are credential-free public GETs (Live only —
//    Testnet never receives production prices, so its market inputs stay unknown);
//  * never throws: any failure becomes an INSUFFICIENT_DATA record, so a caller's behaviour cannot change;
//  * available margin, maintenance margin and per-strategy attribution are NOT wired (null → INSUFFICIENT_DATA).
import { CENTRAL_RISK_POLICY_PROPOSAL, evaluateFuturesProposalReadOnly, selectOnly, type RiskReadPorts, type SelectOnlyDb } from "./central-risk-context.server";
import { publicMarkPrice, publicSymbolRules } from "./futures-public-market.server";
import { buildShadowRecord, deepFreeze, safeText, SHADOW_NOTE, ticketToProposal, type ReadProvenance, type ShadowAccount, type ShadowRecord, type ShadowTicket } from "./central-risk-shadow";
import { evaluateProposal, type RiskContext } from "./central-risk";
import { buildFuturesRiskContext } from "./central-risk-context.server";

const pair = (s: string) => s.replace("/", "").toUpperCase();

/**
 * Today's real read ports for shadow mode. Live: public mark price and lot rules (maintenance margin unknown).
 * Testnet: no market source (the production public feed is never used for Testnet). Margin and attribution: unknown.
 */
export function shadowReadPorts(input: { db: { from(t: string): { select(c: string, o?: { count?: "exact"; head?: boolean }): unknown } }; account: ShadowAccount; now: () => number; fetcher?: typeof fetch }): RiskReadPorts {
  const f = input.fetcher ?? fetch;
  return {
    db: selectOnly(input.db), now: input.now,
    markPrice: async (symbol) => (input.account.testnet ? null : publicMarkPrice(symbol, f)),
    symbolRules: async (symbol) => (input.account.testnet ? null : publicSymbolRules(symbol, f)),
    availableMargin: async () => null,
    strategyUsedLoss: async () => null,
  };
}

/** One mark-price read per evaluation so the adapter and the context see the same snapshot. */
function memoMark(p: RiskReadPorts): RiskReadPorts {
  const cache = new Map<string, Promise<{ markPrice: number; time: number } | null>>();
  return { ...p, markPrice: (s) => { if (!cache.has(s)) cache.set(s, p.markPrice(s).catch(() => null)); return cache.get(s)!; } };
}

export interface ShadowRequest { ports: RiskReadPorts; userId: string; account: ShadowAccount; ticket: ShadowTicket; strategyId?: string; proposalCreatedAt?: number }

/** Evaluates one ticket in shadow mode. Always resolves; never authorizes, claims, submits or writes. */
export async function runShadowEvaluation(req: ShadowRequest): Promise<ShadowRecord> {
  const strategyId = req.strategyId ?? "manual-futures";
  let startedAt = 0, proposalCreatedAt = 0;
  try { startedAt = req.ports.now(); proposalCreatedAt = req.proposalCreatedAt ?? startedAt; } catch { /* clock failure → zeros */ }
  const base = { ticket: req.ticket, account: req.account, strategyId, proposalCreatedAt, startedAt };
  const finish = () => { try { return req.ports.now(); } catch { return startedAt; } };
  try {
    const ports = memoMark(req.ports);
    const mark = await ports.markPrice(pair(req.ticket.symbol));
    // A stale mark is missing evidence (INSUFFICIENT_DATA), never a REJECT, and is never used to place the stop.
    const age = mark ? startedAt - mark.time : null;
    if (mark && (age === null || !Number.isFinite(age) || age > CENTRAL_RISK_POLICY_PROPOSAL.maxDataAgeMs || age < -5_000)) {
      const reads: ReadProvenance[] = [{ source: "mark_price", ok: false, detail: "stale or future-dated", observedAt: Number.isFinite(mark.time) ? mark.time : null }];
      return await buildShadowRecord({ ...base, finishedAt: finish(), proposal: null, decision: null, context: null, reads, adaptProblem: { id: "market_data", status: "missing", detail: "Verified mark price is stale; treated as unavailable" }, internalError: null, marketDataTimestamp: Number.isFinite(mark.time) ? mark.time : null });
    }
    const adapted = ticketToProposal(req.ticket, req.account, mark, strategyId, proposalCreatedAt);
    if (!adapted.proposal) {
      const reads: ReadProvenance[] = [{ source: "mark_price", ok: !!mark, detail: mark ? "read" : "unavailable", observedAt: mark?.time ?? null }];
      return await buildShadowRecord({ ...base, finishedAt: finish(), proposal: null, decision: null, context: null, reads, adaptProblem: adapted.problem, internalError: null, marketDataTimestamp: mark?.time ?? null });
    }
    // The context is built once and then evaluated: the same snapshot is hashed and recorded.
    const built = await buildFuturesRiskContext(ports, req.userId, adapted.proposal).catch(() => null);
    const context: RiskContext | null = built ? built.context : null;
    const { decision, reads } = built
      ? { decision: evaluateProposal(adapted.proposal, built.context), reads: built.reads }
      : await evaluateFuturesProposalReadOnly(ports, req.userId, adapted.proposal); // context read threw → INSUFFICIENT_DATA
    const prov: ReadProvenance[] = reads.map((r) => ({ ...r, observedAt: r.source === "mark_price" ? mark?.time ?? null : context?.now ?? null }));
    return await buildShadowRecord({ ...base, finishedAt: finish(), proposal: adapted.proposal, decision, context, reads: prov, adaptProblem: null, internalError: null });
  } catch {
    // The exception itself is never inspected or copied (its text can carry keys, headers or connection strings).
    try {
      return await buildShadowRecord({ ...base, finishedAt: finish(), proposal: null, decision: null, context: null, reads: [], adaptProblem: null, internalError: "SHADOW_EVALUATION_FAILED" });
    } catch {
      // Last resort: even building a record failed. Still a deeply frozen, non-authorizing INSUFFICIENT_DATA record.
      return lastResortShadowRecord(req, strategyId, proposalCreatedAt, startedAt);
    }
  }
}
/** Last-resort record: no hashing, no exception text, every ticket field read defensively; deeply frozen. */
export function lastResortShadowRecord(req: ShadowRequest, strategyId: string, proposalCreatedAt: number, startedAt: number): ShadowRecord {
  const get = <T>(f: () => T, d: T): T => { try { const v = f(); return v ?? d; } catch { return d; } };
  const num = (f: () => number) => { const v = get(f, Number.NaN); return Number.isFinite(v) ? v : 0; };
  const margin = num(() => req.ticket.margin), leverage = num(() => req.ticket.leverage);
  return deepFreeze({
    recordVersion: "central-risk-shadow-v1", riskEngineVersion: "central-risk-v1", policyVersion: "central-risk-policy-proposal-2026-11-12 (NOT APPROVED)",
    proposalId: null, correlationId: `futures:${safeText(get(() => req.ticket.requestId, ""), "unknown")}`, accountId: safeText(get(() => req.account.connectionId, ""), "unknown"),
    strategyId: safeText(strategyId, "unknown"), environmentLabel: get(() => req.account.testnet, false) ? "TESTNET" : "LIVE",
    symbol: safeText(get(() => req.ticket.symbol, ""), "unknown"), direction: get(() => req.ticket.side, "buy") === "buy" ? "LONG" : "SHORT",
    proposalTimestamp: Number.isFinite(proposalCreatedAt) ? proposalCreatedAt : 0, evaluationTimestamp: Number.isFinite(startedAt) ? startedAt : 0, marketDataTimestamp: null,
    verdict: "INSUFFICIENT_DATA", failedChecks: [], missingInputs: ["shadow_internal"], checks: [{ id: "shadow_internal", status: "missing", detail: "Shadow evaluation failed internally; nothing is known" }],
    sizing: null, proposedLeverage: null, proposedLiquidationBufferPct: null, liquidationPriceEstimate: null,
    ticketComparison: { ticketNotional: margin * leverage, ticketLeverage: leverage, withinEngineSize: null, withinEngineLeverage: null },
    reads: [], contextSnapshotHash: null, evaluationDurationMs: 0, internalError: "SHADOW_RECORD_BUILD_FAILED", executionAuthorized: false, affectsOrderPath: false, shadowOnly: true,
    note: SHADOW_NOTE,
  } as ShadowRecord);
}
export type { SelectOnlyDb };
