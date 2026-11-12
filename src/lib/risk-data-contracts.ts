// Phase 4C — risk-data CONTRACTS (design only). Pure validators for the five inputs the Central Risk Engine cannot
// read today: strategy budget, strategy loss attribution, maintenance-margin brackets, available margin and Testnet
// market data. No I/O, no network, no credentials, no database; nothing in the app imports this module (isolation
// test). A valid snapshot is NOT a data source and authorizes nothing: it only proves a future source's payload would
// be acceptable. Anything missing, non-finite, out of range, stale, future-dated, mis-scoped or from the wrong
// environment returns INSUFFICIENT_DATA — never a permissive default. Max ages are PROPOSALS (NOT APPROVED).
// See docs/phase-4c/risk-data-contracts.md.

export const RISK_DATA_CONTRACTS_VERSION = "risk-data-contracts-v1" as const;
export type ContractEnvironment = "paper" | "testnet" | "production";
/** PROPOSED maximum ages in ms — NOT APPROVED; owner decision required before any enforcement. */
export const PROPOSED_MAX_AGE_MS = Object.freeze({ attribution: 5_000, brackets: 3_600_000, availableMargin: 5_000, testnetMark: 5_000, clockSkew: 1_000 });
export const TESTNET_PUBLIC_HOST = "https://testnet.binancefuture.com" as const;

export interface StrategyRiskBudgetSnapshot { userId: string; strategyId: string; environment: ContractEnvironment; maxLossUsdt: number; updatedAt: number; observedAt: number; source: "strategy_risk_budgets" }
export interface StrategyLossAttributionSnapshot { strategyId: string; strategyVersion: number; environment: ContractEnvironment; realizedNetLossUsdt: number; openRiskReservedUsdt: number; coverage: "COMPLETE" | "PARTIAL" | "NONE"; unattributedTradeCount: number; asOf: number }
export interface MarginBracket { notionalFloorUsdt: number; notionalCapUsdt: number; maintMarginRatio: number; maintAmountUsdt: number; initialLeverage: number }
export interface MaintenanceMarginBracketsSnapshot { symbol: string; environment: ContractEnvironment; brackets: MarginBracket[]; exchangeTime: number; fetchedAt: number; source: string }
export interface AvailableMarginSnapshot { environment: ContractEnvironment; connectionRef: string; availableBalanceUsdt: number; exchangeTime: number; fetchedAt: number; source: string }
export interface TestnetMarketSnapshot { symbol: string; environment: "testnet"; markPrice: number; markTime: number; stepSize: number; minNotionalUsdt: number; fetchedAt: number; source: string }

export type ContractResult<T> = { status: "VALID"; value: T; problems: [] } | { status: "INSUFFICIENT_DATA"; value: null; problems: string[] };
export interface Expect { now: number; environment: ContractEnvironment }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const ts = (x: unknown): x is number => fin(x) && Number.isInteger(x) && x > 0;
const str = (x: unknown, max = 200): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
function result<T>(problems: string[], v: unknown): ContractResult<T> {
  return problems.length ? { status: "INSUFFICIENT_DATA", value: null, problems } : { status: "VALID", value: Object.freeze(structuredClone(v)) as T, problems: [] };
}
function timing(p: string[], name: string, t: unknown, now: number, maxAge: number | null) {
  if (!ts(t)) { p.push(`${name} missing or not an epoch-ms integer`); return; }
  if (t > now + PROPOSED_MAX_AGE_MS.clockSkew) p.push(`${name} is in the future`);
  else if (maxAge !== null && now - t > maxAge) p.push(`${name} is stale (${now - t} ms > ${maxAge} ms)`);
}
function env(p: string[], got: unknown, e: Expect) { if (got !== e.environment) p.push(`environment ${String(got)} does not match the bound environment ${e.environment}`); }

