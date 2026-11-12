// Central Risk Engine context builder: SELECT-only reads, INSUFFICIENT_DATA on any failed critical read, existing
// limits used as-is (fixed Testnet limits on Testnet), and no route to order, credential or exchange code.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFuturesRiskContext, evaluateFuturesProposalReadOnly, selectOnly, type RiskReadPorts } from "@/lib/central-risk-context.server";
import { evaluateProposal, type TradeProposal } from "@/lib/central-risk";

const NOW = Date.UTC(2026, 10, 12, 12, 0);
const USER = "00000000-0000-4000-8000-000000000001";
type Tables = Record<string, { data?: unknown; error?: unknown; count?: number }>;
function fakeDb(tables: Tables) {
  const calls: string[] = [];
  const db = {
    from(t: string) {
      calls.push(`from:${t}`);
      const res = tables[t] ?? { data: null, error: null, count: 0 };
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "in", "gte"]) chain[m] = (...a: unknown[]) => { calls.push(`${m}:${String(a[0])}=${JSON.stringify(a[1])}`); return chain; };
      chain["maybeSingle"] = () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
      chain["then"] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null, count: res.count ?? null }).then(ok, bad);
      return {
        select: (c: string) => { calls.push(`select:${c}`); return chain; },
        insert: () => { throw new Error("WRITE ATTEMPTED"); }, update: () => { throw new Error("WRITE ATTEMPTED"); }, delete: () => { throw new Error("WRITE ATTEMPTED"); }, upsert: () => { throw new Error("WRITE ATTEMPTED"); },
      };
    },
    rpc: () => { throw new Error("RPC ATTEMPTED"); },
  };
  return { db, calls };
}
const GOOD: Tables = {
  risk_settings: { data: { max_daily_loss: 50, max_open_exposure: 2000, max_total_positions: 3, trading_halted: false } },
  futures_settings: { data: { max_leverage: 10, max_loss: 10, max_margin: 100 } },
  strategy_risk_budgets: { data: { max_loss: 30 } },
  positions: { data: [{ trading_pair: "ETH/USDT", entry_price: 2500, quantity: 0.1, unrealized_pnl: -2 }] },
  orders: { count: 0 },
  trades: { data: [{ realized_pnl: -5, fees: 1, funding_pnl: 0, costs_verified: true }] },
};
const ports = (tables: Tables, o: Partial<RiskReadPorts> = {}) => {
  const f = fakeDb(tables);
  const p: RiskReadPorts = {
    db: selectOnly(f.db), now: () => NOW,
    markPrice: async () => ({ markPrice: 100_000, time: NOW - 500 }),
    symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: 0.004 }),
    availableMargin: async () => 500, strategyUsedLoss: async () => 4, ...o,
  };
  return { p, calls: f.calls };
};
const proposal = (x: Partial<TradeProposal> = {}): TradeProposal => ({ proposalId: "proposal-0001", engine: "scalp_intraday", strategyId: "futures-scalp-intraday", symbol: "BTCUSDT", market: "usdm_futures", environment: "live", side: "LONG", referencePrice: 99_000, stopPrice: 99_000, takeProfitPrice: 102_000, createdAt: NOW - 1000, ...x });

