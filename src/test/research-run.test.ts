// Research run orchestration with a fake database and fake AI: no network, no real database.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { executeResearchRun, RESEARCH_WRITE_TABLES, type AnalystCallResult } from "@/lib/research-run.server";
import { researchSnapshot } from "@/lib/research";
import { riskPreview } from "@/lib/research-risk-preview";
import type { ResearchAgent } from "@/lib/research-pipeline";

const U = "00000000-0000-4000-8000-000000000001", RUN = "00000000-0000-4000-8000-0000000000aa";
type Op = { table: string; op: string; row?: unknown };
interface Opts { budgetRow?: Record<string, unknown> | null; ledgerMissing?: boolean; usageError?: boolean; halted?: boolean }
function fakeDb(o: Opts = {}) {
  const ops: Op[] = []; const rpc: string[] = [];
  const result = (table: string, op: string): unknown => {
    if (op === "insert") return { error: table === "ai_decision_records" && o.ledgerMissing ? { code: "PGRST205", message: "Could not find the table" } : null };
    if (op === "update") return { error: null };
    if (table === "ai_research_budget_config") return o.budgetRow === undefined ? { data: null, error: { code: "PGRST205", message: "Could not find the table" } } : { data: o.budgetRow, error: null };
    if (table === "ai_research_usage") return o.usageError ? { data: null, error: { message: "down" } } : { data: [], error: null };
    if (table === "risk_settings") return { data: { max_open_exposure: 10, max_daily_loss: 2, max_total_positions: null, trading_halted: !!o.halted }, error: null };
    return { data: [], error: null };
  };
  const builder = (table: string, op: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "gte", "order", "range", "in", "neq", "select"]) b[m] = () => b;
    b["maybeSingle"] = () => Promise.resolve(result(table, op));
    b["single"] = () => Promise.resolve(result(table, op));
    b["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result(table, op)).then(res, rej);
    return b;
  };
  const db = {
    from(table: string) {
      return {
        select: () => { ops.push({ table, op: "select" }); return builder(table, "select"); },
        insert: (row: unknown) => { ops.push({ table, op: "insert", row }); return builder(table, "insert"); },
        update: (row: unknown) => { ops.push({ table, op: "update", row }); return builder(table, "update"); },
        upsert: (row: unknown) => { ops.push({ table, op: "upsert", row }); return builder(table, "upsert"); },
        delete: () => { ops.push({ table, op: "delete" }); return builder(table, "delete"); },
      };
    },
    rpc: (fn: string) => { rpc.push(fn); return Promise.resolve({ data: null, error: null }); },
  };
  return { db: db as never, ops, rpc };
}
const now = Date.parse("2026-11-12T10:00:00Z");
const candles = Array.from({ length: 100 }, (_, i) => ({ t: Date.parse("2026-08-04T00:00:00Z") + i * 86_400_000, o: 100 + i, h: 103 + i, l: 98 + i, c: 101 + i, v: 1000 }));
type Fact = { metric: string; date: string; value: number; currency: string };
type Article = { uuid: string; title: string; publisher: string; link: string; providerPublishTime: number; relatedTickers: string[] };
const data = (over: Partial<{ facts: Fact[]; articles: Article[] }> = {}) => ({
  snapshot: researchSnapshot(candles, now),
  fundamentals: { facts: over.facts ?? [{ metric: "annualTotalRevenue", date: "2025-12-31", value: 1, currency: "USD" }], limitation: "Annual statements only" },
  news: { provider: "Yahoo Finance search", fetchedAt: "2026-11-12T09:59:00Z", articles: over.articles ?? [{ uuid: "a", title: "t", publisher: "p", link: "https://example.com", providerPublishTime: 1_762_900_000, relatedTickers: [] }], limitation: "Headlines only" },
  sentiment: { provider: "Social sentiment", available: false, limitation: "Authorized social-data access is not connected." },
});
// The AI tries to dictate execution values in its text; none of it may reach sizing.
const aiReport = (agent: string) => ({ summary: `${agent}: BUY NOW entry 999, quantity 50, leverage 100x, stop 1, target 5000`, outlook: "bullish" as const, observations: [`${agent} argument`], risks: ["counterpoint"], limitations: [] });
function analyst(fail: ResearchAgent[] = []) {
  const calls: ResearchAgent[] = [];
  const fn = vi.fn(async (agent: ResearchAgent): Promise<AnalystCallResult> => {
    calls.push(agent);
    if (fail.includes(agent)) throw new Error("provider error");
    return { report: aiReport(agent), inputTokens: 1000, outputTokens: 200, reported: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, providerMessageId: `msg_${agent}`, stopReason: "tool_use" } };
  });
  return { fn, calls };
}
const recordOf = (ops: Op[]) => (ops.find((o) => o.table === "ai_decision_records" && o.op === "insert")?.row as { record: Record<string, any>; outcome: string } | undefined);

