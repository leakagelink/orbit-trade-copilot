#!/usr/bin/env bash
# LOCAL-ONLY restore verifier for the COMPLETE draft chain 0049 → 0050 → 0051 → 0052 → 0053 (Phase 4H finalization).
# NOT a Cloud restore test and NOT an approval to apply anything. Derived from verify-local-restore-0050.sh (same
# isolation prelude, restore, fidelity and fingerprint steps, repeated verbatim); the chain steps replace its 0050 steps.
#
# Usage: scripts/db-export/verify-local-restore-0052.sh /path/to/export.backup
#   Optional env: REPORT=/tmp/chain-restore.md; HOSTED_SCHEMA="tables|functions|policies|triggers|columns_md5" (read
#   separately from the hosted catalog, read-only, compared here as text; this script never connects to it).
#
# Same isolation as verify-local-restore-0048.sh: only an explicit local pg_dump custom-format file; URLs, bucket paths,
# connection strings and extra arguments are refused; DATABASE_URL, PG*, SUPABASE_* and LOVABLE_DB_* are unset; a
# disposable PostgreSQL in a fresh /tmp directory on a private UNIX socket only; every psql/pg_restore call goes through
# one guarded helper bound to that socket. Chain checks: each draft refused without its predecessor; each applied in ONE
# transaction; RLS/grants/EXECUTE of the new objects; probes in rolled-back transactions; no rows created; every
# out-of-order rollback refused (0049 under 0050, 0050 under 0051, 0051 under 0052, 0052 under 0053); rollback
# 0053 → 0052 → 0051 → 0050 → 0049, each in ONE transaction; nothing left behind; pre-existing fingerprint and row
# counts unchanged throughout. Counts/hashes only.
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
MIG="$ROOT/docs/proposed-migrations/0049_futures_paper_ledger_v3.sql"; RB="$ROOT/docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql"
M50="$ROOT/docs/proposed-migrations/0050_futures_paper_worker_gateway.sql"; R50="$ROOT/docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql"
M48="$ROOT/docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql"; R48="$ROOT/docs/proposed-migrations/0048_futures_strategy_attribution_v2.rollback.sql"
M51="$ROOT/docs/proposed-migrations/0051_futures_paper_event_completeness.sql"; R51="$ROOT/docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql"
M52="$ROOT/docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql"; R52="$ROOT/docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.rollback.sql"
M53="$ROOT/docs/proposed-migrations/0053_futures_paper_worker_identity.sql"; R53="$ROOT/docs/proposed-migrations/0053_futures_paper_worker_identity.rollback.sql"
M46="$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.sql"; R46="$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql"
[[ -f "$M51" && -f "$R51" && -f "$M52" && -f "$R52" && -f "$M53" && -f "$R53" ]] || refuse "draft 0051/0052/0053 migration or rollback file missing"
[[ -f "$MIG" && -f "$RB" && -f "$M50" && -f "$R50" && -f "$M46" && -f "$R46" && -f "$M48" && -f "$R48" ]] || refuse "draft migration or rollback file missing"
FILE=$(readlink -f "$SRC"); SHA=$(sha256sum "$FILE" | cut -d' ' -f1); SIZE=$(stat -c %s "$FILE")
MIG_SHA=$(sha256sum "$MIG" | cut -d' ' -f1); RB_SHA=$(sha256sum "$RB" | cut -d' ' -f1)
M50_SHA=$(sha256sum "$M50" | cut -d' ' -f1); R50_SHA=$(sha256sum "$R50" | cut -d' ' -f1)
M51_SHA=$(sha256sum "$M51" | cut -d' ' -f1); R51_SHA=$(sha256sum "$R51" | cut -d' ' -f1); M52_SHA=$(sha256sum "$M52" | cut -d' ' -f1); R52_SHA=$(sha256sum "$R52" | cut -d' ' -f1)
M53_SHA=$(sha256sum "$M53" | cut -d' ' -f1); R53_SHA=$(sha256sum "$R53" | cut -d' ' -f1)
OUT="${REPORT:-/tmp/verify-chain-$(date -u +%Y%m%dT%H%M%SZ).md}"

