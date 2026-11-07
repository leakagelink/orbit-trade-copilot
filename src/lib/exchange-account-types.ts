import { z } from "zod";

export const accountTypeSchema = z.enum(["spot", "futures", "both"]);
export type AccountType = z.infer<typeof accountTypeSchema>;
export const supportsBothAccounts = (exchange: string) => ["binance", "bybit", "okx"].includes(exchange);
export function validateAccountSelection(exchange: string, selection: AccountType) {
  if (selection === "both" && !supportsBothAccounts(exchange)) throw new Error("Both account types are available only for Binance, Bybit and OKX");
  return selection;
}
export const accountTypeLabel = (selection: string) => selection === "both" ? "Spot + Futures" : selection;