describe("research run audit record", () => {
  it("a complete run records all 12 agents, arguments, conclusions, provider metadata and usage", async () => {
    const { db, ops } = fakeDb(); const a = analyst();
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(out.outcome).toBe("complete");
    expect(a.calls).toHaveLength(11); // sentiment source is missing, so no call
    const r = recordOf(ops)!.record;
    expect(r["agents"]).toHaveLength(12);
    expect(r["agents"].find((x: { agent: string }) => x.agent === "sentiment").status).toBe("unavailable");
    expect(r["arguments"].bull.arguments).toEqual(["bull argument"]);
    expect(r["arguments"].bear.arguments).toEqual(["bear argument"]);
    expect(r["conclusions"].researchManager.status).toBe("completed");
    expect(r["conclusions"].portfolioManager.status).toBe("completed");
    expect(r["execution"].model).toBeTruthy();
    expect(r["execution"].promptVersion).toBe("research-prompts-v12");
    expect(r["execution"].calls).toHaveLength(11);
    expect(r["execution"].totals.inputTokens).toBe(11_000);
    expect(r["execution"].totals.costUsd).toBeNull();
    expect(r["execution"].totals.costNote).toMatch(/not reported/);
    expect(r["marketData"].snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r["transparency"].unavailable.map((u: { source: string }) => u.source)).toEqual(["Social sentiment"]);
    expect(r["executionAllowed"]).toBe(false);
  });
  it("the risk preview ignores AI text and equals an independent calculation", async () => {
    const { db, ops } = fakeDb(); const a = analyst();
    await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    const p = recordOf(ops)!.record["riskEvaluation"].preview;
    const snap = researchSnapshot(candles, now);
    const independent = riskPreview({ referencePrice: snap.close, asOf: snap.asOf, candles: snap.candles, limits: { maxOpenExposure: 10, maxDailyLoss: 2, maxTotalPositions: null, halted: false }, account: { openExposure: 0, openPositions: 0, dailyNet: 0 } });
    expect(p).toEqual(independent);
    expect(p.quantity).not.toBe(50);
    expect(p.leverage).toBe("1x (spot research estimate)");
  });
  it("a failed agent is recorded once, without a retry, and the run is partial", async () => {
    const { db, ops } = fakeDb(); const a = analyst(["trader"]);
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(out.outcome).toBe("partial");
    expect(a.calls.filter((x) => x === "trader")).toHaveLength(1);
    expect(a.calls).not.toContain("portfolio");
    expect(ops.some((o) => o.table === "ai_research_stage_metrics" && (o.row as { status: string }).status === "failed")).toBe(true);
    const r = recordOf(ops)!.record;
    expect(r["agents"].find((x: { agent: string }) => x.agent === "trader").status).toBe("failed");
    expect(r["agents"].find((x: { agent: string }) => x.agent === "portfolio").status).toBe("unavailable");
    expect(ops.find((o) => o.table === "ai_research_runs" && (o.row as { status?: string }).status)?.row).toMatchObject({ status: "partial" });
  });
  it("a data failure still writes a failed record with every agent not_run", async () => {
    const { db, ops } = fakeDb(); const a = analyst();
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => { throw new Error("Yahoo down"); }, runAnalyst: a.fn, now: () => now });
    expect(out.outcome).toBe("failed");
    expect(a.calls).toHaveLength(0);
    const r = recordOf(ops)!.record;
    expect(r["agents"].every((x: { status: string }) => x.status === "not_run")).toBe(true);
    expect(r["marketData"].snapshot).toBeNull();
    expect(ops.find((o) => o.table === "ai_research_runs" && (o.row as { status?: string }).status)?.row).toMatchObject({ status: "failed" });
  });
  it("missing sources stay unavailable and are never sent to the AI", async () => {
    const { db, ops } = fakeDb(); const a = analyst();
    await executeResearchRun(db, U, RUN, "BTC-USD", { loadResearchData: async () => data({ facts: [], articles: [] }), runAnalyst: a.fn, now: () => now });
    expect(a.calls).not.toContain("fundamentals"); expect(a.calls).not.toContain("news"); expect(a.calls).not.toContain("sentiment");
    const r = recordOf(ops)!.record;
    expect(r["transparency"].unavailable.map((u: { source: string }) => u.source)).toEqual(["Financial statements", "News headlines", "Social sentiment"]);
  });
});

