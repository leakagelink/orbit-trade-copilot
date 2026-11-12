// Scheduled Autopilot: each cron tick (≈ every minute, a few seconds long) starts due runs and advances active ones by
// one short step — send an asynchronous Claude request (via the database), read its stored reply, or execute ONE tool.
// A per-run lease stops overlap.
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { AUTOPILOT_MODEL, AUTOPILOT_SYSTEM, automaticRunPrompt, createRunBudget, liveRules, type BudgetKind, AUTOPILOT_LIMITS } from "./autopilot-guard";
import { applyModelReply, clip, completeTools, INTERRUPTED_RESULT, isErrorResult, nextTool, parseModelResponse, type Msg, type PendingTool, type RunState } from "./autopilot-run";
import { AI_PRIME_MESSAGES_URL, aiPrimeHeaders } from "./ai-prime.server";
import { executeFencedTool, CANCELLED_RESULT } from "./autopilot-fence";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const TICK_BUDGET_MS = 3000;
const LEASE_MS = 55_000;
const MODEL_TIMEOUT_MS = 180_000;
const REPLY_GIVE_UP_MS = 10 * 60_000;
type Headers = Record<string, string>;

async function toolsFor(db: Admin, userId: string, budgetUsed: Record<string, number>, fence: { runId?: string | undefined; guard?: (() => Promise<void>) | undefined } = {}) {
  const { autopilotTools } = await import("./autopilot-tools.server");
  const { loadLiveAccounts } = await import("./autopilot-settings.server");
  const live = await loadLiveAccounts(db, userId);
  const remaining = Object.fromEntries(Object.entries(AUTOPILOT_LIMITS).map(([k, v]) => [k, Math.max(0, v - (budgetUsed[k] ?? 0))])) as Record<BudgetKind, number>;
  const budget = createRunBudget(remaining);
  return { tools: autopilotTools({ supabase: db, userId, budget, live, ...fence }), budget, live };
}

const ACTIVE = ["waiting_model", "executing"];
// lease_holder is added by the pending Futures/Autopilot migration; generated types do not know it yet.
const runsTable = (db: Admin) => (db as unknown as { from: (t: string) => Row }).from("autopilot_runs");

