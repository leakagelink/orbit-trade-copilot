// Futures PAPER engine, 0049-aligned layer (Phase 4F, owner-approved engine alignment E1–E4). Pure and deterministic.
// It drives the UNCHANGED Phase 4D core (`futures-paper-engine.ts`, kept byte-identical because rejected drafts 0045/0046
// and their tests reference it) one symbol at a time and adds exactly what draft 0049 enforces, so that a payload it
// produces is accepted by 0049 instead of being refused:
//  E1 Expiry: a pending entry remainder is cancelled deterministically (reason APPROVAL_EXPIRED) before the first candle
//     whose open is after its database approval's expiry (approval time + the account's maximum proposal age).
//  E2 Budgets: acceptance is sized with `riskEngineStrategyBudget` over the DATABASE budget definitions (account,
//     Research/Scalping sub-budget, strategy; closed losses + open reserved risk + pending approval risk, owner-wide).
//     The core's own per-strategy budget is neutralized so there is ONE budget source; every approval and fill is then
//     re-checked with 0049's exact level, exposure, position-count and free-margin definitions (open AND pending).
//  E3 Refusals: every 0049 approval- and fill-time refusal maps to a bounded code (`planLedgerRefusalV3`); anything
//     unknown, inconsistent, repeated or not attributable to exactly one proposal halts for review — never a retry.
//  E4 Costs: the round-trip cost is resolved with 0049's precedence (exact → strategy-wide → symbol-wide → owner-wide →
//     account default); the same value sizes the approval here and is frozen on the database approval.
// It never touches an exchange, credentials, real orders, the demo wallet or any database: the caller supplies the ledger
// view (`FPV3Ledger`) it read. Every price is simulated from public candles. Nothing here authorizes anything.
import { FuturesPaperDataError, stepFuturesPaper, type FPBar, type FPConfig, type FPEvent, type FPFillContext, type FPIntent, type FPRefusal, type FPRefusalCode, type FPState, type FPTrade, type PerpSide } from "./futures-paper-engine";
import { riskEngineStrategyBudget, checkAdditionalRisk, type AccountRiskBudget, type BudgetEngine, type StrategyRiskBudget, type StrategyUsage } from "./account-risk-budget";
import type { RiskDecision } from "./central-risk";

export const FUTURES_PAPER_ENGINE_V3 = "futures-paper-engine-v3 (aligned with draft 0049)" as const;
const EPS = 1e-9, TOL = 1e-6, NEUTRAL_BUDGET = 1e15, MAX_ATTEMPTS = 6;
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------------------------------------------------------------
// E4 — cost assumptions (mirror of `fp3_cost`)
// ---------------------------------------------------------------------------------------------------------------------
export interface CostAssumption { strategyId: string; symbol: string; roundTripCostPct: number; validationStatus: "unvalidated" | "validated" }
export type CostSource = "exact" | "strategy" | "symbol" | "owner" | "account_default";
export interface ResolvedCost { costPct: number; source: CostSource; validated: boolean }
const COST_SOURCES: CostSource[] = ["exact", "strategy", "symbol", "owner"];

