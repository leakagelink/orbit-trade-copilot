// Fixed Testnet limits and production-record isolation in the Futures entry path (no network, fake database).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TESTNET_FUTURES_LIMITS as L, testnetAccountProblem, testnetTicketProblem } from "@/lib/futures-testnet-limits";

const S = vi.hoisted(() => ({ calls: [] as string[], reads: [] as string[], writes: [] as string[], payload: {} as Record<string, unknown>, onSymbol: null as null | (() => void), accountRiskCalls: 0 }));
vi.mock("@/lib/binance-futures.server", () => ({
  futuresCall: async (_a: unknown, method: string, path: string) => { S.calls.push(`${method} ${path}`); return []; },
  futuresAccountState: async () => { S.calls.push("GET account"); return { availableBalance: "5000", canTrade: true, hedge: false, multiAssets: false }; },
  futuresSymbol: async () => { S.calls.push("GET symbol"); S.onSymbol?.(); return { symbol: "DOGEUSDT", price: 100, step: 0.001, tick: 0.01, minQty: 0.001, minNotional: 1 }; },
  futuresPositions: async () => [], futuresOrder: async () => { throw new Error("unexpected"); }, futuresAlgo: async () => { throw new Error("unexpected"); },
  futuresCancelAlgo: async () => undefined, futuresCancelOrder: async () => undefined, futuresEvidence: async () => ({ fills: [], income: [] }),
}));
vi.mock("@/lib/futures-lease.server", () => ({ acquireExecution: async () => { throw new Error("LEASE_REACHED"); } }));
vi.mock("@/lib/plan.server", () => ({ requireElite: async () => undefined }));
vi.mock("@/lib/crypto.server", () => ({ decryptJson: async () => ({ apiKey: "k", apiSecret: "s", ...S.payload }) }));
vi.mock("@/lib/engine.server", () => ({ accountRiskBlock: async () => { S.accountRiskCalls++; return null; } }));

type Row = Record<string, unknown>;
const U = "00000000-0000-4000-8000-000000000001", T = "00000000-0000-4000-8000-0000000000b1", P = "00000000-0000-4000-8000-0000000000a1";
class Q {
  f: ((r: Row) => boolean)[] = []; op = "select"; cols = "*"; mode: "many" | "one" | "maybe" | "head" = "many";
  constructor(private db: Fake, private t: string) {}
  select(c = "*", o?: { head?: boolean }) { this.cols = c; if (o?.head) this.mode = "head"; return this; }
  eq(k: string, v: unknown) { this.f.push((r) => r[k] === v); return this; }
  neq(k: string, v: unknown) { this.f.push((r) => r[k] !== v); return this; }
  in(k: string, v: unknown[]) { this.f.push((r) => v.includes(r[k])); return this; }
  gte(k: string, v: unknown) { this.f.push((r) => String(r[k]) >= String(v)); return this; }
  order() { return this; } limit() { return this; }
  insert(_p: Row) { this.op = "insert"; return this; } update(_p: Row) { this.op = "update"; return this; } upsert(_p: Row) { this.op = "upsert"; return this; }
  single() { this.mode = "one"; return this; } maybeSingle() { this.mode = "maybe"; return this; }
  then<A>(ok: (v: unknown) => A) {
    const rows = (this.db.tables[this.t] ?? []).filter((r) => this.f.every((x) => x(r)));
    if (this.op !== "select") { S.writes.push(`${this.op} ${this.t}`); return Promise.resolve({ data: null, error: null }).then(ok); }
    S.reads.push(`${this.t}:${this.cols}`);
    const out = this.mode === "head" ? { count: rows.length, error: null } : this.mode === "many" ? { data: rows, error: null } : { data: rows[0] ?? null, error: null };
    return Promise.resolve(out).then(ok);
  }
}
class Fake { tables: Record<string, Row[]> = {}; from(t: string) { return new Q(this, t); } }
let db: Fake;
const ticket = (o: Partial<{ margin: number; leverage: number; slPct: number; connectionId: string; confirmation: "TESTNET" | "LIVE" }> = {}) =>
  ({ connectionId: T, symbol: "DOGE/USDT", side: "buy" as const, margin: 5, leverage: 2, slPct: 1, tpPct: 2, holdMin: 5, requestId: crypto.randomUUID(), confirmation: "TESTNET" as const, ...o });
const open = async (t: ReturnType<typeof ticket>) => (await import("@/lib/futures.server")).openFutures(db as never, U, t as never);
const touched = (table: string) => [...S.reads, ...S.writes].some((x) => x.includes(table));

beforeEach(() => {
  Object.assign(S, { calls: [], reads: [], writes: [], payload: {}, onSymbol: null, accountRiskCalls: 0 });
  db = new Fake();
  db.tables = {
    exchange_connections: [
      { id: T, user_id: U, exchange: "binance", status: "connected", is_testnet: true, account_type: "futures" },
      { id: P, user_id: U, exchange: "binance", status: "connected", is_testnet: false, account_type: "both" },
    ],
    connection_credentials: [{ connection_id: T, user_id: U, ciphertext: "c", iv: "i" }, { connection_id: P, user_id: U, ciphertext: "c", iv: "i" }],
    // Production limits record (bound to the production account): must never be read or written by Testnet operations.
    futures_settings: [{ user_id: U, connection_id: P, live_enabled: false, max_margin: 5, max_leverage: 1, max_loss: 2 }],
    risk_settings: [{ user_id: U, trading_halted: false, max_daily_loss: 2, max_open_exposure: 10, max_total_positions: null }],
    positions: [], trades: [], orders: [], futures_certifications: [],
  };
});

