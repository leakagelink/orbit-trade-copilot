import { beforeEach, describe, expect, it, vi } from "vitest";
import { tradeNet } from "@/lib/trade-accounting";
import { futuresScore } from "@/lib/futures-score";
import { attributeLedger, protectionProblem, remainderQuantity } from "@/lib/futures-execution";

const S = vi.hoisted(() => {
  const state = {
    clock: 1_800_000_000_000, seq: 0, fillSeq: 0, amt: 0, entryPx: 0, mark: 100, hedge: false, multi: false, margin: "CROSSED", lev: 1,
    orders: new Map<string, Record<string, unknown>>(), algos: new Map<string, Record<string, unknown>>(),
    fills: [] as Record<string, unknown>[], funding: [] as Record<string, unknown>[], calls: [] as string[], extraAlgos: [] as Record<string, unknown>[],
    hooks: {} as { order?: (p: Record<string, string | number>) => unknown; algo?: (p: Record<string, string | number>) => unknown; lookupFail?: boolean; symbolConfig?: () => void },
    locks: new Map<string, string>(), db: null as unknown as FakeDb,
  };
  type FakeDb = { tables: Record<string, Record<string, unknown>[]> };
  return state;
});
const tick = () => (S.clock += 1000);
const r10 = (n: number) => Number(n.toFixed(10));
function brokerFill(client: string, side: string, qty: number, reduce: boolean, executed = qty, status?: string) {
  const id = ++S.seq, t = tick();
  const o = { orderId: id, clientOrderId: client, symbol: "BTCUSDT", side, positionSide: "BOTH", status: status ?? (executed === qty ? "FILLED" : "PARTIALLY_FILLED"), executedQty: String(executed), avgPrice: executed ? String(S.mark) : "0", time: t, updateTime: t };
  S.orders.set(client, o);
  if (executed > 0) {
    const before = S.amt, realized = reduce ? (S.mark - S.entryPx) * executed * (before > 0 ? 1 : -1) : 0;
    if (!reduce) S.entryPx = S.mark;
    S.amt = r10(before + (side === "BUY" ? executed : -executed));
    S.fills.push({ id: ++S.fillSeq, orderId: id, qty: String(executed), price: String(S.mark), commission: String(r10(executed * S.mark * 0.0005)), commissionAsset: "USDT", realizedPnl: String(r10(realized)), side, time: t, positionSide: "BOTH" });
  }
  return o;
}
const missing = () => new Error("Binance Futures 400 (-2013): Order does not exist.");
vi.mock("@/lib/binance-futures.server", () => ({
  futuresCall: async (_a: unknown, method: string, path: string, p: Record<string, string | number> = {}) => {
    S.calls.push(`${method} ${path}${p["reduceOnly"] ? " reduce" : ""}`);
    if (path === "/fapi/v3/positionRisk") return [{ symbol: "BTCUSDT", positionAmt: String(S.amt), positionSide: "BOTH", markPrice: String(S.mark), unRealizedProfit: "0" }];
    if (path === "/fapi/v1/openOrders") return [...S.orders.values()].filter((o) => ["NEW", "PARTIALLY_FILLED"].includes(String(o["status"])));
    if (path === "/fapi/v1/openAlgoOrders") return [...[...S.algos.values()].filter((o) => o["algoStatus"] === "NEW"), ...S.extraAlgos].filter((o) => !p["symbol"] || o["symbol"] === p["symbol"]);
    if (path === "/fapi/v1/positionSide/dual" || path === "/fapi/v1/multiAssetsMargin") { S.hedge = false; S.multi = false; return {}; }
    if (path === "/fapi/v1/symbolConfig") { S.hooks.symbolConfig?.(); return [{ symbol: "BTCUSDT", marginType: S.margin, leverage: S.lev }]; }
    if (path === "/fapi/v1/marginType") { S.margin = "ISOLATED"; return {}; }
    if (path === "/fapi/v1/leverage") { S.lev = Number(p["leverage"]); return {}; }
    if (path === "/fapi/v1/algoOrder") {
      if (S.hooks.algo) return S.hooks.algo(p);
      const a = { algoId: ++S.seq, clientAlgoId: p["clientAlgoId"], symbol: p["symbol"], side: p["side"], positionSide: "BOTH", orderType: p["type"], algoStatus: "NEW", triggerPrice: String(p["triggerPrice"]), closePosition: true, reduceOnly: false, quantity: "0", workingType: p["workingType"] };
      S.algos.set(String(p["clientAlgoId"]), a); return a;
    }
    if (path === "/fapi/v1/order" && method === "GET") { const o = [...S.orders.values()].find((x) => x["orderId"] === Number(p["orderId"])); if (!o) throw missing(); return o; }
    if (path === "/fapi/v1/order" && method === "POST") {
      if (S.hooks.order) return S.hooks.order(p);
      return brokerFill(String(p["newClientOrderId"]), String(p["side"]), Number(p["quantity"]), p["reduceOnly"] === "true");
    }
    throw new Error(`unexpected ${method} ${path}`);
  },
  futuresAccountState: async () => ({ availableBalance: "1000", canTrade: true, hedge: S.hedge, multiAssets: S.multi }),
  futuresSymbol: async () => ({ symbol: "BTCUSDT", price: S.mark, step: 0.001, tick: 0.01, minQty: 0.001, minNotional: 5 }),
  futuresPositions: async () => [{ symbol: "BTCUSDT", positionAmt: String(S.amt), positionSide: "BOTH", markPrice: String(S.mark), unRealizedProfit: "0" }],
  futuresOrder: async (_a: unknown, _s: string, client: string) => { if (S.hooks.lookupFail) throw new Error("Binance Futures 503: request unavailable"); const o = S.orders.get(client); if (!o) throw missing(); return { ...o }; },
  futuresAlgo: async (_a: unknown, client: string) => { const o = S.algos.get(client); if (!o) throw missing(); return { ...o }; },
  futuresCancelAlgo: async (_a: unknown, client: string) => { const o = S.algos.get(client); if (o) o["algoStatus"] = "CANCELED"; },
  futuresCancelOrder: async (_a: unknown, _s: string, client: string) => { const o = S.orders.get(client); if (o && ["NEW", "PARTIALLY_FILLED"].includes(String(o["status"]))) { o["status"] = "CANCELED"; o["updateTime"] = tick(); } },
  futuresEvidence: async () => ({ fills: S.fills.map((f) => ({ ...f })), income: S.funding.map((f) => ({ ...f })) }),
}));
vi.mock("@/lib/futures-lease.server", () => ({
  acquireExecution: async (db: { tables: Record<string, Record<string, unknown>[]> }, _u: string, conn: string) => {
    if (S.locks.get(conn)) throw new Error("Futures account has another active writer; wait for recovery");
    const holder = crypto.randomUUID(); S.locks.set(conn, holder);
    const assert = async (entry = false) => { if (S.locks.get(conn) !== holder) throw new Error("Execution fence lost"); if (entry && db.tables["risk_settings"]![0]!["trading_halted"]) throw new Error("Trading halted or risk authority unavailable"); };
    return { holder, fence: 1, assert, position: async (id: string, patch: Record<string, unknown>) => { await assert(); Object.assign(db.tables["positions"]!.find((p) => p["id"] === id)!, patch); }, release: async () => { if (S.locks.get(conn) === holder) S.locks.delete(conn); } };
  },
}));
vi.mock("@/lib/plan.server", () => ({ requireElite: async () => undefined }));
vi.mock("@/lib/crypto.server", () => ({ decryptJson: async () => ({ apiKey: "k", apiSecret: "s" }) }));
vi.mock("@/lib/engine.server", () => ({ accountRiskBlock: async () => (S.db.tables["risk_settings"]![0]!["trading_halted"] ? "trading halted (emergency stop)" : null) }));

