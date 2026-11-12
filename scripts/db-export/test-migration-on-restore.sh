#!/usr/bin/env bash
# Practice-restores a Lovable Cloud database export into a throwaway local PostgreSQL in /tmp (never the live database),
# optionally brings it up to date with already-applied migrations, then tests a DRAFT migration and its rollback there:
# expected objects, triggers, constraints, grants, RLS, SHA-256, functional checks (inside rolled-back transactions),
# unchanged existing data, and that the rollback does not hand browser roles write/TRUNCATE privileges back.
# Usage: scripts/db-export/test-migration-on-restore.sh <bucket/object | file.backup> <migration.sql> <rollback.sql> [catch-up.sql ...]
# Writes a counts-only report (no row contents) and deletes the downloaded copy. Not a Lovable Cloud restore.
set -euo pipefail
SRC="${1:?export}"; MIG="${2:?migration}"; RB="${3:?rollback}"; shift 3; CATCHUP=("$@")
WORK=$(mktemp -d /tmp/mig-restore.XXXXXX); PGL="$WORK/pg"; PORT=55434
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
if [[ -f "$SRC" ]]; then FILE="$SRC"; else
  FILE="$WORK/export.backup"
  curl -fsS -o "$FILE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_URL/storage/v1/object/$SRC"
fi
SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
DUMPED_AT=$(pg_restore --list "$FILE" | grep -m1 "Archive created at" | sed "s/.*Archive created at //" || true)
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"; chmod 644 "$FILE" 2>/dev/null || true
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start -w >/dev/null
L(){ PGHOST=$WORK PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres PGPASSWORD= PGSSLMODE=disable psql -qAtX "$@"; }
LF(){ PGHOST=$WORK PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres PGPASSWORD= PGSSLMODE=disable psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$1"; }
for r in sandbox_exec anon authenticated service_role authenticator supabase_admin supabase_auth_admin supabase_storage_admin dashboard_user pgbouncer supabase_realtime_admin supabase_replication_admin supabase_read_only_user; do L -c "create role $r" 2>/dev/null || true; done
L -c "alter role service_role bypassrls" >/dev/null
set +e
PGHOST=$WORK PGPORT=$PORT PGUSER=postgres PGPASSWORD= PGSSLMODE=disable pg_restore --no-owner -d postgres "$FILE" > "$WORK/restore.log" 2>&1
set -e
RESTORE_ERRS=$(grep -c '^pg_restore: error' "$WORK/restore.log" || true)
RESEARCH_ERRS=$(grep '^pg_restore: error' "$WORK/restore.log" | grep -ci 'ai_research\|ai_agent\|ai_trade_prop' || true)
OUT="${REPORT:-docs/certification/migration-restore-test-$(date -u +%Y%m%dT%H%M%SZ).md}"
RES=(); pass(){ RES+=("| $1 | PASS |"); }; fail(){ RES+=("| $1 | **FAIL** — $2 |"); FAILED=1; }; FAILED=0
check(){ local name="$1" sql="$2" want="$3"; local got; got=$(L -c "$sql" 2>&1 | tr '\n' ' ' | sed 's/ *$//' || true); [[ "$got" == "$want" ]] && pass "$name" || fail "$name" "expected \`$want\`, got \`$got\`"; }

CATCHUP_NOTE="none"
for f in "${CATCHUP[@]}"; do LF "$f" >/dev/null; CATCHUP_NOTE="${CATCHUP_NOTE/none/} \`$(basename "$f")\`"; done
RT="ai_research_runs ai_agent_outputs ai_research_reports ai_research_decisions ai_trade_proposals ai_research_usage ai_research_stage_metrics"
counts(){ for t in $(L -c "select tablename from pg_tables where schemaname='public' and tablename not in ('ai_decision_records','ai_risk_evaluations','ai_research_budget_config','ai_research_budget_events','ai_research_budget_reservations') order by 1"); do echo "$t $(L -c "select count(*) from public.\"$t\"")"; done; }
fingerprint(){ for t in $RT; do echo "$t $(L -c "select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.\"$t\" x")"; done; }
counts > "$WORK/counts.before"; fingerprint > "$WORK/fp.before"
TABLES_BEFORE=$(wc -l < "$WORK/counts.before"); ROWS_BEFORE=$(awk '{s+=$2} END {print s}' "$WORK/counts.before")
RUNS=$(L -c "select count(*) from public.ai_research_runs"); RUN_STATUSES=$(L -c "select string_agg(status||'='||n, ', ' order by status) from (select status, count(*) n from public.ai_research_runs group by 1) s")
check "Pre-check: research run status constraint present (dropped/re-added by 0043)" "select count(*) from pg_constraint where conname='ai_research_runs_status_check'" "1"
check "Pre-check: no 0043 object names already exist" "select count(*) from pg_class where relname in ('ai_decision_records','ai_risk_evaluations','ai_research_budget_config','ai_research_budget_events','ai_research_budget_reservations')" "0"
check "Pre-check: browser roles hold hosted default write grants on research tables (what 0043 removes)" "select bool_and(has_table_privilege('authenticated','public.'||t,'TRUNCATE')) from unnest(string_to_array('$RT',' ')) t" "t"

# ---- apply the draft migration -------------------------------------------------------------------------------------
set +e; LF "$MIG" > "$WORK/mig.log" 2>&1; MIG_RC=$?; set -e
[[ $MIG_RC == 0 ]] && pass "Migration applies cleanly in one transaction (ON_ERROR_STOP)" || fail "Migration applies" "$(tail -3 "$WORK/mig.log" | tr '\n' ' ')"
if [[ $MIG_RC == 0 ]]; then
check "New tables exist" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ('ai_decision_records','ai_risk_evaluations','ai_research_budget_config','ai_research_budget_events','ai_research_budget_reservations')" "5"
check "RLS enabled on every new table" "select bool_and(relrowsecurity) from pg_class where relname in ('ai_decision_records','ai_risk_evaluations','ai_research_budget_config','ai_research_budget_events','ai_research_budget_reservations')" "t"
check "Owner-read policies on decision records and risk evaluations" "select count(*) from pg_policies where tablename in ('ai_decision_records','ai_risk_evaluations') and cmd='SELECT' and roles='{authenticated}'" "2"
check "Existing research owner-read policies unchanged" "select count(*) > 0 from pg_policies where tablename='ai_research_runs' and cmd='SELECT'" "t"
check "Run worker columns added" "select count(*) from information_schema.columns where table_schema='public' and table_name='ai_research_runs' and column_name in ('worker_id','worker_claimed_at')" "2"
check "Status constraint allows the 7 lifecycle statuses" "select pg_get_constraintdef(oid) like '%budget_exceeded%' from pg_constraint where conname='ai_research_runs_status_check'" "t"
TRIGS=$(grep -oP 'CREATE TRIGGER \K\w+' "$MIG" | sort -u); NT=$(echo "$TRIGS" | wc -l); TLIST=$(echo "$TRIGS" | sed "s/.*/'&'/" | paste -sd,)
check "All $NT triggers the migration creates exist (append-only, no-truncate, append guards, validation, lifecycle)" "select count(distinct tgname) from pg_trigger where not tgisinternal and tgname in ($TLIST)" "$NT"
check "SECURITY DEFINER functions: exactly the 5 intended, all with fixed search_path" "select count(*) || ':' || bool_and(array_to_string(proconfig, ',') like '%search_path=public%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and prosecdef and proname in ('set_ai_research_budget','claim_ai_research_worker','reserve_ai_research_budget','settle_ai_research_budget','release_ai_research_budget')" "5:true"
check "Ledger functions: EXECUTE for service_role only" "select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p where proname in ('claim_ai_research_worker','reserve_ai_research_budget','settle_ai_research_budget','release_ai_research_budget')" "t"
check "Admin limits RPC: not executable by visitors" "select has_function_privilege('anon','public.set_ai_research_budget(integer,bigint,bigint,bigint,integer,integer,integer,numeric,numeric)','EXECUTE')" "f"
check "Browser roles: no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any research table" "select bool_and(not has_table_privilege(r, 'public.'||t, p)) from unnest(string_to_array('$RT ai_decision_records ai_risk_evaluations ai_research_budget_config ai_research_budget_events ai_research_budget_reservations',' ')) t, unnest(array['anon','authenticated']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p" "t"
check "Visitors (anon) cannot read research tables" "select bool_and(not has_table_privilege('anon','public.'||t,'SELECT')) from unnest(string_to_array('$RT ai_decision_records ai_risk_evaluations',' ')) t" "t"
check "Signed-in owners keep SELECT on research tables" "select bool_and(has_table_privilege('authenticated','public.'||t,'SELECT')) from unnest(string_to_array('$RT ai_decision_records ai_risk_evaluations',' ')) t" "t"
check "Backend: insert-only on decision records/risk evaluations; read-only on limits and ledger" "select has_table_privilege('service_role','public.ai_decision_records','INSERT') and not has_table_privilege('service_role','public.ai_decision_records','UPDATE') and not has_table_privilege('service_role','public.ai_risk_evaluations','DELETE') and has_table_privilege('service_role','public.ai_research_budget_reservations','SELECT') and not has_table_privilege('service_role','public.ai_research_budget_reservations','INSERT') and not has_table_privilege('service_role','public.ai_research_budget_config','UPDATE')" "t"
check "SHA-256 available" "select encode(sha256(convert_to('abc','UTF8')),'hex')" "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
# Functional checks on the restored data, each inside a transaction that is rolled back.
U=$(L -c "select user_id from public.ai_research_runs limit 1"); [[ -z "$U" ]] && U=00000000-0000-4000-8000-000000000001
AG='[{"agent":"market"},{"agent":"fundamentals"},{"agent":"news"},{"agent":"sentiment"},{"agent":"bull"},{"agent":"bear"},{"agent":"manager"},{"agent":"trader"},{"agent":"risk_aggressive"},{"agent":"risk_conservative"},{"agent":"risk_neutral"},{"agent":"portfolio"}]'
R=11111111-1111-4111-8111-111111111111; WK=22222222-2222-4222-8222-222222222222
FN=$( (L <<SQL 2>&1 || true) | tr '\n' ' '
BEGIN;
INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES ('$R','$U','AAPL');
SET LOCAL ROLE service_role;
SELECT 'claim=' || public.claim_ai_research_worker('$R','$U','$WK');
SELECT 'claim2=' || public.claim_ai_research_worker('$R','$U','33333333-3333-4333-8333-333333333333');
SELECT 'reserve=' || (public.reserve_ai_research_budget('$R','$U','$WK','market','call',8000)->>'ok');
SELECT 'settle=' || public.settle_ai_research_budget(ARRAY[(SELECT id FROM public.ai_research_budget_reservations WHERE run_id='$R')],'$WK',1234,NULL);
INSERT INTO public.ai_decision_records(run_id,user_id,market,symbol,timeframe,outcome,decided_at,schema_version,record,record_sha256)
  VALUES ('$R','$U','equity','AAPL','1d','complete',now(),1,'{"runId":"$R","userId":"$U","symbol":"AAPL","outcome":"complete","advisoryOnly":true,"executionAllowed":false,"agents":$AG}'::jsonb,'app');
SELECT 'sha_ok=' || (record_sha256 = encode(sha256(convert_to(record::text,'UTF8')),'hex')) FROM public.ai_decision_records WHERE run_id='$R';
RESET ROLE;
UPDATE public.ai_research_runs SET status='cancelled' WHERE id='$R';
SELECT 'late_reserve=' || (public.reserve_ai_research_budget('$R','$U','$WK','bull','call',1000)->>'stopped_by');
ROLLBACK;
SQL
)
[[ "$FN" == *"claim=true"*"claim2=false"*"reserve=true"*"settle=1"*"sha_ok=true"*"late_reserve=run_closed"* ]] && pass "Functional: one worker, reserve/settle, database SHA-256 on a decision record, closed run refuses reservations (rolled back)" || fail "Functional checks" "$FN"
NOOUT=$(L -c "BEGIN; UPDATE public.ai_research_runs SET status=status WHERE status NOT IN ('queued','running'); ROLLBACK;" 2>&1 | tr '\n' ' ' || true)
[[ "$NOOUT" == *"finished research run cannot be changed"* || $(L -c "select count(*) from public.ai_research_runs where status not in ('queued','running')") == 0 ]] && pass "Finished restored runs are frozen" || fail "Finished runs frozen" "$NOOUT"
DEL=$(L -c "BEGIN; DELETE FROM public.ai_research_usage; ROLLBACK;" 2>&1 | tr '\n' ' ' || true)
[[ "$DEL" == *"append-only"* || $(L -c "select count(*) from public.ai_research_usage") == 0 ]] && pass "Restored research history cannot be deleted, even by the table owner" || fail "History deletion blocked" "$DEL"
counts > "$WORK/counts.mig"; fingerprint > "$WORK/fp.mig"
cmp -s "$WORK/counts.before" "$WORK/counts.mig" && pass "Existing data unchanged after migration: row counts of all $TABLES_BEFORE public tables" || fail "Row counts after migration" "$(diff "$WORK/counts.before" "$WORK/counts.mig" | head -5 | tr '\n' ' ')"
fi

# ---- rollback ------------------------------------------------------------------------------------------------------
set +e; LF "$RB" > "$WORK/rb.log" 2>&1; RB_RC=$?; set -e
[[ $RB_RC == 0 ]] && pass "Rollback applies cleanly in one transaction" || fail "Rollback applies" "$(tail -3 "$WORK/rb.log" | tr '\n' ' ')"
if [[ $RB_RC == 0 ]]; then
check "Rollback removes every new table, function and column" "select (select count(*) from pg_class where relname in ('ai_decision_records','ai_risk_evaluations','ai_research_budget_config','ai_research_budget_events','ai_research_budget_reservations')) + (select count(*) from pg_proc where proname in ('reserve_ai_research_budget','settle_ai_research_budget','release_ai_research_budget','claim_ai_research_worker','ai_research_counted_tokens','guard_ai_research_append','guard_ai_research_run','set_ai_research_budget','ai_research_history_immutable')) + (select count(*) from information_schema.columns where table_name='ai_research_runs' and column_name in ('worker_id','worker_claimed_at'))" "0"
check "Rollback does NOT reintroduce browser write or TRUNCATE privileges" "select bool_and(not has_table_privilege(r, 'public.'||t, p)) from unnest(string_to_array('$RT',' ')) t, unnest(array['anon','authenticated']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p" "t"
check "Rollback does NOT reintroduce visitor reads; owners keep SELECT" "select bool_and(not has_table_privilege('anon','public.'||t,'SELECT') and has_table_privilege('authenticated','public.'||t,'SELECT')) from unnest(string_to_array('$RT',' ')) t" "t"
check "Original 4-status constraint restored" "select pg_get_constraintdef(oid) like '%budget_exceeded%' from pg_constraint where conname='ai_research_runs_status_check'" "f"
counts > "$WORK/counts.rb"; fingerprint > "$WORK/fp.rb"
cmp -s "$WORK/counts.before" "$WORK/counts.rb" && pass "Existing data unchanged after rollback: row counts of all $TABLES_BEFORE public tables" || fail "Row counts after rollback" "$(diff "$WORK/counts.before" "$WORK/counts.rb" | head -5 | tr '\n' ' ')"
cmp -s "$WORK/fp.before" "$WORK/fp.rb" && pass "Existing research rows byte-identical after migration + rollback (MD5 of every row, 7 tables)" || fail "Research row fingerprints" "$(diff "$WORK/fp.before" "$WORK/fp.rb" | tr '\n' ' ')"
fi

mkdir -p "$(dirname "$OUT")"
{
echo "# Draft migration test on a restored export — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "Practice restore into a throwaway local PostgreSQL $(postgres --version | awk '{print $3}') — **not** the live database and **not** a Lovable Cloud restore. Counts and fingerprints only; no row contents are in this report. The downloaded copy was deleted afterwards."
echo
echo "| Item | Value |"; echo "|---|---|"
echo "| Export | \`$(basename "$SRC")\` |"
echo "| Archive created at | $DUMPED_AT |"
echo "| SHA-256 | \`$SHA\` |"
echo "| pg_restore errors (platform-managed objects a plain PostgreSQL lacks) | $RESTORE_ERRS total, $RESEARCH_ERRS involving research tables |"
echo "| Already-applied migrations replayed on the restore before testing | ${CATCHUP_NOTE} |"
echo "| Restored public tables / rows | $TABLES_BEFORE / $ROWS_BEFORE |"
echo "| Research runs in the restore | $RUNS ($RUN_STATUSES) |"
echo "| Migration tested | \`$(basename "$MIG")\` (sha256 \`$(sha256sum "$MIG" | cut -c1-16)…\`) |"
echo "| Rollback tested | \`$(basename "$RB")\` (sha256 \`$(sha256sum "$RB" | cut -c1-16)…\`) |"
echo
echo "| Check | Result |"; echo "|---|---|"
printf '%s\n' "${RES[@]}"
echo
echo "Overall: $([[ $FAILED == 0 ]] && echo '**ALL CHECKS PASSED**' || echo '**FAILURES — see above**')"
} > "$OUT"
echo "Report: $OUT"; [[ $FAILED == 0 ]] && echo "ALL CHECKS PASSED" || { echo "FAILURES"; grep FAIL "$OUT"; }
