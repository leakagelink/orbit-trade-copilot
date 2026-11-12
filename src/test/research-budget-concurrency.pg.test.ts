// Multi-session concurrency tests for draft migration 0043's atomic research budget reservations.
// Needs a real PostgreSQL (separate sessions); run with scripts/research-budget/concurrency-check.sh, which starts a
// throwaway local server. Skipped when RESEARCH_PG_URL is not set. Never touches the live database.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { RESEARCH_DB_STUB } from "./fixtures/research-db-stub";

const URL = process.env["RESEARCH_PG_URL"];
const MIGRATION = readFileSync("docs/proposed-migrations/0043_ai_decision_records_and_research_budget.sql", "utf8");
const W = "00000000-0000-4000-8000-0000000000e9";
const uid = (prefix: string, n: number) => `00000000-0000-4000-${prefix}-${String(n).padStart(12, "0")}`;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = [];
const connect = (url: string, max = 1) => { const s = postgres(url, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
afterAll(async () => { await Promise.all(opened.map((s) => s.end({ timeout: 2 }))); });

let dbn = 0;
/** A fresh database with the research stand-in, migration 0043 and the given limits. */
async function freshDb(limits: { perRun: number; day: number; month: number; platform: number; calls?: number }) {
  const admin = connect(URL!);
  const name = `research_cc_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = URL!.replace(/\/[^/]*$/, `/${name}`);
  const owner = connect(url);
  // Roles are cluster-wide: create them once, ignore "already exists".
  const stub = RESEARCH_DB_STUB.replace("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;", () => "DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
  await owner.unsafe(stub);
  await owner.unsafe(MIGRATION);
  await owner.unsafe(`INSERT INTO public.ai_research_budget_config (id, per_run_tokens, per_user_day_tokens, per_user_month_tokens, platform_month_tokens, max_calls_per_run, max_repairs_per_run, max_run_seconds, updated_by)
    VALUES (true, ${limits.perRun}, ${limits.day}, ${limits.month}, ${limits.platform}, ${limits.calls ?? 60}, 3, 1200, gen_random_uuid())`);
  return { url, owner };
}
/** One worker-claimed running run per (user, run) pair. */
async function runs(owner: Sql, pairs: { user: string; run: string }[]) {
  for (const p of pairs) {
    await owner.unsafe(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${p.run}','${p.user}','AAPL')`);
    await owner.unsafe(`SELECT public.claim_ai_research_worker('${p.run}','${p.user}','${W}')`);
  }
}
/** Separate sessions, each already connected and acting as the backend role. */
async function sessions(url: string, n: number) {
  const out = Array.from({ length: n }, () => connect(url));
  await Promise.all(out.map((s) => s.unsafe("SET ROLE service_role")));
  return out;
}
const reserveSql = (run: string, user: string, tokens: number) => `SELECT public.reserve_ai_research_budget('${run}','${user}','${W}','market','call',${tokens}) AS r`;
// Counted tokens (the stand-in schema already holds 2 legacy usage tokens for another user, which count platform-wide).
const counted = async (owner: Sql, user: string | null = null) => Number((await owner.unsafe(`SELECT public.ai_research_counted_tokens(${user ? `'${user}'` : "NULL"}, '-infinity') AS n`))[0]!["n"]);
const race = (ss: Sql[], sql: (i: number) => string) => Promise.all(ss.map((s, i) => s.unsafe(sql(i)).then((rows) => rows[0]!["r"] as { ok: boolean; stopped_by?: string })));