const U = "00000000-0000-4000-8000-000000000001", C = "00000000-0000-4000-8000-000000000002";
type Row = Record<string, unknown>;
class Query {
  filters: ((r: Row) => boolean)[] = []; op = "select"; payload: Row = {}; one = false; maybe = false; head = false;
  constructor(private db: FakeDb, private table: string) {}
  select(_c?: string, o?: { head?: boolean }) { if (o?.head) this.head = true; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  like(k: string, v: string) { this.filters.push((r) => String(r[k]).startsWith(v.replace("%", ""))); return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Row) { this.op = "insert"; this.payload = p; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.maybe = true; return this; }
  then<A>(ok: (v: unknown) => A, bad?: (e: unknown) => A) { return Promise.resolve(this.run()).then(ok, bad); }
  run() {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.db.fail.has(`${this.table}.${this.op}`)) return { data: null, error: { message: "injected" } };
    if (this.op === "insert") {
      const r: Row = { created_at: new Date(S.clock + rows.length).toISOString(), ...this.payload };
      if (this.table === "orders" && rows.some((x) => x["idempotency_key"] === r["idempotency_key"] || (r["client_order_id"] && x["client_order_id"] === r["client_order_id"]))) return { data: null, error: { code: "23505", message: "duplicate" } };
      if (this.table === "futures_broker_events" && rows.some((x) => x["connection_id"] === r["connection_id"] && x["event_type"] === r["event_type"] && x["broker_event_id"] === r["broker_event_id"])) return { data: null, error: { code: "23505", message: "duplicate" } };
      if (this.table === "positions") Object.assign(r, { opened_at: new Date().toISOString(), is_open: true });
      rows.push(r); return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
    if (this.head) return { count: hit.length, error: null };
    if (this.one) return hit.length === 1 ? { data: { ...hit[0] }, error: null } : { data: null, error: { message: "not single" } };
    if (this.maybe) return { data: hit[0] ? { ...hit[0] } : null, error: null };
    return { data: hit.map((r) => ({ ...r })), error: null };
  }
}
class FakeDb {
  tables: Record<string, Row[]> = {}; fail = new Set<string>();
  from(t: string) { return new Query(this, t); }
  async rpc(name: string, a: Row) {
    if (name !== "futures_finalize_position" || this.fail.has("rpc.finalize")) return { data: null, error: { message: "injected" } };
    const p = this.tables["positions"]!.find((x) => x["id"] === a["_position"])!, trades = (this.tables["trades"] ??= []);
    const old = trades.find((x) => x["position_id"] === p["id"]); if (old) return { data: old["id"], error: null };
    p["is_open"] = false; if (!a["_trade"]) return { data: null, error: null };
    const t = a["_trade"] as Record<string, number | string>, id = crypto.randomUUID();
    trades.push({ id, position_id: p["id"], execution_environment: p["execution_environment"], realized_pnl: t["gross"], fees: t["fees"], funding_pnl: t["funding"], quantity: t["quantity"], close_reason: t["reason"], net_pnl: Number(t["gross"]) + Number(t["funding"]) - Number(t["fees"]) });
    return { data: id, error: null };
  }
}
let db: FakeDb;
let F: typeof import("@/lib/futures.server");
const ticket = (requestId = crypto.randomUUID()) => ({ connectionId: C, symbol: "BTC/USDT", side: "buy" as const, margin: 10, leverage: 2, slPct: 1, tpPct: 2, holdMin: 5, requestId, confirmation: "TESTNET" as const });
const entrySubmits = () => S.calls.filter((c) => c === "POST /fapi/v1/order").length;
const exitSubmits = () => S.calls.filter((c) => c === "POST /fapi/v1/order reduce").length;
const position = (id: string) => db.tables["positions"]!.find((p) => p["id"] === id)!;
const asPosition = (id: string) => position(id) as unknown as Parameters<typeof F.closeFutures>[1];

beforeEach(async () => {
  Object.assign(S, { clock: 1_800_000_000_000, seq: 0, fillSeq: 0, amt: 0, entryPx: 0, mark: 100, hedge: false, multi: false, margin: "CROSSED", lev: 1, fills: [], funding: [], calls: [], extraAlgos: [], hooks: {} });
  S.orders.clear(); S.algos.clear(); S.locks.clear();
  db = new FakeDb(); S.db = db as never;
  db.tables = {
    exchange_connections: [{ id: C, user_id: U, exchange: "binance", status: "connected", is_testnet: true, account_type: "futures" }],
    connection_credentials: [{ connection_id: C, user_id: U, ciphertext: "x", iv: "y" }],
    futures_settings: [{ user_id: U, connection_id: C, live_enabled: false, max_margin: 10, max_leverage: 2, max_loss: 2, testnet_certified_at: null }],
    risk_settings: [{ user_id: U, max_daily_loss: 2, max_open_exposure: 100, trading_halted: false }], orders: [], positions: [], trades: [], futures_broker_events: [],
  };
  F = await import("@/lib/futures.server");
});
async function protectedEntry() { const t = ticket(); await F.openFutures(db as never, U, t); return t.requestId; }

describe("one Futures accounting contract", () => {
  it("adds positive funding exactly once", () => expect(tradeNet({ realized_pnl: 1, funding_pnl: 0.1, fees: 0.02 })).toBeCloseTo(1.08, 10));
  it("subtracts negative funding exactly once", () => expect(tradeNet({ realized_pnl: 1, funding_pnl: -0.1, fees: 0.02 })).toBeCloseTo(0.88, 10));
  it("scores the same net as risk", () => expect(futuresScore([{ realized_pnl: 1, funding_pnl: 0.1, fees: 0.02, closed_at: "2026-01-01" }]).netPnl).toBeCloseTo(1.08, 10));
  it("treats unverified or nonfinite costs as unavailable", () => expect(tradeNet({ realized_pnl: 1, fees: Number.NaN })).toBeNaN());
  it("stores gross separately from positive funding on a real close", async () => {
    const id = await protectedEntry(); S.funding.push({ tranId: 9, income: "0.05", asset: "USDT", incomeType: "FUNDING_FEE", time: tick(), symbol: "BTCUSDT" }); S.mark = 101;
    await F.closeFutures(db as never, asPosition(id), "manual");
    const t = db.tables["trades"]![0]!; expect(Number(t["realized_pnl"])).toBeCloseTo(0.2, 8); expect(Number(t["funding_pnl"])).toBe(0.05); expect(Number(t["net_pnl"])).toBeCloseTo(0.2299, 8);
  });
  it("stores negative funding separately on a real close", async () => {
    const id = await protectedEntry(); S.funding.push({ tranId: 10, income: "-0.05", asset: "USDT", incomeType: "FUNDING_FEE", time: tick(), symbol: "BTCUSDT" }); S.mark = 101;
    await F.closeFutures(db as never, asPosition(id), "manual");
    expect(Number(db.tables["trades"]![0]!["net_pnl"])).toBeCloseTo(0.1299, 8);
  });
});

describe("Futures failure injection", () => {
  it("contains a partial entry fill and records only the confirmed quantity", async () => {
    S.hooks.order = (p) => { if (p["reduceOnly"]) return brokerFill(String(p["newClientOrderId"]), String(p["side"]), Number(p["quantity"]), true); return brokerFill(String(p["newClientOrderId"]), "BUY", 0.2, false, 0.12); };
    const t = ticket(); await expect(F.openFutures(db as never, U, t)).rejects.toThrow("do not resubmit");
    expect(entrySubmits()).toBe(1); expect(exitSubmits()).toBe(1); expect(S.amt).toBe(0); expect(db.tables["trades"]![0]!["quantity"]).toBeCloseTo(0.12, 10);
  });
  it("uses lookup after an entry timeout and never resubmits", async () => {
    S.hooks.order = (p) => { brokerFill(String(p["newClientOrderId"]), "BUY", 0.2, false); throw new Error("timeout"); };
    const t = ticket(); await F.openFutures(db as never, U, t);
    expect(entrySubmits()).toBe(1); expect((position(t.requestId)["futures_details"] as Row)["protection"]).toBe("confirmed");
  });
  it("keeps unknown entry status locked and blocks later entries", async () => {
    S.hooks.order = () => { throw new Error("timeout"); }; S.hooks.lookupFail = true;
    const first = ticket(); await expect(F.openFutures(db as never, U, first)).rejects.toThrow();
    expect(db.tables["orders"]![0]!["status"]).toBe("pending"); expect((position(first.requestId)["futures_details"] as Row)["protection"]).toBe("unverified");
    S.hooks = {}; await expect(F.openFutures(db as never, U, ticket())).rejects.toThrow("Pending orders");
    expect(entrySubmits()).toBe(1);
  });
  it("immediately contains exposure after a protective-order timeout", async () => {
    S.hooks.algo = () => { throw new Error("timeout"); };
    const t = ticket(); await expect(F.openFutures(db as never, U, t)).rejects.toThrow();
    expect(exitSubmits()).toBe(1); expect(S.amt).toBe(0); expect(db.tables["trades"]![0]!["close_reason"]).toBe("entry_containment");
  });
  it("does not accept acknowledged protection with wrong reduce semantics", async () => {
    S.hooks.algo = (p) => { const a = { algoId: ++S.seq, clientAlgoId: p["clientAlgoId"], symbol: p["symbol"], side: p["side"], positionSide: "BOTH", orderType: p["type"], algoStatus: "NEW", triggerPrice: String(p["triggerPrice"]), closePosition: false, reduceOnly: false, quantity: "0.2", workingType: "MARK_PRICE" }; S.algos.set(String(p["clientAlgoId"]), a); return a; };
    await expect(F.openFutures(db as never, U, ticket())).rejects.toThrow(); expect(S.amt).toBe(0); expect(exitSubmits()).toBe(1);
  });
  it("rejects a duplicate request without a second broker entry", async () => {
    const t = ticket(); const id = await (async () => { await F.openFutures(db as never, U, t); return t.requestId; })();
    await F.closeFutures(db as never, asPosition(id), "manual");
    await expect(F.openFutures(db as never, U, t)).rejects.toThrow("duplicate"); expect(entrySubmits()).toBe(1);
  });
  it("lets only one concurrent exit writer submit", async () => {
    const id = await protectedEntry(); const p = asPosition(id);
    const r = await Promise.allSettled([F.closeFutures(db as never, p, "manual"), F.closeFutures(db as never, p, "manual")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1); expect(exitSubmits()).toBe(1); expect(db.tables["trades"]).toHaveLength(1);
  });
  it("recovers a filled entry after worker restart without resubmitting", async () => {
    const t = ticket(), orderId = crypto.randomUUID(), client = `fv-${orderId.slice(0, 28)}`;
    db.tables["orders"]!.push({ id: orderId, user_id: U, exchange_connection_id: C, status: "pending", client_order_id: client, idempotency_key: `futures:${t.requestId}`, market_type: "usd_m_futures" });
    db.tables["positions"]!.push({ id: t.requestId, user_id: U, exchange_connection_id: C, trading_pair: "BTC/USDT", side: "buy", quantity: 0.2, entry_price: 100, opened_at: new Date().toISOString(), is_open: true, entry_order_id: orderId, market_type: "usd_m_futures", execution_environment: "testnet", max_hold_until: null, futures_details: { entryClient: client, slClient: "fs-x", tpClient: "ft-x", protection: "pending", state: "submit_started" } });
    brokerFill(client, "BUY", 0.2, false);
    expect(await F.checkFutures(db as never, asPosition(t.requestId))).toBe("protection_failure");
    expect(entrySubmits()).toBe(0); expect(exitSubmits()).toBe(1); expect(db.tables["trades"]).toHaveLength(1);
  });
  it("does not close external inventory added after entry", async () => {
    const id = await protectedEntry(); S.amt = 0.5;
    await expect(F.closeFutures(db as never, asPosition(id), "manual")).rejects.toThrow("changed externally"); expect(exitSubmits()).toBe(0);
  });
  it("blocks halted accounts before broker setting mutations", async () => {
    db.tables["risk_settings"]![0]!["trading_halted"] = true;
    await expect(F.openFutures(db as never, U, ticket())).rejects.toThrow("halted"); expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });
  it("stops an entry when the kill switch lands after its intent claim", async () => {
    S.hooks.symbolConfig = () => { db.tables["risk_settings"]![0]!["trading_halted"] = true; };
    const t = ticket(); await expect(F.openFutures(db as never, U, t)).rejects.toThrow();
    expect(S.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0); expect(db.tables["orders"]![0]!["status"]).toBe("cancelled"); expect(position(t.requestId)["is_open"]).toBe(false);
  });
  it("closes an emergency stop through the fenced reduce-only path", async () => {
    const id = await protectedEntry(); await F.closeFutures(db as never, asPosition(id), "emergency_stop");
    expect(S.amt).toBe(0); expect(db.tables["trades"]![0]!["close_reason"]).toBe("emergency_stop");
  });
  it("does not switch account mode while another symbol has an algo order", async () => {
    S.hedge = true; S.extraAlgos.push({ clientAlgoId: "other", symbol: "ETHUSDT", algoStatus: "NEW" });
    await expect(F.openFutures(db as never, U, ticket())).rejects.toThrow("Account mode changes"); expect(S.calls).not.toContain("POST /fapi/v1/positionSide/dual");
  });
  it("retries ledger finalization after a database failure without another exit", async () => {
    const id = await protectedEntry(); db.fail.add("rpc.finalize");
    await expect(F.closeFutures(db as never, asPosition(id), "manual")).rejects.toThrow("ledger"); expect(position(id)["is_open"]).toBe(true);
    db.fail.clear(); expect(await F.checkFutures(db as never, asPosition(id))).toBe("broker_closed");
    expect(exitSubmits()).toBe(1); expect(db.tables["trades"]).toHaveLength(1);
  });
  it("closes only the remainder after a terminal partial exit", async () => {
    const id = await protectedEntry(); let first = true;
    S.hooks.order = (p) => { const r = brokerFill(String(p["newClientOrderId"]), String(p["side"]), Number(p["quantity"]), true, first ? 0.1 : Number(p["quantity"]), first ? "EXPIRED" : undefined); first = false; return r; };
    await expect(F.closeFutures(db as never, asPosition(id), "manual")).rejects.toThrow("Partial exit");
    await F.closeFutures(db as never, asPosition(id), "manual");
    expect(exitSubmits()).toBe(2); expect(db.tables["trades"]![0]!["quantity"]).toBeCloseTo(0.2, 10);
  });
});

describe("pure protection and attribution contracts", () => {
  const expected = { client: "fs", symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", trigger: 99, qty: 1, tick: 0.01 };
  it("accepts only an active matching close-position stop", () => expect(protectionProblem({ algoId: 1, clientAlgoId: "fs", symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH", orderType: "STOP_MARKET", algoStatus: "NEW", triggerPrice: "99", closePosition: true, quantity: "0", workingType: "MARK_PRICE" }, expected)).toBeNull());
  it("rejects wrong side protection", () => expect(protectionProblem({ algoId: 1, clientAlgoId: "fs", symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", orderType: "STOP_MARKET", algoStatus: "NEW", triggerPrice: "99", closePosition: true, workingType: "MARK_PRICE" }, expected)).toContain("identity"));
  it("rejects external fills inside the holding interval", () => expect(() => attributeLedger({ fills: [{ id: 1, orderId: 9, qty: "1", price: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0", side: "BUY", time: 2 }], funding: [], entryOrderId: "1", exitOrderIds: ["2"], symbol: "BTCUSDT", side: "buy", openedAt: 1, closedAt: 3 })).toThrow("External"));
  it("never plans a remainder while an exit is unknown", () => expect(() => remainderQuantity(1, 1, "buy", [{ orderId: 1, clientOrderId: "x", symbol: "BTCUSDT", side: "SELL", status: "NEW", executedQty: "0", avgPrice: "0" }])).toThrow("lookup only"));
});
describe("exit acknowledgement uncertainty", () => {
  it("settles an exit timeout by lookup without a second exit", async () => {
    const id = await protectedEntry();
    S.hooks.order = (p) => { brokerFill(String(p["newClientOrderId"]), String(p["side"]), Number(p["quantity"]), true); throw new Error("timeout"); };
    await F.closeFutures(db as never, asPosition(id), "manual"); expect(exitSubmits()).toBe(1); expect(db.tables["trades"]).toHaveLength(1);
  });
});

describe("production Futures authorization in the execution path", () => {
  const P = "00000000-0000-4000-8000-0000000000a1";
  const prodTicket = () => ({ ...ticket(), connectionId: P, confirmation: "LIVE" as const });
  const pass = (result = "PASS", revision = "futures-exec-2026-11-r1") => ({ id: crypto.randomUUID(), user_id: U, connection_id: P, environment: "production", result, revision, created_at: new Date(S.clock + db.tables["futures_certifications"]!.length).toISOString() });
  beforeEach(() => {
    db.tables["exchange_connections"]!.push({ id: P, user_id: U, exchange: "binance", status: "connected", is_testnet: false, account_type: "both" });
    db.tables["connection_credentials"]!.push({ connection_id: P, user_id: U, ciphertext: "x", iv: "y" });
    // Observed production state: Live ON, bound account, stale legacy timestamp, no certification record.
    Object.assign(db.tables["futures_settings"]![0]!, { connection_id: P, live_enabled: true, testnet_certified_at: "2026-11-11T17:26:58Z" });
    db.tables["futures_certifications"] = [];
  });
  const posts = () => S.calls.filter((c) => c.startsWith("POST"));
  it("rejects a stale timestamp before any broker call or order claim", async () => {
    await expect(F.openFutures(db as never, U, prodTicket())).rejects.toThrow(/Production Futures locked/);
    expect(posts()).toHaveLength(0); expect(db.tables["orders"]).toHaveLength(0);
  });
  it("rejects a latest FAIL that supersedes an earlier PASS", async () => {
    db.tables["futures_certifications"]!.push(pass("PASS")); S.clock += 10; db.tables["futures_certifications"]!.push(pass("FAIL"));
    await expect(F.openFutures(db as never, U, prodTicket())).rejects.toThrow(/Latest certification is FAIL/); expect(posts()).toHaveLength(0);
  });
  it("rejects a PASS from an older revision", async () => {
    db.tables["futures_certifications"]!.push(pass("PASS", "futures-exec-2026-10-r0"));
    await expect(F.openFutures(db as never, U, prodTicket())).rejects.toThrow(/stale/); expect(posts()).toHaveLength(0);
  });
  it("rejects when Live Futures is disabled even with a current PASS", async () => {
    db.tables["futures_certifications"]!.push(pass()); db.tables["futures_settings"]![0]!["live_enabled"] = false;
    await expect(F.openFutures(db as never, U, prodTicket())).rejects.toThrow(/Live Futures is disabled/); expect(posts()).toHaveLength(0);
  });
  it("re-checks immediately before submission: a FAIL recorded mid-preflight sends no entry", async () => {
    db.tables["futures_certifications"]!.push(pass());
    S.hooks.symbolConfig = () => { S.clock += 10; if (!db.tables["futures_certifications"]!.some((c) => c["result"] === "FAIL")) db.tables["futures_certifications"]!.push(pass("FAIL")); };
    await expect(F.openFutures(db as never, U, prodTicket())).rejects.toThrow(/Latest certification is FAIL/);
    expect(entrySubmits()).toBe(0); expect(db.tables["orders"]![0]!["status"]).toBe("cancelled");
  });
  it("an Autopilot guard that fails before submission sends no entry", async () => {
    db.tables["futures_certifications"]!.push(pass()); let n = 0;
    await expect(F.openFutures(db as never, U, prodTicket(), { beforeSubmit: async () => { if (++n === 3) throw new Error("Autopilot switched off"); } })).rejects.toThrow(/switched off/);
    expect(entrySubmits()).toBe(0);
  });
  it("a current PASS on the bound account allows exactly one entry, and the same Autopilot request ID never submits twice", async () => {
    db.tables["futures_certifications"]!.push(pass());
    const { autopilotRequestId } = await import("@/lib/autopilot-fence");
    const t = { ...prodTicket(), requestId: await autopilotRequestId("run-1", "toolu_1") };
    await F.openFutures(db as never, U, t); expect(entrySubmits()).toBe(1);
    await expect(F.openFutures(db as never, U, { ...t })).rejects.toThrow(); expect(entrySubmits()).toBe(1);
  });
  it("Testnet entries need no production certification", async () => {
    await F.openFutures(db as never, U, ticket()); expect(entrySubmits()).toBe(1);
  });
});

describe("Disable Live Futures", () => {
  it("sets only live_enabled=false, confirms it, audits it and needs no certification", async () => {
    Object.assign(db.tables["futures_settings"]![0]!, { live_enabled: true, testnet_certified_at: "2026-11-11T17:26:58Z" });
    const { disableLiveFutures } = await import("@/lib/futures-authorization.server");
    const r = await disableLiveFutures(db as never, U);
    const s = db.tables["futures_settings"]![0]!;
    expect(r).toEqual({ liveEnabled: false, changed: true, audited: true });
    expect(s).toMatchObject({ live_enabled: false, connection_id: C, max_margin: 10, max_leverage: 2, max_loss: 2, testnet_certified_at: "2026-11-11T17:26:58Z" });
    expect(db.tables["trading_safety_events"]).toEqual([expect.objectContaining({ user_id: U, action: "futures.live_disabled" })]);
    expect(db.tables["exchange_connections"]![0]).toMatchObject({ is_testnet: true, status: "connected" });
    expect(S.calls).toHaveLength(0);
  });
  it("reports failure instead of claiming OFF when the update fails", async () => {
    Object.assign(db.tables["futures_settings"]![0]!, { live_enabled: true });
    db.fail.add("futures_settings.update");
    const { disableLiveFutures } = await import("@/lib/futures-authorization.server");
    await expect(disableLiveFutures(db as never, U)).rejects.toThrow(/could not be disabled/);
  });
});
