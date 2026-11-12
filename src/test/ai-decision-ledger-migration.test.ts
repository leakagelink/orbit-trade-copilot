// Runs DRAFT migration 0043 (and its rollback) verbatim in an in-memory Postgres (PGlite). Nothing touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RESEARCH_AGENTS } from "@/lib/research-pipeline";

const MIGRATION = readFileSync("docs/proposed-migrations/0043_ai_decision_records_and_research_budget.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0043_ai_decision_records_and_research_budget.rollback.sql", "utf8");
import { RESEARCH_DB_STUB as STUB, RESEARCH_IDS } from "./fixtures/research-db-stub";
import { DEFAULT_RESEARCH_BUDGET } from "@/lib/research-budget";
const { A, B, ADMIN, RA, RB } = RESEARCH_IDS;
const rec = (run: string, user: string, symbol: string, over: Record<string, unknown> = {}) => JSON.stringify({ runId: run, userId: user, symbol, outcome: "complete", advisoryOnly: true, executionAllowed: false, agents: RESEARCH_AGENTS.map((agent) => ({ agent, status: "completed" })), ...over });
const insertSql = (run: string, user: string, symbol: string, record: string, sha = "app-supplied") => `INSERT INTO public.ai_decision_records(run_id,user_id,market,symbol,timeframe,outcome,decided_at,schema_version,record,record_sha256) VALUES ('${run}','${user}','equity','${symbol}','1d','complete',now(),1,'${record}'::jsonb,'${sha}')`;
let db: PGlite;
async function as(role: "authenticated" | "service_role" | "anon", uid: string | null, sql: string) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ""}', false);`);
  try { return await db.query(sql); } finally { await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);"); }
}

beforeAll(async () => {
  db = new PGlite(); await db.exec(STUB); await db.exec(MIGRATION);
  await as("service_role", null, insertSql(RA, A, "AAPL", rec(RA, A, "AAPL")));
  await as("service_role", null, insertSql(RB, B, "BTC-USD", rec(RB, B, "BTC-USD")).replace("'equity'", "'crypto'"));
}, 60_000);

