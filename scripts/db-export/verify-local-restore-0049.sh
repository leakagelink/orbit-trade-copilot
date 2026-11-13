#!/usr/bin/env bash
# LOCAL-ONLY restore verifier for DRAFT migration 0049 (Futures paper ledger v3, replacement of 0046 which the owner did
# not approve). Phase 4E follow-up. NOT a Cloud restore test and NOT an approval to apply anything.
#
# Usage: scripts/db-export/verify-local-restore-0049.sh /path/to/export.backup
#   Optional env: REPORT=/tmp/0049-restore.md, MIGRATION / ROLLBACK (draft paths).
#
# Same isolation as verify-local-restore-0048.sh, whose prelude this file repeats verbatim: only an explicit local
# pg_dump custom-format file; URLs, bucket paths, connection strings and extra arguments are refused; DATABASE_URL, PG*,
# SUPABASE_* and LOVABLE_DB_* are unset; a disposable PostgreSQL in a fresh /tmp directory listening on a private UNIX
# socket only; every psql/pg_restore call goes through one guarded helper bound to that socket.
# 0049-specific checks: objects absent before; 0049 applied in ONE transaction; RLS, owner-read MFA-aware policies,
# grants (ledger tables read-only for every API role; configuration tables writable only by service_role), EXECUTE,
# SECURITY DEFINER + search_path, triggers; probes inside rolled-back transactions (a fill without an approval, a
# worker-supplied risk figure and a browser-role budget write are all refused); no rows created; rollback in ONE
# transaction; nothing left behind; coexistence with draft 0048; refusal on top of draft 0046 (never both); pre-existing
# fingerprint and row counts unchanged throughout. Counts/hashes only.
set -euo pipefail
refuse(){ echo "REFUSED: $*" >&2; exit 2; }
[[ $# -eq 1 ]] || refuse "exactly one argument (a local backup file) is required; connection targets are not accepted"
SRC="$1"
[[ "$SRC" =~ :// || "$SRC" =~ ^[a-z]+: || "$SRC" =~ (host=|dbname=|user=|password=|sslmode=|supabase|pooler|amazonaws|\.co/|@) ]] && refuse "'$SRC' looks like a URL or connection string; only a local file path is accepted"
[[ -e "$SRC" ]] || refuse "'$SRC' is not an existing local file (bucket paths and downloads are not supported)"
[[ -f "$SRC" && -r "$SRC" ]] || refuse "'$SRC' is not a readable regular file"
AMBIENT=""
for v in DATABASE_URL PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE PGOPTIONS LOVABLE_DB_MIGRATION_URL SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -n "${!v:-}" ]]; then AMBIENT+="$v "; fi; unset "$v" || true
done
[[ -n "$AMBIENT" ]] && echo "note: ambient connection variables ignored and unset: $AMBIENT" >&2
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MIG="${MIGRATION:-$ROOT/docs/proposed-migrations/0049_futures_paper_ledger_v3.sql}"; RB="${ROLLBACK:-$ROOT/docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql}"
M48="$ROOT/docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql"; R48="$ROOT/docs/proposed-migrations/0048_futures_strategy_attribution_v2.rollback.sql"
M46="$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.sql"; R46="$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql"
[[ -f "$MIG" && -f "$RB" && -f "$M46" && -f "$R46" && -f "$M48" && -f "$R48" ]] || refuse "draft migration or rollback file missing"
FILE=$(readlink -f "$SRC"); SHA=$(sha256sum "$FILE" | cut -d' ' -f1); SIZE=$(stat -c %s "$FILE")
MIG_SHA=$(sha256sum "$MIG" | cut -d' ' -f1); RB_SHA=$(sha256sum "$RB" | cut -d' ' -f1)
OUT="${REPORT:-/tmp/verify-0049-$(date -u +%Y%m%dT%H%M%SZ).md}"

WORK=$(mktemp -d /tmp/verify-0049.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown -R 65534:65534 "$WORK"
"${AS[@]}" env -i PATH="$PATH" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -o "-c listen_addresses='' -k $SOCK -p 5432" -l "$WORK/pg.log" start -w >/dev/null
# The ONLY way this script talks to PostgreSQL: a clean environment bound to the private socket of the disposable server.
local_pg(){ local tool="$1"; shift; [[ "$tool" == psql || "$tool" == pg_restore ]] || refuse "tool $tool not allowed"
  env -i PATH="$PATH" PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres PGDATABASE=verify "$tool" "$@"; }
env -i PATH="$PATH" PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres psql -qAtX -d postgres -c "create database verify" >/dev/null
Q(){ local_pg psql -qAtX -v ON_ERROR_STOP=1 -c "$1"; }
TOC="$WORK/toc.txt"; pg_restore --list "$FILE" > "$TOC" || refuse "not a readable pg_dump custom-format archive"
DUMPED_AT=$(grep -m1 "Archive created at" "$TOC" | sed "s/.*Archive created at //" || true)
# Script form of the archive, parsed as text only (no -d: pg_restore writes SQL to stdout and connects to nothing).
SCRIPT_SQL="$WORK/archive.sql"; pg_restore --file=- "$FILE" > "$SCRIPT_SQL" || refuse "archive could not be read end to end"
ARCHIVE_ROLES=$(grep -oE '^(GRANT|REVOKE) .* (TO|FROM) [a-z_][a-z0-9_]*( WITH GRANT OPTION)?;$' "$SCRIPT_SQL" | sed -E 's/ WITH GRANT OPTION;$/;/; s/.* (TO|FROM) ([a-z_][a-z0-9_]*);$/\2/' | sort -u | grep -vxE 'postgres|public' || true)
for r in anon authenticated "service_role BYPASSRLS" authenticator supabase_admin supabase_auth_admin supabase_storage_admin dashboard_user pgbouncer supabase_realtime_admin supabase_replication_admin supabase_read_only_user $ARCHIVE_ROLES; do Q "create role $r" >/dev/null 2>&1 || true; done
set +e; local_pg pg_restore --no-owner -d verify "$FILE" > "$WORK/restore.log" 2>&1; set -e
ERRS=$(grep -c '^pg_restore: error' "$WORK/restore.log" || true)
# Classify every error. Tolerated: objects of managed extensions unavailable in a plain local server. Reported for the
# rest: only the TOC descriptor (object type, schema, name) — never command text or row data.
CLASS=$(python3 - "$WORK/restore.log" <<'PY2'
import re,sys
lines=open(sys.argv[1],encoding="utf-8",errors="replace").read().splitlines()
ok=re.compile(r'(schema|extension|relation|function|type) "?(cron|net|vault|pg_cron|pg_net|supabase_vault|pgsodium)\b|\b(cron|net|vault)\.[a-z_]+')
exp=0; bad=[]; toc=""
for l in lines:
    if re.match(r"^\S+: from TOC entry ",l): toc=re.sub(r"^\S+: from TOC entry \d+; \d+ \d+ ","",l).rsplit(" ",1)[0]
    elif re.match(r"^\S+: error:",l):
        if ok.search(l): exp+=1
        else: bad.append(toc or "(no TOC entry)")
print(f"{exp}|{len(bad)}|{'; '.join(sorted(set(bad))[:10])}")
PY2
)
ERR_EXPECTED=${CLASS%%|*}; REST=${CLASS#*|}; ERR_UNEXPECTED=${REST%%|*}; ERR_WHERE=${REST#*|}

FAIL=0; ROWS=""
row(){ ROWS+="| $1 | $2 | $3 |"$'\n'; [[ "$2" == FAIL ]] && FAIL=$((FAIL+1)); return 0; }
chk(){ if [[ "$(Q "$2" 2>/dev/null || echo ERR)" == t ]]; then row "$1" PASS "$3"; else row "$1" FAIL "$3"; fi; }

# --- schema version and migration ordering (drizzle journal vs restored drizzle.__drizzle_migrations) ---
JOURNAL="$ROOT/drizzle/migrations/meta/_journal.json"
EXPECTED=$(python3 - "$JOURNAL" "$ROOT/drizzle/migrations" <<'PY'
import json,sys,hashlib
j=json.load(open(sys.argv[1]))
for e in j["entries"]:
    sql=open(f"{sys.argv[2]}/{e['tag']}.sql","rb").read()
    print(f"{e['when']}|{hashlib.sha256(sql).hexdigest()}")
PY
)
HAVE_TABLE=$(Q "select to_regclass('drizzle.__drizzle_migrations') is not null")
if [[ "$HAVE_TABLE" == t ]]; then
  APPLIED=$(Q "select created_at::text || '|' || hash from drizzle.__drizzle_migrations order by created_at, id")
  if [[ "$APPLIED" == "$EXPECTED" ]]; then row "Migration ordering" PASS "$(wc -l <<<"$APPLIED") entries; every timestamp and SHA-256 equals drizzle/migrations in order; latest $(tail -1 <<<"$EXPECTED" | cut -d'|' -f1)"
  else row "Migration ordering" FAIL "restored history ($(grep -c . <<<"$APPLIED" || true) rows) differs from drizzle/migrations ($(wc -l <<<"$EXPECTED") entries)"; fi
else row "Migration ordering" FAIL "drizzle.__drizzle_migrations not in the archive: applied schema version cannot be established"; fi
chk "0039 safety objects present" "select to_regclass('public.futures_certifications') is not null and exists(select 1 from pg_proc where proname='futures_live_authorized')" "export must postdate 0039"
chk "0047/0048 objects absent before" "select to_regclass('public.futures_order_strategy_identity') is null and to_regclass('public.futures_strategy_attribution_events') is null and not exists(select 1 from pg_proc where proname like '%futures_attribution%' or proname like '%strategy_identity%')" "needed for the 0048 coexistence step"
chk "0045/0046/0049 objects absent before" "select to_regclass('public.futures_paper_accounts') is null and to_regclass('public.strategy_risk_budgets') is null and to_regclass('public.account_risk_budgets') is null and to_regclass('public.futures_paper_risk_approvals') is null and not exists(select 1 from pg_proc where proname like 'fp2_%' or proname like 'fp3_%')" "0049 must be applied on a database without 0045/0046"
chk "account_mfa_allowed() exists" "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='account_mfa_allowed')" "required by the RLS policies"

if [[ "$ERR_UNEXPECTED" == 0 ]]; then row "pg_restore errors classified" PASS "$ERRS errors, all managed-extension objects (cron/net/vault) absent from a plain local server"
else row "pg_restore errors classified" FAIL "$ERR_UNEXPECTED unexpected error(s) in: $ERR_WHERE"; fi
# --- restored-object fidelity against the archive's own table of contents (counts only) ---
tocn(){ grep -cE "^[0-9]+; [0-9]+ [0-9]+ $1 public " "$TOC" || true; }
fid(){ local name="$1" want="$2" got="$3"; if [[ "$want" == "$got" ]]; then row "Fidelity: $name" PASS "archive $want = restored $got"; else row "Fidelity: $name" FAIL "archive $want ≠ restored $got"; fi; }
fid "public tables" "$(tocn TABLE)" "$(Q "select count(*) from pg_tables where schemaname='public'")"
fid "public views" "$(tocn VIEW)" "$(Q "select count(*) from pg_views where schemaname='public'")"
fid "public functions" "$(tocn FUNCTION)" "$(Q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')")"
fid "public RLS-enabled tables" "$(tocn 'ROW SECURITY')" "$(Q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity")"
fid "public policies" "$(tocn POLICY)" "$(Q "select count(*) from pg_policies where schemaname='public'")"
fid "public triggers" "$(tocn TRIGGER)" "$(Q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal")"
fid "public PK/unique/exclusion constraints" "$(tocn CONSTRAINT)" "$(Q "select count(*) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname='public' and k.contype in ('p','u','x')")"
fid "public foreign keys" "$(tocn 'FK CONSTRAINT')" "$(Q "select count(*) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname='public' and k.contype='f'")"
fid "public indexes (non-constraint)" "$(tocn INDEX)" "$(Q "select count(*) from pg_indexes i where schemaname='public' and not exists(select 1 from pg_constraint k where k.conname=i.indexname and k.connamespace='public'::regnamespace)")"
ACL_WANT=$(grep -oE "^[0-9]+; 0 0 ACL public (TABLE|VIEW) [a-z_0-9]+" "$TOC" | awk '{print $NF}' | sort -u)
ACL_MISSING=0; for t in $ACL_WANT; do [[ "$(Q "select relacl is not null from pg_class where oid = to_regclass('public.$t')")" == t ]] || ACL_MISSING=$((ACL_MISSING+1)); done
if [[ "$ACL_MISSING" == 0 ]]; then row "Fidelity: public table/view privileges" PASS "$(wc -w <<<"$ACL_WANT") ACL entries in the archive, all restored"; else row "Fidelity: public table/view privileges" FAIL "$ACL_MISSING of $(wc -w <<<"$ACL_WANT") ACL entries not restored"; fi
# Row counts per public table: COPY rows in the archive vs rows restored (numbers only; no row content is printed).
ROWDIFF=$(python3 - "$SCRIPT_SQL" <<'PY2'
import re,sys
cur=None; n={}
for l in open(sys.argv[1],encoding="utf-8",errors="replace"):
    if cur is None:
        m=re.match(r'^COPY public\.("?[a-z_0-9]+"?) ',l)
        if m: cur=m.group(1).strip('"'); n[cur]=0
    elif l.rstrip("\n")=="\\.": cur=None
    else: n[cur]+=1
print(" ".join(f"{k}={v}" for k,v in sorted(n.items())))
PY2
)
RD_BAD=0; RD_N=0; RD_ROWS=0; for kv in $ROWDIFF; do t=${kv%%=*}; want=${kv#*=}; RD_N=$((RD_N+1)); RD_ROWS=$((RD_ROWS+want)); [[ "$(Q "select count(*) from public.\"$t\"")" == "$want" ]] || RD_BAD=$((RD_BAD+1)); done
if [[ "$RD_BAD" == 0 ]]; then row "Fidelity: public row counts" PASS "$RD_N tables in the archive data, $RD_ROWS rows; every table's restored count equals the archive"; else row "Fidelity: public row counts" FAIL "$RD_BAD of $RD_N tables differ"; fi
# --- migration history detail and draft status (drafts 0040–0047 must be absent for this phase's assumptions) ---
LATEST_WHEN=$(Q "select max(created_at) from drizzle.__drizzle_migrations" 2>/dev/null || echo "")
LATEST_TAG=$(python3 -c "import json,sys;j=json.load(open(sys.argv[1]));print(next((e['tag'] for e in j['entries'] if str(e['when'])==sys.argv[2]),'unknown'))" "$JOURNAL" "$LATEST_WHEN")
row "Latest applied migration" INFO "$LATEST_TAG (created_at $LATEST_WHEN); $(Q "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo '?') rows"
draft(){ local d="$1" sql="$2" detail="$3"; if [[ "$(Q "$sql")" == t ]]; then row "Draft $d" INFO "PRESENT ($detail)"; else row "Draft $d" INFO "ABSENT ($detail)"; fi; }
draft 0040 "select exists(select 1 from pg_trigger where tgname='futures_certifications_no_truncate')" "trigger futures_certifications_no_truncate"
draft 0041 "select to_regclass('public.futures_harness_runs') is not null" "table futures_harness_runs"
draft 0042 "select to_regclass('public.testnet_emergency_stops') is not null or exists(select 1 from pg_proc where proname='testnet_futures_limits')" "testnet_emergency_stops / testnet_futures_limits()"
draft 0043 "select to_regclass('public.ai_decision_records') is not null or to_regclass('public.ai_risk_evaluations') is not null" "ai_decision_records / ai_risk_evaluations"
draft 0044 "select to_regclass('public.paper_accounts') is not null or to_regclass('public.paper_bars') is not null" "paper_accounts / paper_bars"
draft 0045/0046/0049 "select to_regclass('public.futures_paper_accounts') is not null or to_regclass('public.strategy_risk_budgets') is not null or to_regclass('public.account_risk_budgets') is not null or exists(select 1 from pg_proc where proname like 'fp2_%' or proname like 'fp3_%')" "futures_paper_* / strategy_risk_budgets / account_risk_budgets / fp2_* / fp3_*"
draft 0047/0048 "select to_regclass('public.futures_order_strategy_identity') is not null or to_regclass('public.futures_strategy_attribution_events') is not null" "futures_order_strategy_identity / futures_strategy_attribution_events"
# Scheduled jobs in the archive (cron.job data; the cron schema itself cannot be restored locally). Counts only.
JOBS=$(awk '/^COPY cron\.job /{f=1;next} f&&/^\\\.$/{f=0} f' "$SCRIPT_SQL")
row "Scheduled jobs in archive" INFO "$(grep -c . <<<"$JOBS" || true) cron job rows; $(grep -ci 'paper' <<<"$JOBS" || true) mention 'paper' (commands not printed)"

# --- fingerprint of every pre-existing public object (structure, policies, grants, functions, triggers) ---
EXCL_REL="relname not like 'futures_%attribution%' and relname not like 'futures_order_strategy_identity%' and relname not like 'futures_paper%' and relname not like 'strategy_risk_budgets%' and relname not like 'account_risk_budgets%'"
FP_SQL="select md5(string_agg(x, E'\n' order by x)) from (
  select 'col:'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull x from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped and c.relkind in ('r','v') and $EXCL_REL
  union all select 'pol:'||tablename||'.'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname='public' and tablename not like 'futures_%' and tablename not in ('strategy_risk_budgets','account_risk_budgets')
  union all select 'acl:'||c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and $EXCL_REL
  union all select 'fn:'||p.proname||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like '%futures_attribution%' and p.proname not like '%strategy_identity%' and p.proname not like 'fp2_%' and p.proname not like 'fp3_%' and p.proname not like '%futures_paper%' and p.proname not in ('guard_strategy_risk_budget','guard_account_risk_budget')
  union all select 'trg:'||tgrelid::regclass::text||'.'||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%futures_%attribution%' and tgrelid::regclass::text not like '%futures_order_strategy_identity%' and tgrelid::regclass::text not like '%futures_paper%' and tgrelid::regclass::text not like '%strategy_risk_budgets%' and tgrelid::regclass::text not like '%account_risk_budgets%'
) s"
rowcounts(){ local acc=""; for t in $(Q "select tablename from pg_tables where schemaname='public' and tablename not like 'futures_%' and tablename not in ('strategy_risk_budgets','account_risk_budgets') order by 1"); do acc+="$t=$(Q "select count(*) from public.\"$t\"");"; done; md5sum <<<"$acc" | cut -d' ' -f1; }
FP0=$(Q "$FP_SQL"); RC0=$(rowcounts); NT0=$(Q "select count(*) from pg_tables where schemaname='public'")
same_struct(){ [[ "$(Q "$FP_SQL")" == "$FP0" && "$(rowcounts)" == "$RC0" ]]; }
same(){ same_struct && [[ "$(Q "select count(*) from pg_tables where schemaname='public'")" == "$NT0" ]]; }

