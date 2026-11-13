#!/usr/bin/env bash
# LOCAL-ONLY restore verifier for DRAFT migration 0046 (reviewed successor of 0045). Phase 4C. NOT a Cloud restore test.
#
# Usage: scripts/db-export/verify-local-restore-0046.sh /absolute/or/relative/path/to/export.backup
#   Optional env: REPORT=/tmp/0046-restore.md (default /tmp/verify-0046-<utc>.md), MIGRATION / ROLLBACK (draft paths).
#
# Safety (differs from verify-export.sh on purpose):
#  * accepts ONLY an explicitly supplied, existing, local pg_dump custom-format file — no URL, bucket path or download;
#  * refuses any extra argument and any connection string; ignores and unsets DATABASE_URL, PG*, SUPABASE_* and
#    LOVABLE_DB_* so no ambient or implicit credential can be used;
#  * starts its own disposable PostgreSQL in a fresh /tmp directory, listening on a private UNIX socket only
#    (listen_addresses=''), and every psql/pg_restore call goes through one guarded helper bound to that socket;
#  * never connects to any other server, never compares with a live database, never applies anything elsewhere.
# Checks: archive readable + SHA-256; migration ordering vs drizzle/migrations (hash + timestamp of every entry);
# 0045/0046 objects absent before; fingerprint of every pre-existing public object; 0046 applied in ONE transaction;
# RLS, policies, grants, EXECUTE privileges, constraints, triggers, SECURITY DEFINER + search_path; a malformed-input
# probe; rollback in ONE transaction; nothing left behind; pre-existing fingerprint unchanged. Counts/hashes only.
# Phase 4E revision (found on the first REAL export): every role the archive grants to is created first (the Phase 4D
# version omitted `sandbox_exec`, so all 60 public-table ACL entries failed and privileges were silently not restored);
# pg_restore errors are classified — only objects of the managed extensions that cannot exist in a plain local server
# (pg_cron, pg_net, supabase_vault: schemas cron/net/vault) are tolerated, anything else FAILs; restored-object fidelity
# is checked against the archive's own table of contents (tables, row counts, ACLs, RLS, policies, triggers,
# functions, constraints); presence of drafts 0040–0047 and scheduled-job counts are reported (counts only, never
# job commands). Parsing the archive (`pg_restore --list` / `--file=-`) never opens a database connection.
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
MIG="${MIGRATION:-$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.sql}"; RB="${ROLLBACK:-$ROOT/docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql}"
[[ -f "$MIG" && -f "$RB" ]] || refuse "draft migration or rollback file missing"
FILE=$(readlink -f "$SRC"); SHA=$(sha256sum "$FILE" | cut -d' ' -f1); SIZE=$(stat -c %s "$FILE")
MIG_SHA=$(sha256sum "$MIG" | cut -d' ' -f1); RB_SHA=$(sha256sum "$RB" | cut -d' ' -f1)
OUT="${REPORT:-/tmp/verify-0046-$(date -u +%Y%m%dT%H%M%SZ).md}"

WORK=$(mktemp -d /tmp/verify-0046.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
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
chk "0045/0046 objects absent before" "select to_regclass('public.futures_paper_accounts') is null and to_regclass('public.strategy_risk_budgets') is null and not exists(select 1 from pg_proc where proname like 'fp2_%')" "never apply on top of 0045"
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
draft 0045/0046 "select to_regclass('public.futures_paper_accounts') is not null or to_regclass('public.strategy_risk_budgets') is not null or exists(select 1 from pg_proc where proname like 'fp2_%')" "futures_paper_* / strategy_risk_budgets / fp2_*"
draft 0047/0048 "select to_regclass('public.futures_order_strategy_identity') is not null or to_regclass('public.futures_strategy_attribution_events') is not null" "futures_order_strategy_identity / futures_strategy_attribution_events"
# Scheduled jobs in the archive (cron.job data; the cron schema itself cannot be restored locally). Counts only.
JOBS=$(awk '/^COPY cron\.job /{f=1;next} f&&/^\\\.$/{f=0} f' "$SCRIPT_SQL")
row "Scheduled jobs in archive" INFO "$(grep -c . <<<"$JOBS" || true) cron job rows; $(grep -ci 'paper' <<<"$JOBS" || true) mention 'paper' (commands not printed)"

# --- fingerprint of every pre-existing public object (structure, policies, grants, functions, row counts) ---
FP_SQL="select md5(string_agg(x, E'\n' order by x)) from (
  select 'col:'||table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') x from information_schema.columns where table_schema='public' and table_name not like 'futures_paper%' and table_name <> 'strategy_risk_budgets'
  union all select 'pol:'||tablename||'.'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname='public' and tablename not like 'futures_paper%' and tablename <> 'strategy_risk_budgets'
  union all select 'acl:'||c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname not like 'futures_paper%' and c.relname not like 'strategy_risk_budgets%'
  union all select 'fn:'||p.proname||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like 'fp2_%' and p.proname not like '%futures_paper%' and p.proname <> 'guard_strategy_risk_budget'
  union all select 'trg:'||tgrelid::regclass::text||'.'||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%futures_paper%' and tgrelid::regclass::text not like '%strategy_risk_budgets%'
) s"
COUNTS_SQL="select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'"
rowcounts(){ local acc=""; for t in $(Q "select tablename from pg_tables where schemaname='public' and tablename not like 'futures_paper%' and tablename <> 'strategy_risk_budgets' order by 1"); do acc+="$t=$(Q "select count(*) from public.\"$t\"");"; done; md5sum <<<"$acc" | cut -d' ' -f1; }
FP0=$(Q "$FP_SQL"); RC0=$(rowcounts); NT0=$(Q "select count(*) from pg_tables where schemaname='public'")

