import { z } from "zod";

export const DERIV_DISCONNECT_FIRST = "Disconnect your existing Deriv connection before connecting another account.";
export function derivConnectionReserved(rows: { exchange: string; status: string }[]) {
  return rows.some((r) => r.exchange === "deriv" && r.status !== "disconnected");
}

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
// ---- Deriv Multipliers (pure helpers shared by the trading adapter and tests) ----
export const DERIV_API = "https://api.derivws.com";
export const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
export const DERIV_GRANULARITY = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;
export type DerivTimeframe = keyof typeof DERIV_GRANULARITY;

const candleRow = z.object({ epoch: z.coerce.number(), open: z.coerce.number(), high: z.coerce.number(), low: z.coerce.number(), close: z.coerce.number() });
/** ticks_history (style candles) → Candle[]; rejects malformed rows instead of inventing prices. */
export function parseDerivCandles(input: unknown) {
  const rows = z.object({ candles: z.array(candleRow) }).parse(input).candles;
  return rows.map((r) => ({ t: r.epoch * 1000, o: r.open, h: r.high, l: r.low, c: r.close, v: 0 }));
}

const num = z.union([z.number(), z.string()]).nullish().transform((v) => (v == null || v === "" ? null : Number(v)));
export const derivOpenContract = z.object({
  contract_id: z.coerce.number(),
  buy_price: num, bid_price: num, sell_price: num, profit: num, commission: num,
  current_spot: num, exit_spot: num, entry_spot: num,
  is_sold: z.coerce.number().optional(), status: z.string().nullish(),
});
export type DerivOpenContract = z.infer<typeof derivOpenContract>;

export function derivContractClosed(c: DerivOpenContract) {
  return c.is_sold === 1 || (c.status != null && c.status !== "open");
}

/** Gross PnL + commission split (trades.realized_pnl is gross; fees stored separately). Profit from Deriv is net of commission. */
export function derivCloseRecord(c: DerivOpenContract, fallbackExit: number) {
  const buy = c.buy_price ?? 0;
  const net = c.profit ?? ((c.sell_price ?? c.bid_price ?? buy) - buy);
  const fees = Math.max(0, c.commission ?? 0);
  return { exit: c.exit_spot ?? c.current_spot ?? fallbackExit, gross: net + fees, fees, net };
}
