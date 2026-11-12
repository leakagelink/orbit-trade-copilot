import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { researchInput, RESEARCH_SYMBOLS } from "./research";
import { costStatus } from "./research-budget";

const RUN_STATUSES = ["queued", "running", "completed", "partial", "failed", "cancelled", "budget_exceeded"] as const;
export const researchFilters = z.object({
  symbol: z.enum(RESEARCH_SYMBOLS).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  market: z.enum(["crypto", "equity"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export type ResearchFilters = z.infer<typeof researchFilters>;

/** Owner's research runs with every stored agent output (read-only). Owner comes from the verified session only. */
export const listResearch = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => researchFilters.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("ai_research_runs").select("*,ai_agent_outputs(*),ai_research_reports(*),ai_research_decisions(*),ai_trade_proposals(*),ai_research_stage_metrics(*)").eq("user_id", context.userId);
    if (data.symbol) q = q.eq("symbol", data.symbol);
    if (data.status) q = q.eq("status", data.status);
    if (data.market === "crypto") q = q.like("symbol", "%-USD");
    if (data.market === "equity") q = q.not("symbol", "like", "%-USD");
    if (data.from) q = q.gte("created_at", `${data.from}T00:00:00Z`);
    if (data.to) q = q.lte("created_at", `${data.to}T23:59:59.999Z`);
    const { data: rows, error } = await q.order("created_at", { ascending: false }).limit(50);
    if (error) throw new Error("Research history is unavailable");
    return rows;
  });

export const startResearchRun = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => researchInput.parse(input)).handler(async ({ data, context }) => {
    const { requirePro } = await import("./plan.server");
    await requirePro(context.supabase, context.userId);
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    // requestId is the idempotency key: a repeated submission of the same request never starts a second run.
    const claim = await db.rpc("claim_ai_research", { _id: data.requestId, _user_id: context.userId, _symbol: data.symbol });
    if (claim.error) throw new Error(claim.error.message.includes("allowance") ? "Monthly research allowance reached. Check usage; new capacity is available next UTC month." : claim.error.message.includes("in progress") ? "A research run is already in progress. Wait for it to finish or cancel it first." : "Research could not start. A prior run may be unresolved; check history before trying again.");
    if (!claim.data) return { runId: data.requestId, duplicate: true as const };
    const { loadResearchData, runAnalyst } = await import("./research.server");
    const { executeResearchRun } = await import("./research-run.server");
    const out = await executeResearchRun(db, context.userId, data.requestId, data.symbol, { loadResearchData, runAnalyst });
    return { ...out, duplicate: false as const };
  });

/**
 * Owner asks a running research run to stop. Recorded as an append-only audit event; the run checks it before every
 * AI call. A run left "running" well past its time limit (its server request ended) is closed here as cancelled.
 */
export const cancelResearchRun = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ runId: z.string().uuid() }).strict().parse(i))
  .handler(async ({ data, context }) => {
    const run = await context.supabase.from("ai_research_runs").select("id,status,created_at").eq("id", data.runId).eq("user_id", context.userId).maybeSingle();
    if (run.error || !run.data) throw new Error("Research run unavailable");
    if (run.data.status !== "running" && run.data.status !== "queued") throw new Error("This research run has already finished");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { RESEARCH_CANCEL_ACTION, loadResearchBudget } = await import("./research-run.server");
    const ev = await db.from("audit_logs").insert({ user_id: context.userId, action: RESEARCH_CANCEL_ACTION, entity_type: "ai_research_run", entity_id: data.runId, details: { requested_at: new Date().toISOString() } });
    if (ev.error) throw new Error("Cancellation could not be recorded");
    const { limits } = await loadResearchBudget(db).catch(() => ({ limits: { maxRunSeconds: 1200 } }));
    const staleAfter = (limits.maxRunSeconds + 600) * 1000;
    let closed = false;
    if (Date.now() - Date.parse(run.data.created_at) > staleAfter) {
      const reason = "Cancelled after the run passed its time limit without finishing; its server request had ended. Completed reports are kept. No trades were placed.";
      const at = new Date().toISOString();
      let u = await db.from("ai_research_runs").update({ status: "cancelled", error: reason, completed_at: at }).eq("id", data.runId).eq("user_id", context.userId).in("status", ["queued", "running"]).select("id");
      if (u.error?.code === "23514") u = await db.from("ai_research_runs").update({ status: "failed", error: reason, completed_at: at }).eq("id", data.runId).eq("user_id", context.userId).in("status", ["queued", "running"]).select("id");
      if (u.error) throw new Error("The run could not be closed");
      closed = (u.data?.length ?? 0) > 0;
    }
    return { requested: true, closed };
  });

