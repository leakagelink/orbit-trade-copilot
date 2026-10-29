// Tradable market catalogue (browser-safe). Crypto trades on crypto exchanges; forex & commodities on OANDA.
export type MarketCategory = "crypto" | "forex" | "commodities";
export interface Market { symbol: string; name: string; category: MarketCategory }

export const MARKETS: Market[] = [
  { symbol: "BTC/USDT", name: "Bitcoin", category: "crypto" },
  { symbol: "ETH/USDT", name: "Ethereum", category: "crypto" },
  { symbol: "SOL/USDT", name: "Solana", category: "crypto" },
  { symbol: "BNB/USDT", name: "BNB", category: "crypto" },
  { symbol: "XRP/USDT", name: "XRP", category: "crypto" },
  { symbol: "DOGE/USDT", name: "Dogecoin", category: "crypto" },
  { symbol: "ADA/USDT", name: "Cardano", category: "crypto" },
  { symbol: "EUR/USD", name: "Euro / US Dollar", category: "forex" },
  { symbol: "GBP/USD", name: "British Pound / US Dollar", category: "forex" },
  { symbol: "USD/JPY", name: "US Dollar / Japanese Yen", category: "forex" },
  { symbol: "AUD/USD", name: "Australian Dollar / US Dollar", category: "forex" },
  { symbol: "USD/CAD", name: "US Dollar / Canadian Dollar", category: "forex" },
  { symbol: "USD/CHF", name: "US Dollar / Swiss Franc", category: "forex" },
  { symbol: "EUR/GBP", name: "Euro / British Pound", category: "forex" },
  { symbol: "XAU/USD", name: "Gold", category: "commodities" },
  { symbol: "XAG/USD", name: "Silver", category: "commodities" },
  { symbol: "WTICO/USD", name: "Crude Oil (WTI)", category: "commodities" },
  { symbol: "BCO/USD", name: "Brent Crude Oil", category: "commodities" },
  { symbol: "NATGAS/USD", name: "Natural Gas", category: "commodities" },
  { symbol: "XCU/USD", name: "Copper", category: "commodities" },
];

export const CATEGORY_LABEL: Record<MarketCategory, string> = { crypto: "Crypto", forex: "Forex", commodities: "Commodities" };
export const marketOf = (symbol: string) => MARKETS.find((m) => m.symbol === symbol);
/** Forex & commodities need an OANDA account; crypto can be paper-traded without one. */
export const needsBroker = (c: MarketCategory) => c !== "crypto";
