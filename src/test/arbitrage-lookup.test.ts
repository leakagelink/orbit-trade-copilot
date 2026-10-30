import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupArbitrageOrder } from "@/lib/exchange-adapters.server";
const creds = { apiKey: "test", apiSecret: "test", passphrase: "test" };
const cid = "12345678-1234-1234-1234-123456789abc";
afterEach(() => vi.unstubAllGlobals());
describe("read-only exchange recovery", () => {
  it("finds a Binance order by its durable client ID without submitting anything", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ symbol: "BTCUSDT", side: "BUY", clientOrderId: cid, orderId: 1, executedQty: "10", cummulativeQuoteQty: "1000", status: "FILLED" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ orderId: 1, qty: "10", commission: "0.01", commissionAsset: "BTC" }])));
    vi.stubGlobal("fetch", fetcher);
    const result = await lookupArbitrageOrder("binance", creds, true, "BTC/USDT", "buy", cid);
    expect(result.qty).toBe(9.99); expect(result.feeQuote).toBe(0); expect(result.quoteValue).toBe(1000);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`origClientOrderId=${cid}`);
    for (const call of fetcher.mock.calls) expect(call[1]?.method ?? "GET").toBe("GET");
  });
  it("leaves missing orders unresolved instead of assuming no execution", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: -2013 }), { status: 400 })));
    await expect(lookupArbitrageOrder("binance", creds, false, "BTC/USDT", "buy", cid)).rejects.toThrow();
  });
  it("rejects incomplete fee history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ symbol: "BTCUSDT", side: "BUY", clientOrderId: cid, orderId: 1, executedQty: "10", cummulativeQuoteQty: "1000", status: "FILLED" }))).mockResolvedValueOnce(new Response("[]")));
    await expect(lookupArbitrageOrder("binance", creds, true, "BTC/USDT", "buy", cid)).rejects.toThrow("Incomplete");
  });
  it("normalizes OKX IDs and preserves signed quote rebates in demo mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "0", data: [{ clOrdId: cid.replaceAll("-", ""), instId: "BTC-USDT", side: "sell", ordId: "2", state: "filled", accFillSz: "10", avgPx: "103", fee: "1", feeCcy: "USDT", rebate: "0", rebateCcy: "USDT" }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await lookupArbitrageOrder("okx", creds, true, "BTC/USDT", "sell", cid);
    expect(result.feeQuote).toBe(-1); expect(result.quoteValue).toBe(1030);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`clOrdId=${cid.replaceAll("-", "")}`);
    expect(fetcher.mock.calls[0]?.[1]?.headers["x-simulated-trading"]).toBe("1");
    expect(fetcher.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });
});