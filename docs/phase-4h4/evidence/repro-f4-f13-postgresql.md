# F4 / F13 reproduction on a throwaway local PostgreSQL — run 2026-11-14T03:28:31Z

Command: `/tmp/phase4h4/run-pg.sh` (throwaway cluster in /tmp on 127.0.0.1, unprivileged OS user; drafts 0049→0054 read byte-for-byte; never the live database). Scripts kept outside the project; full text below.

## Output
```json
{
 "server": "17.11",
 "F4_admin_promotion": {
  "concurrentChangeBlockedByInFlightCall": false,
  "concurrentChange": "committed",
  "inFlightCallCommitted": true,
  "leaseRowsWrittenByThatCall": 1,
  "auditCodes": [
   "ID:ENROLLED",
   "ID:LEASE_ACQUIRED"
  ],
  "nextCall": "refused: futures paper worker: worker identity is no longer eligible (it has an admin role)"
 },
 "F4_worker_owned_account": {
  "concurrentChangeBlockedByInFlightCall": false,
  "concurrentChange": "committed",
  "inFlightCallCommitted": true,
  "leaseRowsWrittenByThatCall": 1,
  "auditCodes": [
   "ID:ENROLLED",
   "ID:LEASE_ACQUIRED"
  ],
  "nextCall": "refused: futures paper worker: worker identity is no longer eligible (it owns a paper account)"
 },
 "F13": {
  "auditRowsBefore": 2,
  "refusedWorkerCall": "refused: futures paper worker: account not enrolled for this worker identity",
  "auditRowsAfterRefusedCall": 2,
  "deleteAsServiceRole": "refused: permission denied for table futures_paper_worker_audit",
  "deleteAsOwnerWithTriggers": "refused: futures paper history is append-only (DELETE on futures_paper_worker_audit)",
  "triggerStateAfterDisable": "D",
  "deleteAsOwnerTriggersDisabled": "deleted 1",
  "deleteAsSuperuserReplicaRole": "deleted 1",
  "statusUpdates": [
   "ok",
   "ok",
   "ok"
  ],
  "configChangeRows": 5,
  "statusChainVersionsBefore": [
   1,
   2,
   3
  ],
  "deleteMiddleVersion2_brokenLinks": 1,
  "versionsAfterMiddleDelete": [
   1,
   3
  ],
  "thenDeleteNewestVersion3_brokenLinks": 0,
  "versionsAfterTailDelete": [
   1
  ],
  "configChangeRowsLeft": 3
 }
}
```

## Runner (verbatim)
```bash
#!/usr/bin/env bash
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE SUPABASE_DB_URL || true
WORK=$(mktemp -d /tmp/phase4h4-pg.XXXXXX); PGL="$WORK/pg"; PORT=55494
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" start -w >/dev/null
cd /dev-server && REPRO_PG_URL="postgres://postgres@127.0.0.1:$PORT/postgres" NODE_PATH=/dev-server/node_modules bun /tmp/phase4h4/repro-pg.ts
```

