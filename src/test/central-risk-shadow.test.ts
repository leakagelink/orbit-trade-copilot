// Phase 4B — Central Risk SHADOW mode: non-interference, fail-closed missing data, environment separation,
// determinism and import isolation. Every test uses fake SELECT-only databases and spy fetchers; nothing touches
// a real database or exchange.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createShadowLog, maintenanceMarginRateFor, missingContextInputs, SHADOW_SOURCE_MATRIX, ticketToProposal, type ShadowTicket } from "@/lib/central-risk-shadow";
import { runShadowEvaluation, shadowReadPorts } from "@/lib/central-risk-shadow.server";
import { selectOnly, type RiskReadPorts } from "@/lib/central-risk-context.server";
import { PUBLIC_FUTURES_ALLOWLIST } from "@/lib/futures-public-market.server";
import type { FuturesTicket } from "@/lib/futures";

const NOW = Date.UTC(2026, 10, 12, 12, 0);
const USER = "00000000-0000-4000-8000-000000000001";
const LIVE = { connectionId: "11111111-1111-4111-8111-111111111111", testnet: false };
const TESTNET = { connectionId: "22222222-2222-4222-8222-222222222222", testnet: true };
type Tables = Record<string, { data?: unknown; error?: unknown; count?: number }>;

function fakeDb(tables: Tables) {
  const calls: string[] = [];
  const writes: string[] = [];
  const db = {
    from(t: string) {
      calls.push(`from:${t}`);
      const res = tables[t] ?? { data: null, error: null, count: 0 };
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "in", "gte"]) chain[m] = (...a: unknown[]) => { calls.push(`${m}:${String(a[0])}=${JSON.stringify(a[1])}`); return chain; };
      chain["maybeSingle"] = () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
      chain["then"] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null, count: res.count ?? null }).then(ok, bad);
      const w = (k: string) => () => { writes.push(`${k}:${t}`); throw new Error("WRITE ATTEMPTED"); };
      return { select: (c: string) => { calls.push(`select:${t}:${c}`); return chain; }, insert: w("insert"), update: w("update"), delete: w("delete"), upsert: w("upsert") };
    },
    rpc: () => { writes.push("rpc"); throw new Error("RPC ATTEMPTED"); },
  };
  return { db, calls, writes };
}
const GOOD: Tables = {
  risk_settings: { data: { max_daily_loss: 50, max_open_exposure: 2000, max_total_positions: 3, trading_halted: false } },
  futures_settings: { data: { max_leverage: 10, max_loss: 10, max_margin: 100 } },
  strategy_risk_budgets: { data: { max_loss: 30 } },
  positions: { data: [{ trading_pair: "ETH/USDT", entry_price: 2500, quantity: 0.1, unrealized_pnl: -2 }] },
  orders: { count: 0 },
  trades: { data: [{ realized_pnl: -5, fees: 1, funding_pnl: 0, costs_verified: true }] },
};
/** Complete ports (what shadow mode would see once the four blocked sources exist). */
function fullPorts(tables: Tables = GOOD, o: Partial<RiskReadPorts> = {}) {
  const f = fakeDb(tables);
  const p: RiskReadPorts = {
    db: selectOnly(f.db), now: () => NOW,
    markPrice: async () => ({ markPrice: 100_000, time: NOW - 500 }),
    symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: 0.004 }),
    availableMargin: async () => 500, strategyUsedLoss: async () => 4, ...o,
  };
  return { p, ...f };
}
const ticket = (x: Partial<ShadowTicket> = {}): ShadowTicket => ({ connectionId: LIVE.connectionId, symbol: "BTC/USDT", side: "buy", margin: 20, leverage: 5, slPct: 1, tpPct: 2, requestId: "33333333-3333-4333-8333-333333333333", confirmation: "LIVE", ...x });
const run = (p: RiskReadPorts, t = ticket(), account = LIVE) => runShadowEvaluation({ ports: p, userId: USER, account, ticket: t, proposalCreatedAt: NOW - 1000 });

