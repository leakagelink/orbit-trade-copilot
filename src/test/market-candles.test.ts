import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandles, fetchHistory } from "@/lib/exchange-adapters.server";

const row = [1700000000000, "100", "110", "90", "105", "20"];
const response = () => new Response(JSON.stringify([row]));
afterEach(() => vi.unstubAllGlobals());

describe("Binance candle feed recovery", () => {
  it("uses the official same-market data host after a blocked primary feed", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("Blocked", { status: 403 })).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const candles = await fetchCandles("binance", "BTC/USDT", "1h", false, 500);
    expect(candles).toEqual([{ t: row[0], o: 100, h: 110, l: 90, c: 105, v: 20 }]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });

  it("does not replace blocked testnet data with production data", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("Blocked", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchCandles("binance", "BTC/USDT", "1h", true)).rejects.toThrow("403");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain("https://testnet.binance.vision/");
  });

  it("also recovers historical candles without changing the requested range", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("Blocked", { status: 451 })).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const candles = await fetchHistory("binance", "BTC/USDT", "1h", 1700000000000, 1700003600000);
    expect(candles).toHaveLength(1);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=1700000000000&limit=1000");
  });

  it("reports a failure rather than fabricating candles when both hosts fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("Unavailable", { status: 503 })));
    await expect(fetchCandles("binance", "BTC/USDT", "1h", false)).rejects.toThrow("503");
  });
});