## Script (verbatim)
```ts
// Phase 4H.4 reproduction on a THROWAWAY local PostgreSQL (127.0.0.1, /tmp). Drafts 0049→0054 read byte-for-byte from
// docs/proposed-migrations; nothing in the project is changed and the live database is never contacted.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { initialFuturesPaperState } from "/dev-server/src/lib/futures-paper-engine.ts";
import { CFG } from "/dev-server/src/test/helpers/fp-v3-harness.ts";
const URL = process.env["REPRO_PG_URL"]!;
if (!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\//.test(URL)) throw new Error("local throwaway database only");
const MIG = ["0049_futures_paper_ledger_v3", "0050_futures_paper_worker_gateway", "0051_futures_paper_event_completeness", "0052_futures_paper_entry_completeness_and_exit_only", "0053_futures_paper_worker_identity", "0054_futures_paper_worker_identity_lifecycle"].map((f) => readFileSync(`/dev-server/docs/proposed-migrations/${f}.sql`, "utf8"));
const role = (r: string, extra = "") => `DO $$ BEGIN CREATE ROLE ${r} ${extra}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
const STUB = `${role("anon")} ${role("authenticated")} ${role("service_role", "BYPASSRLS")}
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TYPE public.app_role AS ENUM ('user','admin','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;`;
type Sql = ReturnType<typeof postgres>;
const opened: Sql[] = []; const connect = (u: string, max = 1) => { const s = postgres(u, { max, onnotice: () => {}, idle_timeout: 5 }); opened.push(s); return s; };
let un = 0, dbn = 0; const uid = () => `00000000-0000-4000-9444-${(++un).toString(16).padStart(12, "0")}`;
const HOLDER = "00000000-0000-4000-8000-00000000aaaa";
async function freshDb() {
  const admin = connect(URL), name = `repro4h4_${process.pid}_${++dbn}`;
  await admin.unsafe(`CREATE DATABASE ${name}`); await admin.unsafe(`ALTER DATABASE ${name} SET futures_paper.change_reason = 'repro fixture'`);
  const url = URL.replace(/\/[^/]*$/, `/${name}`), owner = connect(url, 4);
  await owner.unsafe(STUB); for (const m of MIG) await owner.unsafe(m); return { url, owner };
}
const asUser = <T>(sql: Sql, who: string, f: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE authenticated`); await tx.unsafe(`SELECT set_config('test.uid', $1, true)`, [who]); return f(tx); }) as Promise<T>;
const asService = <T>(sql: Sql, f: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); return f(tx); }) as Promise<T>;
const newAccount = (sql: Sql, user: string) => asService(sql, (tx) => tx.unsafe(`INSERT INTO public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state)
  VALUES ($1, 'futures-paper-v1', 'binance-public-usdm', ARRAY['BTCUSDT','ETHUSDT'], '1m', $2::jsonb, 1000, 0, $3::jsonb) RETURNING id`, [user, CFG, initialFuturesPaperState(1000)] as never[])).then((r) => String(r[0]!["id"]));
async function world(owner: Sql) {
  const ADMIN = uid(), WORKER = uid(), OWNER = uid();
  await owner.unsafe(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [ADMIN]);
  const ACCOUNT = await newAccount(owner, OWNER);
  await asUser(owner, ADMIN, (tx) => tx.unsafe(`SELECT public.fpw_admin_set_identity($1, 'paper-worker', true)`, [WORKER]));
  await asUser(owner, OWNER, (tx) => tx.unsafe(`SELECT public.fpw_owner_enroll($1, $2)`, [ACCOUNT, WORKER]));
  return { ADMIN, WORKER, OWNER, ACCOUNT };
}
const waitIdleInTx = async (mon: Sql) => { for (let i = 0; i < 200; i++) { if ((await mon.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`)).length) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
const acquire = (tx: postgres.TransactionSql, a: string) => tx.unsafe(`SELECT public.fpw_id_acquire_lease($1, $2, 30) AS f`, [a, HOLDER]);
const out: Record<string, unknown> = { server: "" };
const timed = async <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ done: true as const, v })), new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms))]);