describe("Shadow ACCEPT / REJECT / INSUFFICIENT_DATA", () => {
  it("ACCEPT never authorizes execution and never resizes the ticket", async () => {
    const r = await run(fullPorts().p);
    expect(r.verdict).toBe("ACCEPT");
    expect(r.executionAuthorized).toBe(false); expect(r.affectsOrderPath).toBe(false); expect(r.shadowOnly).toBe(true);
    expect(r.note).toMatch(/does not authorize, block, resize/);
    expect(r.proposedLeverage).toBeGreaterThanOrEqual(1); expect(r.proposedLiquidationBufferPct!).toBeGreaterThanOrEqual(2);
    expect(r.ticketComparison).toMatchObject({ ticketNotional: 100, ticketLeverage: 5 });
    expect(Object.isFrozen(r) && Object.isFrozen(r.checks)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/apiKey|api_secret|secret|token/i);
  });
  it("REJECT is only a record: the function resolves, it does not throw or signal a block", async () => {
    const halted = fullPorts({ ...GOOD, risk_settings: { data: { ...(GOOD["risk_settings"]!.data as object), trading_halted: true } } });
    const r = await run(halted.p);
    expect(r.verdict).toBe("REJECT"); expect(r.failedChecks.map((c) => c.id)).toContain("emergency_stop");
    expect(r.affectsOrderPath).toBe(false); expect(r.sizing).toBeNull();
  });
  it("INSUFFICIENT_DATA is fail-closed: no size, leverage or liquidation buffer", async () => {
    const r = await run(fullPorts(GOOD, { availableMargin: async () => null }).p);
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect([r.sizing, r.proposedLeverage, r.proposedLiquidationBufferPct, r.liquidationPriceEstimate]).toEqual([null, null, null, null]);
    expect(r.ticketComparison.withinEngineSize).toBeNull();
  });
  it("detects a missing strategy budget (draft 0045 table absent)", async () => {
    const r = await run(fullPorts({ ...GOOD, strategy_risk_budgets: { error: { message: "relation does not exist" } } }).p);
    expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.missingInputs).toContain("strategy_risk_budget");
  });
  it("detects missing maintenance margin", async () => {
    const r = await run(fullPorts(GOOD, { symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: null }) }).p);
    expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.missingInputs).toContain("maintenance_margin_rate");
  });
  it("detects missing available margin and strategy loss attribution", async () => {
    const r = await run(fullPorts(GOOD, { availableMargin: async () => null, strategyUsedLoss: async () => null }).p);
    expect(r.missingInputs).toEqual(expect.arrayContaining(["available_margin", "strategy_loss_attribution"]));
  });
  it("detects a stale mark price", async () => {
    const r = await run(fullPorts(GOOD, { markPrice: async () => ({ markPrice: 100_000, time: NOW - 60_000 }) }).p);
    expect(r.verdict).toBe("REJECT"); expect(r.failedChecks.map((c) => c.id)).toContain("market_data");
    expect(r.marketDataTimestamp).toBe(NOW - 60_000);
  });
  it("no verified price → INSUFFICIENT_DATA before any proposal is formed", async () => {
    const r = await run(fullPorts(GOOD, { markPrice: async () => null }).p);
    expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.proposalId).toBeNull(); expect(r.missingInputs).toContain("market_data");
  });
  it("identifies duplicates: already-claimed idempotency key and a repeated proposal in the shadow log", async () => {
    const r = await run(fullPorts({ ...GOOD, orders: { count: 1 } }).p);
    expect(r.failedChecks.map((c) => c.id)).toContain("duplicate");
    const log = createShadowLog(), a = await run(fullPorts().p);
    expect(log.append(a).duplicate).toBe(false); expect(log.append(a).duplicate).toBe(true);
    expect(log.summary()).toMatchObject({ total: 2, duplicates: 1 });
    expect(() => (log.all() as unknown as unknown[]).push(a)).toThrow();
  });
  it("today's real ports return INSUFFICIENT_DATA for Live (four blocked sources)", async () => {
    const f = fakeDb(GOOD);
    const fetcher = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/fapi/v1/premiumIndex") return new Response(JSON.stringify({ markPrice: "100000", indexPrice: "100010", time: NOW - 200 }));
      return new Response(JSON.stringify({ symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "MARKET_LOT_SIZE", stepSize: "0.001" }, { filterType: "PRICE_FILTER", tickSize: "0.1" }, { filterType: "MIN_NOTIONAL", notional: "100" }] }] }));
    }) as unknown as typeof fetch;
    const r = await run(shadowReadPorts({ db: f.db, account: LIVE, now: () => NOW, fetcher }));
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.missingInputs).toEqual(expect.arrayContaining(["available_margin", "maintenance_margin_rate", "strategy_loss_attribution"]));
    expect(SHADOW_SOURCE_MATRIX.filter((s) => s.status === "BLOCKED").map((s) => s.input).sort()).toEqual(["available_margin", "maintenance_margin_rate", "strategy_loss_attribution", "strategy_risk_budget"]);
  });
});

