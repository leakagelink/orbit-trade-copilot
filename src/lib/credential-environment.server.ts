// Opens stored exchange credentials only for the environment of the connection they belong to.
import { credentialPayloadProblem, withEnv } from "./binance-futures-env";
import type { Creds } from "./exchange-adapters.server";

/** Decrypts and refuses a payload whose recorded environment differs from the connection's immutable flag. */
export async function openCredentials(sealed: { ciphertext: string; iv: string }, isTestnet: boolean): Promise<Creds> {
  const { decryptJson } = await import("./crypto.server");
  const payload = await decryptJson<Creds & { environment?: unknown }>(sealed.ciphertext, sealed.iv);
  const problem = credentialPayloadProblem(payload, isTestnet);
  if (problem) throw new Error(withEnv(isTestnet, problem));
  return { apiKey: payload.apiKey, apiSecret: payload.apiSecret, ...(payload.passphrase ? { passphrase: payload.passphrase } : {}) };
}
