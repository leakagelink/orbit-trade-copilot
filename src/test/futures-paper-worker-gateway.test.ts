// Phase 4G — DRAFT migration 0050 (hosted worker gateway) on top of DRAFT 0049, in PGlite. Neither is applied
// anywhere real. Covers privileges, fenced leases, the one-statement snapshot, cross-account refusal, provenance
// checks, the wall-clock entry window, the READ COMMITTED guard, status audit, idempotent replay and rollback.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { FPIntent } from "@/lib/futures-paper-engine";
import { selectClosedCandles, type RawSymbolBundle } from "@/lib/futures-paper-market-data";
import { buildCandleProvenance } from "@/lib/futures-paper-market-provenance";
import { viewFromRows } from "@/lib/futures-paper-worker";
import { CFG, M, STUB, MIGRATION_0049, accountBudget, as, freshUser, loadView, newAccount, rawBundle, stepView, strategyBudget } from "./helpers/fp-v3-harness";
import { CFG_H, HOLDER_A, HOLDER_B, MIGRATION_0050, NOW, ROLLBACK_0049, ROLLBACK_0050, callFn, expireLease, intentsFrom, makeGatewayDb, n, path } from "./helpers/fp-gateway-harness";

let db: PGlite;
beforeAll(async () => { db = await makeGatewayDb(); }, 120_000);
const T0 = NOW - 3_000 - 40 * M; // 40 closed one-minute candles, all within the last hour
const FNS = ["fpw_acquire_lease", "fpw_release_lease", "fpw_snapshot", "fpw_evaluated", "fpw_commit", "fpw_mark_review"];

async function setup(cfg = CFG_H) { const user = freshUser(); await accountBudget(db, user, 1000, 400, 600); await strategyBudget(db, user, "s1", "scalping", 500); const id = await newAccount(db, user, T0 - M, cfg); return { user, id }; }
const lease = async (id: string, holder = HOLDER_A) => Number((await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: holder, p_ttl_seconds: 60 })).data);
const bundlesAt = (barT: number, over?: (b: RawSymbolBundle) => RawSymbolBundle) => ["BTCUSDT", "ETHUSDT"].map((s) => { const b = rawBundle(s, barT, M, { trade: path(s, (barT - T0) / M) }, NOW); return over ? over(b) : b; });
async function prepare(id: string, barT: number, intents: FPIntent[] = [], over?: (b: RawSymbolBundle) => RawSymbolBundle) {
  const bundles = bundlesAt(barT, over), v = await loadView(db, id);
  const chk = selectClosedCandles(bundles, { symbols: v.symbols, timeframe: v.timeframe, barT, now: NOW, closeGraceMs: 2_000, maxFutureSkewMs: 5_000 });
  if (!chk.ok) throw new Error(chk.code);
  const step = stepView(v, chk.bars, intents);
  const prov = await buildCandleProvenance(bundles, { symbols: v.symbols, timeframe: v.timeframe, barT, now: NOW });
  if (!prov.ok) throw new Error(prov.code);
  return { v, step, payload: step.payload, provenance: prov.records as unknown[] };
}
const commit = (id: string, fence: number, seq: number, barT: number, payload: unknown, provenance: unknown, holder = HOLDER_A) =>
  callFn(db, "fpw_commit", { p_account: id, p_holder: holder, p_fence: fence, p_expected_seq: seq, p_bar_t: barT, p_payload: payload, p_provenance: provenance });
const counts = async (id: string) => [await n(db, `SELECT count(*)::int n FROM public.futures_paper_commits WHERE account_id=$1`, [id]), await n(db, `SELECT count(*)::int n FROM public.futures_paper_candles WHERE account_id=$1`, [id]), await n(db, `SELECT count(*)::int n FROM public.futures_paper_candle_provenance WHERE account_id=$1`, [id]), await n(db, `SELECT count(*)::int n FROM public.futures_paper_events WHERE account_id=$1`, [id])];
const intentAt = (barT: number, tag: string) => intentsFrom(T0, tag, 1).forCandle("acct00000000", barT);