describe("decision records are append-only for every role", () => {
  it("the database computes the fingerprint; the app cannot supply it", async () => {
    const r = await db.query<{ record_sha256: string }>(`SELECT record_sha256 FROM public.ai_decision_records WHERE run_id='${RA}'`);
    expect(r.rows[0]!.record_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("a signed-in user cannot update their own record", async () => {
    await expect(as("authenticated", A, `UPDATE public.ai_decision_records SET outcome='failed' WHERE run_id='${RA}'`)).rejects.toThrow(/permission denied/);
  });
  it("a signed-in user cannot delete their own record", async () => {
    await expect(as("authenticated", A, `DELETE FROM public.ai_decision_records WHERE run_id='${RA}'`)).rejects.toThrow(/permission denied/);
  });
  it("a signed-in user cannot insert or truncate", async () => {
    await expect(as("authenticated", A, insertSql(RA, A, "AAPL", rec(RA, A, "AAPL")))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, "TRUNCATE public.ai_decision_records")).rejects.toThrow(/permission denied/);
  });
  it("anonymous visitors cannot read", async () => {
    await expect(as("anon", null, "SELECT * FROM public.ai_decision_records")).rejects.toThrow(/permission denied/);
  });
  it("the backend role cannot update, delete or truncate", async () => {
    await expect(as("service_role", null, `UPDATE public.ai_decision_records SET outcome='failed'`)).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, `DELETE FROM public.ai_decision_records`)).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, `TRUNCATE public.ai_decision_records`)).rejects.toThrow(/permission denied/);
  });
  it("even the table owner is stopped by the triggers", async () => {
    await expect(db.exec(`UPDATE public.ai_decision_records SET outcome='failed'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.ai_decision_records`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.ai_decision_records`)).rejects.toThrow(/append-only/);
  });
  it("a second record for the same run is refused", async () => {
    await expect(as("service_role", null, insertSql(RA, A, "AAPL", rec(RA, A, "AAPL")))).rejects.toThrow(/duplicate key/);
  });
});

describe("insert validation", () => {
  it("refuses a record for someone else's run", async () => {
    await expect(as("service_role", null, insertSql(RB, A, "BTC-USD", rec(RB, A, "BTC-USD")))).rejects.toThrow(/existing research run/);
  });
  it("refuses fewer than 12 agents", async () => {
    await db.exec(`INSERT INTO public.ai_research_runs VALUES ('00000000-0000-4000-8000-0000000000c1','${A}','MSFT')`);
    await expect(as("service_role", null, insertSql("00000000-0000-4000-8000-0000000000c1", A, "MSFT", rec("00000000-0000-4000-8000-0000000000c1", A, "MSFT", { agents: [{ agent: "market" }] })))).rejects.toThrow(/all 12 agents/);
  });
  it("refuses a record that claims execution is allowed", async () => {
    await expect(as("service_role", null, insertSql("00000000-0000-4000-8000-0000000000c1", A, "MSFT", rec("00000000-0000-4000-8000-0000000000c1", A, "MSFT", { executionAllowed: true })))).rejects.toThrow(/advisory only/);
  });
});

describe("owner-only reading", () => {
  it("each user sees only their own records", async () => {
    const r = await as("authenticated", A, "SELECT run_id FROM public.ai_decision_records");
    expect(r.rows).toEqual([{ run_id: RA }]);
  });
});

describe("existing research outputs become append-only", () => {
  it("agent outputs cannot be changed or deleted", async () => {
    await expect(db.exec(`UPDATE public.ai_agent_outputs SET status='failed'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.ai_agent_outputs`)).rejects.toThrow(/append-only/);
  });
  it("usage records cannot be changed", async () => {
    await expect(db.exec(`UPDATE public.ai_research_usage SET input_tokens=0`)).rejects.toThrow(/append-only/);
  });
  it("research output tables cannot be truncated", async () => {
    for (const t of ["ai_agent_outputs", "ai_research_reports", "ai_research_decisions", "ai_trade_proposals", "ai_research_usage"]) {
      await expect(db.exec(`TRUNCATE public.${t}`)).rejects.toThrow(/append-only/);
    }
  });
  it("a signed-in user cannot update or delete research runs or outputs directly", async () => {
    await expect(as("authenticated", A, `UPDATE public.ai_research_runs SET status='completed' WHERE id='${RA}'`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `DELETE FROM public.ai_research_runs WHERE id='${RA}'`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", A, `UPDATE public.ai_agent_outputs SET status='failed'`)).rejects.toThrow(/permission denied/);
  });
  it("owners still read their own runs; visitors read nothing", async () => {
    expect((await as("authenticated", A, "SELECT id FROM public.ai_research_runs WHERE id IN ('" + RA + "','" + RB + "')")).rows).toEqual([{ id: RA }]);
    await expect(as("anon", null, "SELECT id FROM public.ai_research_runs")).rejects.toThrow(/permission denied/);
  });
  it("browser roles cannot truncate research tables", async () => {
    await expect(as("authenticated", A, "TRUNCATE public.ai_research_usage")).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, "TRUNCATE public.ai_research_runs CASCADE")).rejects.toThrow(/permission denied/);
  });
  it("new outputs can still be inserted", async () => {
    await expect(db.exec(`INSERT INTO public.ai_research_reports(run_id,user_id,agent,status,report) VALUES ('${RA}','${A}','news','completed','{}')`)).resolves.toBeTruthy();
  });
});

describe("research spending limits", () => {
  const call = "SELECT public.set_ai_research_budget(100000, 600000, 1000000, 5000000, 16, 3, 1200, NULL, NULL)";
  it("a non-admin cannot change limits", async () => {
    await expect(as("authenticated", A, call)).rejects.toThrow(/Only an admin/);
  });
  it("a signed-in user cannot write the limits table directly", async () => {
    await expect(as("authenticated", ADMIN, "UPDATE public.ai_research_budget_config SET per_run_tokens=1")).rejects.toThrow(/permission denied/);
  });
  it("an admin can change limits and every change is kept append-only", async () => {
    await as("authenticated", ADMIN, call);
    const r = await as("service_role", null, "SELECT per_run_tokens FROM public.ai_research_budget_config");
    expect(r.rows).toEqual([{ per_run_tokens: 100000 }]);
    const ev = await db.query<{ n: number }>("SELECT count(*)::int n FROM public.ai_research_budget_events");
    expect(ev.rows[0]!.n).toBe(1);
    await expect(db.exec("DELETE FROM public.ai_research_budget_events")).rejects.toThrow(/append-only/);
  });
  it("browser roles cannot read limits or their history directly", async () => {
    await expect(as("authenticated", A, "SELECT * FROM public.ai_research_budget_config")).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", ADMIN, "SELECT * FROM public.ai_research_budget_events")).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, "SELECT * FROM public.ai_research_budget_config")).rejects.toThrow(/permission denied/);
  });
  it("the backend role can read limits but cannot change them or their history", async () => {
    await expect(as("service_role", null, "UPDATE public.ai_research_budget_config SET per_run_tokens=20000")).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, "INSERT INTO public.ai_research_budget_events(changed_by,config) VALUES (gen_random_uuid(),'{}')")).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, "SELECT public.set_ai_research_budget(100000, 600000, 1000000, 5000000, 16, 3, 1200, NULL, NULL)")).rejects.toThrow(/Only an admin/);
  });
  it("out-of-range limits are refused", async () => {
    await expect(as("authenticated", ADMIN, "SELECT public.set_ai_research_budget(5, 600000, 1000000, 5000000, 16, 3, 1200, NULL, NULL)")).rejects.toThrow(/check constraint/);
  });
});

describe("research run lifecycle", () => {
  const R = "00000000-0000-4000-8000-0000000000d1";
  it("a running run can finish with the new statuses, then is frozen", async () => {
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R}','${A}','AAPL')`);
    await as("service_role", null, `UPDATE public.ai_research_runs SET snapshot='{}'::jsonb WHERE id='${R}'`);
    await as("service_role", null, `UPDATE public.ai_research_runs SET status='budget_exceeded', error='limit' WHERE id='${R}'`);
    const r = await db.query<{ completed_at: string | null }>(`SELECT completed_at FROM public.ai_research_runs WHERE id='${R}'`);
    expect(r.rows[0]!.completed_at).not.toBeNull();
    await expect(as("service_role", null, `UPDATE public.ai_research_runs SET status='completed' WHERE id='${R}'`)).rejects.toThrow(/finished research run cannot be changed/);
  });
  it("runs can never be deleted or truncated, even by the owner role", async () => {
    await expect(db.exec(`DELETE FROM public.ai_research_runs WHERE id='${R}'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.ai_research_runs CASCADE`)).rejects.toThrow(/append-only/);
  });
  it("a running run's owner or symbol cannot be changed", async () => {
    const R2 = "00000000-0000-4000-8000-0000000000d2";
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R2}','${A}','AAPL')`);
    await expect(db.exec(`UPDATE public.ai_research_runs SET user_id='${B}' WHERE id='${R2}'`)).rejects.toThrow(/identity/);
    await db.exec(`UPDATE public.ai_research_runs SET status='cancelled' WHERE id='${R2}'`);
  });
  it("unknown statuses are refused", async () => {
    await expect(db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol,status) VALUES (gen_random_uuid(),'${A}','AAPL','executed')`)).rejects.toThrow(/check constraint/);
  });
});

describe("schema 2 decision records", () => {
  it("refuses a record whose risk evaluation claims execution authority", async () => {
    const R = "00000000-0000-4000-8000-0000000000e1";
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R}','${A}','AAPL')`);
    const bad = rec(R, A, "AAPL", { schemaVersion: 2, riskEvaluation: { evaluation: { status: "PREVIEW_ONLY", executionAuthorized: true } } });
    await expect(as("service_role", null, insertSql(R, A, "AAPL", bad).replace(",1,'", ",2,'"))).rejects.toThrow(/non-executable/);
    const ok = rec(R, A, "AAPL", { schemaVersion: 2, riskEvaluation: { evaluation: { status: "NOT_EXECUTABLE", executionAuthorized: false } } });
    await expect(as("service_role", null, insertSql(R, A, "AAPL", ok).replace(",1,'", ",2,'"))).resolves.toBeTruthy();
  });
});

