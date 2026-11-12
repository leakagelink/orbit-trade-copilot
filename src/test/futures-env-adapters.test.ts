// Environment, endpoint and credential isolation of the separate Binance USD-M Testnet and Live adapters.
// Network is stubbed; no request leaves the test process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { futuresCall, futuresHost } from "@/lib/binance-futures.server";
import { testnetFuturesAdapter, BINANCE_FUTURES_TESTNET_URL } from "@/lib/binance-futures-testnet.server";
import { liveFuturesAdapter, BINANCE_FUTURES_LIVE_URL } from "@/lib/binance-futures-live.server";
import { createFuturesAdapter } from "@/lib/binance-futures-core.server";
import { bindCredentials, credentialPayloadProblem, keyHintConflict, futuresRequestProblem, BINANCE_FUTURES_BASE_URLS } from "@/lib/binance-futures-env";

const sealedPayload = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/lib/crypto.server", () => ({ decryptJson: async () => ({ ...sealedPayload.value }) }));

const raw = { apiKey: "key-abcd", apiSecret: "secret" };
const testCreds = bindCredentials(raw, "testnet"), prodCreds = bindCredentials(raw, "production");
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
function stubFetch(impl: (url: string) => Response | Promise<Response> = () => ok()) {
  const urls: string[] = []; const f = vi.fn(async (url: string) => { urls.push(url); return impl(url); });
  vi.stubGlobal("fetch", f); return { f, urls };
}
afterEach(() => vi.unstubAllGlobals());

describe("immutable environment-specific base URLs", () => {
  it("Testnet adapter is fixed to testnet.binancefuture.com", () => {
    expect(testnetFuturesAdapter.baseUrl).toBe("https://testnet.binancefuture.com");
    expect(BINANCE_FUTURES_TESTNET_URL).toBe(BINANCE_FUTURES_BASE_URLS.testnet);
  });
  it("Live adapter is fixed to fapi.binance.com", () => {
    expect(liveFuturesAdapter.baseUrl).toBe("https://fapi.binance.com");
    expect(BINANCE_FUTURES_LIVE_URL).toBe(BINANCE_FUTURES_BASE_URLS.production);
  });
  it("adapters and the URL table cannot be modified at runtime", () => {
    expect(Object.isFrozen(testnetFuturesAdapter)).toBe(true);
    expect(Object.isFrozen(liveFuturesAdapter)).toBe(true);
    expect(Object.isFrozen(BINANCE_FUTURES_BASE_URLS)).toBe(true);
    expect(() => { (testnetFuturesAdapter as { baseUrl: string }).baseUrl = "https://fapi.binance.com"; }).toThrow();
  });
  it("an adapter cannot be created with the other environment's URL", () => {
    expect(() => createFuturesAdapter("testnet", "https://fapi.binance.com")).toThrow(/mismatch/);
    expect(() => createFuturesAdapter("production", "https://testnet.binancefuture.com")).toThrow(/mismatch/);
  });
  it("futuresHost dispatches only to the two fixed hosts", () => {
    expect(futuresHost(true)).toBe("https://testnet.binancefuture.com");
    expect(futuresHost(false)).toBe("https://fapi.binance.com");
  });
});