describe("spending limits stop further calls", () => {
  it("stops after the per-run limit and records the reason", async () => {
    const { db, ops } = fakeDb({ budgetRow: { per_run_tokens: 12_000, per_user_month_tokens: 3_000_000, platform_month_tokens: 20_000_000, per_run_usd: null, platform_month_usd: null } });
    const a = analyst();
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(out.outcome).toBe("stopped_by_budget");
    expect(out.stopReason).toMatch(/per-run limit of 12,000 tokens/);
    expect(a.calls.length).toBeLessThan(11);
    const r = recordOf(ops)!.record;
    expect(r["agents"].some((x: { report: { summary: string } }) => /Spending limit reached/.test(x.report.summary))).toBe(true);
    expect(r["execution"].budget.stoppedBy).toBe("per_run_tokens");
  });
  it("makes no AI call when usage evidence is unavailable", async () => {
    const { db, ops } = fakeDb({ usageError: true }); const a = analyst();
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(a.calls).toHaveLength(0);
    expect(out.outcome).toBe("failed");
    expect(recordOf(ops)!.record["failure"]).toMatch(/usage evidence unavailable/);
  });
});

describe("storage before migration 0043", () => {
  it("keeps a provisional record with the run when the ledger table is missing", async () => {
    const { db, ops } = fakeDb({ ledgerMissing: true }); const a = analyst();
    const out = await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(out.ledger).toBe("pending_migration");
    const keep = ops.find((o) => o.table === "ai_research_runs" && o.op === "update" && (o.row as { research_evidence?: { pendingDecisionRecord?: unknown } }).research_evidence?.pendingDecisionRecord);
    expect(keep).toBeTruthy();
  });
});

describe("execution isolation", () => {
  it("writes only research tables and calls no database functions", async () => {
    const { db, ops, rpc } = fakeDb({ halted: false }); const a = analyst();
    await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    const writes = ops.filter((o) => o.op !== "select");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(RESEARCH_WRITE_TABLES as readonly string[]).toContain(w.table);
    expect(writes.some((w) => ["risk_settings", "orders", "positions", "trades", "futures_settings", "autopilot_settings", "trading_bots", "exchange_connections"].includes(w.table))).toBe(false);
    expect(rpc).toEqual([]);
  });
  it("research code never references order or settings mutations", () => {
    for (const f of ["research-run.server.ts", "research.server.ts", "research-pipeline.ts", "research-record.ts", "research-risk-preview.ts", "research-budget.ts", "research-transparency.ts", "research-insights.functions.ts"]) {
      const src = readFileSync(`src/lib/${f}`, "utf8");
      expect(src, f).not.toMatch(/placeMarketOrder|openFutures|openManualPosition|emergencyCloseAll|enableLiveTrading|wallet_apply|from\("(orders|positions|risk_settings|futures_settings|autopilot_settings|trading_bots)"\)\.(insert|update|upsert|delete)/);
    }
  });
  it("the emergency stop blocks the preview, and research still writes nothing to trading tables", async () => {
    const { db, ops } = fakeDb({ halted: true }); const a = analyst();
    await executeResearchRun(db, U, RUN, "AAPL", { loadResearchData: async () => data(), runAnalyst: a.fn, now: () => now });
    expect(recordOf(ops)!.record["riskEvaluation"].preview.status).toBe("blocked");
    expect(recordOf(ops)!.record["riskEvaluation"].rejectionReasons.join(" ")).toMatch(/emergency stop/);
  });
});