async function f4(kind: "admin_promotion" | "worker_owned_account") {
  const { url, owner } = await freshDb(); const w = await world(owner);
  const a = connect(url), b = connect(url), mon = connect(url);
  out["server"] = String((await owner.unsafe(`SHOW server_version`))[0]!["server_version"]);
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  // The worker's writing call has passed fpw_id_check (roles + ownership) and is still running (transaction open).
  const worker = asUser(a, w.WORKER, async (tx) => { const f = await acquire(tx, w.ACCOUNT); await hold; return Number(f[0]!["f"]); });
  await waitIdleInTx(mon);
  const change = kind === "admin_promotion" ? owner.unsafe(`INSERT INTO public.user_roles VALUES ($1, 'admin')`, [w.WORKER]).then(() => "committed") : newAccount(b, w.WORKER).then(() => "committed");
  const c = await timed(change, 2000); // does the concurrent change wait for the in-flight call?
  release(); const fence = await worker;
  const leaseRows = (await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_worker_leases WHERE account_id=$1 AND holder=$2`, [w.ACCOUNT, HOLDER]))[0]!["n"];
  const audit = (await owner.unsafe(`SELECT code FROM public.futures_paper_worker_audit WHERE account_id=$1 ORDER BY id`, [w.ACCOUNT])).map((x) => x["code"]);
  const next = await asUser(a, w.WORKER, (tx) => tx.unsafe(`SELECT public.fpw_id_snapshot($1, $2, $3) AS s`, [w.ACCOUNT, HOLDER, fence])).then(() => "allowed", (e: Error) => `refused: ${e.message}`);
  out[`F4_${kind}`] = { concurrentChangeBlockedByInFlightCall: !c.done, concurrentChange: c.done ? c.v : "waited", inFlightCallCommitted: fence > 0, leaseRowsWrittenByThatCall: leaseRows, auditCodes: audit, nextCall: next };
}
async function f13() {
  const { owner } = await freshDb(); const w = await world(owner);
  await asUser(owner, w.WORKER, (tx) => acquire(tx, w.ACCOUNT));
  const count = async (t: string) => Number((await owner.unsafe(`SELECT count(*)::int n FROM public.${t}`))[0]!["n"]);
  const before = await count("futures_paper_worker_audit");
  // Refused worker calls leave no audit row: a second (non-enrolled) account, then call.
  const other = await newAccount(owner, w.OWNER);
  const refused = await asUser(owner, w.WORKER, (tx) => acquire(tx, other)).then(() => "allowed", (e: Error) => `refused: ${e.message}`);
  const afterRefused = await count("futures_paper_worker_audit");
  const asApi = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE service_role`); await tx.unsafe(`DELETE FROM public.futures_paper_worker_audit`); return "deleted"; }).then((x) => x, (e: Error) => `refused: ${e.message.slice(0, 80)}`);
  const asOwnerTrig = await owner.unsafe(`DELETE FROM public.futures_paper_worker_audit`).then(() => "deleted", (e: Error) => `refused: ${e.message.slice(0, 80)}`);
  await owner.unsafe(`ALTER TABLE public.futures_paper_worker_audit DISABLE TRIGGER USER`);
  const tg = (await owner.unsafe(`SELECT string_agg(DISTINCT tgenabled::text, ',') e FROM pg_trigger WHERE tgrelid='public.futures_paper_worker_audit'::regclass AND NOT tgisinternal`))[0]!["e"];
  const del1 = await owner.unsafe(`DELETE FROM public.futures_paper_worker_audit WHERE id = (SELECT min(id) FROM public.futures_paper_worker_audit) RETURNING id`).then((r) => `deleted ${r.length}`, (e: Error) => `refused: ${e.message.slice(0, 80)}`);
  await owner.unsafe(`ALTER TABLE public.futures_paper_worker_audit ENABLE TRIGGER USER`);
  const del2 = await owner.begin(async (tx) => { await tx.unsafe(`SET LOCAL session_replication_role = replica`); const r = await tx.unsafe(`DELETE FROM public.futures_paper_worker_audit RETURNING id`); return `deleted ${r.length}`; }).then((x) => x, (e: Error) => `refused: ${e.message.slice(0, 80)}`);
  // Hash chain (0052): create several config changes for one account, then tamper as the owner.
  const upd = async (st: string) => asService(owner, (tx) => tx.unsafe(`UPDATE public.futures_paper_accounts SET status = $2 WHERE id = $1`, [w.ACCOUNT, st])).then(() => "ok", (e: Error) => `refused: ${e.message.slice(0, 80)}`);
  const updates = [await upd("paused"), await upd("active"), await upd("paused")];
  const broken = async () => Number((await owner.unsafe(`SELECT count(*)::int n FROM public.futures_paper_config_changes c WHERE c.prev_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.futures_paper_config_changes p WHERE p.chain_sha256 = c.prev_sha256)`))[0]!["n"]);
  const rows0 = await count("futures_paper_config_changes");
  const tamper = async (q: string) => { await owner.unsafe(`ALTER TABLE public.futures_paper_config_changes DISABLE TRIGGER USER`); await owner.unsafe(q); await owner.unsafe(`ALTER TABLE public.futures_paper_config_changes ENABLE TRIGGER USER`); };
  const statusVersions = async () => (await owner.unsafe(`SELECT version FROM public.futures_paper_config_changes WHERE entity='account_status' AND entity_key=$1 ORDER BY version`, [w.ACCOUNT])).map((x) => Number(x["version"]));
  const versionsBefore = await statusVersions();
  await tamper(`DELETE FROM public.futures_paper_config_changes WHERE entity='account_status' AND entity_key='${w.ACCOUNT}' AND version = 2`);
  const brokenAfterMiddle = await broken(), versionsAfterMiddle = await statusVersions();
  await tamper(`DELETE FROM public.futures_paper_config_changes WHERE entity='account_status' AND entity_key='${w.ACCOUNT}' AND version = 3`);
  const brokenAfterTail = await broken(), versionsAfterTail = await statusVersions();
  out["F13"] = { auditRowsBefore: before, refusedWorkerCall: refused, auditRowsAfterRefusedCall: afterRefused, deleteAsServiceRole: asApi, deleteAsOwnerWithTriggers: asOwnerTrig,
    triggerStateAfterDisable: tg, deleteAsOwnerTriggersDisabled: del1, deleteAsSuperuserReplicaRole: del2,
    statusUpdates: updates, configChangeRows: rows0, statusChainVersionsBefore: versionsBefore, deleteMiddleVersion2_brokenLinks: brokenAfterMiddle, versionsAfterMiddleDelete: versionsAfterMiddle, thenDeleteNewestVersion3_brokenLinks: brokenAfterTail, versionsAfterTailDelete: versionsAfterTail, configChangeRowsLeft: await count("futures_paper_config_changes") };
}
try { await f4("admin_promotion"); await f4("worker_owned_account"); await f13(); console.log(JSON.stringify(out, null, 1)); }
finally { await Promise.all(opened.map((s) => s.end({ timeout: 2 }).catch(() => {}))); }
```