describe("endpoint enforcement before every request", () => {
  it("Testnet requests go only to the Testnet host", async () => {
    const { urls } = stubFetch();
    await futuresCall({ testnet: true, creds: testCreds }, "GET", "/fapi/v3/account");
    expect(urls).toHaveLength(1); expect(new URL(urls[0]!).origin).toBe("https://testnet.binancefuture.com");
  });
  it("Production requests go only to the production host", async () => {
    const { urls } = stubFetch();
    await futuresCall({ testnet: false, creds: prodCreds }, "GET", "/fapi/v3/account");
    expect(urls).toHaveLength(1); expect(new URL(urls[0]!).origin).toBe("https://fapi.binance.com");
  });
  it("the Testnet adapter refuses a production account without sending", async () => {
    const { f } = stubFetch();
    await expect(testnetFuturesAdapter.call({ testnet: false, creds: prodCreds }, "GET", "/fapi/v3/account")).rejects.toThrow(/\[TESTNET\].*refused before sending/);
    expect(f).not.toHaveBeenCalled();
  });
  it("the Live adapter refuses a Testnet account without sending", async () => {
    const { f } = stubFetch();
    await expect(liveFuturesAdapter.call({ testnet: true, creds: testCreds }, "GET", "/fapi/v3/account")).rejects.toThrow(/\[PRODUCTION\].*refused before sending/);
    expect(f).not.toHaveBeenCalled();
  });
  it("an unknown account environment is refused without sending", async () => {
    const { f } = stubFetch();
    await expect(futuresCall({ testnet: undefined as never, creds: prodCreds }, "GET", "/fapi/v3/account")).rejects.toThrow(/environment unknown/);
    expect(f).not.toHaveBeenCalled();
  });
  it.each(["//evil.example/fapi/v1/order", "/fapi/v1/../../api/v3/order", "/api/v3/account", "/fapi/v1/order?x=1", "https://fapi.binance.com/fapi/v1/order", "/sapi/v1/capital/withdraw/apply"])(
    "refuses non-USD-M path %s without sending", async (path) => {
      const { f } = stubFetch();
      await expect(futuresCall({ testnet: true, creds: testCreds }, "POST", path)).rejects.toThrow(/endpoint path not allowed/);
      expect(f).not.toHaveBeenCalled();
    });
  it("refuses a known endpoint with a method it does not allow", async () => {
    const { f } = stubFetch();
    await expect(futuresCall({ testnet: true, creds: testCreds }, "DELETE", "/fapi/v1/leverage")).rejects.toThrow(/method not allowed/);
    expect(f).not.toHaveBeenCalled();
  });
  it("refuses methods other than GET, POST and DELETE", () => {
    expect(futuresRequestProblem({ adapterEnvironment: "testnet", adapterBaseUrl: BINANCE_FUTURES_BASE_URLS.testnet, accountTestnet: true, credentials: testCreds, signed: true, method: "PUT", path: "/fapi/v1/order", hasFaults: false })).toMatch(/method/);
  });
});

describe("credential isolation", () => {
  it("Testnet credentials never reach the production endpoint", async () => {
    const { f } = stubFetch();
    await expect(futuresCall({ testnet: false, creds: testCreds }, "GET", "/fapi/v3/account")).rejects.toThrow(/TESTNET credentials cannot reach PRODUCTION endpoints/);
    expect(f).not.toHaveBeenCalled();
  });
  it("production credentials never reach the Testnet endpoint", async () => {
    const { f } = stubFetch();
    await expect(futuresCall({ testnet: true, creds: prodCreds }, "GET", "/fapi/v3/account")).rejects.toThrow(/PRODUCTION credentials cannot reach TESTNET endpoints/);
    expect(f).not.toHaveBeenCalled();
  });
  it("unbound or copied credentials are refused for signed calls", async () => {
    const { f } = stubFetch();
    await expect(futuresCall({ testnet: true, creds: { ...raw } }, "GET", "/fapi/v3/account")).rejects.toThrow(/not bound/);
    await expect(futuresCall({ testnet: true, creds: { ...testCreds } }, "GET", "/fapi/v3/account")).rejects.toThrow(/not bound/);
    expect(f).not.toHaveBeenCalled();
  });
  it("public market data needs no credentials and sends no API key header", async () => {
    const seen: (HeadersInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => { seen.push(init?.headers); return ok({ markPrice: "1" }); }));
    await futuresCall({ testnet: true, creds: undefined as never }, "GET", "/fapi/v1/premiumIndex", { symbol: "DOGEUSDT" }, false);
    expect(seen[0]).toEqual({});
  });
  it("bound credentials are frozen", () => expect(Object.isFrozen(testCreds)).toBe(true));
  it("a stored payload tagged for the other environment is refused", () => {
    expect(credentialPayloadProblem({ environment: "production" }, true)).toMatch(/different environment/);
    expect(credentialPayloadProblem({ environment: "testnet" }, false)).toMatch(/different environment/);
    expect(credentialPayloadProblem({ environment: "staging" }, true)).toMatch(/unknown environment/);
  });
  it("legacy payloads without a tag follow the connection's immutable flag", () => {
    expect(credentialPayloadProblem({}, true)).toBeNull();
    expect(credentialPayloadProblem({ environment: "testnet" }, true)).toBeNull();
  });
  it("openCredentials refuses a mismatched payload and strips the tag from a matching one", async () => {
    const { openCredentials } = await import("@/lib/credential-environment.server");
    sealedPayload.value = { apiKey: "k", apiSecret: "s", environment: "testnet" };
    await expect(openCredentials({ ciphertext: "c", iv: "i" }, false)).rejects.toThrow(/\[PRODUCTION\].*different environment/);
    expect(await openCredentials({ ciphertext: "c", iv: "i" }, true)).toEqual({ apiKey: "k", apiSecret: "s" });
  });
  it("a key whose hint matches the other environment is detected", () => {
    expect(keyHintConflict("XXXXabcd", ["••••abcd"])).toBe(true);
    expect(keyHintConflict("XXXXabce", ["••••abcd", null])).toBe(false);
  });
});