async function pages<T>(fetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let p = 0; p < 20; p++) {
    const r = await fetch(p * 1000, p * 1000 + 999);
    if (r.error || !r.data) throw new Error("Research statistics are unavailable");
    out.push(...r.data);
    if (r.data.length < 1000) return out;
  }
  return out;
}

/** Owner-only totals computed from stored rows. Nothing is estimated; unknown costs stay unknown. */
export const getResearchOverview = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const sb = context.supabase, uid = context.userId;
  const [runs, metrics] = await Promise.all([
    pages((a, b) => sb.from("ai_research_runs").select("id,symbol,status,created_at,completed_at").eq("user_id", uid).order("created_at", { ascending: false }).range(a, b)),
    pages((a, b) => sb.from("ai_research_stage_metrics").select("run_id,agent,status,duration_ms,input_tokens,output_tokens,provider_cost_usd").eq("user_id", uid).order("id").range(a, b)),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const finished = runs.filter((r) => r.completed_at && r.status !== "running" && r.status !== "queued");
  const durations = finished.map((r) => Date.parse(r.completed_at!) - Date.parse(r.created_at)).filter((d) => Number.isFinite(d) && d >= 0);
  const n = (v: number | null) => (v === null ? 0 : Number(v));
  const agg = (rows: typeof metrics) => ({
    calls: rows.length, failed: rows.filter((m) => m.status === "failed").length,
    inputTokens: rows.reduce((a, m) => a + n(m.input_tokens), 0), outputTokens: rows.reduce((a, m) => a + n(m.output_tokens), 0),
    durationMs: rows.reduce((a, m) => a + m.duration_ms, 0), cost: costStatus(rows.map((m) => (m.provider_cost_usd === null ? null : Number(m.provider_cost_usd)))),
  });
  const agents = [...new Set(metrics.map((m) => m.agent))];
  const byAgent = agents.map((agent) => { const a = agg(metrics.filter((m) => m.agent === agent)); return { agent, ...a, avgDurationMs: a.calls ? Math.round(a.durationMs / a.calls) : null }; });
  const byRun = runs.slice(0, 30).map((r) => ({ runId: r.id, symbol: r.symbol, status: r.status, createdAt: r.created_at, ...agg(metrics.filter((m) => m.run_id === r.id)) }));
  const completedRunIds = new Set(runs.filter((r) => r.status === "completed").map((r) => r.id));
  const completedCost = costStatus(metrics.filter((m) => completedRunIds.has(m.run_id)).map((m) => (m.provider_cost_usd === null ? null : Number(m.provider_cost_usd))));
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { loadResearchBudget, dayTokens, monthTokens } = await import("./research-run.server");
  const [budget, day, month, admin, superAdmin] = await Promise.all([loadResearchBudget(db).catch(() => null), dayTokens(db, uid).catch(() => null), monthTokens(db, uid).catch(() => null), sb.rpc("has_role", { _user_id: uid, _role: "admin" }), sb.rpc("has_role", { _user_id: uid, _role: "super_admin" })]);
  return {
    runs: { total: runs.length, byStatus, active: runs.filter((r) => r.status === "running" || r.status === "queued").map((r) => ({ id: r.id, symbol: r.symbol, status: r.status, createdAt: r.created_at })), latest: runs[0] ? { id: runs[0].id, symbol: runs[0].symbol, status: runs[0].status, createdAt: runs[0].created_at } : null, avgDurationMs: durations.length ? Math.round(durations.reduce((a, d) => a + d, 0) / durations.length) : null },
    totals: { ...agg(metrics), automaticRetries: 0 },
    byAgent, byRun,
    avgCostPerCompletedRun: completedRunIds.size && completedCost.status === "ACTUAL_PROVIDER_COST" && completedCost.amountUsd !== null ? { status: completedCost.status, amountUsd: completedCost.amountUsd / completedRunIds.size } : { status: "UNKNOWN_COST" as const, amountUsd: null },
    budget: budget ? { ...budget, userDayTokens: day, userMonthTokens: month } : null,
    isAdmin: admin.data === true || superAdmin.data === true,
    checkedAt: new Date().toISOString(),
  };
});