describe("risk evaluation history", () => {
  const ins = (run: string, user: string, symbol: string, ev: Record<string, unknown>, authorized = false) => `INSERT INTO public.ai_risk_evaluations(run_id,user_id,symbol,market_type,proposed_direction,decision,execution_authorized,evaluation) VALUES ('${run}','${user}','${symbol}','equity','LONG','PREVIEW_ONLY',${authorized},'${JSON.stringify(ev)}'::jsonb)`;
  const good = { status: "NOT_EXECUTABLE", executionAuthorized: false, decision: "PREVIEW_ONLY" };
  it("the backend can append a non-executable evaluation for the owner's run", async () => {
    await expect(as("service_role", null, ins(RA, A, "AAPL", good))).resolves.toBeTruthy();
  });
  it("an evaluation can never authorize execution", async () => {
    await expect(as("service_role", null, ins(RA, A, "AAPL", good, true))).rejects.toThrow(/check constraint/);
    await expect(as("service_role", null, ins(RA, A, "AAPL", { ...good, executionAuthorized: true }))).rejects.toThrow(/never authorize/);
  });
  it("refuses an evaluation for someone else's run", async () => {
    await expect(as("service_role", null, ins(RB, A, "BTC-USD", good))).rejects.toThrow(/existing research run/);
  });
  it("users read only their own, and nobody can change or delete them", async () => {
    expect((await as("authenticated", B, "SELECT id FROM public.ai_risk_evaluations")).rows).toEqual([]);
    expect((await as("authenticated", A, "SELECT id FROM public.ai_risk_evaluations")).rows).toHaveLength(1);
    await expect(as("authenticated", A, ins(RA, A, "AAPL", good))).rejects.toThrow(/permission denied/);
    await expect(as("service_role", null, "UPDATE public.ai_risk_evaluations SET decision='REJECTED'")).rejects.toThrow(/permission denied/);
    await expect(db.exec("DELETE FROM public.ai_risk_evaluations")).rejects.toThrow(/append-only/);
  });
});

