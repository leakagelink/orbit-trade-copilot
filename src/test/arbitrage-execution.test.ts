import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ book: vi.fn(), order: vi.fn(), risk: vi.fn(), account: vi.fn() }));
vi.mock("@/lib/exchange-adapters.server", () => ({ fetchArbitrageBook: mocks.book, placeMarketOrder: mocks.order, fetchBalances: vi.fn(), floorToStep: vi.fn(), getStepSize: vi.fn() }));
vi.mock("@/lib/manual.server", () => ({ loadAccount: mocks.account }));
vi.mock("@/lib/engine.server", () => ({ accountRiskBlock: mocks.risk }));
import { executeArbitrage, type ExecuteInput } from "@/lib/arbitrage.server";
import { requireElite } from "@/lib/plan.server";
import { ELITE_UPGRADE_MESSAGE } from "@/lib/plans";

function database() {
  const saved: Record<string, unknown>[] = [];
  const from = vi.fn(() => {
    let insert: Record<string, unknown> | undefined, update: Record<string, unknown> | undefined;
    const chain = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain),
      insert: vi.fn((row: Record<string, unknown>) => { insert = row; return chain; }),
      update: vi.fn((row: Record<string, unknown>) => { update = row; return chain; }),
      maybeSingle: vi.fn(async () => ({ data: saved[0] ?? null, error: null })),
      single: vi.fn(async () => {
        if (insert) saved.push({ id: "run-1", ...insert });
        if (update && saved[0]) Object.assign(saved[0], update);
        return { data: saved[0], error: null };
      }),
    }; return chain;
  });
  return { from, saved };
}
const input: ExecuteInput = { pair: "BTC/USDT", budget: 1000, feeBps: 10, slippageBps: 5, exchanges: ["binance", "okx"],
  requestKey: "00000000-0000-4000-8000-000000000001", buyExchange: "binance", sellExchange: "okx", buyConnectionId: null, sellConnectionId: null, mode: "paper", confirmation: "", minimumNetPct: 0.1 };
type DB = Parameters<typeof executeArbitrage>[0];
beforeEach(() => {
  vi.clearAllMocks(); mocks.risk.mockResolvedValue(null);
  mocks.book.mockImplementation(async (exchange: string) => ({ exchange, asks: [[exchange === "binance" ? 100 : 104, 100]], bids: [[exchange === "binance" ? 99 : 103, 100]], fetchedAt: Date.now() }));
});
describe("server arbitrage execution", () => {
  it("persists a paper run and reads it back without sending exchange orders", async () => {
    const db = database();
    const result = await executeArbitrage(db as unknown as DB, "user-1", input);
    expect(result?.status).toBe("completed"); expect(result?.realized_net).toBeCloseTo(26.955);
    const again = await executeArbitrage(db as unknown as DB, "user-1", input);
    expect(again?.id).toBe(result?.id); expect(db.saved).toHaveLength(1); expect(mocks.order).not.toHaveBeenCalled();
  });
  it("blocks execution when emergency stop is active", async () => {
    mocks.risk.mockResolvedValue("trading halted (emergency stop)");
    const db = database();
    await expect(executeArbitrage(db as unknown as DB, "user-1", input)).rejects.toThrow("trading halted");
    expect(db.saved).toHaveLength(0); expect(mocks.order).not.toHaveBeenCalled();
  });
  it("requires LIVE confirmation before touching live accounts", async () => {
    const db = database();
    await expect(executeArbitrage(db as unknown as DB, "user-1", { ...input, mode: "live" })).rejects.toThrow("Type LIVE");
    expect(mocks.account).not.toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled();
  });
  it("server plan guard denies non-Elite arbitrage callers", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
    await expect(requireElite(db as unknown as Parameters<typeof requireElite>[0], "user-1")).rejects.toThrow(ELITE_UPGRADE_MESSAGE);
    expect(db.rpc).toHaveBeenCalledWith("has_elite_access", { _uid: "user-1" });
  });
  it("server plan guard accepts confirmed Elite access", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
    await expect(requireElite(db as unknown as Parameters<typeof requireElite>[0], "user-1")).resolves.toBeUndefined();
  });
});