describe("Environment separation", () => {
  it("a ticket labelled LIVE on a Testnet connection (and vice versa) is refused before any read", async () => {
    const f = fullPorts();
    const a = await run(f.p, ticket({ connectionId: TESTNET.connectionId, confirmation: "LIVE" }), TESTNET);
    const b = await run(f.p, ticket({ confirmation: "TESTNET" }), LIVE);
    for (const r of [a, b]) { expect(r.verdict).toBe("REJECT"); expect(r.failedChecks[0]!.id).toBe("environment_label"); }
    expect(a.environmentLabel).toBe("TESTNET"); expect(b.environmentLabel).toBe("LIVE");
    expect(f.calls.filter((c) => c.startsWith("from:"))).toEqual([]);
  });
  it("a ticket for another connection is refused", async () => {
    const r = await run(fullPorts().p, ticket({ connectionId: TESTNET.connectionId }));
    expect(r.failedChecks[0]!.id).toBe("account_binding");
  });
  it("Testnet never reads production Futures limits, scopes orders/positions/trades to Testnet, and never fetches production prices", async () => {
    const f = fakeDb(GOOD); const urls: string[] = [];
    const fetcher = (async (u: string) => { urls.push(u); return new Response("{}"); }) as unknown as typeof fetch;
    const r = await run(shadowReadPorts({ db: f.db, account: TESTNET, now: () => NOW, fetcher }), ticket({ connectionId: TESTNET.connectionId, confirmation: "TESTNET" }), TESTNET);
    expect(urls).toEqual([]); expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.environmentLabel).toBe("TESTNET");
    const full = fullPorts();
    await run(full.p, ticket({ connectionId: TESTNET.connectionId, confirmation: "TESTNET" }), TESTNET);
    expect(full.calls).not.toContain("from:futures_settings");
    expect(full.calls).toContain('eq:execution_environment="testnet"'); expect(full.calls).not.toContain('eq:execution_environment="production"');
  });
  it("Live reads production-scoped rows only", async () => {
    const f = fullPorts(); await run(f.p);
    expect(f.calls).toContain('eq:execution_environment="production"'); expect(f.calls).not.toContain('eq:execution_environment="testnet"');
  });
});