describe("rollback", () => {
  it("removes the new objects and restores ordinary behaviour of existing tables", async () => {
    const d = new PGlite(); await d.exec(STUB); await d.exec(MIGRATION); await d.exec(ROLLBACK);
    const t = await d.query<{ n: number }>("SELECT count(*)::int n FROM pg_tables WHERE tablename IN ('ai_decision_records','ai_research_budget_config','ai_research_budget_events')");
    expect(t.rows[0]!.n).toBe(0);
    await expect(d.exec(`UPDATE public.ai_agent_outputs SET status='completed'`)).resolves.toBeTruthy();
    expect((await d.query<{ n: number }>("SELECT count(*)::int n FROM pg_tables WHERE tablename='ai_risk_evaluations'")).rows[0]!.n).toBe(0);
    await expect(d.exec(`DELETE FROM public.ai_research_runs WHERE id='${RB}'`)).resolves.toBeTruthy();
    const cols = await d.query<{ n: number }>("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='ai_research_runs' AND column_name IN ('worker_id','worker_claimed_at')");
    expect(cols.rows[0]!.n).toBe(0);
    const fns = await d.query<{ n: number }>("SELECT count(*)::int n FROM pg_proc WHERE proname IN ('reserve_ai_research_budget','settle_ai_research_budget','release_ai_research_budget','claim_ai_research_worker','ai_research_counted_tokens','guard_ai_research_append')");
    expect(fns.rows[0]!.n).toBe(0);
  }, 60_000);
  it("does NOT give browser roles back write, TRUNCATE or visitor-read privileges (deliberate deviation)", async () => {
    const d = new PGlite(); await d.exec(STUB); await d.exec(MIGRATION); await d.exec(ROLLBACK);
    const tables = ["ai_research_runs", "ai_agent_outputs", "ai_research_reports", "ai_research_decisions", "ai_trade_proposals", "ai_research_usage", "ai_research_stage_metrics"];
    for (const t of tables) for (const role of ["anon", "authenticated"]) for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      const r = await d.query<{ ok: boolean }>(`SELECT has_table_privilege('${role}','public.${t}','${priv}') ok`);
      expect(r.rows[0]!.ok, `${role} ${priv} on ${t}`).toBe(false);
    }
    for (const t of tables) expect((await d.query<{ ok: boolean }>(`SELECT has_table_privilege('anon','public.${t}','SELECT') ok`)).rows[0]!.ok).toBe(false);
    // Owners still read their own rows through the existing policies; the backend role is unaffected.
    await d.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${A}', false);`);
    expect((await d.query<{ id: string }>(`SELECT id FROM public.ai_research_runs`)).rows).toEqual([{ id: RA }]);
    await expect(d.exec("TRUNCATE public.ai_research_usage")).rejects.toThrow(/permission denied/);
    await d.exec("RESET ROLE");
    expect((await d.query<{ ok: boolean }>("SELECT has_table_privilege('service_role','public.ai_research_usage','INSERT') ok")).rows[0]!.ok).toBe(true);
  }, 60_000);
  it("relabels runs with statuses the original list does not allow", async () => {
    const d = new PGlite(); await d.exec(STUB); await d.exec(MIGRATION);
    await d.exec(`UPDATE public.ai_research_runs SET status='cancelled' WHERE id='${RA}'`);
    await d.exec(ROLLBACK);
    const r = await d.query<{ status: string; error: string }>(`SELECT status, error FROM public.ai_research_runs WHERE id='${RA}'`);
    expect(r.rows[0]).toEqual({ status: "partial", error: "Cancelled: no reason recorded" });
  }, 60_000);
});

