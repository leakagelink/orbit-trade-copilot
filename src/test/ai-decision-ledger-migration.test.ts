// Runs DRAFT migration 0043 (and its rollback) verbatim in an in-memory Postgres (PGlite). Nothing touches the real database.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RESEARCH_AGENTS } from "@/lib/research-pipeline";

const MIGRATION = readFileSync("docs/proposed-migrations/0043_ai_decision_records_and_research_budget.sql", "utf8");
const ROLLBACK = readFileSync("docs/proposed-migrations/0043_ai_decision_records_and_research_budget.rollback.sql", "utf8");
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b", ADMIN = "00000000-0000-4000-8000-0000000000ad";
const RA = "00000000-0000-4000-8000-0000000000a1", RB = "00000000-0000-4000-8000-0000000000b1";
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; -- as on the hosted database
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $$;
CREATE TABLE public.ai_research_runs (id uuid PRIMARY KEY, user_id uuid NOT NULL, symbol text NOT NULL, status text NOT NULL DEFAULT 'running' CONSTRAINT ai_research_runs_status_check CHECK (status IN ('running','completed','partial','failed')), error text, snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE TABLE public.ai_agent_outputs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, agent text, status text, report jsonb);
CREATE TABLE public.ai_research_reports (LIKE public.ai_agent_outputs INCLUDING DEFAULTS);
CREATE TABLE public.ai_research_decisions (LIKE public.ai_agent_outputs INCLUDING DEFAULTS);
CREATE TABLE public.ai_trade_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, proposal jsonb);
CREATE TABLE public.ai_research_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, user_id uuid, agent text, input_tokens int, output_tokens int);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO public.user_roles VALUES ('${ADMIN}', 'admin');
INSERT INTO public.ai_research_runs VALUES ('${RA}', '${A}', 'AAPL'), ('${RB}', '${B}', 'BTC-USD');
INSERT INTO public.ai_agent_outputs(run_id,user_id,agent,status,report) VALUES ('${RA}','${A}','market','completed','{}');
INSERT INTO public.ai_research_usage(run_id,user_id,agent,input_tokens,output_tokens) VALUES ('${RA}','${A}','market',1,1);
`;
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
    const r = await as("authenticated", A, "SELECT per_run_tokens FROM public.ai_research_budget_config");
    expect(r.rows).toEqual([{ per_run_tokens: 100000 }]);
    const ev = await db.query<{ n: number }>("SELECT count(*)::int n FROM public.ai_research_budget_events");
    expect(ev.rows[0]!.n).toBe(1);
    await expect(db.exec("DELETE FROM public.ai_research_budget_events")).rejects.toThrow(/append-only/);
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
  }, 60_000);
  it("relabels runs with statuses the original list does not allow", async () => {
    const d = new PGlite(); await d.exec(STUB); await d.exec(MIGRATION);
    await d.exec(`UPDATE public.ai_research_runs SET status='cancelled' WHERE id='${RA}'`);
    await d.exec(ROLLBACK);
    const r = await d.query<{ status: string; error: string }>(`SELECT status, error FROM public.ai_research_runs WHERE id='${RA}'`);
    expect(r.rows[0]).toEqual({ status: "partial", error: "Cancelled: no reason recorded" });
  }, 60_000);
});
