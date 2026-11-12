// Binance USD-M Futures PRODUCTION (live) adapter. Fixed to fapi.binance.com; refuses Testnet accounts,
// Testnet-bound credentials and fault injection.
import { createFuturesAdapter } from "./binance-futures-core.server";
export const BINANCE_FUTURES_LIVE_URL = "https://fapi.binance.com" as const;
export const liveFuturesAdapter = createFuturesAdapter("production", BINANCE_FUTURES_LIVE_URL);