describe("0050 installs only on top of 0049", () => {
  it("refuses to apply without 0049", async () => {
    const bare = new PGlite(); await bare.exec(STUB);
    await expect(bare.exec(MIGRATION_0050)).rejects.toThrow(/0050 requires draft 0049/);
  });
});

describe("privileges and row security", () => {
  it("browser roles cannot execute any gateway function; service_role can no longer call the 0049 commit directly", async () => {
    for (const role of ["anon", "authenticated"] as const) for (const fn of FNS) {
      const r = await as<{ ok: boolean }>(db, "service_role", `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE p.proname = $2`, [role, fn]);
      expect(r.rows[0]!.ok, `${role} ${fn}`).toBe(false);
    }
    const { id } = await setup();
    const direct = await callFn(db, "futures_paper_commit_bar_v3", { p_account: id, p_expected_seq: 0, p_bar_t: T0, p_payload: {} });
    expect(direct.error?.code).toBe("42501");
    for (const fn of FNS) expect((await as<{ ok: boolean }>(db, "service_role", `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE p.proname = $1`, [fn])).rows[0]!.ok, fn).toBe(true);
  });
  it("browser roles cannot read leases; owners read only their own provenance and audit rows", async () => {
    const a = await setup(), b = await setup();
    for (const s of [a, b]) { const f = await lease(s.id); const p = await prepare(s.id, T0); expect((await commit(s.id, f, 0, T0, p.payload, p.provenance)).error).toBeNull(); await callFn(db, "fpw_mark_review", { p_account: s.id, p_holder: HOLDER_A, p_fence: f, p_code: "TEST_HOLD" }); }
    await expect(as(db, "authenticated", `SELECT * FROM public.futures_paper_worker_leases`)).rejects.toThrow(/permission denied/);
    await expect(as(db, "anon", `SELECT * FROM public.futures_paper_candle_provenance`)).rejects.toThrow(/permission denied/);
    await db.exec(`SET test.uid = '${a.user}'`);
    try {
      const pv = await as<{ user_id: string }>(db, "authenticated", `SELECT user_id FROM public.futures_paper_candle_provenance`);
      const au = await as<{ user_id: string }>(db, "authenticated", `SELECT user_id FROM public.futures_paper_worker_audit`);
      expect(pv.rows.length).toBe(2); expect(au.rows.length).toBeGreaterThan(0);
      expect([...pv.rows, ...au.rows].every((r) => r.user_id === a.user)).toBe(true);
      await expect(as(db, "authenticated", `INSERT INTO public.futures_paper_worker_audit(account_id,user_id,code,actor) VALUES ($1,$2,'FAKE','x')`, [a.id, a.user])).rejects.toThrow(/permission denied/);
    } finally { await db.exec(`RESET test.uid`); }
  });
});