WORK=$(mktemp -d /tmp/verify-chain.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
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
  union all select 'fn:'||p.proname||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like '%futures_attribution%' and p.proname not like '%strategy_identity%' and p.proname !~ '^fp[2-5]_' and p.proname not like '%futures_paper%' and p.proname not like 'fpw\_%' and p.proname not in ('guard_strategy_risk_budget','guard_account_risk_budget')
  union all select 'trg:'||tgrelid::regclass::text||'.'||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%futures_%attribution%' and tgrelid::regclass::text not like '%futures_order_strategy_identity%' and tgrelid::regclass::text not like '%futures_paper%' and tgrelid::regclass::text not like '%strategy_risk_budgets%' and tgrelid::regclass::text not like '%account_risk_budgets%'
) s"
rowcounts(){ local acc=""; for t in $(Q "select tablename from pg_tables where schemaname='public' and tablename not like 'futures_%' and tablename not in ('strategy_risk_budgets','account_risk_budgets') order by 1"); do acc+="$t=$(Q "select count(*) from public.\"$t\"");"; done; md5sum <<<"$acc" | cut -d' ' -f1; }
FP0=$(Q "$FP_SQL"); RC0=$(rowcounts); NT0=$(Q "select count(*) from pg_tables where schemaname='public'")
same_struct(){ [[ "$(Q "$FP_SQL")" == "$FP0" && "$(rowcounts)" == "$RC0" ]]; }
same(){ same_struct && [[ "$(Q "select count(*) from pg_tables where schemaname='public'")" == "$NT0" ]]; }

# --- schema fingerprint compared with the hosted catalog figures (same query; text comparison only) ---
LOCAL_SCHEMA=$(Q "select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||'|'||(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')||'|'||(select count(*) from pg_policies where schemaname='public')||'|'||(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal)||'|'||(select md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' order by table_name, ordinal_position)) from information_schema.columns where table_schema='public')")
if [[ -z "${HOSTED_SCHEMA:-}" ]]; then row "Schema equals hosted catalog" INFO "not compared (HOSTED_SCHEMA not supplied); restored: $LOCAL_SCHEMA"
elif [[ "$LOCAL_SCHEMA" == "$HOSTED_SCHEMA" ]]; then row "Schema equals hosted catalog" PASS "tables|functions|policies|triggers|columns-md5 = $LOCAL_SCHEMA (schema unchanged since the export; data may differ)"
else row "Schema equals hosted catalog" FAIL "restored $LOCAL_SCHEMA ≠ hosted $HOSTED_SCHEMA"; fi

# --- 0050 alone must be refused (it depends on 0049) ---
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$M50" > "$WORK/alone50.log" 2>&1; then row "0050 refused without 0049" FAIL "0050 applied without 0049"
else grep -q "requires draft 0049" "$WORK/alone50.log" && row "0050 refused without 0049" PASS "guard raised; nothing created" || row "0050 refused without 0049" FAIL "$(grep -m1 -i error "$WORK/alone50.log" | cut -c1-200)"; fi
same && row "Nothing changed by the refused 0050" PASS "fingerprint $FP0" || row "Nothing changed by the refused 0050" FAIL "fingerprint changed"

