// Browser-safe paid-plan prices (USD). Server checkout reads the same table so the browser can't change a price.
import type { BillingInterval, PlanId } from "./plans";

export type PaidPlanId = Exclude<PlanId, "free">;

export const PLAN_PRICES_USD: Record<PaidPlanId, Record<BillingInterval, number>> = {
  pro: { monthly: 249, yearly: 1999 },
  elite: { monthly: 449, yearly: 3899 },
};

export function planPrice(plan: PaidPlanId, interval: BillingInterval): number {
  return PLAN_PRICES_USD[plan][interval];
}

/** Percentage saved by paying yearly instead of 12 monthly payments, rounded down. */
export function yearlySavingsPercent(plan: PaidPlanId): number {
  const { monthly, yearly } = PLAN_PRICES_USD[plan];
  return Math.floor((1 - yearly / (monthly * 12)) * 100);
}

/**
 * A paying user may not buy a lower tier while a higher tier is still running
 * (it would replace the remaining higher-tier time).
 */
export function checkoutBlockedReason(current: { plan: string | null; status: string | null; periodEnd: string | null } | null, target: PaidPlanId, now = Date.now()): string | null {
  if (!current || !current.plan) return null;
  const active = (current.status === "active" || current.status === "trialing") && (current.periodEnd === null || new Date(current.periodEnd).getTime() > now);
  if (!active) return null;
  const elite = current.plan === "elite" || current.plan === "premium";
  if (target === "pro" && elite) return "You already have an active Elite plan, which includes everything in Pro.";
  if (current.periodEnd === null && (current.plan === target || elite)) return "Your plan has no end date, so no payment is needed.";
  return null;
}

/** Payment statuses NOWPayments reports once the crypto is confirmed on-chain. */
export const PAID_STATUSES = ["confirmed", "sending", "finished"] as const;

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  created: "Awaiting payment",
  waiting: "Awaiting payment",
  confirming: "Confirming on blockchain",
  confirmed: "Paid",
  sending: "Paid",
  finished: "Paid",
  partially_paid: "Partly paid — contact support",
  failed: "Failed",
  refunded: "Refunded",
  expired: "Expired",
};