describe("outputs can be appended only while the run is in progress", () => {
  const R = "00000000-0000-4000-8000-0000000000f1";
  it("a finished run refuses new outputs, usage, metrics, proposals, decision records and risk evaluations", async () => {
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R}','${A}','AAPL')`);
    await as("service_role", null, `INSERT INTO public.ai_research_reports(run_id,user_id,agent,status,report) VALUES ('${R}','${A}','news','completed','{}')`);
    await db.exec(`UPDATE public.ai_research_runs SET status='cancelled' WHERE id='${R}'`);
    for (const sql of [
      `INSERT INTO public.ai_research_reports(run_id,user_id,agent,status,report) VALUES ('${R}','${A}','bull','completed','{}')`,
      `INSERT INTO public.ai_agent_outputs(run_id,user_id,agent,status,report) VALUES ('${R}','${A}','market','completed','{}')`,
      `INSERT INTO public.ai_research_usage(run_id,user_id,agent,input_tokens,output_tokens) VALUES ('${R}','${A}','bull',1,1)`,
      `INSERT INTO public.ai_research_stage_metrics(run_id,user_id,agent) VALUES ('${R}','${A}','bull')`,
      `INSERT INTO public.ai_trade_proposals(run_id,user_id,proposal) VALUES ('${R}','${A}','{}')`,
    ]) await expect(as("service_role", null, sql)).rejects.toThrow(/only be added while their run is in progress/);
    await expect(as("service_role", null, insertSql(R, A, "AAPL", rec(R, A, "AAPL")))).rejects.toThrow(/only be added while their run is in progress/);
    // The output written before the cancellation is preserved.
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.ai_research_reports WHERE run_id='${R}'`)).rows[0]!.n).toBe(1);
  });
  it("an output must belong to the run's owner", async () => {
    await expect(as("service_role", null, `INSERT INTO public.ai_research_reports(run_id,user_id,agent,status,report) VALUES ('${RA}','${B}','bull','completed','{}')`)).rejects.toThrow(/in progress/);
  });
  it("stage metrics become append-only", async () => {
    await as("service_role", null, `INSERT INTO public.ai_research_stage_metrics(run_id,user_id,agent) VALUES ('${RA}','${A}','market')`);
    await expect(db.exec(`UPDATE public.ai_research_stage_metrics SET agent='x'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.ai_research_stage_metrics`)).rejects.toThrow(/append-only/);
  });
});

describe("single worker per run", () => {
  const R = "00000000-0000-4000-8000-0000000000f2", W1 = "00000000-0000-4000-8000-0000000000e1", W2 = "00000000-0000-4000-8000-0000000000e2";
  it("the first worker claims the run; a second worker is refused; the worker can never be replaced", async () => {
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R}','${A}','AAPL')`);
    expect((await as("service_role", null, `SELECT public.claim_ai_research_worker('${R}','${A}','${W1}') ok`)).rows).toEqual([{ ok: true }]);
    expect((await as("service_role", null, `SELECT public.claim_ai_research_worker('${R}','${A}','${W2}') ok`)).rows).toEqual([{ ok: false }]);
    await expect(db.exec(`UPDATE public.ai_research_runs SET worker_id='${W2}' WHERE id='${R}'`)).rejects.toThrow(/worker cannot be replaced/);
  });
  it("a claim for another owner's run is refused", async () => {
    const R2 = "00000000-0000-4000-8000-0000000000f3";
    await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${R2}','${A}','AAPL')`);
    expect((await as("service_role", null, `SELECT public.claim_ai_research_worker('${R2}','${B}','${W1}') ok`)).rows).toEqual([{ ok: false }]);
  });
  it("browser roles cannot call the ledger functions", async () => {
    for (const sql of [`SELECT public.claim_ai_research_worker('${R}','${A}','${W1}')`, `SELECT public.reserve_ai_research_budget('${R}','${A}','${W1}','market','call',1000)`, `SELECT public.settle_ai_research_budget(ARRAY[gen_random_uuid()],'${W1}',1,NULL)`, `SELECT public.release_ai_research_budget(gen_random_uuid(),'${W1}')`]) {
      await expect(as("authenticated", A, sql)).rejects.toThrow(/permission denied/);
      await expect(as("anon", null, sql)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("budget reservations (single session; concurrency is tested against a multi-session PostgreSQL)", () => {
  const U = "00000000-0000-4000-8000-0000000000c9", W = "00000000-0000-4000-8000-0000000000e9";
  let n = 0;
  const newRun = async (user = U) => { n += 1; const id = `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`; await db.exec(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${id}','${user}','AAPL')`); await as("service_role", null, `SELECT public.claim_ai_research_worker('${id}','${user}','${W}')`); return id; };
  const reserve = async (run: string, tokens: number, kind = "call", user = U, worker = W) => (await as("service_role", null, `SELECT public.reserve_ai_research_budget('${run}','${user}','${worker}','market','${kind}',${tokens}) r`)).rows[0] as { r: { ok: boolean; reservation_id?: string; stopped_by?: string; reason?: string } };
  it("built-in limits equal the app defaults", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("CREATE FUNCTION public.reserve_ai_research_budget"));
    const d = DEFAULT_RESEARCH_BUDGET;
    for (const [col, v] of [["per_run_tokens", d.perRunTokens], ["per_user_day_tokens", d.perUserDayTokens], ["per_user_month_tokens", d.perUserMonthTokens], ["platform_month_tokens", d.platformMonthTokens], ["max_calls_per_run", d.maxCallsPerRun], ["max_repairs_per_run", d.maxRepairsPerRun], ["max_run_seconds", d.maxRunSeconds]] as const)
      expect(fn).toContain(`coalesce(c.${col}, ${v})`);
  });
  // Limits saved by the admin test above apply here: 100,000 per run, 600,000 per user per day.
  it("per-run cap: a reservation that would pass it is refused and nothing is reserved", async () => {
    const run = await newRun();
    expect((await reserve(run, 80_000)).r.ok).toBe(true);
    const r = await reserve(run, 30_000);
    expect(r.r).toMatchObject({ ok: false, stopped_by: "per_run_tokens" });
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.ai_research_budget_reservations WHERE run_id='${run}'`)).rows[0]!.n).toBe(1);
  });
  it("reconciliation: settling with smaller provider-reported usage frees the difference", async () => {
    const run = await newRun();
    const first = (await reserve(run, 80_000)).r.reservation_id!;
    expect((await reserve(run, 30_000)).r.ok).toBe(false);
    await as("service_role", null, `SELECT public.settle_ai_research_budget(ARRAY['${first}']::uuid[],'${W}',12000,NULL)`);
    const row = (await db.query<{ status: string; consumed_tokens: string; usage_basis: string }>(`SELECT status, consumed_tokens::text, usage_basis FROM public.ai_research_budget_reservations WHERE id='${first}'`)).rows[0];
    expect(row).toEqual({ status: "consumed", consumed_tokens: "12000", usage_basis: "provider_reported" });
    expect((await reserve(run, 30_000)).r.ok).toBe(true);
  });
  it("unknown usage counts the full reservation", async () => {
    const run = await newRun();
    const id = (await reserve(run, 50_000)).r.reservation_id!;
    await as("service_role", null, `SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'${W}',NULL,NULL)`);
    expect((await db.query<{ c: string; b: string }>(`SELECT consumed_tokens::text c, usage_basis b FROM public.ai_research_budget_reservations WHERE id='${id}'`)).rows[0]).toEqual({ c: "50000", b: "reservation_estimate" });
  });
  it("a released reservation stops counting and cannot be settled again", async () => {
    const run = await newRun();
    const id = (await reserve(run, 90_000)).r.reservation_id!;
    await as("service_role", null, `SELECT public.release_ai_research_budget('${id}','${W}')`);
    expect((await reserve(run, 90_000)).r.ok).toBe(true);
    await expect(as("service_role", null, `SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'${W}',1,NULL)`)).rejects.toThrow(/already settled/);
  });
  it("call and correction limits", async () => {
    const run = await newRun();
    for (let i = 0; i < 3; i++) expect((await reserve(run, 1_000, "repair")).r.ok).toBe(true);
    expect((await reserve(run, 1_000, "repair")).r).toMatchObject({ ok: false, stopped_by: "max_repairs" });
    for (let i = 0; i < 13; i++) expect((await reserve(run, 1_000)).r.ok).toBe(true);
    expect((await reserve(run, 1_000)).r).toMatchObject({ ok: false, stopped_by: "max_calls" });
  });
  it("cancelled, finished and foreign-worker runs get no reservation", async () => {
    const run = await newRun();
    await db.exec(`INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id) VALUES ('${U}','ai_research_cancel_requested','ai_research_run','${run}')`);
    expect((await reserve(run, 1_000)).r).toMatchObject({ ok: false, stopped_by: "cancelled" });
    const run2 = await newRun();
    expect((await reserve(run2, 1_000, "call", U, "00000000-0000-4000-8000-0000000000ee")).r).toMatchObject({ ok: false, stopped_by: "run_closed" });
    await db.exec(`UPDATE public.ai_research_runs SET status='failed' WHERE id='${run2}'`);
    expect((await reserve(run2, 1_000)).r).toMatchObject({ ok: false, stopped_by: "run_closed" });
  });
  it("a call that finishes after the run closed is still accounted, flagged late", async () => {
    const run = await newRun();
    const id = (await reserve(run, 5_000)).r.reservation_id!;
    await db.exec(`UPDATE public.ai_research_runs SET status='cancelled' WHERE id='${run}'`);
    await as("service_role", null, `SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'${W}',4321,NULL)`);
    expect((await db.query<{ late: boolean }>(`SELECT settled_after_run_closed late FROM public.ai_research_budget_reservations WHERE id='${id}'`)).rows[0]!.late).toBe(true);
  });
  it("another worker cannot settle a reservation", async () => {
    const run = await newRun();
    const id = (await reserve(run, 5_000)).r.reservation_id!;
    await expect(as("service_role", null, `SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'00000000-0000-4000-8000-0000000000ee',1,NULL)`)).rejects.toThrow(/another worker/);
  });
  it("the ledger cannot be edited, deleted or truncated, and the backend can only read it", async () => {
    await expect(db.exec(`UPDATE public.ai_research_budget_reservations SET reserved_tokens=1 WHERE status='consumed'`)).rejects.toThrow(/cannot be changed/);
    await expect(db.exec(`DELETE FROM public.ai_research_budget_reservations`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.ai_research_budget_reservations`)).rejects.toThrow(/append-only/);
    await expect(as("service_role", null, `UPDATE public.ai_research_budget_reservations SET status='released'`)).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", U, `SELECT * FROM public.ai_research_budget_reservations`)).rejects.toThrow(/permission denied/);
  });
  it("per-user daily cap counts usage recorded before the ledger existed", async () => {
    const V = "00000000-0000-4000-8000-0000000000c8";
    const old = await newRun(V);
    await db.exec(`INSERT INTO public.ai_research_usage(run_id,user_id,agent,input_tokens,output_tokens) VALUES ('${old}','${V}','market',590000,5000)`);
    const run = await newRun(V);
    expect((await reserve(run, 10_000, "call", V)).r).toMatchObject({ ok: false, stopped_by: "user_day_tokens" });
  });
});