# --- apply 0049 then 0050, each in ONE transaction ---
A=PASS; for f in "$MIG" "$M50"; do local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$f" >> "$WORK/apply.log" 2>&1 || A=FAIL; done
row "Apply 0049 → 0050 (each a single transaction)" "$A" "$( [[ $A == PASS ]] && echo "0049 $MIG_SHA; 0050 $M50_SHA" || grep -m1 -i error "$WORK/apply.log" | cut -c1-200)"
NEW3="'futures_paper_worker_leases','futures_paper_candle_provenance','futures_paper_worker_audit'"
FNS="'fpw_acquire_lease','fpw_release_lease','fpw_snapshot','fpw_evaluated','fpw_commit','fpw_mark_review'"
chk "RLS enabled on the 3 new tables" "select count(*)=3 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ($NEW3) and relrowsecurity" ""
chk "2 owner-read MFA-aware policies (provenance, audit); none on leases" "select count(*)=2 and bool_and(cmd='SELECT' and roles='{authenticated}' and qual like '%auth.uid()%' and qual like '%account_mfa_allowed()%') from pg_policies where tablename in ($NEW3)" ""
chk "anon: no privilege on the new tables" "select not bool_or(has_table_privilege('anon', ('public.'||t)::regclass, 'SELECT,INSERT,UPDATE,DELETE')) from unnest(array[$NEW3]) t" ""
chk "authenticated: SELECT on provenance/audit only; nothing on leases" "select has_table_privilege('authenticated','public.futures_paper_candle_provenance','SELECT') and has_table_privilege('authenticated','public.futures_paper_worker_audit','SELECT') and not has_table_privilege('authenticated','public.futures_paper_worker_leases','SELECT') and not bool_or(has_table_privilege('authenticated', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$NEW3]) t" ""
chk "service_role: read-only on the new tables" "select bool_and(has_table_privilege('service_role', ('public.'||t)::regclass, 'SELECT') and not has_table_privilege('service_role', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$NEW3]) t" ""
chk "6 gateway functions: SECURITY DEFINER, pinned search_path, EXECUTE for service_role only" "select count(*)=6 and bool_and(p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p where proname in ($FNS)" ""
chk "0049 commit no longer executable by service_role (gateway is the only path)" "select not has_function_privilege('service_role', 'public.futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)', 'EXECUTE')" ""
chk "append-only / no-truncate / status-audit triggers present (6)" "select count(*)=6 from pg_trigger where not tgisinternal and (tgrelid::regclass::text in ($NEW3) or tgname='futures_paper_accounts_status_audit')" ""
P5=$(local_pg psql -qAtX -c "begin; set local role service_role; select public.fpw_commit(gen_random_uuid(), gen_random_uuid(), 1, 0, 0, '{}'::jsonb, '[]'::jsonb); rollback;" 2>&1 || true)
grep -q "lease lost" <<<"$P5" && row "Probe: commit without a lease (rolled back)" PASS "refused" || row "Probe: commit without a lease (rolled back)" FAIL "not refused as expected"
P6=$(local_pg psql -qAtX -c "begin isolation level repeatable read; set local role service_role; select public.fpw_commit(gen_random_uuid(), gen_random_uuid(), 1, 0, 0, '{}'::jsonb, '[]'::jsonb); rollback;" 2>&1 || true)
grep -q "READ COMMITTED" <<<"$P6" && row "Probe: commit at REPEATABLE READ (rolled back)" PASS "refused" || row "Probe: commit at REPEATABLE READ (rolled back)" FAIL "not refused as expected"
P7=$(local_pg psql -qAtX -c "begin; set local role authenticated; select public.fpw_snapshot(gen_random_uuid(), gen_random_uuid(), 1); rollback;" 2>&1 || true)
grep -q "permission denied" <<<"$P7" && row "Probe: browser role calls the gateway (rolled back)" PASS "permission denied" || row "Probe: browser role calls the gateway (rolled back)" FAIL "not refused"
chk "No rows created" "select (select count(*) from public.futures_paper_accounts)+(select count(*) from public.futures_paper_worker_leases)+(select count(*) from public.futures_paper_candle_provenance)+(select count(*) from public.futures_paper_worker_audit)=0" ""
same_struct && row "Pre-existing objects unchanged after 0049 + 0050" PASS "fingerprint $FP0" || row "Pre-existing objects unchanged after 0049 + 0050" FAIL "fingerprint changed"

