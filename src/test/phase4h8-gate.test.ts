// Phase 4H.8 — disabled execution adapter, hard server-side gate (bypass attempts) and environment isolation.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateProposal, type RiskDecision, type TradeProposal } from "@/lib/central-risk";
import { buildOrderPlan, clientOrderId, CLIENT_ID_RE, endpointsAllowed, executionGate, LIVE_ORDER_EXECUTION_ENABLED, reconcileExchange, settleUncertainSubmit, verifyProtection, type GateContext, type OrderPlan } from "@/lib/scalp-execution";
import { requestScalpOrder } from "@/lib/scalp-execution.server";

const read = (f: string) => readFileSync(f, "utf8");
const allPass: GateContext = { requestedEnvironment: "live", credentialEnvironment: "live", liveOptIn: true, emergencyStop: false, certificationPass: true, decision: { verdict: "ACCEPT", sizing: { qty: 1 } } as unknown as RiskDecision, decisionAgeMs: 10, maxDecisionAgeMs: 5_000, unresolvedOrders: 0, protectionVerified: true };
const prop = (env: "paper" | "testnet" | "live"): TradeProposal => ({ proposalId: "prop-gate-0001", engine: "scalp_intraday", strategyId: "s", symbol: "ETHUSDT", market: "usdm_futures", environment: env, side: "LONG", referencePrice: 1900, stopPrice: 1890, takeProfitPrice: 1915, createdAt: 1 });
const accept = (p: TradeProposal) => evaluateProposal(p, { now: 2, account: { equity: 10_000, availableMargin: 10_000, openExposure: 0, openPositions: 0, dayNet: 0, halted: false, environmentHalted: false }, limits: { maxExposure: 5_000, maxDailyLoss: 50, maxPositions: 2, maxLossPerTrade: 5, maxMarginPerTrade: 200, maxLeverage: 10, liquidationBufferPct: 5, maxDataAgeMs: 5_000, maxProposalAgeMs: 60_000, roundTripCostPct: 0.13 }, strategy: { budget: 20, usedLoss: 0 }, market: { markPrice: 1900, markTimestamp: 1, stepSize: 0.001, minNotional: 20, maintenanceMarginRate: 0.025 }, orders: { sameProposalSeen: false, unresolvedOrders: 0, openPositionOnSymbol: false } });

describe("hard execution gate", () => {
  it("the code flag is false and the gate refuses even when every other check passes", () => {
    expect(LIVE_ORDER_EXECUTION_ENABLED).toBe(false);
    for (const env of ["live", "testnet"]) { const g = executionGate({ ...allPass, requestedEnvironment: env, credentialEnvironment: env as "live" }); expect(g.allowed).toBe(false); expect(g.code).toBe("LIVE_ORDER_EXECUTION_DISABLED"); expect(g.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["code_flag"]); }
  });
  it("an environment variable cannot enable it (the flag is a code constant; no env read exists)", () => {
    vi.stubEnv("LIVE_ORDER_EXECUTION_ENABLED", "true");
    expect(executionGate(allPass).allowed).toBe(false);
    vi.unstubAllEnvs();
    expect(read("src/lib/scalp-execution.ts")).toMatch(/export const LIVE_ORDER_EXECUTION_ENABLED = false as const;/);
    expect(read("src/lib/scalp-execution.ts") + read("src/lib/scalp-execution.server.ts") + read("src/lib/scalp-execution.functions.ts")).not.toMatch(/process\.env|import\.meta\.env/);
  });
  it("no fallback between environments: live request + Testnet credentials (or the reverse) fails its own check", () => {
    const a = executionGate({ ...allPass, requestedEnvironment: "live", credentialEnvironment: "testnet" }), b = executionGate({ ...allPass, requestedEnvironment: "testnet", credentialEnvironment: "live" });
    for (const g of [a, b]) expect(g.checks.find((c) => c.id === "credentials_same_environment")!.ok).toBe(false);
    expect(a.checks.find((c) => c.id === "credentials_same_environment")!.detail).toMatch(/no fallback/);
    for (const env of ["paper", "production", "", null, "LIVE"]) expect(executionGate({ ...allPass, requestedEnvironment: env }).environment).toBeNull();
  });
  it("each missing condition is reported (stop, certification, risk, freshness, unresolved orders, protection, opt-in)", () => {
    const g = executionGate({ ...allPass, liveOptIn: null, emergencyStop: null, certificationPass: false, decision: null, decisionAgeMs: 10_000, unresolvedOrders: null, protectionVerified: false });
    expect(g.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["code_flag", "live_opt_in", "emergency_stop", "certification", "risk_accept", "risk_fresh", "no_unresolved_orders", "protection_verifiable"]);
  });
});

