// Phase 4D — Central Risk SHADOW safety remediation: stale data is INSUFFICIENT_DATA (never REJECT), every record
// (normal and last-resort) is deeply immutable, records carry bounded error codes instead of raw exception text
// (adversarial synthetic secrets), and the pure pre-/post-claim order snapshot classifier. Fake ports only; the shadow
// evaluator stays disconnected from every order path (import-graph tests in central-risk-shadow.test.ts unchanged).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildShadowRecord, classifyOrderSnapshot, safeText, type ShadowRecord, type ShadowTicket } from "@/lib/central-risk-shadow";
import { lastResortShadowRecord, runShadowEvaluation } from "@/lib/central-risk-shadow.server";
import { selectOnly, type RiskReadPorts } from "@/lib/central-risk-context.server";
import type { RiskDecision } from "@/lib/central-risk";

const NOW = Date.UTC(2026, 10, 13, 6, 0);
const USER = "00000000-0000-4000-8000-000000000001";
const LIVE = { connectionId: "11111111-1111-4111-8111-111111111111", testnet: false };
type Tables = Record<string, { data?: unknown; error?: unknown; count?: number }>;
function fakeDb(tables: Tables, throwOn?: string) {
  return {
    from(t: string) {
      if (t === throwOn) throw new Error(SECRETS.join(" | "));
      const res = tables[t] ?? { data: null, error: null, count: 0 };
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "in", "gte"]) chain[m] = () => chain;
      chain["maybeSingle"] = () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
      chain["then"] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null, count: res.count ?? null }).then(ok, bad);
      return { select: () => chain };
    },
  };
}
const GOOD: Tables = {
  risk_settings: { data: { max_daily_loss: 50, max_open_exposure: 2000, max_total_positions: 3, trading_halted: false } },
  futures_settings: { data: { max_leverage: 10, max_loss: 10, max_margin: 100 } },
  strategy_risk_budgets: { data: { max_loss: 30 } },
  positions: { data: [] }, orders: { count: 0 }, trades: { data: [] },
};
const ports = (tables: Tables = GOOD, o: Partial<RiskReadPorts> = {}, throwOn?: string): RiskReadPorts => ({
  db: selectOnly(fakeDb(tables, throwOn) as never), now: () => NOW,
  markPrice: async () => ({ markPrice: 100_000, time: NOW - 500 }),
  symbolRules: async () => ({ stepSize: 0.001, minNotional: 100, maintenanceMarginRate: 0.004 }),
  availableMargin: async () => 500, strategyUsedLoss: async () => 4, ...o,
});
const ticket = (x: Partial<ShadowTicket> = {}): ShadowTicket => ({ connectionId: LIVE.connectionId, symbol: "BTC/USDT", side: "buy", margin: 20, leverage: 5, slPct: 1, tpPct: 2, requestId: "33333333-3333-4333-8333-333333333333", confirmation: "LIVE", ...x });
const run = (p: RiskReadPorts, t = ticket()) => runShadowEvaluation({ ports: p, userId: USER, account: LIVE, ticket: t, proposalCreatedAt: NOW - 1000 });

// Synthetic secret values only — nothing real.
const SECRETS = [
  "SYNTH_API_KEY_a1b2c3d4e5f6", "SYNTH_API_SECRET_q9w8e7r6", "Authorization: Bearer SYNTH.eyJhbGciOi.jwt", "X-MBX-APIKEY: SYNTHMBXKEY",
  "postgresql://svc:SYNTHpw@db.synthetic.example:5432/postgres", "enc:v1:SYNTHCIPHERTEXT==", "exchange-account-SYNTH-778899", "signature=SYNTHSIG0123",
];
const leaks = (r: unknown) => SECRETS.flatMap((s) => s.match(/SYNTH[A-Za-z0-9_.=-]*/g) ?? []).filter((frag) => JSON.stringify(r).includes(frag));

afterEach(() => { vi.restoreAllMocks(); });