describe("Non-interference", () => {
  it("never writes: only from/select/eq/in/gte/maybeSingle are reached; risk settings are only selected", async () => {
    const f = fullPorts(); await run(f.p);
    expect(f.writes).toEqual([]);
    expect(f.calls.every((c) => /^(from|select|eq|in|gte):/.test(c))).toBe(true);
    expect(f.calls.filter((c) => c.includes("risk_settings")).every((c) => c.startsWith("from:") || c.startsWith("select:"))).toBe(true);
    for (const file of ["src/lib/central-risk-shadow.ts", "src/lib/central-risk-shadow.server.ts"]) expect(readFileSync(file, "utf8"), file).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });
  it("exchange access is credential-free public GET on the fixed allowlist only", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await run(shadowReadPorts({ db: fakeDb(GOOD).db, account: LIVE, now: () => NOW, fetcher }));
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      const u = new URL(s.url);
      expect(u.origin).toBe("https://fapi.binance.com"); expect(PUBLIC_FUTURES_ALLOWLIST).toContain(u.pathname);
      expect(s.init?.method).toBe("GET"); expect(JSON.stringify(s.init ?? {})).not.toMatch(/X-MBX-APIKEY|signature/i);
    }
  });
  it("exceptions anywhere resolve to an INSUFFICIENT_DATA record (never a throw)", async () => {
    const boom = () => { throw new Error("boom"); };
    const throwingDb = { from: boom } as unknown as Parameters<typeof selectOnly>[0];
    const cases: RiskReadPorts[] = [
      fullPorts(GOOD, { markPrice: async () => { throw new Error("net"); } }).p,
      fullPorts(GOOD, { symbolRules: async () => { throw new Error("net"); }, availableMargin: async () => { throw new Error("x"); } }).p,
      { ...fullPorts().p, db: selectOnly(throwingDb) },
      { ...fullPorts().p, now: boom as unknown as () => number },
    ];
    for (const p of cases) {
      const r = await run(p);
      expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.executionAuthorized).toBe(false);
    }
  });
  it("is deterministic: identical inputs give identical records and context hashes", async () => {
    const a = await run(fullPorts().p), b = await run(fullPorts().p);
    expect(a).toEqual(b); expect(a.contextSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const c = await run(fullPorts({ ...GOOD, orders: { count: 0 }, trades: { data: [] } }).p);
    expect(c.contextSnapshotHash).not.toBe(a.contextSnapshotHash);
  });
  it("the ticket adapter never carries the ticket's margin or leverage into the proposal", () => {
    const r = ticketToProposal(ticket({ margin: 999, leverage: 20 }), LIVE, { markPrice: 100, time: NOW }, "manual-futures", NOW);
    expect(r.proposal).not.toBeNull();
    expect(JSON.stringify(r.proposal)).not.toMatch(/999|"leverage"|margin/);
    expect(r.proposal!.stopPrice).toBeCloseTo(99); expect(r.proposal!.takeProfitPrice).toBeCloseTo(102); expect(r.proposal!.referencePrice).toBeNull();
  });
  it("ShadowTicket stays a structural subset of the real Futures ticket", () => {
    const real: FuturesTicket = { ...ticket(), holdMin: 30 };
    const asShadow: ShadowTicket = real; expect(asShadow.requestId).toBe(real.requestId);
  });
  it("missing-input listing and leverage-bracket contract are field-level and fail closed", () => {
    expect(missingContextInputs({ now: NOW, account: null, limits: null, strategy: null, market: null, orders: null })).toEqual(["account", "risk_limits", "strategy_risk_budget", "market", "order_state"]);
    const brackets = [{ notionalFloor: 0, notionalCap: 50_000, maintMarginRatio: 0.004, initialLeverage: 125 }, { notionalFloor: 50_000, notionalCap: 250_000, maintMarginRatio: 0.005, initialLeverage: 100 }];
    expect(maintenanceMarginRateFor(brackets, 1000)).toBe(0.004); expect(maintenanceMarginRateFor(brackets, 60_000)).toBe(0.005);
    expect(maintenanceMarginRateFor(brackets, 1e9)).toBeNull(); expect(maintenanceMarginRateFor(null, 1000)).toBeNull();
  });
});

// ---- Import graph -------------------------------------------------------------------------------------------------
const ROOT = process.cwd();
function graph(entries: string[]) {
  const seen = new Set<string>(entries.map((e) => resolve(ROOT, e))), queue = [...seen];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (!hit) continue;
      if (!seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}
function walk(dir: string): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; }); }

describe("Shadow import isolation", () => {
  it("the shadow evaluator cannot reach any order-capable, credential, exchange-adapter, wallet, bot or AI module", () => {
    const files = graph(["src/lib/central-risk-shadow.server.ts", "src/lib/central-risk-shadow.ts"]);
    expect(files).toContain("src/lib/central-risk-context.server.ts");
    expect(files.filter((f) => /futures\.server|futures-execution|futures-authorization|futures-lease|binance-futures|exchange-adapters|credential|crypto\.server|engine|autopilot|wallet|ai-|integrations\/|manual|arbitrage|deriv|paper\.server/.test(f))).toEqual([]);
  });
  it("nothing outside tests imports the shadow modules (order path, functions, routes, engine, Autopilot)", () => {
    const importers = walk(resolve(ROOT, "src")).filter((f) => !f.includes(`${join("src", "test")}`) && !/central-risk-shadow/.test(f))
      .filter((f) => /central-risk-shadow/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => relative(ROOT, f))).toEqual([]);
    for (const f of ["src/lib/futures.server.ts", "src/lib/futures.functions.ts", "src/lib/futures-execution.ts", "src/lib/engine.server.ts", "src/lib/autopilot-tools.server.ts", "src/lib/futures-harness.server.ts"]) {
      expect(graph([f]).filter((x) => /central-risk/.test(x)), f).toEqual([]);
    }
  });
});