describe("Central Risk Engine context builder", () => {
  it("builds a complete context from SELECT reads and existing limits; ACCEPT still authorizes nothing", async () => {
    const { p, calls } = ports(GOOD);
    const { context, reads } = await buildFuturesRiskContext(p, USER, proposal());
    expect(reads.every((r) => r.ok)).toBe(true);
    expect(context.limits).toMatchObject({ maxDailyLoss: 50, maxExposure: 2000, maxPositions: 3, maxLossPerTrade: 10, maxMarginPerTrade: 100, maxLeverage: 10 });
    expect(context.account).toMatchObject({ openExposure: 250, openPositions: 1, dayNet: -8, halted: false, availableMargin: 500 });
    expect(context.orders).toEqual({ sameProposalSeen: false, unresolvedOrders: 0, openPositionOnSymbol: false });
    expect(calls).toContain('eq:execution_environment="production"');
    const d = evaluateProposal(proposal(), context);
    expect(d.verdict).toBe("ACCEPT"); expect(d.executionAuthorized).toBe(false);
    expect(calls.filter((c) => /^(insert|update|delete|upsert|rpc)/.test(c))).toEqual([]);
  });

  it("returns INSUFFICIENT_DATA with today's real ports: no maintenance margin, available margin or strategy attribution", async () => {
    const { p } = ports(GOOD, { symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: null }), availableMargin: async () => null, strategyUsedLoss: async () => null });
    const { decision, reads } = await evaluateFuturesProposalReadOnly(p, USER, proposal());
    expect(decision.verdict).toBe("INSUFFICIENT_DATA"); expect(decision.sizing).toBeNull();
    expect(reads.filter((r) => !r.ok).map((r) => r.source).sort()).toEqual(["available_margin", "strategy_used_loss"]);
  });

  it.each([
    ["risk_settings", { risk_settings: { error: { message: "boom" } } }],
    ["futures_settings", { futures_settings: { error: { message: "boom" } } }],
    ["strategy_risk_budgets (table not created yet)", { strategy_risk_budgets: { error: { message: "relation does not exist" } } }],
    ["positions", { positions: { error: { message: "boom" } } }],
    ["orders", { orders: { error: { message: "boom" } } }],
    ["trades", { trades: { error: { message: "boom" } } }],
  ])("a failed %s read yields INSUFFICIENT_DATA", async (_name, broken) => {
    const { p } = ports({ ...GOOD, ...(broken as Tables) });
    const { decision } = await evaluateFuturesProposalReadOnly(p, USER, proposal());
    expect(decision.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("missing mark price or a throwing port yields INSUFFICIENT_DATA; stale mark price is refused", async () => {
    expect((await evaluateFuturesProposalReadOnly(ports(GOOD, { markPrice: async () => null }).p, USER, proposal())).decision.verdict).toBe("INSUFFICIENT_DATA");
    expect((await evaluateFuturesProposalReadOnly(ports(GOOD, { availableMargin: async () => { throw new Error("net"); } }).p, USER, proposal())).decision.verdict).toBe("INSUFFICIENT_DATA");
    const stale = await evaluateFuturesProposalReadOnly(ports(GOOD, { markPrice: async () => ({ markPrice: 100_000, time: NOW - 60_000 }) }).p, USER, proposal());
    expect(stale.decision.verdict).toBe("REJECT"); expect(stale.decision.checks.find((c) => c.id === "market_data")!.status).toBe("fail");
  });

  it("emergency stop, unresolved orders and duplicates reject", async () => {
    const halted = await evaluateFuturesProposalReadOnly(ports({ ...GOOD, risk_settings: { data: { ...(GOOD["risk_settings"]!.data as object), trading_halted: true } } }).p, USER, proposal());
    expect(halted.decision.verdict).toBe("REJECT");
    const pending = await evaluateFuturesProposalReadOnly(ports({ ...GOOD, orders: { count: 1 } }).p, USER, proposal());
    expect(pending.decision.checks.find((c) => c.id === "unknown_outcomes")!.status).toBe("fail");
    expect(pending.decision.checks.find((c) => c.id === "duplicate")!.status).toBe("fail");
  });

  it("Testnet uses the fixed Testnet limits, never reads production Futures limits, and scopes orders to Testnet", async () => {
    const { p, calls } = ports(GOOD);
    const { context } = await buildFuturesRiskContext(p, USER, proposal({ environment: "testnet" }));
    expect(context.limits).toMatchObject({ maxMarginPerTrade: 5, maxLossPerTrade: 2, maxDailyLoss: 2, maxExposure: 10, maxPositions: 1, maxLeverage: 10 });
    expect(calls).not.toContain("from:futures_settings");
    expect(calls).toContain('eq:execution_environment="testnet"');
  });

  it("refuses paper and Spot proposals and malformed or AI-sized proposals", async () => {
    expect((await buildFuturesRiskContext(ports(GOOD).p, USER, proposal({ environment: "paper" }))).context.limits).toBeNull();
    const sized = await evaluateFuturesProposalReadOnly(ports(GOOD).p, USER, { ...proposal(), leverage: 50 });
    expect(sized.decision.verdict).toBe("REJECT"); expect(sized.reads).toEqual([]);
  });

  it("the handle cannot write: selectOnly exposes only from().select()", () => {
    const h = selectOnly(fakeDb({}).db) as unknown as Record<string, unknown>;
    expect(Object.keys(h)).toEqual(["from"]);
    expect(Object.keys((h["from"] as (t: string) => object)("orders"))).toEqual(["select"]);
    const src = readFileSync("src/lib/central-risk-context.server.ts", "utf8");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });

  it("imports no order, credential, exchange-adapter, AI or wallet module", () => {
    const seen = new Set([resolve("src/lib/central-risk-context.server.ts"), resolve("src/lib/futures-public-market.server.ts")]), queue = [...seen];
    while (queue.length) {
      const file = queue.shift()!;
      for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = (m[1] ?? m[2])!;
        const base = spec.startsWith("@/") ? resolve("src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
        if (!base) continue;
        const hit = [base, `${base}.ts`].find((c) => existsSync(c) && statSync(c).isFile())!;
        if (!seen.has(hit)) { seen.add(hit); queue.push(hit); }
      }
    }
    const files = [...seen].map((f) => relative(process.cwd(), f));
    expect(files.filter((f) => /futures\.server|futures-execution|binance-futures|exchange-adapters|credential|crypto\.server|testnet-credentials|engine|autopilot|wallet|ai-|integrations\/|manual|arbitrage|deriv/.test(f))).toEqual([]);
    expect(readFileSync("src/lib/futures-public-market.server.ts", "utf8")).not.toMatch(/X-MBX-APIKEY|signature|POST|DELETE|\/fapi\/v1\/order/);
  });
});