# --- apply 0049 in ONE transaction ---
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$MIG" > "$WORK/apply.log" 2>&1; then row "Apply 0049 (single transaction)" PASS "migration SHA-256 $MIG_SHA"
else row "Apply 0049 (single transaction)" FAIL "$(grep -m1 -i error "$WORK/apply.log" | cut -c1-200)"; fi
LEDGER="'futures_paper_events','futures_paper_positions','futures_paper_commits','futures_paper_candles','futures_paper_risk_approvals'"
CONF="'futures_paper_accounts','account_risk_budgets','strategy_risk_budgets','futures_paper_cost_assumptions'"
chk "RLS enabled on all 9 tables" "select count(*)=9 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ($LEDGER,$CONF) and relrowsecurity" ""
chk "9 owner-read policies, SELECT for authenticated, MFA-aware" "select count(*)=9 and bool_and(cmd='SELECT' and roles='{authenticated}' and qual like '%auth.uid()%' and qual like '%account_mfa_allowed()%') from pg_policies where tablename in ($LEDGER,$CONF)" ""
chk "anon: no privilege on any table" "select not bool_or(has_table_privilege('anon', ('public.'||t)::regclass, 'SELECT,INSERT,UPDATE,DELETE')) from unnest(array[$LEDGER,$CONF]) t" ""
chk "authenticated: SELECT only" "select bool_and(has_table_privilege('authenticated', ('public.'||t)::regclass, 'SELECT') and not has_table_privilege('authenticated', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$LEDGER,$CONF]) t" ""
chk "service_role: ledger tables read-only (events, positions, commits, candles, approvals)" "select bool_and(not has_table_privilege('service_role', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$LEDGER]) t" ""
chk "service_role: INSERT/UPDATE on configuration tables, never DELETE/TRUNCATE" "select bool_and(has_table_privilege('service_role', ('public.'||t)::regclass, 'INSERT') and has_table_privilege('service_role', ('public.'||t)::regclass, 'UPDATE') and not has_table_privilege('service_role', ('public.'||t)::regclass, 'DELETE,TRUNCATE')) from unnest(array[$CONF]) t" ""
chk "commit function: SECURITY DEFINER, pinned search_path, EXECUTE for service_role only" "select p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE') from pg_proc p where proname='futures_paper_commit_bar_v3'" ""
chk "risk helpers (fp3_*): no EXECUTE for any API role" "select count(*)=5 and bool_and(not has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p where proname in ('fp3_cost','fp3_usage','fp3_mark','fp3_check_account','fp3_daily_left')" ""
chk "guard / append-only / no-truncate triggers present (20)" "select count(*)=20 from pg_trigger where not tgisinternal and tgrelid::regclass::text in ($LEDGER,$CONF)" ""
chk "nesting constraint and one-open-approval index present" "select exists(select 1 from pg_constraint where conname='account_risk_budgets_sub_budgets_fit') and to_regclass('public.futures_paper_risk_approvals_one_open') is not null" ""
chk "No rows created (no backfill)" "select (select count(*) from public.futures_paper_accounts)+(select count(*) from public.account_risk_budgets)+(select count(*) from public.strategy_risk_budgets)+(select count(*) from public.futures_paper_risk_approvals)=0" ""
# --- probes, each inside a transaction that is always rolled back (synthetic owner id; no restored row is read or printed) ---
CFGJ='{"startingBalance":1000,"triggerSource":"MARK","maxBasisPct":0.5,"entryTtlBars":3,"costs":{"takerFeePct":0.05,"spreadPct":0.01,"slippagePct":0.01,"maxParticipationPct":null},"specs":{"BTCUSDT":{"stepSize":0.001,"tickSize":0.1,"minNotional":5,"maintenanceMarginRate":0.004}},"limits":{"maxExposure":5000,"maxDailyLoss":50,"maxPositions":2,"maxLossPerTrade":10,"maxMarginPerTrade":200,"maxLeverage":10,"liquidationBufferPct":5,"maxDataAgeMs":5000,"maxProposalAgeMs":60000,"roundTripCostPct":0.13},"strategyBudgets":{"s1":30}}'
STJ='{"version":"futures-paper-v1","wallet":1000,"seq":0,"day":-1,"dayCash":0,"halted":false,"positions":{},"pending":{},"strategyLoss":{},"seen":[],"cursors":{}}'
probe(){ local event="$1"; local_pg psql -qAtX -v ON_ERROR_STOP=1 <<SQL 2>&1 || true
begin;
create temp table pu as select gen_random_uuid() u, (floor(extract(epoch from now())*1000)::bigint/60000)*60000 - 600000 bt;
grant select on pu to service_role;
set local role service_role;
insert into public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) select u,'paper',100,40,60 from pu;
insert into public.strategy_risk_budgets(user_id, strategy_id, environment, engine, max_loss) select u,'s1','paper','scalping',30 from pu;
insert into public.futures_paper_accounts(user_id, engine_version, data_source, symbols, timeframe, config, starting_balance, wallet, state) select u,'futures-paper-v1','binance-public-usdm',array['BTCUSDT'],'1m','$CFGJ'::jsonb,1000,0,'$STJ'::jsonb from pu;
reset role;
select set_config('futures_paper.commit','on',true); update public.futures_paper_accounts set cursor_t=(select bt from pu)-60000; select set_config('futures_paper.commit','off',true);
set local role service_role;
select public.futures_paper_commit_bar_v3((select id from public.futures_paper_accounts where user_id=(select u from pu)), 0, (select bt from pu),
  jsonb_build_object('wallet',1000,'state','$STJ'::jsonb,'candles',jsonb_build_object('BTCUSDT','{"trade":{"o":100,"h":100.2,"l":99.9,"c":100,"v":1000000},"mark":{"o":100,"h":100.2,"l":99.9,"c":100},"index_c":100,"funding":[]}'::jsonb),
  'events',jsonb_build_array(($event)::jsonb || jsonb_build_object('t',(select bt from pu)))));