describe("fenced leases and the one-statement snapshot", () => {
  it("one holder at a time; an expired lease is taken over with a higher fence and the old holder is locked out", async () => {
    const { id } = await setup();
    expect(await lease(id, HOLDER_A)).toBe(1);
    expect((await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: HOLDER_B, p_ttl_seconds: 60 })).data).toBeNull();
    expect((await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: HOLDER_A, p_ttl_seconds: 60 })).data).toBeNull(); // no re-entry
    expect((await callFn(db, "fpw_acquire_lease", { p_account: id, p_holder: HOLDER_B, p_ttl_seconds: 5 })).error?.message).toMatch(/10\.\.300 s lease/);
    await expireLease(db, id);
    expect(await lease(id, HOLDER_B)).toBe(2);
    expect((await callFn(db, "fpw_snapshot", { p_account: id, p_holder: HOLDER_A, p_fence: 1 })).data).toBeNull();
    const p = await prepare(id, T0);
    expect((await commit(id, 1, 0, T0, p.payload, p.provenance, HOLDER_A)).error?.message).toMatch(/lease lost/);
    expect((await callFn(db, "fpw_mark_review", { p_account: id, p_holder: HOLDER_A, p_fence: 1, p_code: "X" })).error?.message).toMatch(/lease lost/);
    expect((await callFn(db, "fpw_release_lease", { p_account: id, p_holder: HOLDER_A, p_fence: 1 })).data).toBe(false);
    expect(await counts(id)).toEqual([0, 0, 0, 0]);
    expect((await commit(id, 2, 0, T0, p.payload, p.provenance, HOLDER_B)).data).toBe(0);
    expect((await callFn(db, "fpw_release_lease", { p_account: id, p_holder: HOLDER_B, p_fence: 2 })).data).toBe(true);
    expect(await lease(id, HOLDER_A)).toBe(3);
  });
  it("the snapshot equals the Phase 4F multi-query view and is empty without the lease", async () => {
    const { id } = await setup(); const f = await lease(id);
    const p = await prepare(id, T0, await intentAt(T0, "snap")); expect((await commit(id, f, 0, T0, p.payload, p.provenance)).error).toBeNull();
    const s = (await callFn(db, "fpw_snapshot", { p_account: id, p_holder: HOLDER_A, p_fence: f })).data as { account: Record<string, unknown>; account_budget: Record<string, unknown> | null; usage: Record<string, unknown>[]; costs: Record<string, unknown>[]; approvals: Record<string, unknown>[]; positions: Record<string, unknown>[] };
    const v = viewFromRows(s.account, s.account_budget, s.usage, s.costs, s.approvals, s.positions);
    expect(v).toEqual(await loadView(db, id));
    expect(Object.keys(v.ledger.approvals)).toEqual(["BTCUSDT"]);
    expect((await callFn(db, "fpw_snapshot", { p_account: id, p_holder: HOLDER_B, p_fence: f })).data).toBeNull();
  });
  it("evaluated proposals: the owner comes from the account; another user id is refused", async () => {
    const a = await setup(), b = await setup(); const f = await lease(a.id);
    const p = await prepare(a.id, T0, await intentAt(T0, "ev")); await commit(a.id, f, 0, T0, p.payload, p.provenance);
    const pid = (await intentAt(T0, "ev"))[0]!.proposal.proposalId;
    expect((await callFn(db, "fpw_evaluated", { p_account: a.id, p_holder: HOLDER_A, p_fence: f, p_user: a.user, p_ids: [pid, "nope"] })).data).toEqual([pid]);
    expect((await callFn(db, "fpw_evaluated", { p_account: a.id, p_holder: HOLDER_A, p_fence: f, p_user: b.user, p_ids: [pid] })).error?.message).toMatch(/cross-account access refused/);
  });
});