describe("server-side gate (what any UI or forged request reaches)", () => {
  const deps = (log: string[] = []) => ({ now: () => 1_000, readEmergencyStop: async () => false, log: (l: string) => { log.push(l); } });
  it("a valid live or Testnet request is REFUSED with an audit line naming the environment and a correlation id", async () => {
    for (const environment of ["live", "testnet"] as const) {
      const log: string[] = [], r = await requestScalpOrder({ proposalId: "prop-gate-0001", environment, symbol: "BTCUSDT" }, deps(log));
      expect(r.status).toBe("REFUSED"); expect(r.audit).toMatchObject({ environment, code: "LIVE_ORDER_EXECUTION_DISABLED", proposalId: "prop-gate-0001" });
      expect(r.audit.correlationId).toMatch(/^exec_/); expect(JSON.parse(log[0]!)).toMatchObject({ type: "EXECUTION_REFUSED", environment });
    }
  });
  it("bypass attempts — enable flags, forced fields, quantities, unknown environments, other symbols — are refused before the gate", async () => {
    const bad = [{ proposalId: "prop-gate-0001", environment: "live", symbol: "BTCUSDT", enabled: true }, { proposalId: "prop-gate-0001", environment: "live", symbol: "BTCUSDT", LIVE_ORDER_EXECUTION_ENABLED: true },
      { proposalId: "prop-gate-0001", environment: "live", symbol: "BTCUSDT", quantity: 1, leverage: 20 }, { proposalId: "prop-gate-0001", environment: "production", symbol: "BTCUSDT" },
      { proposalId: "prop-gate-0001", environment: "paper", symbol: "BTCUSDT" }, { proposalId: "prop-gate-0001", environment: "live", symbol: "DOGEUSDT" }, null, "live", { environment: "live" }];
    for (const b of bad) { const r = await requestScalpOrder(b, deps()); expect(r.status).toBe("REFUSED"); expect(r.audit.code).toBe("INVALID_REQUEST"); expect(r.gate).toBeNull(); }
  });
  it("a failing emergency-stop read is unknown (never assumed off) and the request is still refused", async () => {
    const r = await requestScalpOrder({ proposalId: "prop-gate-0001", environment: "live", symbol: "ETHUSDT" }, { ...deps(), readEmergencyStop: async () => { throw new Error("db down"); } });
    expect(r.gate!.checks.find((c) => c.id === "emergency_stop")!.detail).toMatch(/unknown/);
  });
  it("no network call is possible from the gate path", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await requestScalpOrder({ proposalId: "prop-gate-0001", environment: "live", symbol: "ETHUSDT" }, deps());
    expect(f).not.toHaveBeenCalled(); f.mockRestore();
  });
  it("audit lines never carry credential-looking values", async () => {
    const log: string[] = []; await requestScalpOrder({ proposalId: "prop-gate-0001", environment: "live", symbol: "ETHUSDT", apiSecret: "a".repeat(64) }, deps(log));
    expect(log.join()).not.toMatch(/aaaaaaaaaaaaaaaa|apiSecret/);
  });
});

