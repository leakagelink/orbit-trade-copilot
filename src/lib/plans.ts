// Plan rules (browser-safe). Server code enforces the same split with public.has_pro_access().
export type PlanId = "free" | "pro" | "elite";
export type BillingInterval = "monthly" | "yearly";
export const PLAN_IDS: PlanId[] = ["free", "pro", "elite"];

/** Pages the Free plan can open. Everything else needs a paid plan. */
export const FREE_PATHS = ["/trade", "/wallet", "/exchanges", "/risk", "/settings", "/plans"] as const;

export function requiredPlan(path: string): PlanId {
  if (["/scalping", "/arbitrage"].some(p => path === p || path.startsWith(p + "/"))) return "elite";
  return FREE_PATHS.some(p => path === p || path.startsWith(p + "/")) ? "free" : "pro";
}

export function canOpen(path: string, plan: PlanId | boolean): boolean {
  const tier = typeof plan === "boolean" ? (plan ? "pro" : "free") : plan;
  if (tier === "elite") return true;
  if (requiredPlan(path) === "elite") return false;
  if (tier === "pro") return true;
  return FREE_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export const PLAN_FEATURES: Record<PlanId, { name: string; summary: string; features: string[] }> = {
  free: {
    name: "Free",
    summary: "Manual trading essentials",
    features: [
      "Manual buy & sell: crypto, forex, commodities",
      "Demo wallet: deposit & withdraw",
      "TradingView charts",
      "Stop loss / take profit",
      "Connect your own broker for real trades",
    ],
  },
  pro: {
    name: "Pro",
    summary: "AI-assisted & automated trading",
    features: [
      "Everything in Free",
      "AI assistant & AI trade ideas",
      "AI one-click trades on the Trade page",
      "Strategy builder",
      "Algo trading bots (paper & live)",
      "Backtesting & analytics",
      "Performance dashboard",
    ],
  },
  elite: {
    name: "Elite",
    summary: "Advanced execution & multi-exchange trading",
    features: [
      "Everything in Pro",
      "Scalping desk: one-click buy & sell",
      "Automatic scalp stop, target & time limit",
      "Ready-made scalping strategy templates",
      "Multi-exchange arbitrage scanner",
      "AI arbitrage review",
      "Paper & prefunded live arbitrage",
      "Exchange-order reconciliation & run history",
    ],
  },
};

export const UPGRADE_MESSAGE = "This needs a Pro plan. Upgrade on the Plans page.";
export const ELITE_UPGRADE_MESSAGE = "This needs an Elite plan. Upgrade on the Plans page.";
