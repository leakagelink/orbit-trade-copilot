// AI research spending limits. Pure and browser-safe.
// Token limits are always enforced before every AI call. USD limits apply only to costs the provider actually reports:
// AI Prime Tech currently returns token counts but no price, and public list prices are never assumed.
import { z } from "zod";

export const researchBudget = z.object({
  perRunTokens: z.number().int().min(10_000).max(2_000_000),
  perUserMonthTokens: z.number().int().min(10_000).max(500_000_000),
  platformMonthTokens: z.number().int().min(10_000).max(5_000_000_000),
  perRunUsd: z.number().positive().max(10_000).nullable(),
  platformMonthUsd: z.number().positive().max(1_000_000).nullable(),
});
export type ResearchBudget = z.infer<typeof researchBudget>;

/** Used until an admin saves limits (and while the configuration table is not enabled). */
export const DEFAULT_RESEARCH_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  perRunTokens: 250_000,
  perUserMonthTokens: 3_000_000,
  platformMonthTokens: 20_000_000,
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

export class ResearchBudgetStop extends Error {
  constructor(readonly limit: string, message: string) { super(message); this.name = "ResearchBudgetStop"; }
}

export interface PriorUsage { userMonthTokens: number; platformMonthTokens: number; platformMonthUsd: number | null }
export interface BudgetState {
  limits: ResearchBudget; runTokens: number; runUsd: number | null; reserved: number; costReported: boolean;
  userMonthTokens: number; platformMonthTokens: number; stoppedBy: string | null; stopReason: string | null;
}

/** One meter per run. Reservations are synchronous, so parallel calls in one stage cannot jointly exceed a limit. */
export function createBudgetMeter(limits: ResearchBudget, prior: PriorUsage) {
  researchBudget.parse(limits);
  if (![prior.userMonthTokens, prior.platformMonthTokens].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Research usage evidence unavailable");
  let runTokens = 0, reserved = 0, runUsd = 0, costReported = false;
  let stoppedBy: string | null = null, stopReason: string | null = null;
  const stop = (limit: string, message: string): never => {
    if (!stoppedBy) { stoppedBy = limit; stopReason = message; }
    throw new ResearchBudgetStop(limit, message);
  };
  return {
    reserve(projected: number) {
      if (!Number.isFinite(projected) || projected <= 0) throw new Error("Invalid research call estimate");
      const after = runTokens + reserved + projected;
      if (after > limits.perRunTokens) stop("per_run_tokens", `Spending limit reached: this call could exceed the per-run limit of ${limits.perRunTokens.toLocaleString("en-US")} tokens. No further AI calls were made for this run.`);
      if (prior.userMonthTokens + after > limits.perUserMonthTokens) stop("user_month_tokens", `Spending limit reached: your monthly research limit of ${limits.perUserMonthTokens.toLocaleString("en-US")} tokens would be exceeded. No further AI calls were made.`);
      if (prior.platformMonthTokens + after > limits.platformMonthTokens) stop("platform_month_tokens", "Spending limit reached: the platform's monthly AI research limit would be exceeded. No further AI calls were made.");
      if (limits.perRunUsd !== null && costReported && runUsd >= limits.perRunUsd) stop("per_run_usd", `Spending limit reached: provider-reported cost for this run reached $${limits.perRunUsd}. No further AI calls were made.`);
      if (limits.platformMonthUsd !== null && prior.platformMonthUsd !== null && costReported && prior.platformMonthUsd + runUsd >= limits.platformMonthUsd) stop("platform_month_usd", "Spending limit reached: provider-reported platform cost for this month reached its limit. No further AI calls were made.");
      reserved += projected;
      return projected;
    },
    /** Actual provider-reported usage replaces the reservation. */
    settle(handle: number, actualTokens: number, costUsd: number | null) {
      reserved -= handle;
      runTokens += Number.isFinite(actualTokens) && actualTokens >= 0 ? actualTokens : handle;
      if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) { runUsd += costUsd; costReported = true; }
    },
    /** A failed call's usage is unknown; the full reservation is counted as spent. */
    settleFailed(handle: number) { reserved -= handle; runTokens += handle; },
    state(): BudgetState {
      return { limits, runTokens, runUsd: costReported ? runUsd : null, reserved, costReported, userMonthTokens: prior.userMonthTokens + runTokens, platformMonthTokens: prior.platformMonthTokens + runTokens, stoppedBy, stopReason };
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