describe("prepared adapter (never sent)", () => {
  it("a paper proposal can never become a live or Testnet order plan", () => {
    const p = prop("paper"), d = accept(p);
    expect(d.verdict).toBe("ACCEPT");
    expect(buildOrderPlan(p, d, "live", { stepSize: 0.001, tickSize: 0.01 })).toEqual({ error: "a paper proposal cannot become a live order (no conversion path)" });
  });
  it("a same-environment plan: deterministic environment-tagged client ids, reduce-only close-position protection on the mark price", () => {
    const p = prop("testnet"), plan = buildOrderPlan(p, accept(p), "testnet", { stepSize: 0.001, tickSize: 0.01 }) as OrderPlan;
    expect(plan.environment).toBe("testnet"); expect(plan.entry.environment).toBe("testnet");
    expect(plan.entry.params).toMatchObject({ type: "MARKET", side: "BUY", newClientOrderId: clientOrderId(p.proposalId, "testnet", "E") });
    expect(plan.protection.map((x) => [x.params["type"], x.params["side"], x.params["closePosition"], x.params["workingType"], x.environment])).toEqual([["STOP_MARKET", "SELL", "true", "MARK_PRICE", "testnet"], ["TAKE_PROFIT_MARKET", "SELL", "true", "MARK_PRICE", "testnet"]]);
    expect(buildOrderPlan(p, accept(p), "live", { stepSize: 0.001, tickSize: 0.01 })).toHaveProperty("error");
    expect(buildOrderPlan(p, { ...accept(p), verdict: "REJECT", sizing: null }, "testnet", { stepSize: 0.001, tickSize: 0.01 })).toHaveProperty("error");
  });
  it("client order ids: ≤ 36 chars, Binance charset, idempotent per proposal+leg, distinct per environment and leg", () => {
    const a = clientOrderId("prop-x", "live", "E");
    expect(a).toMatch(CLIENT_ID_RE); expect(a.length).toBeLessThanOrEqual(36); expect(clientOrderId("prop-x", "live", "E")).toBe(a);
    expect(new Set([a, clientOrderId("prop-x", "testnet", "E"), clientOrderId("prop-x", "live", "S"), clientOrderId("prop-y", "live", "E")]).size).toBe(4);
  });
  it("every endpoint is in the shared USD-M allowlist (no withdrawal or wallet endpoint)", () => {
    expect(endpointsAllowed()).toBe(true);
    expect(read("src/lib/scalp-execution.ts")).not.toMatch(/withdraw|\/sapi\/|transfer/i);
  });
  it("uncertain submits are settled by lookup only and resubmission is never allowed", () => {
    const id = "otsLE-x";
    const o = (status: string, executedQty: string) => ({ orderId: 1, clientOrderId: id, symbol: "ETHUSDT", side: "BUY", status, executedQty, avgPrice: "1900" });
    expect(settleUncertainSubmit(id, [{ kind: "ERROR", at: 10 }], 0, 5_000)).toMatchObject({ state: "UNKNOWN_LOCKED", resubmitAllowed: false });
    expect(settleUncertainSubmit(id, [{ kind: "NOT_FOUND", at: 1_000 }, { kind: "NOT_FOUND", at: 2_000 }], 0, 5_000).state).toBe("UNKNOWN_LOCKED");
    expect(settleUncertainSubmit(id, [{ kind: "NOT_FOUND", at: 6_000 }, { kind: "NOT_FOUND", at: 7_000 }], 0, 5_000)).toMatchObject({ state: "NOT_FOUND_CONFIRMED", resubmitAllowed: false });
    expect(settleUncertainSubmit(id, [{ kind: "FOUND", order: o("FILLED", "0.5") }], 0, 0)).toMatchObject({ state: "FILLED", filledQty: 0.5 });
    expect(settleUncertainSubmit(id, [{ kind: "FOUND", order: o("CANCELED", "0.2") }], 0, 0).state).toBe("PARTIALLY_FILLED");
    expect(settleUncertainSubmit(id, [{ kind: "FOUND", order: o("NEW", "0") }], 0, 0).state).toBe("OPEN");
    expect(settleUncertainSubmit(id, [{ kind: "FOUND", order: { ...o("FILLED", "1"), clientOrderId: "other" } }], 0, 0).state).toBe("UNKNOWN_LOCKED");
  });
  it("protection verification: missing, wrong-side or mismatched stops and unverifiable state all demand containment", () => {
    const p = prop("live"), plan = buildOrderPlan(p, accept(p), "live", { stepSize: 0.001, tickSize: 0.01 }) as OrderPlan, pos = { symbol: "ETHUSDT", positionAmt: 0.5, entryPrice: 1900 };
    const stop = { symbol: "ETHUSDT", side: "SELL", type: "STOP_MARKET", closePosition: true, triggerPrice: 1890, status: "NEW" };
    expect(verifyProtection(pos, [stop], plan, 0.01)).toEqual({ state: "PROTECTED", action: "NONE" });
    expect(verifyProtection(pos, [], plan, 0.01).state).toBe("MISSING_STOP");
    expect(verifyProtection(pos, [{ ...stop, side: "BUY" }], plan, 0.01).state).toBe("WRONG_SIDE");
    expect(verifyProtection(pos, [{ ...stop, triggerPrice: 1850 }], plan, 0.01).state).toBe("TRIGGER_MISMATCH");
    expect(verifyProtection(pos, null, plan, 0.01)).toEqual({ state: "UNVERIFIABLE", action: "CONTAIN_REDUCE_ONLY" });
    expect(verifyProtection(null, [], plan, 0.01).state).toBe("NO_POSITION");
  });
  it("exchange reconciliation flags position, fill and balance mismatches and unavailable data", () => {
    expect(reconcileExchange({ symbol: "ETHUSDT", qty: 0.5, fillsQty: 0.5, balance: 100 }, { positionAmt: 0.5, fillsQty: 0.5, balance: 100 })).toEqual([]);
    expect(reconcileExchange({ symbol: "ETHUSDT", qty: 0.5, fillsQty: 0.5, balance: 100 }, { positionAmt: 0.4, fillsQty: null, balance: 99 })).toHaveLength(3);
  });
});

