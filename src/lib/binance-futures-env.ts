// Pure Binance USD-M environment rules shared by the separate Testnet and Live adapters.
// Every exchange request is checked against these rules before anything is signed or sent.
export type FuturesEnvironment = "testnet" | "production";

/** Immutable, environment-specific base URLs. Nothing else may be used as a Binance Futures origin. */
export const BINANCE_FUTURES_BASE_URLS: Readonly<Record<FuturesEnvironment, string>> = Object.freeze({
  testnet: "https://testnet.binancefuture.com",
  production: "https://fapi.binance.com",
});

export const futuresEnvironment = (testnet: boolean): FuturesEnvironment => (testnet ? "testnet" : "production");
export const envLabel = (env: FuturesEnvironment | boolean) =>
  (typeof env === "boolean" ? env : env === "testnet") ? "TESTNET" : "PRODUCTION";
/** Prefixes a log/error message with its environment exactly once. */
export function withEnv(env: FuturesEnvironment | boolean, message: string) {
  const tag = `[${envLabel(env)}]`;
  return message.startsWith("[TESTNET]") || message.startsWith("[PRODUCTION]") ? message : `${tag} ${message}`;
}

/**
 * Decrypted credentials are tagged with the environment of the connection they were decrypted for.
 * The tag lives outside the object (WeakMap), so it cannot be serialized, copied or overwritten by spreading.
 */
const boundEnvironment = new WeakMap<object, FuturesEnvironment>();
export interface ApiCredentials { apiKey: string; apiSecret: string; passphrase?: string }
export function bindCredentials(creds: ApiCredentials, env: FuturesEnvironment): Readonly<ApiCredentials> {
  const copy = Object.freeze({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, ...(creds.passphrase ? { passphrase: creds.passphrase } : {}) });
  boundEnvironment.set(copy, env);
  return copy;
}
export const credentialEnvironment = (creds: object | null | undefined) => (creds ? boundEnvironment.get(creds) ?? null : null);

/** Credentials saved after this change carry their environment inside the encrypted payload; legacy payloads have none. */
export function credentialPayloadProblem(payload: { environment?: unknown }, isTestnet: boolean): string | null {
  if (payload.environment === undefined || payload.environment === null) return null;
  if (payload.environment !== "testnet" && payload.environment !== "production") return "Stored credentials have an unknown environment; reconnect this account";
  return payload.environment === futuresEnvironment(isTestnet) ? null : "Stored credentials belong to a different environment than this account; they were not used";
}

/** Exact USD-M endpoints the app uses, with their allowed methods. Anything else (Spot, wallet, withdrawal,
 *  protocol-relative or traversal paths) is refused before signing. No endpoint here can move funds. */
export const FUTURES_ENDPOINTS: Readonly<Record<string, readonly ("GET" | "POST" | "DELETE")[]>> = Object.freeze({
  "/fapi/v1/accountConfig": ["GET"], "/fapi/v1/allOrders": ["GET"], "/fapi/v1/exchangeInfo": ["GET"], "/fapi/v1/income": ["GET"],
  "/fapi/v1/klines": ["GET"], "/fapi/v1/openAlgoOrders": ["GET"], "/fapi/v1/openOrders": ["GET"], "/fapi/v1/premiumIndex": ["GET"],
  "/fapi/v1/symbolConfig": ["GET"], "/fapi/v1/userTrades": ["GET"], "/fapi/v2/positionRisk": ["GET"], "/fapi/v3/account": ["GET"],
  "/fapi/v3/positionRisk": ["GET"], "/fapi/v1/multiAssetsMargin": ["GET", "POST"], "/fapi/v1/positionSide/dual": ["GET", "POST"],
  "/fapi/v1/leverage": ["POST"], "/fapi/v1/marginType": ["POST"],
  "/fapi/v1/order": ["GET", "POST", "DELETE"], "/fapi/v1/algoOrder": ["GET", "POST", "DELETE"],
});
export interface FuturesRequestCheck {
  adapterEnvironment: FuturesEnvironment;
  adapterBaseUrl: string;
  accountTestnet: unknown;
  credentials: object | null | undefined;
  signed: boolean;
  method: string;
  path: string;
  hasFaults: boolean;
}
/** Returns why a request must not be sent, or null. Pure so it can be tested exhaustively. */
export function futuresRequestProblem(c: FuturesRequestCheck): string | null {
  const expected = BINANCE_FUTURES_BASE_URLS[c.adapterEnvironment];
  if (!expected || c.adapterBaseUrl !== expected) return "adapter base URL does not match its environment";
  if (typeof c.accountTestnet !== "boolean") return "account environment unknown";
  if (futuresEnvironment(c.accountTestnet) !== c.adapterEnvironment) return `${envLabel(c.accountTestnet)} account cannot use the ${envLabel(c.adapterEnvironment)} adapter`;
  if (!["GET", "POST", "DELETE"].includes(c.method)) return "HTTP method not allowed";
  const allowed = Object.prototype.hasOwnProperty.call(FUTURES_ENDPOINTS, c.path) ? FUTURES_ENDPOINTS[c.path] : undefined;
  if (!allowed) return "endpoint path not allowed";
  if (!allowed.includes(c.method as "GET")) return "HTTP method not allowed for this endpoint";
  if (c.hasFaults && c.adapterEnvironment !== "testnet") return "fault injection is Testnet-only";
  if (c.signed) {
    const credEnv = credentialEnvironment(c.credentials);
    if (!credEnv) return "credentials are not bound to an environment";
    if (credEnv !== c.adapterEnvironment) return `${envLabel(credEnv)} credentials cannot reach ${envLabel(c.adapterEnvironment)} endpoints`;
  }
  return null;
}
/** Final URL check after construction: same origin and the exact path that was validated. */
export function futuresUrlProblem(url: URL, adapterBaseUrl: string, path: string): string | null {
  if (url.origin !== new URL(adapterBaseUrl).origin) return "request origin changed";
  if (url.pathname !== path) return "request path changed";
  if (url.username || url.password || url.hash) return "request URL has forbidden parts";
  return null;
}

/** Same last-4 hint as a known key of the other environment: refuse before any network call. */
export function keyHintConflict(apiKey: string, otherEnvironmentHints: (string | null | undefined)[]) {
  const hint = `••••${apiKey.trim().slice(-4)}`;
  return otherEnvironmentHints.some((h) => h === hint);
}
