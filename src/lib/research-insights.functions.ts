import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { researchBudget } from "./research-budget";
import { evaluateResearchRisk } from "./research-risk-evaluation";

const snapshotShape = z.object({ close: z.number(), asOf: z.string(), candles: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number() })) });
type Err = { code?: string; message?: string } | null;
type UntypedRead = { from: (t: string) => { select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown; error: Err }>; order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: Err }> } } } };
type UntypedRpc = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Err }> };

async function isAdmin(sb: { rpc: (fn: "has_role", a: { _user_id: string; _role: "admin" | "super_admin" }) => PromiseLike<{ data: boolean | null }> }, userId: string) {
  const [a, s] = await Promise.all([sb.rpc("has_role", { _user_id: userId, _role: "admin" }), sb.rpc("has_role", { _user_id: userId, _role: "super_admin" })]);
  return a.data === true || s.data === true;
}

/** Read-only: decision-record status, a fresh Risk Engine preview with current limits, and spending-limit status. */
export const getResearchInsights = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const run = await context.supabase.from("ai_research_runs").select("id,symbol,snapshot,research_evidence,ai_trade_proposals(proposal)").eq("id", data.runId).eq("user_id", context.userId).maybeSingle();
    if (run.error || !run.data) throw new Error("Research run unavailable");
    const { tableMissing, computeRiskPreview, loadResearchBudget, monthTokens } = await import("./research-run.server");
    const stored = await (context.supabase as unknown as UntypedRead).from("ai_decision_records").select("record,record_sha256,created_at").eq("run_id", data.runId).maybeSingle();
    const evidence = run.data.research_evidence as { pendingDecisionRecord?: unknown } | null;
    const row = !stored.error && stored.data ? (stored.data as { record: unknown; record_sha256: string; created_at: string }) : null;
    // The record travels as JSON text so the browser can download it unchanged.
    const record: { storage: "immutable" | "provisional" | "unverified" | "none"; recordJson: string | null; sha256: string | null; createdAt: string | null } = row
      ? { storage: "immutable", recordJson: JSON.stringify(row.record), sha256: row.record_sha256, createdAt: row.created_at }
      : evidence?.pendingDecisionRecord
        ? { storage: tableMissing(stored.error) ? "provisional" : "unverified", recordJson: JSON.stringify(evidence.pendingDecisionRecord), sha256: null, createdAt: null }
        : { storage: "none", recordJson: null, sha256: null, createdAt: null };
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const snap = snapshotShape.safeParse(run.data.snapshot);
    const live = await computeRiskPreview(db, context.userId, snap.success ? snap.data : null).catch(() => null);
    // Fresh evaluation with today's limits, shown beside the stored one. Not saved; never authorizes anything.
    const liveEvaluation = evaluateResearchRisk({ symbol: run.data.symbol, proposal: run.data.ai_trade_proposals[0]?.proposal ?? null, preview: live?.preview ?? null, riskEngineBlock: live?.riskEngineBlock ?? null, accountExposure: live?.accountExposure ?? null, evaluatedAt: new Date().toISOString() });
    // Stored, append-only evaluation history (available once migration 0043 is applied).
    const hist = await (context.supabase as unknown as UntypedRead).from("ai_risk_evaluations").select("id,decision,evaluated_at,evaluation").eq("run_id", data.runId).order("evaluated_at", { ascending: false });
    const evaluations: { storage: "immutable" | "pending_migration" | "unavailable"; rowsJson: string | null } = !hist.error ? { storage: "immutable", rowsJson: JSON.stringify(hist.data ?? []) } : tableMissing(hist.error) ? { storage: "pending_migration", rowsJson: null } : { storage: "unavailable", rowsJson: null };
    const budget = await loadResearchBudget(db).catch(() => null);
    const used = await monthTokens(db, context.userId).catch(() => null);
    return { record, livePreview: live, liveEvaluation, evaluations, budget, userMonthTokens: used, isAdmin: await isAdmin(context.supabase, context.userId), checkedAt: new Date().toISOString() };
  });

/** Admin-only. Saves platform research spending limits through the draft 0043 RPC (role re-checked in the database). */
export const saveResearchBudget = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => researchBudget.parse(i))
  .handler(async ({ data, context }) => {
    if (!(await isAdmin(context.supabase, context.userId))) throw new Error("Only an admin can change research spending limits");
    const r = await (context.supabase as unknown as UntypedRpc).rpc("set_ai_research_budget", { _per_run_tokens: data.perRunTokens, _per_user_day_tokens: data.perUserDayTokens, _per_user_month_tokens: data.perUserMonthTokens, _platform_month_tokens: data.platformMonthTokens, _max_calls_per_run: data.maxCallsPerRun, _max_repairs_per_run: data.maxRepairsPerRun, _max_run_seconds: data.maxRunSeconds, _per_run_usd: data.perRunUsd, _platform_month_usd: data.platformMonthUsd });
    if (r.error) {
      const { tableMissing } = await import("./research-run.server");
      throw new Error(tableMissing(r.error) || r.error.code === "PGRST202" ? "Saving limits needs migration 0043 to be approved and applied. Default limits remain in effect." : "Research spending limits could not be saved");
    }
    return { ok: true };
  });
