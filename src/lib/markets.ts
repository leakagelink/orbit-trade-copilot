// Tradable market catalogue (browser-safe).
// Crypto prices come from crypto exchanges; forex & commodities prices come from Yahoo Finance
// (demo wallet) or OANDA (real broker account, only where `oanda` is true).
export type MarketCategory = "crypto" | "forex" | "commodities";
export interface Market { symbol: string; name: string; category: MarketCategory; yahoo?: string; oanda?: boolean; group?: string }

const crypto: Market[] = [
  ["BTC/USDT", "Bitcoin"], ["ETH/USDT", "Ethereum"], ["SOL/USDT", "Solana"], ["BNB/USDT", "BNB"],
  ["XRP/USDT", "XRP"], ["DOGE/USDT", "Dogecoin"], ["ADA/USDT", "Cardano"],
].map(([symbol, name]) => ({ symbol: symbol!, name: name!, category: "crypto" as const }));

const CCY: Record<string, string> = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", JPY: "Japanese Yen", AUD: "Australian Dollar", CAD: "Canadian Dollar",
  CHF: "Swiss Franc", NZD: "New Zealand Dollar", INR: "Indian Rupee", CNY: "Chinese Yuan", HKD: "Hong Kong Dollar",
  SGD: "Singapore Dollar", ZAR: "South African Rand", MXN: "Mexican Peso", TRY: "Turkish Lira", SEK: "Swedish Krona",
  NOK: "Norwegian Krone", DKK: "Danish Krone", PLN: "Polish Zloty", THB: "Thai Baht", KRW: "South Korean Won", BRL: "Brazilian Real",
};
const MAJORS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];
const CROSSES = ["EURGBP", "EURJPY", "GBPJPY", "EURCHF", "EURAUD", "EURCAD", "EURNZD", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD", "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD", "CADJPY", "CHFJPY", "NZDJPY", "NZDCAD", "NZDCHF", "CADCHF"];
const EXOTICS = ["USDINR", "USDCNY", "USDHKD", "USDSGD", "USDZAR", "USDMXN", "USDTRY", "USDSEK", "USDNOK", "USDDKK", "USDPLN", "USDTHB", "USDKRW", "USDBRL", "EURINR", "GBPINR", "EURTRY", "EURSEK", "EURNOK", "EURPLN"];
const NO_OANDA = new Set(["USDINR", "USDCNY", "USDKRW", "USDBRL", "EURINR", "GBPINR"]);
const fx = (list: string[], group: string): Market[] =>
  list.map((p) => {
    const b = p.slice(0, 3), q = p.slice(3);
    return { symbol: `${b}/${q}`, name: `${CCY[b]} / ${CCY[q]}`, category: "forex", yahoo: `${p}=X`, oanda: !NO_OANDA.has(p), group };
  });

// [symbol, name, yahoo ticker, tradable on OANDA, group]
const COMMODITIES: [string, string, string, boolean, string][] = [
  ["XAU/USD", "Gold", "GC=F", true, "Metals"],
  ["XAG/USD", "Silver", "SI=F", true, "Metals"],
  ["XPT/USD", "Platinum", "PL=F", true, "Metals"],
  ["XPD/USD", "Palladium", "PA=F", true, "Metals"],
  ["XCU/USD", "Copper", "HG=F", true, "Metals"],
  ["ALU/USD", "Aluminium", "ALI=F", false, "Metals"],
  ["WTICO/USD", "Crude Oil (WTI)", "CL=F", true, "Energy"],
  ["BCO/USD", "Brent Crude Oil", "BZ=F", true, "Energy"],
  ["NATGAS/USD", "Natural Gas", "NG=F", true, "Energy"],
  ["HEATOIL/USD", "Heating Oil", "HO=F", false, "Energy"],
  ["GASOLINE/USD", "RBOB Gasoline", "RB=F", false, "Energy"],
  ["CORN/USD", "Corn", "ZC=F", true, "Agriculture"],
  ["WHEAT/USD", "Wheat (Chicago)", "ZW=F", true, "Agriculture"],
  ["KWHEAT/USD", "Wheat (Kansas HRW)", "KE=F", false, "Agriculture"],
  ["SOYBN/USD", "Soybeans", "ZS=F", true, "Agriculture"],
  ["SOYMEAL/USD", "Soybean Meal", "ZM=F", false, "Agriculture"],
  ["SOYOIL/USD", "Soybean Oil", "ZL=F", false, "Agriculture"],
  ["OATS/USD", "Oats", "ZO=F", false, "Agriculture"],
  ["RICE/USD", "Rough Rice", "ZR=F", false, "Agriculture"],
  ["SUGAR/USD", "Sugar #11", "SB=F", true, "Softs"],
  ["COFFEE/USD", "Coffee", "KC=F", false, "Softs"],
  ["COCOA/USD", "Cocoa", "CC=F", false, "Softs"],
  ["COTTON/USD", "Cotton", "CT=F", false, "Softs"],
  ["OJ/USD", "Orange Juice", "OJ=F", false, "Softs"],
  ["CATTLE/USD", "Live Cattle", "LE=F", false, "Livestock"],
  ["FCATTLE/USD", "Feeder Cattle", "GF=F", false, "Livestock"],
  ["HOGS/USD", "Lean Hogs", "HE=F", false, "Livestock"],
  ["MILK/USD", "Class III Milk", "DC=F", false, "Livestock"],
];

export const MARKETS: Market[] = [
  ...crypto,
  ...fx(MAJORS, "Majors"), ...fx(CROSSES, "Crosses"), ...fx(EXOTICS, "Exotics"),
  ...COMMODITIES.map(([symbol, name, yahoo, oanda, group]) => ({ symbol, name, category: "commodities" as const, yahoo, oanda, group })),
];

export const CATEGORY_LABEL: Record<MarketCategory, string> = { crypto: "Crypto", forex: "Forex", commodities: "Commodities" };
export const marketOf = (symbol: string) => MARKETS.find((m) => m.symbol === symbol);
export const yahooTicker = (symbol: string) => marketOf(symbol)?.yahoo;

const USDLIKE = new Set(["USD", "USDT", "USDC"]);
/** How a quote-currency amount converts to USD. Returns a number, or a Yahoo FX ticker to look up (cross pairs). */
export function quoteUsdSource(symbol: string, price: number): number | string {
  const [b, q] = symbol.split("/") as [string, string];
  if (USDLIKE.has(q)) return 1;
  if (b === "USD") return 1 / price;
  return `${q}USD=X`;
}
