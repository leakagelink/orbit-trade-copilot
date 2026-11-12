// AI research spending limits. Pure and browser-safe.
// Token, call, correction and duration limits are enforced before every AI call. USD limits apply only to costs the
// provider actually reports: AI Prime Tech returns token counts but no price, and no list price is ever assumed.
import { z } from "zod";

export const researchBudget = z.object({
  perRunTokens: z.number().int().min(10_000).max(2_000_000),
  perUserDayTokens: z.number().int().min(10_000).max(100_000_000),
  perUserMonthTokens: z.number().int().min(10_000).max(500_000_000),
  platformMonthTokens: z.number().int().min(10_000).max(5_000_000_000),
  maxCallsPerRun: z.number().int().min(1).max(60),
  maxRepairsPerRun: z.number().int().min(0).max(12),
  maxRunSeconds: z.number().int().min(60).max(3600),
  perRunUsd: z.number().positive().max(10_000).nullable(),
  platformMonthUsd: z.number().positive().max(1_000_000).nullable(),
});
export type ResearchBudget = z.infer<typeof researchBudget>;

/** Used until an admin saves limits (and while the configuration table is not enabled). Conservative by design. */
export const DEFAULT_RESEARCH_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  perRunTokens: 250_000,
  perUserDayTokens: 600_000,
  perUserMonthTokens: 3_000_000,
  platformMonthTokens: 20_000_000,
  maxCallsPerRun: 16,
  maxRepairsPerRun: 3,
  maxRunSeconds: 1200,
  perRunUsd: null,
  platformMonthUsd: null,
});

/** Analyst calls request at most this many output tokens. */
export const ANALYST_MAX_OUTPUT_TOKENS = 4000;
/** Output cap for the single correction call after a reply ran out of output allowance. */
export const ANALYST_REPAIR_MAX_OUTPUT_TOKENS = 8000;
/** Conservative pre-call estimate: about 3 characters per input token, plus the full output allowance. */
export function projectCallTokens(inputChars: number, maxOutputTokens = ANALYST_MAX_OUTPUT_TOKENS) {
  if (!Number.isFinite(inputChars) || inputChars < 0) throw new Error("Invalid research input size");
  return Math.ceil(inputChars / 3) + maxOutputTokens;
}

/** Stops the whole run: no further AI calls of any kind. */
export class ResearchBudgetStop extends Error {
  constructor(readonly limit: string, message: string) { super(message); this.name = "ResearchBudgetStop"; }
}

export interface PriorUsage { userDayTokens?: number; userMonthTokens: number; platformMonthTokens: number; platformMonthUsd: number | null }
export interface BudgetState {
  limits: ResearchBudget; runTokens: number; runUsd: number | null; reserved: number; costReported: boolean;
  calls: number; repairs: number; elapsedMs: number;
  userDayTokens: number; userMonthTokens: number; platformMonthTokens: number; stoppedBy: string | null; stopReason: string | null;
}

/**
 * One meter per run. Reservations are synchronous, so parallel calls in one stage cannot jointly exceed a limit.
 * Once any stop happens, every later reservation is refused too (no hidden follow-up calls).
 */