describe.skipIf(!URL)("atomic research budget reservations under concurrent sessions", () => {
  it("platform monthly cap: 24 users racing in 24 sessions never exceed it", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    const pairs = Array.from({ length: 24 }, (_, i) => ({ user: uid("8001", i), run: uid("9001", i) }));
    await runs(owner, pairs);
    const ss = await sessions(url, 24);
    const out = await race(ss, (i) => reserveSql(pairs[i]!.run, pairs[i]!.user, 7_000));
    expect(out.filter((r) => r.ok)).toHaveLength(7); // 7 x 7,000 = 49,000 <= 50,000
    expect(out.filter((r) => !r.ok).every((r) => r.stopped_by === "platform_month_tokens")).toBe(true);
    expect(await counted(owner)).toBeLessThanOrEqual(50_000);
  }, 60_000);
  it("per-user daily cap: two runs of the same user racing in 20 sessions never exceed it", async () => {
    const { url, owner } = await freshDb({ perRun: 100_000, day: 20_000, month: 1_000_000, platform: 10_000_000 });
    const user = uid("8002", 1), pairs = [{ user, run: uid("9002", 1) }, { user, run: uid("9002", 2) }];
    await runs(owner, pairs);
    const ss = await sessions(url, 20);
    const out = await race(ss, (i) => reserveSql(pairs[i % 2]!.run, user, 5_000));
    expect(out.filter((r) => r.ok)).toHaveLength(4);
    expect(out.filter((r) => !r.ok).every((r) => r.stopped_by === "user_day_tokens")).toBe(true);
    expect(await counted(owner, user)).toBe(20_000);
  }, 60_000);
  it("per-user monthly cap under concurrency", async () => {
    const { url, owner } = await freshDb({ perRun: 100_000, day: 1_000_000, month: 30_000, platform: 10_000_000 });
    const user = uid("8003", 1), pairs = [1, 2, 3].map((n) => ({ user, run: uid("9003", n) }));
    await runs(owner, pairs);
    const ss = await sessions(url, 15);
    const out = await race(ss, (i) => reserveSql(pairs[i % 3]!.run, user, 7_000));
    expect(out.filter((r) => r.ok)).toHaveLength(4); // 28,000 <= 30,000
    expect(out.filter((r) => !r.ok).every((r) => r.stopped_by === "user_month_tokens")).toBe(true);
  }, 60_000);
  it("per-run cap: parallel calls inside one run never exceed it", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 1_000_000, month: 1_000_000, platform: 10_000_000 });
    const p = { user: uid("8004", 1), run: uid("9004", 1) };
    await runs(owner, [p]);
    const ss = await sessions(url, 10);
    const out = await race(ss, () => reserveSql(p.run, p.user, 15_000));
    expect(out.filter((r) => r.ok)).toHaveLength(3);
    expect(out.filter((r) => !r.ok).every((r) => r.stopped_by === "per_run_tokens")).toBe(true);
  }, 60_000);
  it("call limit under concurrency", async () => {
    const { url, owner } = await freshDb({ perRun: 1_000_000, day: 10_000_000, month: 10_000_000, platform: 100_000_000, calls: 5 });
    const p = { user: uid("8005", 1), run: uid("9005", 1) };
    await runs(owner, [p]);
    const ss = await sessions(url, 12);
    const out = await race(ss, () => reserveSql(p.run, p.user, 1_000));
    expect(out.filter((r) => r.ok)).toHaveLength(5);
    expect(out.filter((r) => !r.ok).every((r) => r.stopped_by === "max_calls")).toBe(true);
  }, 60_000);
  it("a second reservation waits for the first session's transaction, then sees it", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    const a = { user: uid("8006", 1), run: uid("9006", 1) }, b = { user: uid("8006", 2), run: uid("9006", 2) };
    await runs(owner, [a, b]);
    const [s1, s2] = await sessions(url, 2);
    const tx = await s1!.reserve();
    await tx.unsafe("BEGIN"); await tx.unsafe("SET LOCAL ROLE service_role");
    expect(((await tx.unsafe(reserveSql(a.run, a.user, 30_000)))[0]!["r"] as { ok: boolean }).ok).toBe(true);
    let settled = false;
    const second = s2!.unsafe(reserveSql(b.run, b.user, 30_000)).then((rows) => { settled = true; return rows[0]!["r"] as { ok: boolean; stopped_by?: string }; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false); // blocked on the platform-wide lock, not reading a stale total
    await tx.unsafe("COMMIT"); tx.release();
    expect(await second).toMatchObject({ ok: false, stopped_by: "platform_month_tokens" });
  }, 60_000);
  it("settlement reconciles concurrently: freed headroom is granted exactly once", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    const pairs = Array.from({ length: 10 }, (_, i) => ({ user: uid("8007", i), run: uid("9007", i) }));
    await runs(owner, pairs);
    const [s0] = await sessions(url, 1);
    const id = ((await s0!.unsafe(reserveSql(pairs[0]!.run, pairs[0]!.user, 45_000)))[0]!["r"] as { reservation_id: string }).reservation_id;
    await s0!.unsafe(`SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'${W}',15000,NULL)`); // 30,000 freed
    const ss = await sessions(url, 9);
    const out = await race(ss, (i) => reserveSql(pairs[i + 1]!.run, pairs[i + 1]!.user, 10_000));
    expect(out.filter((r) => r.ok)).toHaveLength(3); // 2 legacy + 15,000 + 3 x 10,000 = 45,002 <= 50,000; a 4th would pass it
    expect(await counted(owner)).toBe(45_002);
  }, 60_000);
  it("exactly one of 20 concurrent workers can claim a run", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    const run = uid("9008", 1), user = uid("8008", 1);
    await owner.unsafe(`INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('${run}','${user}','AAPL')`);
    const ss = await sessions(url, 20);
    const out = await Promise.all(ss.map((s, i) => s.unsafe(`SELECT public.claim_ai_research_worker('${run}','${user}','${uid("7008", i)}') AS ok`).then((r) => r[0]!["ok"] as boolean)));
    expect(out.filter(Boolean)).toHaveLength(1);
  }, 60_000);
  it("cancellation racing a reservation: closing the run waits for the reservation, then every later call is refused", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    const p = { user: uid("8009", 1), run: uid("9009", 1) };
    await runs(owner, [p]);
    const [s1, s2] = await sessions(url, 2);
    const tx = await s1!.reserve();
    await tx.unsafe("BEGIN"); await tx.unsafe("SET LOCAL ROLE service_role");
    const id = ((await tx.unsafe(reserveSql(p.run, p.user, 5_000)))[0]!["r"] as { reservation_id: string }).reservation_id;
    let closed = false;
    const close = s2!.unsafe(`UPDATE public.ai_research_runs SET status='cancelled', error='Cancelled' WHERE id='${p.run}' AND status='running'`).then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false); // the run row is locked by the in-progress reservation
    await tx.unsafe("COMMIT"); tx.release();
    await close;
    // The in-flight call finishes after the close: its usage is accounted (flagged late), its output is refused.
    await s1!.unsafe(`SELECT public.settle_ai_research_budget(ARRAY['${id}']::uuid[],'${W}',4000,NULL)`);
    expect((await owner.unsafe(`SELECT settled_after_run_closed AS late FROM public.ai_research_budget_reservations WHERE id='${id}'`))[0]!["late"]).toBe(true);
    await expect(s1!.unsafe(`INSERT INTO public.ai_research_reports(run_id,user_id,agent,status,report) VALUES ('${p.run}','${p.user}','market','completed','{}')`)).rejects.toThrow(/in progress/);
    expect(((await s1!.unsafe(reserveSql(p.run, p.user, 1_000)))[0]!["r"] as { stopped_by: string }).stopped_by).toBe("run_closed");
  }, 60_000);
  it("control: the same checks without the lock DO overshoot (so these tests can detect a race)", async () => {
    const { url, owner } = await freshDb({ perRun: 50_000, day: 50_000, month: 50_000, platform: 50_000 });
    await owner.unsafe(`CREATE FUNCTION public.naive_reserve(_run uuid, _user uuid, _tokens bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN IF public.ai_research_counted_tokens(NULL, '-infinity') + _tokens > 50000 THEN RETURN false; END IF; PERFORM pg_sleep(0.05);
      INSERT INTO public.ai_research_budget_reservations(run_id,user_id,worker_id,agent,kind,reserved_tokens) VALUES (_run,_user,'${W}','market','call',_tokens); RETURN true; END $$;
      GRANT EXECUTE ON FUNCTION public.naive_reserve(uuid, uuid, bigint) TO service_role;`);
    const pairs = Array.from({ length: 12 }, (_, i) => ({ user: uid("8010", i), run: uid("9010", i) }));
    await runs(owner, pairs);
    const ss = await sessions(url, 12);
    const out = await Promise.all(ss.map((s, i) => s.unsafe(`SELECT public.naive_reserve('${pairs[i]!.run}','${pairs[i]!.user}',10000) AS ok`).then((r) => r[0]!["ok"] as boolean)));
    expect(out.filter(Boolean).length).toBeGreaterThan(5); // more than the cap allows
    expect(await counted(owner)).toBeGreaterThan(50_000);
  }, 60_000);
});
