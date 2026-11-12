// Testnet-only authenticated verification, run BEFORE Testnet credentials are stored or replaced.
// Calls only Binance Testnet hosts; a failure stores nothing and leaves existing credentials unchanged.
import { bindCredentials, keyHintConflict, withEnv } from "./binance-futures-env";
import type { Creds } from "./exchange-adapters.server";

export type AccountSelection = "spot" | "futures" | "both" | "options";
export async function verifyBinanceTestnetCredentials(accountType: AccountSelection, creds: Creds) {
  const checks: string[] = [];
  try {
    if (accountType === "futures" || accountType === "both") {
      const { futuresAccountState } = await import("./binance-futures.server");
      // Bound to Testnet: the Testnet adapter is the only one that will accept these credentials.
      await futuresAccountState({ connectionId: "testnet-verification", testnet: true, creds: bindCredentials(creds, "testnet") });
      checks.push("usd_m_futures_testnet");
    }
    if (accountType === "spot" || accountType === "both") {
      const { fetchBalances } = await import("./exchange-adapters.server");
      await fetchBalances("binance", creds, true); // testnet.binance.vision only
      checks.push("spot_testnet");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(withEnv(true, `Testnet key verification failed; nothing was saved. ${msg.replace(/^\[(TESTNET|PRODUCTION)\] /, "")}`.slice(0, 400)));
  }
  if (!checks.length) throw new Error(withEnv(true, "Select Spot, Futures or Both for a Binance Testnet key"));
  return checks;
}

type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
/** Metadata-only check (no decryption, no network): a key whose hint matches the other environment is refused. */
export async function assertKeyNotFromOtherEnvironment(db: Db, userId: string, exchange: string, isTestnet: boolean, apiKey: string, exceptId?: string) {
  if (exchange !== "binance") return;
  const r = await db.from("exchange_connections").select("id,api_key_hint").eq("user_id", userId).eq("exchange", "binance").eq("is_testnet", !isTestnet).neq("status", "disconnected");
  if (r.error) throw new Error(withEnv(isTestnet, "Connection check unavailable; nothing was saved"));
  const hints = (r.data ?? []).filter((c) => c.id !== exceptId).map((c) => c.api_key_hint);
  if (keyHintConflict(apiKey, hints)) throw new Error(withEnv(isTestnet, `This key matches a connected ${isTestnet ? "production" : "Testnet"} key. ${isTestnet ? "Testnet" : "Production"} connections accept only ${isTestnet ? "Testnet" : "production"} keys; nothing was saved.`));
}