rollback;
SQL
}
FILLJ='{"seq":1,"symbol":"BTCUSDT","kind":"entry_fill","side":"LONG","qty":1,"price":100.015,"fee":0.0500075,"pnl":0,"wallet_delta":-0.0500075,"margin_delta":20.003,"reason":"probe","proposal_id":"probe-ghost","strategy_id":"s1"}'
P1=$(probe "'$FILLJ'")
if grep -q "entry fill without a valid risk approval" <<<"$P1"; then row "Probe: fill without a risk approval (rolled back)" PASS "refused by the commit function"; else row "Probe: fill without a risk approval (rolled back)" FAIL "not refused as expected"; fi
P2=$(probe "'$FILLJ'::jsonb || '{\"risk_amount\":0}'")
if grep -q "computed by the database" <<<"$P2"; then row "Probe: worker-supplied risk figure (rolled back)" PASS "refused by the commit function"; else row "Probe: worker-supplied risk figure (rolled back)" FAIL "not refused as expected"; fi
P3=$(local_pg psql -qAtX -c "begin; set local role authenticated; insert into public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) values (gen_random_uuid(),'paper',1,0,0); rollback;" 2>&1 || true)
if grep -q "permission denied" <<<"$P3"; then row "Probe: browser-role budget write (rolled back)" PASS "authenticated INSERT refused"; else row "Probe: browser-role budget write (rolled back)" FAIL "not refused"; fi
P4=$(local_pg psql -qAtX -c "begin; set local role service_role; insert into public.futures_paper_risk_approvals(account_id, proposal_id, user_id, strategy_id, budget_engine, symbol, side, approved_qty, leverage, reference_price, reference_t, stop_price, stop_dist, cost_pct, liquidation_price, liquidation_gap_pct, risk_amount, margin_estimate, proposal_created_t, approved_bar_t, approved_seq, expires_t) values (gen_random_uuid(),'p',gen_random_uuid(),'s1','scalping','BTCUSDT','LONG',1,1,100,0,99,1,0.13,1,1,1,1,0,0,1,1); rollback;" 2>&1 || true)
if grep -q "permission denied" <<<"$P4"; then row "Probe: service-role direct approval write (rolled back)" PASS "INSERT refused (approvals are written only by the commit function)"; else row "Probe: service-role direct approval write (rolled back)" FAIL "not refused"; fi
chk "Probes left no rows" "select (select count(*) from public.futures_paper_accounts)+(select count(*) from public.account_risk_budgets)+(select count(*) from public.futures_paper_risk_approvals)=0" ""
same_struct && row "Pre-existing objects unchanged after migration" PASS "fingerprint $FP0" || row "Pre-existing objects unchanged after migration" FAIL "fingerprint changed"