/** Strategy budget row, read in the same evaluation. Scope must match owner, strategy and environment exactly. */
export function validateStrategyBudget(x: unknown, e: Expect & { userId: string; strategyId: string }): ContractResult<StrategyRiskBudgetSnapshot> {
  const p: string[] = [];
  if (!isObj(x)) return result([`strategy budget missing`], null);
  if (x["source"] !== "strategy_risk_budgets") p.push("unexpected budget source");
  if (x["userId"] !== e.userId) p.push("budget belongs to another owner");
  if (x["strategyId"] !== e.strategyId) p.push("budget is for another strategy");
  env(p, x["environment"], e);
  const m = x["maxLossUsdt"]; if (!fin(m) || !(m > 0) || m > 1_000_000) p.push("maxLossUsdt must be finite, > 0 and ≤ 1,000,000 USDT");
  timing(p, "observedAt", x["observedAt"], e.now, PROPOSED_MAX_AGE_MS.attribution);
  if (!ts(x["updatedAt"])) p.push("updatedAt missing");
  else if (ts(x["observedAt"]) && (x["updatedAt"] as number) > (x["observedAt"] as number)) p.push("updatedAt is after observedAt");
  return result(p, x);
}

/** Loss attribution: only COMPLETE coverage with zero unattributed trades is usable. */
export function validateLossAttribution(x: unknown, e: Expect & { strategyId: string }): ContractResult<StrategyLossAttributionSnapshot> {
  const p: string[] = [];
  if (!isObj(x)) return result(["strategy loss attribution missing"], null);
  if (x["strategyId"] !== e.strategyId) p.push("attribution is for another strategy");
  env(p, x["environment"], e);
  const v = x["strategyVersion"]; if (!fin(v) || !Number.isInteger(v) || v < 1) p.push("strategyVersion must be a positive integer");
  for (const k of ["realizedNetLossUsdt", "openRiskReservedUsdt"]) { const n = x[k]; if (!fin(n) || n < 0) p.push(`${k} must be finite and ≥ 0`); }
  const u = x["unattributedTradeCount"]; if (!fin(u) || !Number.isInteger(u) || u < 0) p.push("unattributedTradeCount must be a non-negative integer");
  else if (u > 0) p.push(`${u} unattributed trade(s) in the window: attribution incomplete`);
  if (x["coverage"] !== "COMPLETE") p.push(`coverage ${String(x["coverage"])} is not COMPLETE`);
  timing(p, "asOf", x["asOf"], e.now, PROPOSED_MAX_AGE_MS.attribution);
  return result(p, x);
}
/** Used loss for the Risk Engine (realized net loss + reserved open risk). Null unless the snapshot is valid. */
export const usedLossFrom = (r: ContractResult<StrategyLossAttributionSnapshot>) => (r.status === "VALID" ? r.value.realizedNetLossUsdt + r.value.openRiskReservedUsdt : null);

