// Account-level risk budgeting (owner decision, 13 Nov 2026): ONE central account budget per owner and environment,
// split into a Research sub-budget and a Scalping sub-budget; every strategy belongs to exactly one sub-budget.
// Pure and browser-safe; imports nothing. It mirrors the definitions draft migration 0049 enforces in the database
// (`fp3_usage`, `fp3_check_account`, budget guards) so the Risk Engine, the paper engine and reports can apply the
// SAME shared check. Nothing here places, sizes or authorizes an order; nothing calls it on an order path. All
// numbers are caller configuration — no budget value is approved policy.
//
// Usage of a strategy = cumulative closed-trade losses (wins never refill) + reserved risk of OPEN positions + risk of
// PENDING (approved, unfilled) entries. A new risk amount fits only if it fits the strategy budget, its sub-budget AND
// the account budget. Statically, Σ sub-budgets ≤ account budget and Σ strategy budgets of a sub-budget ≤ that
// sub-budget, so independently additive strategy budgets can never exceed the central account budget.

export type BudgetEngine = "research" | "scalping";
export const BUDGET_ENGINES: readonly BudgetEngine[] = ["research", "scalping"] as const;
export interface AccountRiskBudget { maxLoss: number; research: number; scalping: number }
export interface StrategyRiskBudget { strategyId: string; engine: BudgetEngine; maxLoss: number }
export interface StrategyUsage { closedLoss: number; openRisk: number; pendingRisk: number }
export type BudgetCheckCode = "OK" | "CONFIG_INVALID" | "STRATEGY_UNKNOWN" | "USAGE_UNKNOWN" | "RISK_INVALID" | "STRATEGY_BUDGET" | "SUB_BUDGET" | "ACCOUNT_BUDGET";
export interface BudgetCheck { ok: boolean; code: BudgetCheckCode; room: number; usage: { strategy: number; subBudget: number; account: number } | null; detail: string }

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const TOL = 1e-6;

/** Static configuration problems; an empty list means the configuration is nested correctly. */
export function validateBudgetConfig(account: AccountRiskBudget, strategies: StrategyRiskBudget[]): string[] {
  const out: string[] = [];
  if (!account || !fin(account.maxLoss) || !(account.maxLoss > 0)) out.push("account budget must be a positive number");
  if (!account || !fin(account.research) || account.research < 0 || !fin(account.scalping) || account.scalping < 0) out.push("sub-budgets must be non-negative numbers");
  if (out.length) return out;
  if (account.research + account.scalping > account.maxLoss + TOL) out.push(`sub-budgets ${account.research} + ${account.scalping} exceed the account budget ${account.maxLoss}`);
  const seen = new Set<string>();
  const sum: Record<BudgetEngine, number> = { research: 0, scalping: 0 };
  for (const s of strategies) {
    if (!s || typeof s.strategyId !== "string" || !s.strategyId) { out.push("a strategy budget has no strategy id"); continue; }
    if (seen.has(s.strategyId)) out.push(`strategy ${s.strategyId} has more than one budget`);
    seen.add(s.strategyId);
    if (!BUDGET_ENGINES.includes(s.engine)) { out.push(`strategy ${s.strategyId} has no valid sub-budget (research or scalping)`); continue; }
    if (!fin(s.maxLoss) || !(s.maxLoss > 0)) { out.push(`strategy ${s.strategyId} budget must be a positive number`); continue; }
    sum[s.engine] += s.maxLoss;
  }
  for (const e of BUDGET_ENGINES) if (sum[e] > account[e] + TOL) out.push(`${e} strategy budgets total ${sum[e]} above the ${e} sub-budget ${account[e]}`);
  return out;
}

const total = (u: StrategyUsage) => u.closedLoss + u.openRisk + u.pendingRisk;
function validUsage(u: StrategyUsage | undefined): u is StrategyUsage {
  return !!u && [u.closedLoss, u.openRisk, u.pendingRisk].every((x) => fin(x) && x >= 0);
}

/**
 * Whether `addRisk` more risk for `strategyId` fits every level. Fails closed: invalid configuration, an unknown
 * strategy, or missing/invalid usage for ANY budgeted strategy refuses (never a default of zero).
 */