export function createBudgetMeter(limits: ResearchBudget, prior: PriorUsage, clock: { startedAt: number; now: () => number } = { startedAt: Date.now(), now: Date.now }) {
  researchBudget.parse(limits);
  const priorDay = prior.userDayTokens ?? 0;
  if (![priorDay, prior.userMonthTokens, prior.platformMonthTokens].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Research usage evidence unavailable");
  let runTokens = 0, reserved = 0, runUsd = 0, costReported = false, calls = 0, repairs = 0;
  let stoppedBy: string | null = null, stopReason: string | null = null;
  const stop = (limit: string, message: string): never => {
    if (!stoppedBy) { stoppedBy = limit; stopReason = message; }
    throw new ResearchBudgetStop(stoppedBy, stopReason ?? message);
  };
  const fmt = (n: number) => n.toLocaleString("en-US");
  return {
    /** kind "repair" = the single format-correction call for one agent. */
    reserve(projected: number, kind: "call" | "repair" = "call") {
      if (!Number.isFinite(projected) || projected <= 0) throw new Error("Invalid research call estimate");
      if (stoppedBy) stop(stoppedBy, stopReason ?? "Research was stopped");
      if (clock.now() - clock.startedAt > limits.maxRunSeconds * 1000) stop("max_duration", `Time limit reached: this run passed the ${Math.round(limits.maxRunSeconds / 60)}-minute maximum. No further AI calls were made.`);
      if (calls + 1 > limits.maxCallsPerRun) stop("max_calls", `Call limit reached: this run already made ${limits.maxCallsPerRun} AI calls. No further AI calls were made.`);
      // A refused correction fails only that agent; it does not stop the other agents.
      if (kind === "repair" && repairs + 1 > limits.maxRepairsPerRun) throw new Error(`Format correction not attempted: this run reached its limit of ${limits.maxRepairsPerRun} corrections`);
      const after = runTokens + reserved + projected;
      if (after > limits.perRunTokens) stop("per_run_tokens", `Spending limit reached: this call could exceed the per-run limit of ${fmt(limits.perRunTokens)} tokens. No further AI calls were made for this run.`);
      if (priorDay + after > limits.perUserDayTokens) stop("user_day_tokens", `Spending limit reached: your daily research limit of ${fmt(limits.perUserDayTokens)} tokens would be exceeded. No further AI calls were made.`);
      if (prior.userMonthTokens + after > limits.perUserMonthTokens) stop("user_month_tokens", `Spending limit reached: your monthly research limit of ${fmt(limits.perUserMonthTokens)} tokens would be exceeded. No further AI calls were made.`);
      if (prior.platformMonthTokens + after > limits.platformMonthTokens) stop("platform_month_tokens", "Spending limit reached: the platform's monthly AI research limit would be exceeded. No further AI calls were made.");
      if (limits.perRunUsd !== null && costReported && runUsd >= limits.perRunUsd) stop("per_run_usd", `Spending limit reached: provider-reported cost for this run reached $${limits.perRunUsd}. No further AI calls were made.`);
      if (limits.platformMonthUsd !== null && prior.platformMonthUsd !== null && costReported && prior.platformMonthUsd + runUsd >= limits.platformMonthUsd) stop("platform_month_usd", "Spending limit reached: provider-reported platform cost for this month reached its limit. No further AI calls were made.");
      reserved += projected; calls += 1; if (kind === "repair") repairs += 1;
      return projected;
    },
    /** Stops the run for a non-spending reason (for example the owner cancelled it). */
    halt(limit: string, message: string): never { return stop(limit, message); },
    /** Actual provider-reported usage replaces the reservation. */
    settle(handle: number, actualTokens: number, costUsd: number | null) {
      reserved -= handle;
      runTokens += Number.isFinite(actualTokens) && actualTokens >= 0 ? actualTokens : handle;
      if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) { runUsd += costUsd; costReported = true; }
    },
    /** A failed call's usage is unknown; the full reservation is counted as spent. */
    settleFailed(handle: number) { reserved -= handle; runTokens += handle; },
    state(): BudgetState {
      return { limits, runTokens, runUsd: costReported ? runUsd : null, reserved, costReported, calls, repairs, elapsedMs: Math.max(0, clock.now() - clock.startedAt), userDayTokens: priorDay + runTokens, userMonthTokens: prior.userMonthTokens + runTokens, platformMonthTokens: prior.platformMonthTokens + runTokens, stoppedBy, stopReason };
    },
  };
}
export type BudgetMeter = ReturnType<typeof createBudgetMeter>;

/** Reads a provider-reported USD cost if one is present; never derives one from token counts. */
export function reportedCostUsd(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  for (const key of ["cost_usd", "total_cost_usd", "cost"]) {
    const v = u[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

export type CostStatus = "ACTUAL_PROVIDER_COST" | "ESTIMATED_PROVIDER_COST" | "UNKNOWN_COST";
/**
 * Cost label for a set of calls. Only provider-reported amounts count as actual. No rates are configured, so
 * ESTIMATED_PROVIDER_COST is never produced today; a partly reported set stays UNKNOWN_COST (its reported part is kept).
 */
export function costStatus(costs: (number | null)[]): { status: CostStatus; amountUsd: number | null; reportedPartUsd: number | null; note: string } {
  const reported = costs.filter((c): c is number => c !== null && Number.isFinite(c) && c >= 0);
  const part = reported.length ? reported.reduce((a, c) => a + c, 0) : null;
  if (costs.length && reported.length === costs.length) return { status: "ACTUAL_PROVIDER_COST", amountUsd: part, reportedPartUsd: part, note: "Cost reported by the provider." };
  return { status: "UNKNOWN_COST", amountUsd: null, reportedPartUsd: part, note: costs.length === 0 ? "No AI calls were made." : "The provider did not report a price for every call, and no rate has been configured, so no cost is estimated." };
}
