import { afterEach, expect, it, vi } from "vitest";
import { fetchBinanceChart } from "@/lib/chart-feed";

afterEach(() => vi.unstubAllGlobals());

it("fetches real display candles without sending credentials", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([[1700000000000, "100", "110", "90", "105", "20"]])));
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchBinanceChart("BTC/USDT", "5m")).toEqual([{ t: 1700000000000, o: 100, h: 110, l: 90, c: 105, v: 20 }]);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=500");
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe("omit");
  expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
});

it("rejects invalid data instead of drawing fabricated prices", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([[1700000000000, "bad", "110", "90", "105", "20"]]))));
  await expect(fetchBinanceChart("BTC/USDT", "1h")).rejects.toThrow("Invalid chart candles");
});