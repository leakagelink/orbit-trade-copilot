import { z } from "zod";

export const derivAppId = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, "Enter a valid Deriv PAT App ID");

// Reject unrecognised responses rather than presenting a fabricated balance.
export const derivAccounts = z.object({
  data: z.array(z.object({
    account_id: z.string().min(1),
    balance: z.coerce.number().finite().nonnegative(),
    currency: z.string().min(1),
    account_type: z.enum(["demo", "real"]),
  })),
});

export function parseDerivBalances(input: unknown, demo: boolean) {
  const accounts = derivAccounts.parse(input).data.filter((a) => a.account_type === (demo ? "demo" : "real"));
  if (!accounts.length) throw new Error(`No Deriv ${demo ? "demo" : "real"} Options account found`);
  return accounts.map((a) => ({ asset: a.currency, free: a.balance, locked: 0 }));
}