# --- chain: 0051, 0052, 0053 — each refused without its predecessor (checked by its own guard), each ONE transaction ---
applyone(){ local label="$1" file="$2" sha="$3"; if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$file" > "$WORK/apply-$label.log" 2>&1; then row "Apply $label (single transaction)" PASS "SHA-256 $sha"; else row "Apply $label (single transaction)" FAIL "$(grep -m1 -i error "$WORK/apply-$label.log" | cut -c1-200)"; fi; }
refused(){ local label="$1" file="$2" want="$3"; if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$file" > "$WORK/refuse-$label.log" 2>&1; then row "$label" FAIL "applied out of order"; else grep -q "$want" "$WORK/refuse-$label.log" && row "$label" PASS "guard raised; nothing created" || row "$label" FAIL "$(grep -m1 -i error "$WORK/refuse-$label.log" | cut -c1-200)"; fi; }
refused "0052 refused before 0051" "$M52" "requires drafts 0049, 0050 and 0051"
applyone 0051 "$M51" "$M51_SHA"
refused "0053 refused before 0052" "$M53" "requires drafts 0049"
applyone 0052 "$M52" "$M52_SHA"
applyone 0053 "$M53" "$M53_SHA"
NEWC="'futures_paper_protection_terms','futures_paper_candle_checks','futures_paper_entry_checks','futures_paper_config_changes','futures_paper_worker_identities','futures_paper_worker_enrollments'"
chk "RLS enabled on the 6 chain tables" "select count(*)=6 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ($NEWC) and relrowsecurity" ""
chk "Chain tables: no write privilege for anon/authenticated/service_role" "select not bool_or(has_table_privilege(r, ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$NEWC]) t, unnest(array['anon','authenticated','service_role']) r" ""
chk "Owner-read MFA-aware policies on the 5 owner-visible chain tables" "select count(*)=5 and bool_and(cmd='SELECT' and qual like '%auth.uid()%' and qual like '%account_mfa_allowed()%') from pg_policies where tablename in ($NEWC)" ""
chk "Commit functions v4/v5 and helpers executable by no API role" "select not bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon','authenticated','service_role']) r where p.proname ~ '^fp[45]_' or p.proname ~ '^futures_paper_commit_bar_v[345]$'" ""
chk "After 0053 the gateway is reachable only through the signed-in wrappers" "select (select count(*) from pg_proc where proname ~ '^fpw_id_' and proname <> 'fpw_id_authorize' and has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('service_role', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE'))=6 and not exists(select 1 from pg_proc where proname in ('fpw_acquire_lease','fpw_release_lease','fpw_snapshot','fpw_evaluated','fpw_commit','fpw_mark_review') and has_function_privilege('service_role', oid, 'EXECUTE'))" ""
P8=$(local_pg psql -qAtX -c "begin; set local role service_role; select public.fpw_commit(gen_random_uuid(), gen_random_uuid(), 1, 0, 0, '{}'::jsonb, '[]'::jsonb); rollback;" 2>&1 || true)
grep -q "permission denied" <<<"$P8" && row "Probe: service role calls the gateway after 0053 (rolled back)" PASS "permission denied" || row "Probe: service role calls the gateway after 0053 (rolled back)" FAIL "not refused"
P9=$(local_pg psql -qAtX -c "begin; set local role authenticated; select public.fpw_id_acquire_lease(gen_random_uuid(), gen_random_uuid(), 30); rollback;" 2>&1 || true)
grep -q "not an enabled worker identity" <<<"$P9" && row "Probe: unregistered signed-in caller (rolled back)" PASS "refused" || row "Probe: unregistered signed-in caller (rolled back)" FAIL "not refused as expected"
P10=$(local_pg psql -qAtX -c "begin; set local role service_role; insert into public.account_risk_budgets(user_id, environment, max_loss, research_max_loss, scalping_max_loss) values (gen_random_uuid(),'paper',10,5,5); rollback;" 2>&1 || true)
grep -q "needs a reason" <<<"$P10" && row "Probe: budget write without a reason (rolled back)" PASS "refused" || row "Probe: budget write without a reason (rolled back)" FAIL "not refused as expected"
chk "No rows created by the chain" "select (select count(*) from public.futures_paper_accounts)+(select count(*) from public.futures_paper_config_changes)+(select count(*) from public.futures_paper_entry_checks)+(select count(*) from public.futures_paper_worker_identities)=0" ""
same_struct && row "Pre-existing objects unchanged after the whole chain" PASS "fingerprint $FP0" || row "Pre-existing objects unchanged after the whole chain" FAIL "fingerprint changed"

# --- rollback order: every out-of-order rollback fails as a whole; then 0053 → 0052 → 0051 → 0050 → 0049 ---
oorder(){ local label="$1" file="$2"; if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$file" > "$WORK/oo-$label.log" 2>&1; then row "$label" FAIL "rolled back underneath its successor"; else row "$label" PASS "the whole transaction failed; nothing dropped"; fi; }
oorder "0049 rollback refused while 0050 is present" "$RB"
oorder "0050 rollback refused while 0051 is present" "$R50"
oorder "0051 rollback refused while 0052 is present" "$R51"
oorder "0052 rollback refused while 0053 is present" "$R52"
rbone(){ local label="$1" file="$2" sha="$3"; if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$file" > "$WORK/rb-$label.log" 2>&1; then row "Rollback $label (single transaction)" PASS "rollback SHA-256 $sha"; else row "Rollback $label (single transaction)" FAIL "$(grep -m1 -i error "$WORK/rb-$label.log" | cut -c1-200)"; fi; }
rbone 0053 "$R53" "$R53_SHA"
chk "Service-role gateway grants restored after 0053 rollback" "select count(*)=6 from pg_proc where proname in ('fpw_acquire_lease','fpw_release_lease','fpw_snapshot','fpw_evaluated','fpw_commit','fpw_mark_review') and has_function_privilege('service_role', oid, 'EXECUTE')" ""
rbone 0052 "$R52" "$R52_SHA"
rbone 0051 "$R51" "$R51_SHA"
rbone 0050 "$R50" "$R50_SHA"
chk "0049 grant restored after 0050 rollback" "select has_function_privilege('service_role', 'public.futures_paper_commit_bar_v3(uuid,bigint,bigint,jsonb)', 'EXECUTE') and not exists(select 1 from pg_proc where proname like 'fpw\_%')" ""
rbone 0049 "$RB" "$RB_SHA"
LEFT_SQL="select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (relname like 'futures_paper%' or relname in ('strategy_risk_budgets','account_risk_budgets'))) and not exists(select 1 from pg_proc where proname ~ '^fp[2-5]_' or proname like 'fpw_%' or proname like '%futures_paper%' or proname in ('guard_strategy_risk_budget','guard_account_risk_budget'))"
chk "Nothing left after the five rollbacks" "$LEFT_SQL" ""
same && row "Pre-existing objects unchanged at the end" PASS "fingerprint $FP0; $NT0 public tables" || row "Pre-existing objects unchanged at the end" FAIL "fingerprint changed"

VERDICT=PASS; [[ $FAIL -gt 0 || "${ERR_UNEXPECTED:-1}" != 0 ]] && VERDICT=FAIL
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<MD
# Local-only restore verification — draft chain 0049 → 0053 — $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Verdict: $VERDICT** (local disposable PostgreSQL $(postgres --version | awk '{print $3}'), private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply any of 0049–0053. Nothing was applied anywhere else.

- Archive: \`$(basename "$FILE")\`, $SIZE bytes, SHA-256 \`$SHA\`, created at: ${DUMPED_AT:-unknown}
- pg_restore errors: $ERRS total — $ERR_EXPECTED tolerated (managed-extension objects: cron/net/vault), $ERR_UNEXPECTED unexpected
- Ambient connection variables ignored: ${AMBIENT:-none}
- 0049 SHA-256 \`$MIG_SHA\` / rollback \`$RB_SHA\`; 0050 SHA-256 \`$M50_SHA\` / rollback \`$R50_SHA\`
- 0051 SHA-256 \`$M51_SHA\` / rollback \`$R51_SHA\`; 0052 SHA-256 \`$M52_SHA\` / rollback \`$R52_SHA\`; 0053 SHA-256 \`$M53_SHA\` / rollback \`$R53_SHA\`

| Check | Result | Detail |
|---|---|---|
$ROWS
MD
echo "$VERDICT — report: $OUT"
[[ "$VERDICT" == PASS ]]