describe("the commit gateway", () => {
  it("records provenance with database hashes, never 'verified'; an identical replay writes nothing more", async () => {
    const { id } = await setup(); const f = await lease(id); const p = await prepare(id, T0);
    expect((await commit(id, f, 0, T0, p.payload, p.provenance)).data).toBe(0);
    expect(await counts(id)).toEqual([1, 2, 2, 0]);
    const rows = (await db.query<Record<string, unknown>>(`SELECT * FROM public.futures_paper_candle_provenance WHERE account_id=$1 ORDER BY symbol`, [id])).rows;
    for (const r of rows) {
      expect(r["independently_verified"]).toBe(false); expect(r["open_t"]).toBe(T0); expect(r["close_t"]).toBe(T0 + M - 1); expect(r["source"]).toBe("binance-public-usdm");
      expect(r["recorded_sha256"]).toBe((await db.query<{ h: string }>(`SELECT public.fpw_candle_digest($1,$2,$3,true) h`, [id, T0, r["symbol"]])).rows[0]!.h);
      expect(r["raw_sha256"]).toBe((p.provenance as { symbol: string; raw_sha256: string }[]).find((x) => x.symbol === r["symbol"])!.raw_sha256);
    }
    expect((await commit(id, f, 0, T0, p.payload, p.provenance)).data).toBe(0);
    expect(await counts(id)).toEqual([1, 2, 2, 0]);
  });
  it("refuses incomplete, mismatched, early, stale, unhashed or 'verified' provenance — and writes nothing", async () => {
    const { id } = await setup(); const f = await lease(id); const p = await prepare(id, T0);
    const base = p.provenance as Record<string, unknown>[];
    const bad: [string, unknown][] = [
      ["missing symbol", base.slice(0, 1)], ["duplicate symbol", [base[0], base[0]]], ["not an array", {}],
      ["wrong source", [{ ...base[0], source: "other" }, base[1]]], ["wrong timeframe", [{ ...base[0], timeframe: "5m" }, base[1]]],
      ["wrong open", [{ ...base[0], open_t: T0 + M }, base[1]]], ["wrong close", [{ ...base[0], close_t: T0 + M }, base[1]]],
      ["fetched before close", [{ ...base[0], fetched_at: T0 + 10 }, base[1]]], ["fetched in the future", [{ ...base[0], fetched_at: Date.now() + 60_000 }, base[1]]],
      ["fetched too long ago", [{ ...base[0], fetched_at: T0 + M }, base[1]]], ["no hash", [{ ...base[0], raw_sha256: "abc" }, base[1]]],
      ["claims verified", [{ ...base[0], independently_verified: true }, base[1]]], ["verification omitted", [{ ...base[0], independently_verified: undefined }, base[1]]],
    ];
    // "fetched too long ago" uses a candle 40 minutes old only when its fetch is that old; re-target it.
    bad[9] = ["fetched too long ago", [{ ...base[0], fetched_at: Date.now() - 16 * 60_000 }, base[1]]];
    for (const [why, prov] of bad) {
      const r = await commit(id, f, 0, T0, p.payload, JSON.parse(JSON.stringify(prov ?? null)));
      expect(r.error?.message, why).toMatch(/provenance/); expect(await counts(id), why).toEqual([0, 0, 0, 0]);
    }
  });
  it("the same public candle recorded with different prices for another account is refused", async () => {
    const a = await setup(), b = await setup(); const fa = await lease(a.id), fb = await lease(b.id);
    const pa = await prepare(a.id, T0); expect((await commit(a.id, fa, 0, T0, pa.payload, pa.provenance)).error).toBeNull();
    const pb = await prepare(b.id, T0, [], (x) => (x.symbol === "ETHUSDT" ? { ...x, trade: [[...(x.trade[0] as unknown[]).slice(0, 4), "49.99", ...(x.trade[0] as unknown[]).slice(5)]] } : x));
    expect((await commit(b.id, fb, 0, T0, pb.payload, pb.provenance)).error?.message).toMatch(/conflicts with the same public candle/);
    expect(await counts(b.id)).toEqual([0, 0, 0, 0]);
    const pb2 = await prepare(b.id, T0); expect((await commit(b.id, fb, 0, T0, pb2.payload, pb2.provenance)).error).toBeNull();
  });
  it("G1: new entries are refused when the candle closed longer ago than the account's max data age (database clock); exits/no-entry candles still commit", async () => {
    const { id } = await setup(CFG); const f = await lease(id); // CFG: 5 s data age; T0 closed ~40 minutes ago
    const withEntry = await prepare(id, T0, await intentAt(T0, "late"));
    expect(withEntry.payload.events.some((e: { kind: string }) => e.kind === "order_accepted")).toBe(true);
    expect((await commit(id, f, 0, T0, withEntry.payload, withEntry.provenance)).error?.message).toMatch(/new entries need data younger than 5000 ms/);
    expect(await counts(id)).toEqual([0, 0, 0, 0]);
    const none = await prepare(id, T0); expect((await commit(id, f, 0, T0, none.payload, none.provenance)).error).toBeNull();
  });
  it("G3: a commit inside REPEATABLE READ is refused (budget serialization needs per-statement snapshots)", async () => {
    const { id } = await setup(); const f = await lease(id); const p = await prepare(id, T0);
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await db.exec("SET LOCAL ROLE service_role");
      await expect(db.query(`SELECT public.fpw_commit($1::uuid,$2::uuid,$3::bigint,0,$4::bigint,$5::jsonb,$6::jsonb)`, [id, HOLDER_A, f, T0, JSON.stringify(p.payload), JSON.stringify(p.provenance)])).rejects.toThrow(/commits must run at READ COMMITTED \(found repeatable read\)/);
    } finally { await db.exec("ROLLBACK"); }
    expect(await counts(id)).toEqual([0, 0, 0, 0]);
  });
  it("G6: review holds and owner pause/resume leave append-only audit rows with bounded codes", async () => {
    const { id } = await setup(); const f = await lease(id);
    expect((await callFn(db, "fpw_mark_review", { p_account: id, p_holder: HOLDER_A, p_fence: f, p_code: "bad code; DROP" })).error?.message).toMatch(/review code/);
    expect((await callFn(db, "fpw_mark_review", { p_account: id, p_holder: HOLDER_A, p_fence: f, p_code: "FILL_INCONSISTENT" })).data).toBe(true);
    await as(db, "service_role", `UPDATE public.futures_paper_accounts SET status='active', status_reason=NULL WHERE id=$1`, [id]);
    await as(db, "service_role", `UPDATE public.futures_paper_accounts SET halted=true WHERE id=$1`, [id]);
    const rows = (await db.query<{ code: string; actor: string }>(`SELECT code, actor FROM public.futures_paper_worker_audit WHERE account_id=$1 ORDER BY id`, [id])).rows;
    expect(rows.map((r) => r.code)).toEqual(["STATUS:ACTIVE>PAUSED", "REVIEW:FILL_INCONSISTENT", "STATUS:PAUSED>ACTIVE", "HALTED:FALSE>TRUE"]);
    expect(rows.slice(0, 2).map((r) => r.actor)).toEqual(["worker", "worker"]);
    await expect(db.query(`UPDATE public.futures_paper_worker_audit SET code='X' WHERE account_id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM public.futures_paper_candle_provenance`)).rejects.toThrow(/append-only/);
  });
});

