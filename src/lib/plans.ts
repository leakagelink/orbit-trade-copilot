// Plan rules (browser-safe). Server code enforces the same split with public.has_pro_access().
export type PlanId = "free" | "pro";

/** Pages the Free plan can open. Everything else needs a paid plan. */
export const FREE_PATHS = ["/trade", "/wallet", "/exchanges", "/risk", "/settings", "/plans"] as const;

export function canOpen(path: string, pro: boolean): boolean {
  if (pro) return true;
  return FREE_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export const PLAN_FEATURES: Record<PlanId, { name: string; features: string[] }> = {
  free: {
    name: "Free",
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
    features: [
      "Everything in Free",
      "AI assistant & AI trade ideas",
      "AI one-click trades on the Trade page",
      "Strategy builder",
      "Algo trading bots (paper & live)",
      "Backtesting & analytics",
    ],
  },
};

export const UPGRADE_MESSAGE = "This needs a Pro plan. Upgrade on the Plans page.";