# --- rollback in ONE transaction ---
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$RB" > "$WORK/rollback.log" 2>&1; then row "Rollback 0049 (single transaction)" PASS "rollback SHA-256 $RB_SHA"
else row "Rollback 0049 (single transaction)" FAIL "$(grep -m1 -i error "$WORK/rollback.log" | cut -c1-200)"; fi
LEFT_SQL="select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (relname like 'futures_paper%' or relname in ('strategy_risk_budgets','account_risk_budgets'))) and not exists(select 1 from pg_proc where proname like 'fp2_%' or proname like 'fp3_%' or proname like '%futures_paper%' or proname in ('guard_strategy_risk_budget','guard_account_risk_budget'))"
chk "Nothing left after rollback" "$LEFT_SQL" ""
same && row "Pre-existing objects unchanged after rollback" PASS "fingerprint $FP0; $NT0 public tables" || row "Pre-existing objects unchanged after rollback" FAIL "fingerprint changed"

# --- coexistence with draft 0048: apply 0049 then 0048; roll back 0048 then 0049 (each in ONE transaction) ---
CO=PASS
for f in "$MIG" "$M48" "$R48" "$RB"; do local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$f" >> "$WORK/coexist.log" 2>&1 || CO=FAIL; done
row "Coexistence 0049 → 0048 → rollback 0048 → rollback 0049" "$CO" "$( [[ $CO == PASS ]] && echo 'all four steps committed' || grep -m1 -i error "$WORK/coexist.log" | cut -c1-200)"
chk "Nothing left after coexistence round trip" "$LEFT_SQL and to_regclass('public.futures_order_strategy_identity') is null" ""
same && row "Pre-existing objects unchanged after coexistence round trip" PASS "fingerprint $FP0" || row "Pre-existing objects unchanged after coexistence round trip" FAIL "fingerprint changed"

