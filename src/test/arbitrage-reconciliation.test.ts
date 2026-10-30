import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), order: vi.fn(), account: vi.fn() }));
vi.mock("@/lib/exchange-adapters.server", () => ({ lookupArbitrageOrder: mocks.lookup, placeMarketOrder: mocks.order }));
vi.mock("@/lib/manual.server", () => ({ loadAccount: mocks.account }));
vi.mock("@/lib/engine.server", () => ({ accountRiskBlock: vi.fn() }));
import { reconcileArbitrage } from "@/lib/arbitrage.server";
const run = { id: "run", user_id: "owner", status: "needs_review", mode: "testnet", updated_at: new Date(Date.now() - 120000).toISOString(), trading_pair: "BTC/USDT", buy_exchange: "binance", sell_exchange: "okx", buy_connection_id: "buy-account", sell_connection_id: "sell-account" };
function database(current: typeof run | null = run) {
  const patches: Record<string, unknown>[] = [];
  const filters: unknown[][] = [];
  const from = vi.fn((table: string) => {
    let patch: Record<string, unknown> | undefined;
    const rows = [{ id: "buy-id", side: "buy", exchange: "binance", exchange_connection_id: "buy-account", idempotency_key: "arb:run:buy" }, { id: "sell-id", side: "sell", exchange: "okx", exchange_connection_id: "sell-account", idempotency_key: "arb:run:sell" }];
    const chain = {
      select: () => chain, eq: (...args: unknown[]) => { filters.push(args); return chain; }, in: () => chain,
      single: async () => ({ data: current, error: null }),
      update: (p: Record<string, unknown>) => { patch = p; patches.push(p); return chain; },
      maybeSingle: async () => ({ data: current ? { ...current, ...patch } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "orders" ? rows : current, error: null }).then(resolve),
    }; return chain;
  });
  return { from, patches, filters };
}
type DB = Parameters<typeof reconcileArbitrage>[0];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockImplementation(async (_db, _user, id) => ({ exchange: id === "buy-account" ? "binance" : "okx", testnet: true, creds: { apiKey: "test", apiSecret: "test" } }));
  mocks.lookup.mockImplementation(async (exchange) => ({ orderId: exchange, state: "filled", qty: 10, avgPrice: exchange === "binance" ? 100 : 103, quoteValue: exchange === "binance" ? 1000 : 1030, feeQuote: 1 }));
});
describe("server reconciliation never places trades", () => {
  it("reads both original intents and saves matched fills with owner and version filters", async () => {
    const db = database(); const result = await reconcileArbitrage(db as unknown as DB, "owner", "run");
    expect(result.status).toBe("completed"); expect(result.realized_net).toBe(28);
    expect(mocks.lookup).toHaveBeenCalledTimes(2); expect(mocks.order).not.toHaveBeenCalled();
    expect(db.filters).toContainEqual(["user_id", "owner"]); expect(db.filters).toContainEqual(["updated_at", run.updated_at]);
  });
  it("keeps the run locked when an exchange lookup fails", async () => {
    mocks.lookup.mockRejectedValue(new Error("unknown order")); const db = database();
    expect((await reconcileArbitrage(db as unknown as DB, "owner", "run")).status).toBe("needs_review");
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("does not reconcile an execution still within its cooling period", async () => {
    const db = database({ ...run, updated_at: new Date().toISOString() });
    await expect(reconcileArbitrage(db as unknown as DB, "owner", "run")).rejects.toThrow("still be running");
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(db.patches).toHaveLength(0);
  });
  it("rejects a missing or inaccessible run before reading credentials", async () => {
    const db = database(null);
    await expect(reconcileArbitrage(db as unknown as DB, "other", "run")).rejects.toThrow("not found");
    expect(mocks.account).not.toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled();
  });
});