describe("Issue 1 — stale market data is INSUFFICIENT_DATA, never REJECT", () => {
  it("stale mark: no proposal is formed from it, nothing failed, timestamp recorded", async () => {
    const r = await run(ports(GOOD, { markPrice: async () => ({ markPrice: 100_000, time: NOW - 60_000 }) }));
    expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.failedChecks).toEqual([]);
    expect(r.missingInputs).toContain("market_data"); expect(r.proposalId).toBeNull(); expect(r.marketDataTimestamp).toBe(NOW - 60_000);
    expect(r.sizing).toBeNull();
  });
  it("future-dated mark is also unavailable; a fresh mark still evaluates normally", async () => {
    expect((await run(ports(GOOD, { markPrice: async () => ({ markPrice: 100_000, time: NOW + 60_000 }) }))).verdict).toBe("INSUFFICIENT_DATA");
    expect((await run(ports())).verdict).toBe("ACCEPT");
  });
  it("invalid ticket structure and a verified limit violation remain REJECT", async () => {
    expect((await run(ports(), ticket({ confirmation: "TESTNET" }))).verdict).toBe("REJECT");
    const halted = await run(ports({ ...GOOD, risk_settings: { data: { ...(GOOD["risk_settings"]!.data as object), trading_halted: true } } }));
    expect(halted.verdict).toBe("REJECT"); expect(halted.failedChecks.map((c) => c.id)).toEqual(["emergency_stop"]);
  });
  it("defensive layer: a decision whose only failure is market_data is recorded as INSUFFICIENT_DATA", async () => {
    const decision: RiskDecision = { version: "central-risk-v1", proposalId: "p", verdict: "REJECT", checks: [{ id: "market_data", status: "fail", detail: "Price age 9000 ms (max 5000 ms)" }], sizing: null, executionAuthorized: false, note: "x" };
    const r = await buildShadowRecord({ ticket: ticket(), account: LIVE, strategyId: "manual-futures", proposalCreatedAt: NOW, startedAt: NOW, finishedAt: NOW, proposal: null, decision, context: null, reads: [], adaptProblem: null, internalError: null });
    expect(r.verdict).toBe("INSUFFICIENT_DATA"); expect(r.checks[0]!.status).toBe("missing");
  });
});

function expectDeepFrozen(o: unknown, path = "record") {
  if (!o || typeof o !== "object") return;
  expect(Object.isFrozen(o), path).toBe(true);
  for (const [k, v] of Object.entries(o)) expectDeepFrozen(v, `${path}.${k}`);
}
describe("Issue 2 — every record is deeply immutable", () => {
  it("normal ACCEPT record: nested checks, reads, sizing and comparison are frozen; mutation throws and changes nothing", async () => {
    const r = await run(ports());
    expectDeepFrozen(r);
    const before = JSON.stringify(r);
    expect(() => { (r.checks[0] as { status: string }).status = "pass"; }).toThrow();
    expect(() => { (r.reads as unknown as unknown[]).push({}); }).toThrow();
    expect(() => { (r.sizing as { qty: number }).qty = 1e9; }).toThrow();
    expect(() => { (r.ticketComparison as { withinEngineSize: boolean }).withinEngineSize = true; }).toThrow();
    expect(() => { (r as { executionAuthorized: boolean }).executionAuthorized = true as never; }).toThrow();
    expect(JSON.stringify(r)).toBe(before);
  });
  it("last-resort fallback is deeply frozen, non-authorizing, carries only a code and survives a hostile ticket", () => {
    const hostile = new Proxy(ticket(), { get(t, k) { if (k === "margin" || k === "symbol") throw new Error(SECRETS[0]); return Reflect.get(t, k); } });
    const r = lastResortShadowRecord({ ports: ports(), userId: USER, account: LIVE, ticket: hostile }, "manual-futures", NOW, NOW);
    expect(r.internalError).toBe("SHADOW_RECORD_BUILD_FAILED"); expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.executionAuthorized).toBe(false); expect(r.affectsOrderPath).toBe(false); expect(r.symbol).toBe("unknown");
    expectDeepFrozen(r);
    const before = JSON.stringify(r);
    expect(() => { (r.checks[0] as { status: string }).status = "pass"; }).toThrow();
    expect(() => { (r.ticketComparison as { ticketLeverage: number }).ticketLeverage = 99; }).toThrow();
    expect(() => { (r.missingInputs as string[]).push("x"); }).toThrow();
    expect(JSON.stringify(r)).toBe(before); expect(leaks(r)).toEqual([]);
  });
  it("hashing failure mid-evaluation yields a coded, frozen INSUFFICIENT_DATA record without exception text", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error(SECRETS.join(" ")));
    const r = await run(ports());
    expect(r.internalError).toBe("SHADOW_EVALUATION_FAILED"); expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expectDeepFrozen(r); expect(leaks(r)).toEqual([]);
  });
});