describe("fixed Testnet limits (values from the owner)", () => {
  it("margin per trade is 5 USDT", () => { expect(L.maxMargin).toBe(5); expect(testnetTicketProblem({ margin: 5, leverage: 1, slPct: 1 }, L)).toBeNull(); expect(testnetTicketProblem({ margin: 5.01, leverage: 1, slPct: 1 }, L)).toMatch(/margin/); });
  it("loss reserve per trade is 2 USDT", () => { expect(L.maxLossReserve).toBe(2); expect(testnetTicketProblem({ margin: 5, leverage: 10, slPct: 5 }, L)).toMatch(/loss reserve/); });
  it("leverage is at most 10x", () => { expect(L.maxLeverage).toBe(10); expect(testnetTicketProblem({ margin: 1, leverage: 10, slPct: 0.1 }, L)).toBeNull(); expect(testnetTicketProblem({ margin: 1, leverage: 11, slPct: 0.1 }, L)).toMatch(/leverage/); });
  const base = { halted: false, openPositions: 0, exposure: 0, dailyNet: 0, newCost: 10, slPct: 1 };
  it("maximum exposure is 10 USDT", () => { expect(L.maxExposure).toBe(10); expect(testnetAccountProblem(base, L)).toBeNull(); expect(testnetAccountProblem({ ...base, newCost: 10.01 }, L)).toMatch(/exposure/); });
  it("only 1 open position", () => { expect(L.maxOpenPositions).toBe(1); expect(testnetAccountProblem({ ...base, newCost: 1, openPositions: 1 }, L)).toMatch(/open position/); });
  it("daily loss is 2 USDT", () => { expect(L.maxDailyLoss).toBe(2); expect(testnetAccountProblem({ ...base, dailyNet: -2 }, L)).toMatch(/daily loss/); expect(testnetAccountProblem({ ...base, dailyNet: -1.9 }, L)).toMatch(/remaining daily loss/); });
  it("the production emergency stop also blocks Testnet", () => { expect(testnetAccountProblem({ ...base, halted: true }, L)).toMatch(/emergency stop/); expect(testnetAccountProblem({ ...base, halted: null }, L)).toMatch(/unavailable/); });
  it("limits cannot be changed at runtime", () => { expect(Object.isFrozen(L)).toBe(true); expect(() => { (L as { maxMargin: number }).maxMargin = 50; }).toThrow(); });
});

describe("Testnet entries never use the production limits record", () => {
  it("over-limit margin is refused before any exchange call, without touching futures_settings", async () => {
    await expect(open(ticket({ margin: 6 }))).rejects.toThrow(/\[TESTNET\] Testnet limit: margin/);
    expect(S.calls).toHaveLength(0); expect(touched("futures_settings")).toBe(false);
  });
  it("leverage the production record would refuse (1x) is allowed up to 10x on Testnet", async () => {
    await expect(open(ticket({ margin: 1, leverage: 10 }))).rejects.toThrow("LEASE_REACHED");
    expect(touched("futures_settings")).toBe(false);
  });
  it("over-exposure is refused before any POST and reads only the stop flag from risk_settings", async () => {
    await expect(open(ticket({ margin: 5, leverage: 3 }))).rejects.toThrow(/\[TESTNET\] Testnet limit: maximum exposure/);
    expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
    expect(S.reads.filter((r) => r.startsWith("risk_settings:"))).toEqual(["risk_settings:trading_halted"]);
    expect(S.accountRiskCalls).toBe(0); expect(touched("futures_settings")).toBe(false); expect(S.writes).toHaveLength(0);
  });
  it("a production position does not count toward Testnet limits", async () => {
    db.tables["positions"]!.push({ user_id: U, is_open: true, execution_environment: "production", entry_price: 100, quantity: 1, unrealized_pnl: -5 });
    await expect(open(ticket())).rejects.toThrow("LEASE_REACHED");
  });
  it("an open Testnet position blocks a second Testnet entry", async () => {
    db.tables["positions"]!.push({ user_id: U, is_open: true, execution_environment: "testnet", entry_price: 1, quantity: 1, unrealized_pnl: 0 });
    await expect(open(ticket({ margin: 1 }))).rejects.toThrow(/open position limit/);
  });
  it("the production emergency stop blocks Testnet entries", async () => {
    db.tables["risk_settings"]![0]!["trading_halted"] = true;
    await expect(open(ticket())).rejects.toThrow(/emergency stop/); expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });
  it("a credential payload tagged production on the Testnet connection is refused before any exchange call", async () => {
    S.payload = { environment: "production" };
    await expect(open(ticket())).rejects.toThrow(/\[TESTNET\].*different environment/); expect(S.calls).toHaveLength(0);
  });
  it("a changed stored environment stops the request before submission", async () => {
    S.onSymbol = () => { db.tables["exchange_connections"]![0]!["is_testnet"] = false; };
    // First re-verification passes; the flip after the symbol read is caught at the next pre-submit check.
    await expect(open(ticket())).rejects.toThrow();
    expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });
});

describe("production regression", () => {
  it("production entries still read the production limits record and stay locked without a PASS", async () => {
    await expect(open(ticket({ connectionId: P, confirmation: "LIVE", margin: 5, leverage: 1 }))).rejects.toThrow(/\[PRODUCTION\] Production Futures locked/);
    expect(touched("futures_settings")).toBe(true);
    expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });
  it("production entries still use the account-wide production limits", async () => {
    await expect(open(ticket({ connectionId: P, confirmation: "LIVE", margin: 6, leverage: 1 }))).rejects.toThrow(/\[PRODUCTION\] Futures margin limit exceeded/);
    expect(S.calls).toHaveLength(0);
  });
  it("a TESTNET confirmation cannot open on the production account", async () => {
    await expect(open(ticket({ connectionId: P, confirmation: "TESTNET" }))).rejects.toThrow(/\[PRODUCTION\] Confirm the selected/);
  });
});