/** Compare-and-set on a run this worker holds. A stopped/finished run or a newer holder turns every stale write into a no-op. */
async function cas(db: Admin, runId: string, holder: string, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await runsTable(db).update({ ...patch, updated_at: new Date().toISOString() }).eq("id", runId).eq("lease_holder", holder).in("status", ACTIVE).select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

/** Re-read immediately before an action: still our run, still executing, Autopilot ON, no emergency stop. */
async function runAuthorization(db: Admin, runId: string, userId: string, holder: string): Promise<string | null> {
  const [run, settings, risk] = await Promise.all([
    runsTable(db).select("status,lease_holder").eq("id", runId).maybeSingle(),
    db.from("autopilot_settings").select("enabled").eq("user_id", userId).maybeSingle(),
    db.from("risk_settings").select("trading_halted").eq("user_id", userId).maybeSingle(),
  ]);
  if (run.error || settings.error || risk.error) return "Autopilot authorization unavailable";
  if (!run.data || run.data.status !== "executing" || run.data.lease_holder !== holder) return "This run is no longer active for this worker";
  if (!settings.data?.enabled) return "Automatic Autopilot was switched off";
  if (risk.data?.trading_halted) return "Emergency stop is active";
  return null;
}

async function submitStep(db: Admin, headers: Headers, run: Row) {
  const { tools, live } = await toolsFor(db, run.user_id, run.budget ?? {});
  const specs = Object.entries(tools).map(([name, t]) => ({
    name, description: (t as { description?: string }).description ?? name,
    input_schema: z.toJSONSchema((t as { inputSchema: z.ZodType }).inputSchema, { io: "input" }),
  }));
  const body = { model: AUTOPILOT_MODEL, max_tokens: 4000, system: AUTOPILOT_SYSTEM + (live ? liveRules(live) : ""), messages: run.messages, tools: specs };
  const { data, error } = await db.rpc("ai_async_submit", { _url: AI_PRIME_MESSAGES_URL, _headers: headers as unknown as Json, _body: body as unknown as Json, _timeout_ms: MODEL_TIMEOUT_MS });
  if (error || data == null) throw new Error(`Could not send the Autopilot request: ${error?.message ?? "no request id"}`);
  return { batch_id: `net:${data}`, live: !!live };
}

async function readStep(db: Admin, requestRef: string, sentAt: string) {
  if (!requestRef.startsWith("net:")) return { ok: false as const, error: "An earlier AI request format is no longer used; nothing was done." };
  const { data, error } = await db.rpc("ai_async_result", { _id: Number(requestRef.slice(4)) });
  if (error) throw new Error(`Could not read the Autopilot reply: ${error.message}`);
  const row = data?.[0];
  if (!row) return Date.now() - new Date(sentAt).getTime() > REPLY_GIVE_UP_MS ? { ok: false as const, error: "No AI reply arrived within 10 minutes; nothing was done." } : null;
  return parseModelResponse(row);
}

async function finish(db: Admin, run: Row, holder: string, patch: Partial<RunState> & { status: RunState["status"] }) {
  return cas(db, run.id, holder, { ...patch, messages: (patch.messages ?? run.messages) as unknown as Json, pending_tools: (patch.pending_tools ?? []) as unknown as Json, lease_until: null, lease_holder: null, finished_at: new Date().toISOString() });
}

/** Advances one run by one step. Returns false when nothing could be done now (still waiting on Claude, or the fence was lost). */
async function advance(db: Admin, headers: Headers, run: Row, deadline: number, holder: string): Promise<boolean> {
  const save = (patch: Record<string, unknown>) => cas(db, run.id, holder, patch);
  const [settings, risk] = await Promise.all([
    db.from("autopilot_settings").select("enabled").eq("user_id", run.user_id).maybeSingle(),
    db.from("risk_settings").select("trading_halted").eq("user_id", run.user_id).maybeSingle(),
  ]);
  if (!settings.data?.enabled) { await finish(db, run, holder, { status: "stopped", error: "Automatic Autopilot was switched off" }); return false; }
  if (risk.data?.trading_halted) {
    await db.from("autopilot_settings").update({ enabled: false, updated_at: new Date().toISOString() }).eq("user_id", run.user_id);
    await finish(db, run, holder, { status: "stopped", error: "Emergency stop is active — Autopilot switched off" });
    return false;
  }
  const state: RunState = { status: run.status, step: run.step, messages: run.messages as Msg[], pending_tools: run.pending_tools as PendingTool[], batch_id: run.batch_id };

  if (run.status === "waiting_model") {
    if (!run.batch_id) { const s = await submitStep(db, headers, run); return save({ batch_id: s.batch_id, live: run.live || s.live }); }
    const r = await readStep(db, run.batch_id, run.updated_at);
    if (!r) return false;
    if (!r.ok) return finish(db, run, holder, { status: "failed", error: r.error });
    const next = applyModelReply(state, r.message);
    if (next.status === "done") return finish(db, run, holder, next);
    return save({ status: next.status, messages: next.messages as unknown as Json, pending_tools: next.pending_tools as unknown as Json, batch_id: null });
  }

  // executing: one tool per call, marked started first so an interrupted action is never repeated.
  const n = nextTool(state.pending_tools);
  if (n.kind === "complete") {
    const next = completeTools(state);
    if (next.status === "done") return finish(db, run, holder, next);
    return save({ status: next.status, step: next.step, messages: next.messages as unknown as Json, pending_tools: [] as unknown as Json, batch_id: null });
  }
  const pending = [...state.pending_tools];
  if (n.kind === "interrupted") {
    pending[n.index] = { ...pending[n.index]!, result: INTERRUPTED_RESULT, isError: true };
    return save({ pending_tools: pending as unknown as Json });
  }
  if (Date.now() > deadline - 2000) return false; // not enough time left in this tick to act safely
  const call = pending[n.index]!;
  const started = pending.map((p, i) => (i === n.index ? { ...p, started: true } : p));
  let used: Record<string, number> = {};
  let lastResult: unknown;
  const outcome = await executeFencedTool<unknown>({
    claim: () => save({ pending_tools: started as unknown as Json }),
    authorize: () => runAuthorization(db, run.id, run.user_id, holder),
    cancel: async (reason) => {
      const cancelled = started.map((p, i) => (i === n.index ? { ...p, result: CANCELLED_RESULT(reason), isError: true } : p));
      await finish(db, run, holder, { status: "stopped", error: reason, pending_tools: cancelled });
    },
    execute: async (guard) => {
      const { tools, budget } = await toolsFor(db, run.user_id, run.budget ?? {}, { runId: run.id, guard });
      const t = tools[call.name] as { inputSchema: z.ZodType; execute?: (i: unknown, o: unknown) => Promise<unknown> } | undefined;
      let result: unknown;
      if (!t?.execute) result = { ok: false, error: `Tool ${call.name} is not available now (real money may have been switched off)` };
      else {
        const parsed = t.inputSchema.safeParse(call.input);
        result = parsed.success ? await t.execute(parsed.data, { toolCallId: call.id, messages: [] }) : { ok: false, error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
      }
      used = budget.used();
      return result;
    },
    record: (result) => {
      const totals = Object.fromEntries(Object.keys(AUTOPILOT_LIMITS).map((k) => [k, (run.budget?.[k] ?? 0) + (used[k as BudgetKind] ?? 0)]));
      const done = started.map((p, i) => (i === n.index ? { ...p, result: clip(result), isError: isErrorResult(result) } : p));
      const actions = [...((run.actions as unknown[]) ?? []), { at: new Date().toISOString(), tool: call.name, input: call.input, result: clip(result).slice(0, 1500), error: isErrorResult(result) }].slice(-60);
      lastResult = result;
      return save({ pending_tools: done as unknown as Json, budget: totals as unknown as Json, actions: actions as unknown as Json });
    },
  });
  if (outcome.outcome === "orphaned") {
    // The run was stopped while this action ran: keep a durable record so its outcome is reconciled, never repeated.
    await db.from("audit_logs").insert({ user_id: run.user_id, action: "autopilot.result_after_stop", entity_type: "autopilot_run", entity_id: run.id, details: { tool: call.name, result: clip(lastResult).slice(0, 1500) } as Json });
  }
  return outcome.outcome === "executed";
}

async function startDueRuns(db: Admin) {
  const now = new Date();
  const { data: due } = await db.from("autopilot_settings").select("user_id,goal,interval_minutes,next_run_at").eq("enabled", true).or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`).limit(20);
  for (const s of due ?? []) {
    await db.from("autopilot_settings").update({ next_run_at: new Date(now.getTime() + s.interval_minutes * 60_000).toISOString() }).eq("user_id", s.user_id);
    const [{ data: pro }, { data: halted }] = await Promise.all([
      db.rpc("has_pro_access", { _uid: s.user_id }),
      db.from("risk_settings").select("trading_halted").eq("user_id", s.user_id).maybeSingle(),
    ]);
    if (pro !== true || halted?.trading_halted) continue;
    const { loadLiveAccounts } = await import("./autopilot-settings.server");
    const live = !!(await loadLiveAccounts(db, s.user_id));
    // Unique active-run index: a user never has two runs at once (insert simply fails).
    await db.from("autopilot_runs").insert({ user_id: s.user_id, live, messages: [{ role: "user", content: automaticRunPrompt(s.goal, live) }] as unknown as Json });
  }
}

export async function runAutopilotTick() {
  const deadline = Date.now() + TICK_BUDGET_MS;
  const headers = aiPrimeHeaders();
  if (!headers) return { ok: false, reason: "AI Prime Tech is not connected" };
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  await startDueRuns(db);
  const { data: runs } = await db.from("autopilot_runs").select("*").in("status", ["waiting_model", "executing"]).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).order("updated_at").limit(10);
  let steps = 0;
  for (const run of runs ?? []) {
    if (Date.now() > deadline) break;
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const holder = crypto.randomUUID();
    const { data: claimed } = await runsTable(db).update({ lease_until: lease, lease_holder: holder }).eq("id", run.id).in("status", ACTIVE).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("*");
    const current = claimed?.[0];
    if (!current) continue;
    try {
      // Waiting-only steps are cheap; keep advancing the same run while time remains.
      while (Date.now() < deadline) {
        const { data: fresh } = await db.from("autopilot_runs").select("*").eq("id", run.id).maybeSingle();
        if (!fresh || !ACTIVE.includes(fresh.status) || (fresh as Row).lease_holder !== holder) break;
        const progressed = await advance(db, headers, fresh, deadline, holder);
        if (!progressed) break;
        steps += 1;
      }
    } catch (e) {
      await cas(db, run.id, holder, { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    } finally {
      await runsTable(db).update({ lease_until: null, lease_holder: null }).eq("id", run.id).eq("lease_holder", holder).in("status", ACTIVE);
    }
  }
  return { ok: true, steps };
}