describe("Issue 3 — safe error codes; adversarial synthetic secrets never reach a record or a log", () => {
  const cases: [string, () => RiskReadPorts][] = [
    ["mark read throws a secret-laden error", () => ports(GOOD, { markPrice: async () => { throw new Error(SECRETS.join(" ")); } })],
    ["symbol rules + margin throw", () => ports(GOOD, { symbolRules: async () => { throw new Error(SECRETS[1]!); }, availableMargin: async () => { throw new Error(SECRETS[4]!); } })],
    ["database from() throws", () => ports(GOOD, {}, "risk_settings")],
    ["database returns error objects with secrets", () => ports(Object.fromEntries(Object.keys(GOOD).map((k) => [k, { error: { message: SECRETS.join(" "), details: SECRETS[4], hint: SECRETS[2] } }])))],
    ["clock throws", () => ({ ...ports(), now: () => { throw new Error(SECRETS[3]!); } })],
    ["strategy attribution throws", () => ports(GOOD, { strategyUsedLoss: async () => { throw new Error(SECRETS[6]!); } })],
  ];
  for (const [name, mk] of cases) {
    it(name, async () => {
      const logged: string[] = [];
      for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
      const r = await run(mk());
      expect(r.verdict).not.toBe("ACCEPT"); expect(r.executionAuthorized).toBe(false);
      expect(r.internalError === null || ["SHADOW_EVALUATION_FAILED", "SHADOW_RECORD_BUILD_FAILED"].includes(r.internalError)).toBe(true);
      expect(leaks(r)).toEqual([]); expect(leaks(logged)).toEqual([]);
    });
  }
  it("safeText refuses secret-like or unexpected text and keeps the engine's own phrases", () => {
    // Account identifiers are kept out structurally (no record field carries one); the filter targets credential shapes.
    for (const s of SECRETS.filter((x) => !x.startsWith("exchange-account"))) expect(safeText(s)).toBe("redacted");
    expect(safeText("read failed (table may not exist yet)")).toBe("read failed (table may not exist yet)");
    expect(safeText(42)).toBe("redacted"); expect(safeText("x".repeat(500))).toBe("redacted");
  });
});

describe("Issue 4 — pre-claim vs post-claim snapshot classification (pure; not connected)", () => {
  const own = "futures:33333333-3333-4333-8333-333333333333";
  it("pre-claim: any own-key order is a duplicate; otherwise clean with unrelated unresolved orders counted", () => {
    expect(classifyOrderSnapshot("pre_claim", own, [])).toMatchObject({ outcome: "CLEAN", sameProposalSeen: false, unresolvedOrders: 0 });
    expect(classifyOrderSnapshot("pre_claim", own, [{ idempotencyKey: own, status: "filled" }])).toMatchObject({ outcome: "DUPLICATE", sameProposalSeen: true });
    expect(classifyOrderSnapshot("pre_claim", own, [{ idempotencyKey: "futures:other", status: "pending" }])).toMatchObject({ outcome: "CLEAN", unresolvedOrders: 1 });
  });
  it("post-claim: exactly one own-key order is recognised by its key, not by exclusion; unrelated orders are never suppressed", () => {
    const r = classifyOrderSnapshot("post_claim", own, [{ idempotencyKey: own, status: "pending" }, { idempotencyKey: "futures:other", status: "open" }, { idempotencyKey: null, status: "partially_filled" }]);
    expect(r).toMatchObject({ outcome: "CLEAN", ownOrders: 1, sameProposalSeen: false, unresolvedOrders: 2 });
    expect(classifyOrderSnapshot("post_claim", own, [{ idempotencyKey: own, status: "pending" }, { idempotencyKey: own, status: "pending" }])).toMatchObject({ outcome: "DUPLICATE", sameProposalSeen: true, unresolvedOrders: 2 }); // ambiguous own rows all count (fail closed)
  });
  it("post-claim without the claimed order, or with no snapshot, is INCONSISTENT and unknown (fail closed)", () => {
    expect(classifyOrderSnapshot("post_claim", own, [{ idempotencyKey: "futures:other", status: "pending" }])).toMatchObject({ outcome: "INCONSISTENT", sameProposalSeen: null, unresolvedOrders: null });
    expect(classifyOrderSnapshot("post_claim", own, null)).toMatchObject({ outcome: "INCONSISTENT", sameProposalSeen: null });
    expect(classifyOrderSnapshot("pre_claim", "", [])).toMatchObject({ outcome: "INCONSISTENT" });
  });
});

describe("isolation flags stay fixed", () => {
  it("every verdict keeps executionAuthorized:false and affectsOrderPath:false", async () => {
    const rs: ShadowRecord[] = [await run(ports()), await run(ports(GOOD, { markPrice: async () => null })), await run(ports(), ticket({ confirmation: "TESTNET" }))];
    for (const r of rs) { expect(r.executionAuthorized).toBe(false); expect(r.affectsOrderPath).toBe(false); expect(r.shadowOnly).toBe(true); }
  });
});