# --- apply 0046 in ONE transaction ---
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$MIG" > "$WORK/apply.log" 2>&1; then row "Apply 0046 (single transaction)" PASS "migration SHA-256 $MIG_SHA"
else row "Apply 0046 (single transaction)" FAIL "$(grep -m1 -i error "$WORK/apply.log" | cut -c1-200)"; fi
NEW="'futures_paper_accounts','futures_paper_events','futures_paper_positions','futures_paper_commits','strategy_risk_budgets'"
chk "RLS enabled on all 5 tables" "select count(*)=5 from pg_class where relname in ($NEW) and relrowsecurity" ""
chk "5 owner-read policies, all SELECT for authenticated" "select count(*)=5 and bool_and(cmd='SELECT' and roles='{authenticated}') from pg_policies where tablename in ($NEW)" ""
chk "anon has no table privilege" "select not bool_or(has_table_privilege('anon', ('public.'||t)::regclass, 'SELECT,INSERT,UPDATE,DELETE')) from unnest(array[$NEW]) t" ""
chk "authenticated: SELECT only" "select bool_and(has_table_privilege('authenticated', ('public.'||t)::regclass, 'SELECT') and not has_table_privilege('authenticated', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array[$NEW]) t" ""
chk "service_role cannot write events/positions/commits directly" "select not bool_or(has_table_privilege('service_role', ('public.'||t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array['futures_paper_events','futures_paper_positions','futures_paper_commits']) t" ""
chk "commit function: EXECUTE for service_role only" "select has_function_privilege('service_role','public.futures_paper_commit_bar_v2(uuid,bigint,bigint,jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.futures_paper_commit_bar_v2(uuid,bigint,bigint,jsonb)','EXECUTE') and not has_function_privilege('anon','public.futures_paper_commit_bar_v2(uuid,bigint,bigint,jsonb)','EXECUTE')" ""
chk "commit function SECURITY DEFINER with pinned search_path" "select prosecdef and proconfig @> array['search_path=public'] from pg_proc where proname='futures_paper_commit_bar_v2'" ""
chk "event constraints present" "select count(*)=2 from pg_constraint where conname in ('futures_paper_event_numbers','futures_paper_event_kind_shape')" ""
chk "fill-once unique index present" "select to_regclass('public.futures_paper_events_fill_once') is not null" ""
chk "append-only / guard triggers present" "select count(*)>=11 from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('futures_paper_accounts','futures_paper_events','futures_paper_positions','futures_paper_commits','strategy_risk_budgets')" ""
PROBE=$(local_pg psql -qAtX -c "set role service_role; select public.futures_paper_commit_bar_v2(gen_random_uuid(), null, 0, '{}'::jsonb)" 2>&1 || true)
if grep -q "all required" <<<"$PROBE"; then row "Malformed-input probe (NULL sequence)" PASS "refused"; else row "Malformed-input probe (NULL sequence)" FAIL "not refused"; fi
[[ "$(Q "$FP_SQL")" == "$FP0" && "$(rowcounts)" == "$RC0" ]] && row "Pre-existing objects unchanged after migration" PASS "fingerprint $FP0" || row "Pre-existing objects unchanged after migration" FAIL "fingerprint changed"

# --- rollback in ONE transaction ---
if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$RB" > "$WORK/rollback.log" 2>&1; then row "Rollback (single transaction)" PASS "rollback SHA-256 $RB_SHA"
else row "Rollback (single transaction)" FAIL "$(grep -m1 -i error "$WORK/rollback.log" | cut -c1-200)"; fi
chk "Nothing left after rollback" "select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (relname like 'futures_paper%' or relname like 'strategy_risk%')) and not exists(select 1 from pg_proc where proname like 'fp2_%' or proname like '%futures_paper%' or proname='guard_strategy_risk_budget')" ""
[[ "$(Q "$FP_SQL")" == "$FP0" && "$(rowcounts)" == "$RC0" && "$(Q "select count(*) from pg_tables where schemaname='public'")" == "$NT0" ]] && row "Pre-existing objects unchanged after rollback" PASS "fingerprint $FP0; $NT0 public tables" || row "Pre-existing objects unchanged after rollback" FAIL "fingerprint changed"

VERDICT=PASS; [[ $FAIL -gt 0 || "${ERR_UNEXPECTED:-1}" != 0 ]] && VERDICT=FAIL
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<MD
# Local-only restore verification — draft 0046 — $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Verdict: $VERDICT** (local disposable PostgreSQL $(postgres --version | awk '{print $3}'), private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not proof of production readiness. Nothing was applied anywhere else.

- Archive: \`$(basename "$FILE")\`, $SIZE bytes, SHA-256 \`$SHA\`, created at: ${DUMPED_AT:-unknown}
- pg_restore errors: $ERRS total — $ERR_EXPECTED tolerated (managed-extension objects: cron/net/vault), $ERR_UNEXPECTED unexpected (restore log is deleted with the work dir)
- Roles created from the archive's grants: $(wc -w <<<"$ARCHIVE_ROLES") ($(tr '\n' ' ' <<<"$ARCHIVE_ROLES"))
- Ambient connection variables ignored: ${AMBIENT:-none}
- Migration \`$(basename "$MIG")\` SHA-256 \`$MIG_SHA\`; rollback SHA-256 \`$RB_SHA\`

| Check | Result | Detail |
|---|---|---|
$ROWS
MD
echo "$VERDICT — report: $OUT"
[[ "$VERDICT" == PASS ]]