describe("Testnet-only authenticated verification before saving keys", () => {
  it("Futures Testnet keys are verified on the Testnet Futures host only", async () => {
    const { urls } = stubFetch((u) => ok(u.includes("accountConfig") ? { canTrade: true } : u.includes("dual") ? { dualSidePosition: false } : u.includes("multiAssets") ? { multiAssetsMargin: false } : { availableBalance: "5000" }));
    const { verifyBinanceTestnetCredentials } = await import("@/lib/testnet-credentials.server");
    expect(await verifyBinanceTestnetCredentials("futures", raw)).toEqual(["usd_m_futures_testnet"]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => new URL(u).origin === "https://testnet.binancefuture.com")).toBe(true);
  });
  it("a key rejected by Testnet fails verification and nothing is saved", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }), { status: 401 }));
    const { verifyBinanceTestnetCredentials } = await import("@/lib/testnet-credentials.server");
    await expect(verifyBinanceTestnetCredentials("futures", raw)).rejects.toThrow(/\[TESTNET\] Testnet key verification failed; nothing was saved/);
  });
  it("Spot+Futures Testnet verification never contacts a production host", async () => {
    const { urls } = stubFetch((u) => ok(u.includes("/api/v3/account") ? { balances: [] } : u.includes("accountConfig") ? { canTrade: true } : { availableBalance: "1", dualSidePosition: false, multiAssetsMargin: false }));
    const { verifyBinanceTestnetCredentials } = await import("@/lib/testnet-credentials.server");
    await verifyBinanceTestnetCredentials("both", raw);
    expect(urls.every((u) => ["https://testnet.binancefuture.com", "https://testnet.binance.vision"].includes(new URL(u).origin))).toBe(true);
  });
});

describe("safe order-status reconciliation in the adapter", () => {
  it("an order submit timeout is sent once, never retried, and reported as outcome unknown", async () => {
    const f = vi.fn(async (_url: string) => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    vi.stubGlobal("fetch", f);
    await expect(futuresCall({ testnet: true, creds: testCreds }, "POST", "/fapi/v1/order", { symbol: "DOGEUSDT" })).rejects.toThrow(/\[TESTNET\].*outcome unknown.*never resubmitted/);
    expect(f.mock.calls.filter((c) => String(c[0]).includes("/fapi/v1/order"))).toHaveLength(1);
  });
  it("a lookup failure is reported as unavailable, not as a rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(futuresCall({ testnet: false, creds: prodCreds }, "GET", "/fapi/v1/order")).rejects.toThrow(/\[PRODUCTION\].*unavailable/);
  });
  it("broker errors keep their Binance code and carry the environment label", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: -2013, msg: "Order does not exist." }), { status: 400 }));
    await expect(futuresCall({ testnet: false, creds: prodCreds }, "GET", "/fapi/v1/order")).rejects.toThrow("[PRODUCTION] Binance Futures 400 (-2013): Order does not exist.");
  });
});