# --- never together with 0046: with 0046 applied, 0049 must fail as a whole; then 0046 is rolled back ---
local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$M46" > "$WORK/with46.log" 2>&1 || true
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$MIG" >> "$WORK/with46.log" 2>&1; then row "0049 refused on top of 0046" FAIL "0049 applied on top of 0046"
else row "0049 refused on top of 0046" PASS "the whole transaction failed (same object names); nothing of 0049 was created"; fi
local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$R46" >> "$WORK/with46.log" 2>&1 || row "Rollback 0046 after refusal" FAIL "$(grep -m1 -i error "$WORK/with46.log" | cut -c1-200)"
chk "Nothing left after the 0046 refusal step" "$LEFT_SQL" ""
same && row "Pre-existing objects unchanged at the end" PASS "fingerprint $FP0; $NT0 public tables" || row "Pre-existing objects unchanged at the end" FAIL "fingerprint changed"

VERDICT=PASS; [[ $FAIL -gt 0 || "${ERR_UNEXPECTED:-1}" != 0 ]] && VERDICT=FAIL
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<MD
# Local-only restore verification — draft 0049 — $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Verdict: $VERDICT** (local disposable PostgreSQL $(postgres --version | awk '{print $3}'), private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply 0049. Nothing was applied anywhere else.

- Archive: \`$(basename "$FILE")\`, $SIZE bytes, SHA-256 \`$SHA\`, created at: ${DUMPED_AT:-unknown}
- pg_restore errors: $ERRS total — $ERR_EXPECTED tolerated (managed-extension objects: cron/net/vault), $ERR_UNEXPECTED unexpected
- Ambient connection variables ignored: ${AMBIENT:-none}
- Migration \`$(basename "$MIG")\` SHA-256 \`$MIG_SHA\`; rollback SHA-256 \`$RB_SHA\`; coexistence used 0048 \`$(sha256sum "$M48" | cut -c1-16)…\` / rollback \`$(sha256sum "$R48" | cut -c1-16)…\`; refusal step used 0046 \`$(sha256sum "$M46" | cut -c1-16)…\`

| Check | Result | Detail |
|---|---|---|
$ROWS
MD
echo "$VERDICT — report: $OUT"
[[ "$VERDICT" == PASS ]]