/** Leverage brackets: ordered, contiguous from 0, non-overlapping, valid ratios. Leverage alone is never used. */
export function validateBrackets(x: unknown, e: Expect & { symbol: string }): ContractResult<MaintenanceMarginBracketsSnapshot> {
  const p: string[] = [];
  if (!isObj(x)) return result(["maintenance-margin brackets missing"], null);
  if (x["symbol"] !== e.symbol) p.push("brackets are for another symbol");
  env(p, x["environment"], e);
  if (e.environment === "paper") p.push("paper accounts never use exchange account brackets");
  if (!str(x["source"], 300)) p.push("source missing");
  timing(p, "fetchedAt", x["fetchedAt"], e.now, PROPOSED_MAX_AGE_MS.brackets);
  timing(p, "exchangeTime", x["exchangeTime"], e.now, PROPOSED_MAX_AGE_MS.brackets);
  const bs = x["brackets"];
  if (!Array.isArray(bs) || bs.length === 0) p.push("no brackets");
  else bs.forEach((b: unknown, i) => {
    if (!isObj(b)) { p.push(`bracket ${i} malformed`); return; }
    const f = b["notionalFloorUsdt"], c = b["notionalCapUsdt"], r = b["maintMarginRatio"], a = b["maintAmountUsdt"], l = b["initialLeverage"];
    if (!fin(f) || !fin(c) || f < 0 || !(c > f)) p.push(`bracket ${i}: floor/cap invalid`);
    if (!fin(r) || !(r > 0) || !(r < 1)) p.push(`bracket ${i}: maintMarginRatio must be in (0, 1)`);
    if (!fin(a) || a < 0) p.push(`bracket ${i}: maintAmountUsdt must be ≥ 0`);
    if (!fin(l) || !Number.isInteger(l) || l < 1) p.push(`bracket ${i}: initialLeverage must be a positive integer`);
    const prev = bs[i - 1] as Record<string, unknown> | undefined;
    if (i === 0 && f !== 0) p.push("first bracket must start at 0 notional");
    if (prev && prev["notionalCapUsdt"] !== f) p.push(`bracket ${i} is not contiguous with bracket ${i - 1}`);
  });
  return result(p, x);
}
/** The bracket covering `notional`; null when the snapshot is invalid or no bracket covers it (never extrapolated). */
export function bracketFor(r: ContractResult<MaintenanceMarginBracketsSnapshot>, notional: number): MarginBracket | null {
  if (r.status !== "VALID" || !fin(notional) || notional < 0) return null;
  return r.value.brackets.find((b) => notional >= b.notionalFloorUsdt && notional < b.notionalCapUsdt) ?? null;
}

/** Futures available margin from the bound account. Wallet, equity and Spot balances are never accepted. */
export function validateAvailableMargin(x: unknown, e: Expect & { connectionRef: string }): ContractResult<AvailableMarginSnapshot> {
  const p: string[] = [];
  if (!isObj(x)) return result(["available margin missing"], null);
  env(p, x["environment"], e);
  if (e.environment === "paper") p.push("paper accounts never use exchange account margin");
  if (x["connectionRef"] !== e.connectionRef) p.push("margin is for another connection");
  const src = x["source"];
  if (!str(src, 300) || !/\/fapi\/v[23]\/account$/.test(src)) p.push("source must be the USD-M Futures account endpoint (wallet/Spot balances are not margin)");
  const a = x["availableBalanceUsdt"]; if (!fin(a) || a < 0) p.push("availableBalanceUsdt must be finite and ≥ 0");
  for (const k of ["walletBalance", "walletBalanceUsdt", "spotBalance", "equity"]) if (k in x) p.push(`field ${k} is not accepted as available margin`);
  timing(p, "fetchedAt", x["fetchedAt"], e.now, PROPOSED_MAX_AGE_MS.availableMargin);
  timing(p, "exchangeTime", x["exchangeTime"], e.now, PROPOSED_MAX_AGE_MS.availableMargin);
  return result(p, x);
}

/** Testnet market data must come from the Testnet host; production prices are never substituted. */
export function validateTestnetMarket(x: unknown, e: { now: number; symbol: string }): ContractResult<TestnetMarketSnapshot> {
  const p: string[] = [];
  if (!isObj(x)) return result(["Testnet market data missing"], null);
  if (x["environment"] !== "testnet") p.push("Testnet market data must be labelled testnet");
  if (x["symbol"] !== e.symbol) p.push("market data is for another symbol");
  const src = x["source"]; if (typeof src !== "string" || !src.startsWith(`${TESTNET_PUBLIC_HOST}/fapi/v1/`)) p.push("source is not the Testnet host (production prices are never used for Testnet)");
  for (const k of ["markPrice", "stepSize", "minNotionalUsdt"]) { const n = x[k]; if (!fin(n) || !(n > 0)) p.push(`${k} must be finite and > 0`); }
  timing(p, "markTime", x["markTime"], e.now, PROPOSED_MAX_AGE_MS.testnetMark);
  timing(p, "fetchedAt", x["fetchedAt"], e.now, PROPOSED_MAX_AGE_MS.testnetMark);
  return result(p, x);
}