describe("isolation (static)", () => {
  const live = ["live-feed.ts", "live-feed-client.ts", "live-monitor.ts", "live-scalp-signal.ts", "live-paper-exec.ts", "live-scalp-risk.ts", "live-scalp-pipeline.ts"].map((f) => join("src/lib", f));
  const imports = (f: string) => [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  it("live market-data, signal, paper and risk modules cannot reach credentials, orders, wallets, exchange adapters, AI or the database", () => {
    for (const f of live) {
      for (const i of imports(f)) expect(i, `${f} → ${i}`).toMatch(/^(\.\/(live-feed|live-feed-client|live-monitor|live-scalp-signal|live-paper-exec|live-scalp-risk|live-scalp-pipeline|central-risk|indicators|scalp-intraday|scalp-microstructure|futures-testnet-limits)|zod)$/);
      expect(read(f)).not.toMatch(/supabase|apiSecret|apiKey|X-MBX-APIKEY|signature=|\/fapi\/v1\/order|ai-prime|createServerFn/);
    }
  });
  it("the execution adapter has no transport: no fetch, adapter, credential decryption or database write", () => {
    for (const f of ["src/lib/scalp-execution.ts", "src/lib/scalp-execution.server.ts", "src/lib/scalp-execution.functions.ts"]) {
      const s = read(f);
      expect(s).not.toMatch(/fetch\(|binance-futures-(live|testnet|core)|crypto\.server|credential-environment|exchange-adapters|supabaseAdmin|client\.server|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    }
  });
  it("no page or component calls the order request function; the Command Center only reads the gate status", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const ui = [...walk("src/routes"), ...walk("src/components")].filter((f) => /\.tsx?$/.test(f));
    expect(ui.filter((f) => /requestScalpLiveOrder|requestScalpOrder/.test(read(f)))).toEqual([]);
    expect(read("src/routes/_authenticated/scalp-center.tsx")).toMatch(/getScalpExecutionGate/);
  });
});