export function checkAdditionalRisk(account: AccountRiskBudget, strategies: StrategyRiskBudget[], usage: Record<string, StrategyUsage>, strategyId: string, addRisk: number): BudgetCheck {
  const no = (code: BudgetCheckCode, detail: string, u: BudgetCheck["usage"] = null): BudgetCheck => ({ ok: false, code, room: 0, usage: u, detail });
  const issues = validateBudgetConfig(account, strategies);
  if (issues.length) return no("CONFIG_INVALID", issues.join("; "));
  const s = strategies.find((x) => x.strategyId === strategyId);
  if (!s) return no("STRATEGY_UNKNOWN", `no budget for strategy ${strategyId}`);
  if (!fin(addRisk) || addRisk < 0) return no("RISK_INVALID", "the additional risk must be a non-negative number");
  for (const x of strategies) if (!validUsage(usage[x.strategyId])) return no("USAGE_UNKNOWN", `usage of strategy ${x.strategyId} is unknown`);
  const uStrategy = total(usage[s.strategyId]!);
  const uSub = strategies.filter((x) => x.engine === s.engine).reduce((a, x) => a + total(usage[x.strategyId]!), 0);
  const uAccount = strategies.reduce((a, x) => a + total(usage[x.strategyId]!), 0);
  const u = { strategy: uStrategy, subBudget: uSub, account: uAccount };
  const subMax = account[s.engine];
  const levels: [BudgetCheckCode, number, number, string][] = [
    ["STRATEGY_BUDGET", s.maxLoss, uStrategy, `strategy ${s.strategyId} budget`],
    ["SUB_BUDGET", subMax, uSub, `${s.engine} sub-budget`],
    ["ACCOUNT_BUDGET", account.maxLoss, uAccount, "account budget"],
  ];
  const room = Math.max(0, Math.min(...levels.map(([, max, used]) => max - used)));
  for (const [code, max, used, what] of levels) {
    if (used + addRisk > max + TOL) return { ok: false, code, room, usage: u, detail: `${what} ${max}: used ${used.toFixed(6)} + new ${addRisk.toFixed(6)} exceeds it` };
  }
  return { ok: true, code: "OK", room, usage: u, detail: `fits: room ${room.toFixed(6)} after strategy, ${s.engine} sub-budget and account checks` };
}

/**
 * The tightest remaining room expressed as the Central Risk Engine's strategy input ({budget, usedLoss} with
 * budget − usedLoss = room), so acceptance can size with the same shared definition. null = cannot be established.
 */
export function riskEngineStrategyBudget(account: AccountRiskBudget, strategies: StrategyRiskBudget[], usage: Record<string, StrategyUsage>, strategyId: string): { budget: number; usedLoss: number } | null {
  const c = checkAdditionalRisk(account, strategies, usage, strategyId, 0);
  if (!c.usage || (c.code !== "OK" && c.code !== "STRATEGY_BUDGET" && c.code !== "SUB_BUDGET" && c.code !== "ACCOUNT_BUDGET")) return null;
  return { budget: c.usage.strategy + c.room, usedLoss: c.usage.strategy };
}

export interface OpenPositionExposure { symbol: string; qty: number; margin: number }
export interface PendingEntryExposure { symbol: string; remainingQty: number; leverage: number }
/**
 * Open AND pending exposure, symbols held or pending, and margin used + reserved, at the given marks. Returns null
 * when any involved symbol has no positive mark (never values a position at a fallback price).
 */
export function openAndPendingExposure(positions: OpenPositionExposure[], pending: PendingEntryExposure[], marks: Record<string, number>) {
  let exposure = 0, margin = 0; const symbols = new Set<string>();
  for (const p of positions) { const m = marks[p.symbol]; if (!fin(m) || !(m > 0) || !fin(p.qty) || !fin(p.margin)) return null; exposure += p.qty * m; margin += p.margin; symbols.add(p.symbol); }
  for (const q of pending) { const m = marks[q.symbol]; if (!fin(m) || !(m > 0) || !fin(q.remainingQty) || !(q.leverage >= 1)) return null; exposure += q.remainingQty * m; margin += (q.remainingQty * m) / q.leverage; symbols.add(q.symbol); }
  return { exposure, positionCount: symbols.size, marginUsedAndReserved: margin };
}
