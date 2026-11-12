// Binance USD-M Futures TESTNET adapter. Fixed to testnet.binancefuture.com; refuses production accounts and
// any credentials not decrypted for a Testnet connection.
import { createFuturesAdapter } from "./binance-futures-core.server";
export const BINANCE_FUTURES_TESTNET_URL = "https://testnet.binancefuture.com" as const;
export const testnetFuturesAdapter = createFuturesAdapter("testnet", BINANCE_FUTURES_TESTNET_URL);