describe("rollback", () => {
  it("0050 rollback restores the 0049 grant; 0050 then 0049 rollback leaves no paper object behind", async () => {
    const d = await makeGatewayDb();
    await d.exec(ROLLBACK_0050);
    const r = await d.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'public.futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)', 'EXECUTE') ok`);
    expect(r.rows[0]!.ok).toBe(true);
    expect((await d.query(`SELECT 1 FROM pg_proc WHERE proname LIKE 'fpw\\_%'`)).rows).toEqual([]);
    await d.exec(ROLLBACK_0049);
    expect((await d.query(`SELECT relname FROM pg_class WHERE relname LIKE 'futures\\_paper%' OR relname LIKE '%risk\\_budget%'`)).rows).toEqual([]);
    expect((await d.query(`SELECT proname FROM pg_proc WHERE proname ~ '^(fp2_|fp3_|fpw_|futures_paper|guard_futures_paper|guard_account_risk|guard_strategy_risk)'`)).rows).toEqual([]);
  });
  it("0049 rollback alone is refused while 0050 depends on it (rollback order is enforced)", async () => {
    const d = await makeGatewayDb();
    await expect(d.exec(`BEGIN; ${ROLLBACK_0049} COMMIT;`)).rejects.toThrow();
    await d.exec("ROLLBACK").catch(() => {});
    expect((await d.query(`SELECT 1 FROM pg_class WHERE relname = 'futures_paper_worker_leases'`)).rows.length).toBe(1);
  });
});