/** 0049 precedence: ORDER BY (strategy_id = '*'), (symbol = '*') LIMIT 1, else the account default. null = no valid cost. */
export function resolveCost(list: CostAssumption[], strategyId: string, symbol: string, accountDefault: number | null): ResolvedCost | null {
  const keys = new Set<string>();
  for (const c of list) {
    const k = `${c.strategyId}\u0000${c.symbol}`;
    if (keys.has(k)) throw new FuturesPaperDataError(`cost assumptions: duplicate entry for ${c.strategyId}/${c.symbol}`);
    keys.add(k);
  }
  const rank = (c: CostAssumption) => (c.strategyId === "*" ? 2 : 0) + (c.symbol === "*" ? 1 : 0);
  const hit = list.filter((c) => (c.strategyId === strategyId || c.strategyId === "*") && (c.symbol === symbol || c.symbol === "*")).sort((a, b) => rank(a) - rank(b))[0];
  if (hit) {
    if (!fin(hit.roundTripCostPct) || hit.roundTripCostPct < 0 || hit.roundTripCostPct > 5) return null;
    return { costPct: hit.roundTripCostPct, source: COST_SOURCES[rank(hit)]!, validated: hit.validationStatus === "validated" };
  }
  if (!fin(accountDefault) || accountDefault < 0 || accountDefault > 5) return null;
  return { costPct: accountDefault, source: "account_default", validated: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger view (what the database holds; the worker reads it, offline replay carries it forward)
// ---------------------------------------------------------------------------------------------------------------------
export interface V3Approval {
  proposalId: string; strategyId: string; engine: BudgetEngine; symbol: string; side: PerpSide;
  approvedQty: number; filledQty: number; leverage: number; referencePrice: number; stopDist: number; costPct: number;
  approvedT: number; expiresT: number;
}
export interface V3Position { symbol: string; proposalId: string; strategyId: string; riskReserved: number }
export interface FPV3Ledger {
  accountBudget: AccountRiskBudget | null;
  strategies: StrategyRiskBudget[];
  /** Owner-wide usage (all paper accounts) per budgeted strategy, exactly as the database computes it. */
  usage: Record<string, StrategyUsage>;
  costs: CostAssumption[];
  /** This account's OPEN approvals, by symbol. */
  approvals: Record<string, V3Approval>;
  /** This account's open positions with the database's reserved risk, by symbol. */
  positions: Record<string, V3Position>;
  /** Proposal ids among this candle's intents that the database already holds for this owner (any account). */
  evaluatedProposals: string[];
  /** When true, an approval needs a cost assumption marked validated (the account default never is). */
  requireValidatedCost: boolean;
}
export function initialV3Ledger(accountBudget: AccountRiskBudget | null, strategies: StrategyRiskBudget[], costs: CostAssumption[] = [], requireValidatedCost = false): FPV3Ledger {
  return { accountBudget, strategies, usage: Object.fromEntries(strategies.map((s) => [s.strategyId, { closedLoss: 0, openRisk: 0, pendingRisk: 0 }])), costs, approvals: {}, positions: {}, evaluatedProposals: [], requireValidatedCost };
}

/** Differences between the engine state and the ledger view; non-empty means the caller must not step (halt for review). */
export function ledgerStateProblems(state: FPState, ledger: FPV3Ledger): string[] {
  const out: string[] = [];
  for (const [sym, p] of Object.entries(state.pending)) {
    const a = ledger.approvals[sym];
    if (!a) { out.push(`pending ${sym} has no open approval in the ledger`); continue; }
    if (a.proposalId !== p.proposalId || a.strategyId !== p.strategyId || a.side !== p.side || !near(a.approvedQty, p.qtyTotal) || !near(a.filledQty + 1, p.qtyFilled + 1) || a.leverage !== p.leverage || !near(a.stopDist, p.stopDist)) out.push(`pending ${sym} differs from its approval`);
  }
  for (const sym of Object.keys(ledger.approvals)) if (!state.pending[sym]) out.push(`approval for ${sym} has no pending entry in the state`);
  for (const [sym, p] of Object.entries(state.positions)) {
    const l = ledger.positions[sym];
    if (!l || l.proposalId !== p.proposalId || l.strategyId !== p.strategyId || !fin(l.riskReserved) || l.riskReserved < 0) out.push(`position ${sym} differs from the ledger`);
  }
  for (const sym of Object.keys(ledger.positions)) if (!state.positions[sym]) out.push(`ledger position ${sym} is not in the state`);
  for (const s of ledger.strategies) {
    const u = ledger.usage[s.strategyId];
    if (!u || ![u.closedLoss, u.openRisk, u.pendingRisk].every((x) => fin(x) && x >= -TOL)) out.push(`usage of strategy ${s.strategyId} is missing or invalid`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounded codes
// ---------------------------------------------------------------------------------------------------------------------
export const V3_APPROVAL_CODES = [
  "APPROVAL_BUDGET_MISSING", "APPROVAL_ACCOUNT_BUDGET_MISSING", "APPROVAL_BUDGET_CONFIG_INVALID", "APPROVAL_DUPLICATE_PROPOSAL",
  "APPROVAL_SYMBOL_BUSY", "APPROVAL_PRICE_STALE", "APPROVAL_PROPOSAL_STALE", "APPROVAL_BASIS", "APPROVAL_STOP_SIDE",
  "APPROVAL_LEVERAGE", "APPROVAL_LOT_SIZE", "APPROVAL_RISK_PER_TRADE", "APPROVAL_MARGIN_PER_TRADE",
  "APPROVAL_LIQUIDATION_BUFFER", "APPROVAL_DAILY_LOSS", "APPROVAL_STRATEGY_BUDGET", "APPROVAL_SUB_BUDGET",
  "APPROVAL_ACCOUNT_BUDGET", "APPROVAL_EXPOSURE", "APPROVAL_POSITION_LIMIT", "APPROVAL_FREE_MARGIN",
  "APPROVAL_COST_MISSING", "APPROVAL_COST_UNVALIDATED", "APPROVAL_INTENT_LIMIT",
] as const;
export type V3ApprovalCode = (typeof V3_APPROVAL_CODES)[number];
export const V3_FILL_ONLY_CODES = ["FILL_APPROVAL_EXPIRED", "FILL_PRICE_STALE"] as const;
export type V3FillCode = FPRefusalCode | (typeof V3_FILL_ONLY_CODES)[number];
const CORE_CODE: Record<(typeof V3_FILL_ONLY_CODES)[number], FPRefusalCode> = { FILL_APPROVAL_EXPIRED: "PENDING_INVALID", FILL_PRICE_STALE: "MARK_STALE" };
const toCore = (c: V3FillCode): FPRefusalCode => (c in CORE_CODE ? CORE_CODE[c as keyof typeof CORE_CODE] : (c as FPRefusalCode));

export interface V3Refusal { t: number; symbol: string; proposalId: string | null; strategyId: string | null; stage: "approval" | "fill" | "expiry"; code: V3ApprovalCode | V3FillCode | "APPROVAL_EXPIRED"; source: "engine-v3" | "ledger"; detail: string }

// ---------------------------------------------------------------------------------------------------------------------
// 0049 mirror (sequential, per event) — the same definitions as `fp3_check_account`, `fp3_usage` and the approval checks
// ---------------------------------------------------------------------------------------------------------------------
interface BookPos { side: PerpSide; qty: number; margin: number; strategyId: string; proposalId: string; risk: number }
interface Book { wallet: number; positions: Record<string, BookPos>; approvals: Record<string, V3Approval>; usage: Record<string, StrategyUsage>; net: Record<string, number> }
const clone = <T>(x: T): T => structuredClone(x);
const useOf = (b: Book, sid: string) => (b.usage[sid] ??= { closedLoss: 0, openRisk: 0, pendingRisk: 0 });
const pendingRiskOf = (a: V3Approval, qty: number) => qty * (a.stopDist + (a.referencePrice * a.costPct) / 100);
const total = (u: StrategyUsage) => u.closedLoss + u.openRisk + u.pendingRisk;

function bookFrom(state: FPState, ledger: FPV3Ledger): Book {
  const positions: Record<string, BookPos> = {}, net: Record<string, number> = {};
  for (const [sym, p] of Object.entries(state.positions)) {
    positions[sym] = { side: p.side, qty: p.qty, margin: p.margin, strategyId: p.strategyId, proposalId: p.proposalId, risk: ledger.positions[sym]!.riskReserved };
    net[p.proposalId] = -p.fees + p.funding; // entry fees + funding so far (the database sums the same event cash)
  }
  return { wallet: state.wallet, positions, approvals: clone(ledger.approvals), usage: clone(ledger.usage), net };
}

type Level = "STRATEGY" | "SUB" | "ACCOUNT" | "MISSING" | "ACCOUNT_MISSING";
/** 0049 level checks for strategy `sid` on the current usage: the first exceeded level, or null. */
function levelExceeded(b: Book, ledger: FPV3Ledger, sid: string): { level: Level; detail: string } | null {
  const ab = ledger.accountBudget;
  if (!ab) return { level: "ACCOUNT_MISSING", detail: "no paper account risk budget" };
  const sb = ledger.strategies.find((s) => s.strategyId === sid);
  if (!sb) return { level: "MISSING", detail: `no paper risk budget for strategy ${sid}` };
  const used = (ids: string[]) => ids.reduce((a, id) => a + total(useOf(b, id)), 0);
  const uS = used([sid]);
  if (uS > sb.maxLoss + TOL) return { level: "STRATEGY", detail: `strategy ${sid} usage ${uS.toFixed(6)} > budget ${sb.maxLoss}` };
  const sub = sb.engine === "research" ? ab.research : ab.scalping;
  const uSub = used(ledger.strategies.filter((s) => s.engine === sb.engine).map((s) => s.strategyId));
  if (uSub > sub + TOL) return { level: "SUB", detail: `${sb.engine} sub-budget usage ${uSub.toFixed(6)} > ${sub}` };
  const uA = used(ledger.strategies.map((s) => s.strategyId));
  if (uA > ab.maxLoss + TOL) return { level: "ACCOUNT", detail: `account usage ${uA.toFixed(6)} > ${ab.maxLoss}` };
  return null;
}
/** Room before a new approval, as the Central Risk Engine's {budget, usedLoss} (riskEngineStrategyBudget). */
function sizingRoom(b: Book, ledger: FPV3Ledger, sid: string): { room: number } | { code: V3ApprovalCode; detail: string } {
  if (!ledger.accountBudget) return { code: "APPROVAL_ACCOUNT_BUDGET_MISSING", detail: "no paper account risk budget" };
  const clamp = (u: StrategyUsage) => ({ closedLoss: Math.max(0, u.closedLoss), openRisk: Math.max(0, u.openRisk), pendingRisk: Math.max(0, u.pendingRisk) }); // float drift
  const usage = Object.fromEntries(ledger.strategies.map((s) => [s.strategyId, clamp(useOf(b, s.strategyId))]));
  const r = riskEngineStrategyBudget(ledger.accountBudget, ledger.strategies, usage, sid);
  if (!r) {
    const c = checkAdditionalRisk(ledger.accountBudget, ledger.strategies, usage, sid, 0);
    if (c.code === "STRATEGY_UNKNOWN") return { code: "APPROVAL_BUDGET_MISSING", detail: c.detail };
    if (c.code === "CONFIG_INVALID") return { code: "APPROVAL_BUDGET_CONFIG_INVALID", detail: c.detail };
    throw new FuturesPaperDataError(`budget usage unavailable: ${c.detail}`);
  }
  return { room: r.budget - r.usedLoss };
}
function bookExposure(b: Book, marks: Record<string, number>) {
  let expo = 0, margin = 0; const syms = new Set<string>();
  for (const [sym, p] of Object.entries(b.positions)) { const m = marks[sym]; if (!fin(m)) throw new FuturesPaperDataError(`no candle for held symbol ${sym}`); expo += p.qty * m; margin += p.margin; syms.add(sym); }
  for (const [sym, a] of Object.entries(b.approvals)) { const m = marks[sym]; if (!fin(m)) throw new FuturesPaperDataError(`no candle for pending symbol ${sym}`); const rem = a.approvedQty - a.filledQty; expo += rem * m; margin += (rem * m) / a.leverage; syms.add(sym); }
  return { expo, margin, count: syms.size };
}

type MirrorFail = { stage: "fill"; proposalId: string; code: V3FillCode; detail: string } | { stage: "approval"; proposalId: string; code: V3ApprovalCode; detail: string; roomBefore: number | null };
interface MirrorEnv { cfg: FPConfig; ledger: FPV3Ledger; bar: FPBar; marksO: Record<string, number>; marksC: Record<string, number>; intent: FPIntent | null; cost: ResolvedCost | null; after: FPState }

function mirrorEvent(b: Book, e: FPEvent, env: MirrorEnv): MirrorFail | null {
  const sym = e.symbol, L = env.cfg.limits, spec = env.cfg.specs[sym]!;
  const cash = () => { b.wallet += e.walletDelta; if (e.proposalId) b.net[e.proposalId] = (b.net[e.proposalId] ?? 0) + e.walletDelta; };
  switch (e.kind) {
    case "entry_cancelled": {
      const a = b.approvals[sym];
      if (!a || a.proposalId !== e.proposalId) throw new FuturesPaperDataError(`cancellation of ${sym} has no open approval`);
      useOf(b, a.strategyId).pendingRisk -= pendingRiskOf(a, a.approvedQty - a.filledQty);
      delete b.approvals[sym];
      return null;
    }
    case "entry_fill": {
      const a = b.approvals[sym];
      if (!a || a.proposalId !== e.proposalId) throw new FuturesPaperDataError(`fill of ${sym} has no open approval`);
      if (e.t > a.expiresT) return { stage: "fill", proposalId: a.proposalId, code: "FILL_APPROVAL_EXPIRED", detail: `approval expired at ${a.expiresT}` };
      const u = useOf(b, a.strategyId), q = e.qty, risk = q * a.stopDist + (q * e.price! * a.costPct) / 100;
      u.pendingRisk -= pendingRiskOf(a, q); u.openRisk += risk; a.filledQty += q;
      if (a.approvedQty - a.filledQty <= spec.stepSize / 2) { u.pendingRisk -= pendingRiskOf(a, a.approvedQty - a.filledQty); delete b.approvals[sym]; }
      const p = (b.positions[sym] ??= { side: a.side, qty: 0, margin: 0, strategyId: a.strategyId, proposalId: a.proposalId, risk: 0 });
      p.qty += q; p.margin += e.marginDelta; p.risk += risk; cash();
      const lv = levelExceeded(b, env.ledger, a.strategyId);
      if (lv) return { stage: "fill", proposalId: a.proposalId, code: lv.level === "MISSING" || lv.level === "ACCOUNT_MISSING" ? "STRATEGY_BUDGET_MISSING" : "STRATEGY_BUDGET_EXCEEDED", detail: lv.detail };
      const x = bookExposure(b, env.marksO);
      if (x.expo > L.maxExposure! + TOL) return { stage: "fill", proposalId: a.proposalId, code: "EXPOSURE_LIMIT", detail: `open + pending exposure ${x.expo.toFixed(6)} > ${L.maxExposure}` };
      if (x.count > L.maxPositions!) return { stage: "fill", proposalId: a.proposalId, code: "POSITION_LIMIT", detail: `${x.count} symbols held or pending > ${L.maxPositions}` };
      if (b.wallet - x.margin < -TOL) return { stage: "fill", proposalId: a.proposalId, code: "FREE_MARGIN", detail: `wallet ${b.wallet.toFixed(6)} < margin used + reserved ${x.margin.toFixed(6)}` };
      return null;
    }
    case "funding": { const p = b.positions[sym]; if (!p) throw new FuturesPaperDataError(`funding without a ${sym} position`); p.margin += e.marginDelta; cash(); return null; }
    case "exit_fill": case "liquidation": {
      const p = b.positions[sym]; if (!p) throw new FuturesPaperDataError(`close without a ${sym} position`);
      cash(); const u = useOf(b, p.strategyId);
      u.closedLoss += Math.max(0, -(b.net[p.proposalId] ?? 0)); u.openRisk -= p.risk;
      delete b.positions[sym]; delete b.net[p.proposalId];
      return null;
    }
    case "order_accepted": {
      const it = env.intent, pend = env.after.pending[sym], c = env.cost;
      if (!it || !pend || pend.proposalId !== e.proposalId || !c) throw new FuturesPaperDataError(`accepted order on ${sym} has no matching intent, pending entry or cost`);
      const fail = (code: V3ApprovalCode, detail: string, roomBefore: number | null = null): MirrorFail => ({ stage: "approval", proposalId: pend.proposalId, code, detail, roomBefore });
      const sb = env.ledger.strategies.find((s) => s.strategyId === pend.strategyId);
      if (!sb) return fail("APPROVAL_BUDGET_MISSING", `no paper risk budget for strategy ${pend.strategyId}`);
      const closeT = env.bar.t + env.bar.tfMs, ref = env.marksC[sym]!, stop = it.proposal.stopPrice!, dir = pend.side === "LONG" ? 1 : -1;
      const created = it.proposal.createdAt;
      if (closeT - created > L.maxProposalAgeMs! || created > closeT + 5000) return fail("APPROVAL_PROPOSAL_STALE", `proposal age ${closeT - created} ms`);
      const ix = env.bar.index?.c;
      if (!fin(ix) || (Math.abs(ref - ix) / ix) * 100 > env.cfg.maxBasisPct) return fail("APPROVAL_BASIS", "index missing or basis above the maximum");
      if (!(stop > 0) || (dir === 1 && stop >= ref) || (dir === -1 && stop <= ref)) return fail("APPROVAL_STOP_SIDE", "stop on the wrong side of the mark");
      if (!Number.isInteger(pend.leverage) || pend.leverage < 1 || pend.leverage > L.maxLeverage!) return fail("APPROVAL_LEVERAGE", `leverage ${pend.leverage}`);
      const q = e.qty, steps = q / spec.stepSize;
      if (!(q > 0) || Math.abs(steps - Math.round(steps)) > 1e-6 || q * ref < spec.minNotional) return fail("APPROVAL_LOT_SIZE", `quantity ${q}`);
      const dist = Math.abs(ref - stop), risk = q * (dist + (ref * c.costPct) / 100);
      if (risk > L.maxLossPerTrade! + TOL) return fail("APPROVAL_RISK_PER_TRADE", `risk ${risk.toFixed(6)} > ${L.maxLossPerTrade}`);
      if ((q * ref) / pend.leverage > L.maxMarginPerTrade! + TOL) return fail("APPROVAL_MARGIN_PER_TRADE", "margin above the per-trade maximum");
      const liq = dir === 1 ? ref * (1 - 1 / pend.leverage + spec.maintenanceMarginRate) : ref * (1 + 1 / pend.leverage - spec.maintenanceMarginRate);
      const gap = ((dir === 1 ? stop - liq : liq - stop) / ref) * 100;
      if (gap < L.liquidationBufferPct! - 1e-9) return fail("APPROVAL_LIQUIDATION_BUFFER", `stop ${gap.toFixed(4)}% from estimated liquidation`);
      const before = sizingRoom(b, env.ledger, pend.strategyId);
      const roomBefore = "room" in before ? before.room : null;
      const a: V3Approval = { proposalId: pend.proposalId, strategyId: pend.strategyId, engine: sb.engine, symbol: sym, side: pend.side, approvedQty: q, filledQty: 0, leverage: pend.leverage, referencePrice: ref, stopDist: dist, costPct: c.costPct, approvedT: closeT, expiresT: closeT + L.maxProposalAgeMs! };
      b.approvals[sym] = a; useOf(b, a.strategyId).pendingRisk += risk;
      const lv = levelExceeded(b, env.ledger, a.strategyId);
      if (lv) return fail(lv.level === "STRATEGY" ? "APPROVAL_STRATEGY_BUDGET" : lv.level === "SUB" ? "APPROVAL_SUB_BUDGET" : lv.level === "ACCOUNT" ? "APPROVAL_ACCOUNT_BUDGET" : lv.level === "MISSING" ? "APPROVAL_BUDGET_MISSING" : "APPROVAL_ACCOUNT_BUDGET_MISSING", lv.detail, roomBefore);
      const x = bookExposure(b, env.marksC);
      if (x.expo > L.maxExposure! + TOL) return fail("APPROVAL_EXPOSURE", `open + pending exposure ${x.expo.toFixed(6)} > ${L.maxExposure}`);
      if (x.count > L.maxPositions!) return fail("APPROVAL_POSITION_LIMIT", `${x.count} symbols held or pending`);
      if (b.wallet - x.margin < -TOL) return fail("APPROVAL_FREE_MARGIN", "free margin would be negative");
      return null;
    }
    case "order_rejected": return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// One account-wide candle
// ---------------------------------------------------------------------------------------------------------------------
export interface FPV3Context { accountStatus: "active" | "paused" | "stopped"; accountHalted: boolean }
export interface FPV3Options {
  /** Fills the database refused at commit (from `planLedgerRefusalV3`): cancelled, never re-attempted. */
  refused?: Record<string, V3FillCode>;
  /** Approvals the database refused at commit: the intent is rejected with this code, never re-submitted. */
  rejected?: Record<string, V3ApprovalCode>;
}
export interface FPV3Result {
  state: FPState; events: FPEvent[]; trades: FPTrade[]; decisions: RiskDecision[]; coreRefusals: FPRefusal[];
  refusals: V3Refusal[]; ledger: FPV3Ledger; costs: Record<string, ResolvedCost>; barT: number; attempts: number;
}

export function stepFuturesPaperCandleV3(prev: FPState, cfg: FPConfig, bars: FPBar[], intents: FPIntent[], ctx: FPV3Context, ledger: FPV3Ledger, opts: FPV3Options = {}): FPV3Result {
  if (!Array.isArray(bars) || bars.length === 0) throw new FuturesPaperDataError("account candle: at least one symbol candle is required");
  const t = bars[0]!.t, tf = bars[0]!.tfMs;
  if (!fin(t) || !fin(tf) || !(tf > 0) || t % tf !== 0) throw new FuturesPaperDataError("account candle: candle time is not aligned to its timeframe");
  const syms = bars.map((b) => b.symbol);
  if (new Set(syms).size !== syms.length) throw new FuturesPaperDataError("account candle: a symbol appears twice");
  for (const b of bars) {
    if (b.t !== t || b.tfMs !== tf) throw new FuturesPaperDataError(`account candle: ${b.symbol} is not the same candle`);
    if (!cfg.specs[b.symbol]) throw new FuturesPaperDataError(`${b.symbol}: no symbol specification`);
    if (!b.mark) throw new FuturesPaperDataError(`${b.symbol} ${t}: mark price candle missing`);
  }
  if (prev.accountCursor !== undefined && t <= prev.accountCursor) throw new FuturesPaperDataError(`account candle ${t}: duplicate or out-of-order (account cursor ${prev.accountCursor})`);
  for (const held of [...Object.keys(prev.positions), ...Object.keys(prev.pending)]) if (!syms.includes(held)) throw new FuturesPaperDataError(`account candle ${t}: no candle for held symbol ${held}; nothing is applied`);
  for (const it of intents) if (!syms.includes(it.proposal.symbol.replace("/", ""))) throw new FuturesPaperDataError(`account candle ${t}: intent for ${it.proposal.symbol} has no candle`);
  const L = cfg.limits;
  if (![L.maxExposure, L.maxPositions, L.maxLossPerTrade, L.maxMarginPerTrade, L.maxLeverage, L.liquidationBufferPct, L.maxProposalAgeMs].every(fin)) throw new FuturesPaperDataError("account config: limits required by 0049 are missing");
  const problems = ledgerStateProblems(prev, ledger);
  if (problems.length) throw new FuturesPaperDataError(`ledger and state disagree: ${problems.join("; ")}`);

  const ordered = [...bars].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const marksO = Object.fromEntries(ordered.map((b) => [b.symbol, b.mark!.o])), marksC = Object.fromEntries(ordered.map((b) => [b.symbol, b.mark!.c]));
  // One budget source (C5): the core's per-strategy budget is neutralized; the database definitions are checked here.
  const neutral: Record<string, number> = Object.fromEntries(ledger.strategies.map((s) => [s.strategyId, NEUTRAL_BUDGET]));
  const external = Object.fromEntries(ledger.strategies.map((s) => [s.strategyId, { closedLoss: 0, reservedRisk: 0 }]));
  const fillBase: FPFillContext = { accountStatus: ctx.accountStatus, accountHalted: ctx.accountHalted, externalStrategy: external, marks: Object.fromEntries(ordered.map((b) => [b.symbol, { price: b.mark!.o, t: b.t }])), maxMarkAgeMs: 0 };
  const evaluated = new Set(ledger.evaluatedProposals);

  let s = prev, book = bookFrom(prev, ledger);
  const out: FPV3Result = { state: prev, events: [], trades: [], decisions: [], coreRefusals: [], refusals: [], ledger, costs: {}, barT: t, attempts: 0 };
  const emit = (st: FPState, e: Omit<FPEvent, "seq">) => { const ev = { seq: ++st.seq, ...e }; return ev; };

  for (const bar of ordered) {
    const sym = bar.symbol, closeT = t + tf;
    let st: FPState = structuredClone(s);
    const pre: FPEvent[] = [];
    // E1 — expiry: cancel the remainder before the first fill time after the approval's expiry.
    const pend = st.pending[sym], ap = book.approvals[sym];
    if (pend && ap && bar.t > ap.expiresT) {
      const ev = emit(st, { t: bar.t, symbol: sym, kind: "entry_cancelled", side: pend.side, qty: pend.qtyTotal - pend.qtyFilled, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: `risk approval expired at ${ap.expiresT} [APPROVAL_EXPIRED]; unfilled remainder cancelled`, proposalId: pend.proposalId });
      delete st.pending[sym]; pre.push(ev);
      out.refusals.push({ t: bar.t, symbol: sym, proposalId: pend.proposalId, strategyId: pend.strategyId, stage: "expiry", code: "APPROVAL_EXPIRED", source: "engine-v3", detail: `approval expired at ${ap.expiresT}` });
    }
    const bookPre = clone(book);
    for (const e of pre) mirrorEvent(bookPre, e, { cfg, ledger, bar, marksO, marksC, intent: null, cost: null, after: st });

    // Intents: one per symbol and candle; pre-checks that need the ledger.
    const mine = intents.filter((i) => i.proposal.symbol.replace("/", "") === sym);
    const extra = mine.slice(1);
    let intent: FPIntent | null = mine[0] ?? null, cost: ResolvedCost | null = null;
    const rejections: { it: FPIntent; code: V3ApprovalCode; detail: string; source: V3Refusal["source"] }[] = extra.map((it) => ({ it, code: "APPROVAL_INTENT_LIMIT" as const, detail: "only one intent per symbol and candle is evaluated", source: "engine-v3" as const }));
    const drop = (code: V3ApprovalCode, detail: string, source: V3Refusal["source"] = "engine-v3") => { rejections.unshift({ it: intent!, code, detail, source }); intent = null; };
    const live = ctx.accountStatus === "active" && !ctx.accountHalted; // otherwise the core rejects every intent itself
    if (intent && live) {
      const p = intent.proposal;
      if (opts.rejected?.[p.proposalId]) drop(opts.rejected[p.proposalId]!, "the database refused this approval at commit", "ledger");
      else if (evaluated.has(p.proposalId)) drop("APPROVAL_DUPLICATE_PROPOSAL", `proposal ${p.proposalId} was already evaluated for this owner`);
      else if (!ledger.accountBudget) drop("APPROVAL_ACCOUNT_BUDGET_MISSING", "no paper account risk budget");
      else if (!ledger.strategies.some((x) => x.strategyId === p.strategyId)) drop("APPROVAL_BUDGET_MISSING", `no paper risk budget for strategy ${p.strategyId}`);
      else {
        cost = resolveCost(ledger.costs, p.strategyId, sym, L.roundTripCostPct);
        if (!cost) drop("APPROVAL_COST_MISSING", "no valid round-trip cost assumption");
        else if (ledger.requireValidatedCost && !cost.validated) drop("APPROVAL_COST_UNVALIDATED", `cost ${cost.costPct}% (${cost.source}) is not validated`);
      }
    }
    let maxLoss = L.maxLossPerTrade!;
    if (intent && cost && live) {
      const r = sizingRoom(bookPre, ledger, (intent as FPIntent).proposal.strategyId);
      if ("code" in r) drop(r.code, r.detail);
      else if (!(r.room > EPS)) drop("APPROVAL_STRATEGY_BUDGET", "no budget room left at strategy, sub-budget or account level");
      else maxLoss = Math.min(maxLoss, r.room);
    }

    // Core step + 0049 mirror, until the mirror accepts every approval and fill (bounded).
    const refusedCore: Record<string, FPRefusalCode> = {}; const fillWhy: Record<string, { code: V3FillCode; detail: string; source: V3Refusal["source"] }> = {};
    if (pend && opts.refused?.[pend.proposalId] && st.pending[sym]) { const c = opts.refused[pend.proposalId]!; refusedCore[pend.proposalId] = toCore(c); fillWhy[pend.proposalId] = { code: c, detail: "the database refused this fill at commit", source: "ledger" }; }
    let r: ReturnType<typeof stepFuturesPaper> | null = null, bookAfter = bookPre, attempts = 0;
    for (;;) {
      if (++attempts > MAX_ATTEMPTS) throw new FuturesPaperDataError(`${sym} ${t}: 0049 alignment did not converge`);
      const it = intent as FPIntent | null;
      const cfgSym: FPConfig = { ...cfg, strategyBudgets: neutral, limits: { ...L, maxLossPerTrade: maxLoss, roundTripCostPct: cost ? cost.costPct : L.roundTripCostPct } };
      r = stepFuturesPaper(st, cfgSym, bar, it ? [it] : [], marksC, { ...fillBase, refused: refusedCore });
      bookAfter = clone(bookPre);
      let failed: MirrorFail | null = null;
      for (const e of r.events) { failed = mirrorEvent(bookAfter, e, { cfg, ledger, bar, marksO, marksC, intent: it, cost, after: r.state }); if (failed) break; }
      if (!failed) break;
      if (failed.stage === "fill") {
        if (refusedCore[failed.proposalId]) throw new FuturesPaperDataError(`${sym} ${t}: fill of ${failed.proposalId} still refused after cancellation`);
        refusedCore[failed.proposalId] = toCore(failed.code); fillWhy[failed.proposalId] = { code: failed.code, detail: failed.detail, source: "engine-v3" };
        continue;
      }
      const budget = failed.code === "APPROVAL_STRATEGY_BUDGET" || failed.code === "APPROVAL_SUB_BUDGET" || failed.code === "APPROVAL_ACCOUNT_BUDGET";
      if (budget && failed.roomBefore !== null && failed.roomBefore > EPS && failed.roomBefore < maxLoss - EPS) { maxLoss = failed.roomBefore * (1 - 1e-9); continue; }
      drop(failed.code, failed.detail);
    }
    out.attempts += attempts;
    // Accurate audit text for cancellations the 0049 alignment caused.
    for (const e of r.events) if (e.kind === "entry_cancelled" && e.proposalId && fillWhy[e.proposalId]) {
      const w = fillWhy[e.proposalId]!;
      e.reason = `fill refused [${w.code}] (${w.source === "ledger" ? "database refusal at commit" : "0049-aligned pre-check"}): ${w.detail}; unfilled entry cancelled`;
      out.refusals.push({ t: bar.t, symbol: sym, proposalId: e.proposalId, strategyId: s.pending[sym]?.strategyId ?? null, stage: "fill", code: w.code, source: w.source, detail: w.detail });
    }
    for (const e of r.events) if (e.kind === "order_accepted" && maxLoss < L.maxLossPerTrade! - EPS) e.reason = e.reason.replace("(limited by max loss per trade)", `(limited by database budget room ${maxLoss.toFixed(6)})`);
    // A budget room too small for the minimum order: the core rejects on size; record it as the budget refusal it is.
    if (maxLoss < L.maxLossPerTrade! - EPS) for (const d of r.decisions) {
      const e = r.events.find((x) => x.kind === "order_rejected" && x.proposalId === d.proposalId);
      if (!e || !d.checks.some((c) => c.id === "min_notional" && c.status === "fail")) continue;
      e.reason = `[APPROVAL_STRATEGY_BUDGET] database budget room ${maxLoss.toFixed(6)} is too small for the minimum order; ${e.reason}`;
      out.refusals.push({ t: closeT, symbol: sym, proposalId: d.proposalId, strategyId: (intent as FPIntent | null)?.proposal.strategyId ?? null, stage: "approval", code: "APPROVAL_STRATEGY_BUDGET", source: "engine-v3", detail: `budget room ${maxLoss.toFixed(6)} below the minimum order` });
    }
    st = r.state;
    const post: FPEvent[] = [];
    for (const x of rejections) {
      const p = x.it.proposal;
      post.push(emit(st, { t: closeT, symbol: sym, kind: "order_rejected", side: p.side ?? null, qty: 0, price: null, fee: 0, pnl: 0, walletDelta: 0, marginDelta: 0, reason: `[${x.code}] ${x.detail}`, proposalId: typeof p.proposalId === "string" ? p.proposalId : null }));
      if (typeof p.proposalId === "string") st.seen.push(p.proposalId);
      out.refusals.push({ t: closeT, symbol: sym, proposalId: p.proposalId ?? null, strategyId: p.strategyId ?? null, stage: "approval", code: x.code, source: x.source, detail: x.detail });
    }
    // Renumber: expiry cancellations first, then the core's events, then wrapper rejections (strictly consecutive).
    const all = [...pre, ...r.events, ...post];
    all.forEach((e, i) => { e.seq = s.seq + i + 1; });
    st.seq = s.seq + all.length;
    if (intent && cost) out.costs[(intent as FPIntent).proposal.proposalId] = cost;
    out.events.push(...all); out.trades.push(...r.trades); out.decisions.push(...r.decisions); out.coreRefusals.push(...r.refusals);
    book = bookAfter; s = st;
  }
  out.state = { ...s, accountCursor: t };
  out.ledger = {
    ...ledger, evaluatedProposals: [],
    usage: Object.fromEntries(Object.entries(book.usage).map(([k, u]) => [k, { closedLoss: Math.max(0, u.closedLoss), openRisk: Math.max(0, u.openRisk), pendingRisk: Math.max(0, u.pendingRisk) }])),
    approvals: book.approvals,
    positions: Object.fromEntries(Object.entries(book.positions).map(([sym, p]) => [sym, { symbol: sym, proposalId: p.proposalId, strategyId: p.strategyId, riskReserved: p.risk }])),
  };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// E3 — database refusal → deterministic next step. The message is classified into a bounded code and never stored.
// ---------------------------------------------------------------------------------------------------------------------
export type LedgerRefusalPlanV3 =
  | { action: "recompute"; refused: Record<string, V3FillCode>; rejected: Record<string, V3ApprovalCode>; code: V3FillCode | V3ApprovalCode }
  | { action: "reload_account"; code: "SEQUENCE_MOVED" | "ACCOUNT_STATE_CHANGED" | "CANDLE_ALREADY_COMMITTED" }
  | { action: "wait"; code: "CANDLE_NOT_CLOSED" }
  | { action: "halt_for_review"; code: "REFUSAL_REPEATED" | "UNCLASSIFIED_REFUSAL" | "AMBIGUOUS_APPROVAL" | "APPROVAL_INCONSISTENT" | "FILL_INCONSISTENT" };

type Key = "strategy" | "proposal" | "symbol" | null;
/** Approval-time messages of draft 0049 (order matters: specific before generic). */
export const APPROVAL_REFUSALS: [RegExp, V3ApprovalCode, Key][] = [
  [/approval refused: no paper risk budget for strategy (\S+)/, "APPROVAL_BUDGET_MISSING", "strategy"],
  [/approval refused: proposal (\S+) was already evaluated/, "APPROVAL_DUPLICATE_PROPOSAL", "proposal"],
  [/approval refused: (\S+) already has a position or a pending entry/, "APPROVAL_SYMBOL_BUSY", "symbol"],
  [/approval refused: price is older than/, "APPROVAL_PRICE_STALE", null],
  [/approval refused: proposal age/, "APPROVAL_PROPOSAL_STALE", null],
  [/approval refused: index price missing or mark\/index basis/, "APPROVAL_BASIS", null],
  [/approval refused: stop is on the wrong side/, "APPROVAL_STOP_SIDE", null],
  [/approval refused: leverage \S+ outside/, "APPROVAL_LEVERAGE", null],
  [/approval refused: quantity \S+ is not a lot-size multiple/, "APPROVAL_LOT_SIZE", null],
  [/approval refused: risk \S+ exceeds the per-trade maximum/, "APPROVAL_RISK_PER_TRADE", null],
  [/approval refused: margin \S+ exceeds the per-trade maximum/, "APPROVAL_MARGIN_PER_TRADE", null],
  [/approval refused: stop is \S+ % from estimated liquidation/, "APPROVAL_LIQUIDATION_BUFFER", null],
  [/approval refused: daily loss limit reached/, "APPROVAL_DAILY_LOSS", null],
  [/no paper account risk budget: approval refused/, "APPROVAL_ACCOUNT_BUDGET_MISSING", null],
  [/strategy (\S+) budget \S+-sub-budget:\S+ would be exceeded at approval/, "APPROVAL_SUB_BUDGET", "strategy"],
  [/strategy (\S+) budget account:\S+ would be exceeded at approval/, "APPROVAL_ACCOUNT_BUDGET", "strategy"],
  [/strategy (\S+) budget \S+ would be exceeded at approval/, "APPROVAL_STRATEGY_BUDGET", "strategy"],
  [/exposure \S+ would exceed \S+ at approval/, "APPROVAL_EXPOSURE", null],
  [/position limit \S+ exceeded at approval/, "APPROVAL_POSITION_LIMIT", null],
  [/free margin would be negative at approval/, "APPROVAL_FREE_MARGIN", null],
];
/** Fill-time messages that a deterministic cancellation resolves. */
export const FILL_REFUSALS_V3: [RegExp, V3FillCode, Key][] = [
  [/risk approval (\S+) expired at/, "FILL_APPROVAL_EXPIRED", "proposal"],
  [/entry fill refused: price is older than/, "FILL_PRICE_STALE", null],
  [/daily loss limit reached: entry fill refused/, "DAILY_LOSS_LIMIT", null],
  [/no paper account risk budget: fill refused/, "STRATEGY_BUDGET_MISSING", null],
  [/no paper risk budget for strategy (\S+): entry fill refused/, "STRATEGY_BUDGET_MISSING", "strategy"],
  [/strategy (\S+) budget \S+ would be exceeded at fill/, "STRATEGY_BUDGET_EXCEEDED", "strategy"],
  [/exposure \S+ would exceed \S+ at fill/, "EXPOSURE_LIMIT", null],
  [/position limit \S+ exceeded at fill/, "POSITION_LIMIT", null],
  [/free margin would be negative at fill/, "FREE_MARGIN", null],
  [/entry fill does not match the open \S+ position/, "STRATEGY_IDENTITY_MISMATCH", null],
];
/** Messages that mean the engine and the database disagree about facts: never resolved automatically. */
export const INCONSISTENT_REFUSALS: [RegExp, "APPROVAL_INCONSISTENT" | "FILL_INCONSISTENT"][] = [
  [/approval: proposal, strategy and side are required/, "APPROVAL_INCONSISTENT"],
  [/approval refused: approvals are made at the candle close/, "APPROVAL_INCONSISTENT"],
  [/entry fill without a valid risk approval/, "FILL_INCONSISTENT"],
  [/risk approval \S+ is \S+ and cannot fill/, "FILL_INCONSISTENT"],
  [/entry fill does not match the open \S+ risk approval/, "FILL_INCONSISTENT"],
  [/entry fill precedes its risk approval/, "FILL_INCONSISTENT"],
  [/entry fill quantity .* exceeds the approved remainder/, "FILL_INCONSISTENT"],
  [/entry fill price .* differs from the taker price/, "FILL_INCONSISTENT"],
  [/entry fill fee differs from the database computation/, "FILL_INCONSISTENT"],
  [/entry fill margin differs from the approved leverage/, "FILL_INCONSISTENT"],
];

/**
 * @param prev    state the refused attempt started from
 * @param attempt the refused candle's events and resulting state (accepted orders' strategies live in its pending entries)
 * @param message database error message (classified only; never persisted)
 * @param already refusals and rejections already applied to this candle
 */
export function planLedgerRefusalV3(prev: FPState, attempt: { events: FPEvent[]; state: FPState }, message: string, already: { refused?: Record<string, V3FillCode>; rejected?: Record<string, V3ApprovalCode> } = {}): LedgerRefusalPlanV3 {
  const m = String(message ?? "").slice(0, 500), refused = { ...(already.refused ?? {}) }, rejected = { ...(already.rejected ?? {}) };
  if (/already committed with a different payload/.test(m)) return { action: "reload_account", code: "CANDLE_ALREADY_COMMITTED" };
  if (/sequence moved|is not after the cursor/.test(m)) return { action: "reload_account", code: "SEQUENCE_MOVED" };
  if (/entries are refused while the account is not active or is halted|account is stopped/.test(m)) return { action: "reload_account", code: "ACCOUNT_STATE_CHANGED" };
  if (/has not closed yet/.test(m)) return { action: "wait", code: "CANDLE_NOT_CLOSED" };
  for (const [re, code] of INCONSISTENT_REFUSALS) if (re.test(m)) return { action: "halt_for_review", code };
  for (const [re, code, key] of APPROVAL_REFUSALS) {
    const hit = re.exec(m); if (!hit) continue;
    let targets = attempt.events.filter((e) => e.kind === "order_accepted" && e.proposalId && !(e.proposalId in rejected));
    const v = hit[1];
    if (key === "proposal") targets = targets.filter((e) => e.proposalId === v);
    if (key === "symbol") targets = targets.filter((e) => e.symbol === v);
    if (key === "strategy") targets = targets.filter((e) => attempt.state.pending[e.symbol]?.strategyId === v);
    if (targets.length === 0) return { action: "halt_for_review", code: "REFUSAL_REPEATED" };
    if (targets.length > 1) return { action: "halt_for_review", code: "AMBIGUOUS_APPROVAL" };
    rejected[targets[0]!.proposalId!] = code;
    return { action: "recompute", refused, rejected, code };
  }
  for (const [re, code, key] of FILL_REFUSALS_V3) {
    const hit = re.exec(m); if (!hit) continue;
    let targets = attempt.events.filter((e) => e.kind === "entry_fill" && e.proposalId && !(e.proposalId in refused));
    const v = hit[1];
    if (key === "proposal") targets = targets.filter((e) => e.proposalId === v);
    if (key === "strategy") targets = targets.filter((e) => prev.pending[e.symbol]?.strategyId === v);
    if (targets.length === 0) return { action: "halt_for_review", code: "REFUSAL_REPEATED" };
    for (const e of targets) refused[e.proposalId!] = code;
    return { action: "recompute", refused, rejected, code };
  }
  return { action: "halt_for_review", code: "UNCLASSIFIED_REFUSAL" };
}
