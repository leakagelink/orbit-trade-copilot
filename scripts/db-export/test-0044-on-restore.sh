#!/usr/bin/env bash
# Practice-restores a Lovable Cloud database export into a throwaway local PostgreSQL in /tmp (never the live database),
# optionally replays already-applied migrations, then tests DRAFT migration 0044 (forward paper ledger) and its rollback:
# every expected table, constraint, index, trigger, RLS policy, grant and function; functional refusals inside rolled-back
# transactions; existing data byte-identical (MD5 of every row of every pre-existing table, plus auth user count); and the
# privileges/policies of every pre-existing object identical after the migration AND after the rollback.
# Usage: scripts/db-export/test-0044-on-restore.sh <bucket/object | file.backup> [catch-up.sql ...]
# Writes a counts-and-hashes-only report (no row contents) and deletes the downloaded copy. Not a Lovable Cloud restore.
set -euo pipefail
SRC="${1:?export}"; shift; CATCHUP=("$@")
MIG=docs/proposed-migrations/0044_forward_paper_trading.sql; RB=docs/proposed-migrations/0044_forward_paper_trading.rollback.sql
WORK=$(mktemp -d /tmp/mig44-restore.XXXXXX); PGL="$WORK/pg"; PORT=55436
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
APP_ERRS=$(grep '^pg_restore: error' "$WORK/restore.log" | grep -c 'public\.' || true)
CATCHUP_NOTE="none"
for f in "${CATCHUP[@]}"; do LF "$f" >/dev/null; CATCHUP_NOTE="${CATCHUP_NOTE/none/} \`$(basename "$f")\`"; done
OUT="${REPORT:-docs/certification/migration-0044-restore-test-$(date -u +%Y%m%dT%H%M%SZ).md}"
RES=(); FAILED=0; pass(){ RES+=("| $1 | PASS |"); }; fail(){ RES+=("| $1 | **FAIL** — $2 |"); FAILED=1; }
check(){ local got; got=$(L -c "$2" 2>&1 | tr '\n' ' ' | sed 's/ *$//' || true); [[ "$got" == "$3" ]] && pass "$1" || fail "$1" "expected \`$3\`, got \`$got\`"; }
PAPER="'paper_accounts','paper_strategies','paper_bars','paper_order_events','paper_trades'"
fingerprint(){ for t in $(L -c "select tablename from pg_tables where schemaname='public' and tablename not in ($PAPER) order by 1"); do echo "$t $(L -c "select count(*) || ' ' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.\"$t\" x")"; done
  echo "auth.users $(L -c "select count(*) from auth.users" 2>/dev/null || echo n/a)"; }
privileges(){ L -c "select 'table '||grantee||' '||table_name||' '||privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role','PUBLIC') and table_name not in ($PAPER)
  union all select 'function '||r.grantee||' '||r.specific_name||' '||r.privilege_type from information_schema.role_routine_grants r where r.routine_schema='public' and r.grantee in ('anon','authenticated','service_role','PUBLIC') and r.routine_name not in ('paper_commit_bar','paper_history_immutable','guard_paper_account','guard_paper_strategy')
  union all select 'policy '||tablename||' '||policyname||' '||cmd||' '||roles::text||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname='public' and tablename not in ($PAPER)
  union all select 'rls '||c.relname||' '||c.relrowsecurity||' '||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname not in ($PAPER)
  union all select 'secdef '||p.proname||' '||coalesce(array_to_string(p.proconfig,','),'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.proname<>'paper_commit_bar'
  order by 1"; }
fingerprint > "$WORK/fp.before"; privileges > "$WORK/priv.before"
TABLES_BEFORE=$(($(wc -l < "$WORK/fp.before") - 1)); ROWS_BEFORE=$(awk '$1!="auth.users"{s+=$2} END {print s}' "$WORK/fp.before")
PAPERBOTS=$(L -c "select count(*) from public.trading_bots where mode='paper'" 2>/dev/null || echo n/a)
PAPERTRADES=$(L -c "select count(*) from public.trades where mode='paper'" 2>/dev/null || echo n/a)

set +e; LF "$MIG" > "$WORK/mig.log" 2>&1; MIG_RC=$?; set -e
[[ $MIG_RC == 0 ]] && pass "Migration 0044 applies cleanly in one transaction on the restored data" || fail "Migration applies" "$(tail -3 "$WORK/mig.log" | tr '\n' ' ')"
if [[ $MIG_RC == 0 ]]; then
check "5 paper tables exist" "select count(*) from pg_tables where schemaname='public' and tablename in ($PAPER)" "5"
check "Row security enabled on all 5" "select count(*) from pg_class where relname in ($PAPER) and relrowsecurity" "5"
check "5 owner-read policies, SELECT only, signed-in role only, owner + MFA" "select count(*) || ':' || bool_and(cmd='SELECT' and roles::text='{authenticated}' and qual like '%auth.uid()%' and qual like '%account_mfa_allowed%') from pg_policies where tablename in ($PAPER)" "5:true"
check "Indexes (5 named + primary keys + unique keys)" "select count(*) from pg_indexes where tablename in ($PAPER) and indexname in ('paper_strategies_one_running','paper_strategies_user','paper_bars_user','paper_order_events_user','paper_trades_user')" "5"
check "Unique keys: one record per candle, per event sequence, per settled position" "select count(*) from pg_constraint where contype='u' and conrelid::regclass::text in ('paper_bars','paper_order_events','paper_trades')" "3"
check "Every fill and settlement row is forced simulated" "select count(*) from pg_constraint where contype='c' and pg_get_constraintdef(oid) like '%simulated%'" "2"
check "No foreign key from paper tables to any real-trading, wallet or auth table" "select count(*) from pg_constraint where contype='f' and conrelid::regclass::text in ($PAPER) and confrelid::regclass::text not in ($PAPER)" "0"
TRIGS=$(grep -oP 'CREATE TRIGGER \K\w+' "$MIG" | sort -u | wc -l)
check "Triggers: 6 append-only/no-truncate on history (loop) + $TRIGS named" "select count(*) from pg_trigger where not tgisinternal and tgrelid::regclass::text in ($PAPER)" "$((TRIGS + 6))"
check "Only paper_commit_bar is SECURITY DEFINER, with fixed search_path" "select string_agg(proname || ':' || array_to_string(proconfig, ','), ' ') from pg_proc where prosecdef and proname in ('paper_commit_bar','paper_history_immutable','guard_paper_account','guard_paper_strategy')" "paper_commit_bar:search_path=public"
check "paper_commit_bar: EXECUTE for service_role only" "select has_function_privilege('service_role','public.paper_commit_bar(uuid,bigint,jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.paper_commit_bar(uuid,bigint,jsonb)','EXECUTE') and not has_function_privilege('anon','public.paper_commit_bar(uuid,bigint,jsonb)','EXECUTE')" "t"
check "Browser roles: no write privilege of any kind on paper tables" "select bool_and(not has_table_privilege(r, 'public.'||t, p)) from unnest(array[$PAPER]) t, unnest(array['anon','authenticated']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p" "t"
check "Visitors cannot read; signed-in owners can (policy-limited)" "select bool_and(not has_table_privilege('anon','public.'||t,'SELECT') and has_table_privilege('authenticated','public.'||t,'SELECT')) from unnest(array[$PAPER]) t" "t"
check "Backend: no direct insert into history; no DELETE/TRUNCATE anywhere; INSERT/UPDATE only on accounts and strategies" "select bool_and(not has_table_privilege('service_role','public.'||t,'DELETE') and not has_table_privilege('service_role','public.'||t,'TRUNCATE')) and not has_table_privilege('service_role','public.paper_bars','INSERT') and not has_table_privilege('service_role','public.paper_trades','UPDATE') and has_table_privilege('service_role','public.paper_strategies','INSERT') from unnest(array[$PAPER]) t" "t"
U=00000000-0000-4000-8000-0000000000f1
FN=$( (L <<SQL 2>&1 || true) | tr '\n' ' '
BEGIN; SET LOCAL ROLE service_role;
INSERT INTO public.paper_accounts(user_id) VALUES ('$U');
INSERT INTO public.paper_strategies(id,user_id,strategy_id,strategy_name,config,engine_version,data_source,pair,timeframe,costs,risk,starting_capital,state)
  VALUES ('00000000-0000-4000-8000-0000000000f2','$U',gen_random_uuid(),'Restore check','{}','forward-paper-v1','binance-public-spot-klines','BTC/USDT','1h','{}','{}',1000,'{"v":1,"cash":1000,"position":null,"orders":[],"seq":0,"dayUtc":null,"dayNet":0,"closedTrades":0}');
SELECT 'start=' || (cursor_t + tf_ms >= floor(extract(epoch from now())*1000)::bigint - tf_ms) || ',' || cash FROM public.paper_strategies WHERE user_id='$U';
SAVEPOINT a; SELECT public.paper_commit_bar('00000000-0000-4000-8000-0000000000f2', (SELECT cursor_t FROM public.paper_strategies WHERE user_id='$U'), '{"bar":{"bar_t":0}}'); ROLLBACK TO a;
SAVEPOINT b; SELECT public.paper_commit_bar('00000000-0000-4000-8000-0000000000f2', (SELECT cursor_t FROM public.paper_strategies WHERE user_id='$U'), json_build_object('bar', json_build_object('bar_t', (SELECT cursor_t + tf_ms FROM public.paper_strategies WHERE user_id='$U')))::jsonb); ROLLBACK TO b;
SAVEPOINT c; SELECT set_config('paper.commit','on',true); UPDATE public.paper_strategies SET cash=99999 WHERE user_id='$U'; ROLLBACK TO c;
SAVEPOINT d; UPDATE public.paper_strategies SET risk='{"x":1}' WHERE user_id='$U'; ROLLBACK TO d;
SAVEPOINT e; DELETE FROM public.paper_strategies WHERE user_id='$U'; ROLLBACK TO e;
ROLLBACK;
SQL
)
[[ "$FN" == *"start=true,1000"*"paper_bar_out_of_sequence"*"paper_bar_not_closed"*"only through paper_commit_bar"*"frozen"*"permission denied"* ]] && pass "Functional (rolled back): starts flat at the next candle; refuses out-of-sequence and unclosed candles; backend cannot edit balances (even with the flag), terms, or delete" || fail "Functional checks" "$FN"
fingerprint > "$WORK/fp.mig"; privileges > "$WORK/priv.mig"
cmp -s "$WORK/fp.before" "$WORK/fp.mig" && pass "Existing data byte-identical after migration ($TABLES_BEFORE tables, MD5 of every row; auth users count)" || fail "Existing data after migration" "$(diff "$WORK/fp.before" "$WORK/fp.mig" | head -4 | tr '\n' ' ')"
cmp -s "$WORK/priv.before" "$WORK/priv.mig" && pass "Pre-existing grants, function grants, policies, RLS flags and SECURITY DEFINER settings unchanged by the migration ($(wc -l < "$WORK/priv.before") entries)" || fail "Pre-existing privileges after migration" "$(diff "$WORK/priv.before" "$WORK/priv.mig" | head -4 | tr '\n' ' ')"
fi

set +e; LF "$RB" > "$WORK/rb.log" 2>&1; RB_RC=$?; set -e
[[ $RB_RC == 0 ]] && pass "Rollback applies cleanly in one transaction" || fail "Rollback applies" "$(tail -3 "$WORK/rb.log" | tr '\n' ' ')"
if [[ $RB_RC == 0 ]]; then
check "Rollback removes every paper table and function" "select (select count(*) from pg_class where relname in ($PAPER)) + (select count(*) from pg_proc where proname in ('paper_commit_bar','paper_history_immutable','guard_paper_account','guard_paper_strategy'))" "0"
fingerprint > "$WORK/fp.rb"; privileges > "$WORK/priv.rb"
cmp -s "$WORK/priv.before" "$WORK/priv.rb" && pass "Rollback leaves every pre-existing grant, policy, RLS flag and SECURITY DEFINER setting exactly as before (does not weaken security)" || fail "Privileges after rollback" "$(diff "$WORK/priv.before" "$WORK/priv.rb" | head -4 | tr '\n' ' ')"
cmp -s "$WORK/fp.before" "$WORK/fp.rb" && pass "Existing data byte-identical after migration + rollback" || fail "Existing data after rollback" "$(diff "$WORK/fp.before" "$WORK/fp.rb" | head -4 | tr '\n' ' ')"
fi

mkdir -p "$(dirname "$OUT")"
{
echo "# Draft migration 0044 test on a restored export — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "Practice restore into a throwaway local PostgreSQL $(postgres --version | awk '{print $3}') — **not** the live database and **not** a Lovable Cloud restore. Counts and hashes only; no row contents. The downloaded copy was deleted afterwards."
echo
echo "| Item | Value |"; echo "|---|---|"
echo "| Export | \`$(basename "$SRC")\` |"
echo "| Archive created at | $DUMPED_AT |"
echo "| SHA-256 | \`$SHA\` |"
echo "| pg_restore errors (platform-managed objects a plain PostgreSQL lacks) | $RESTORE_ERRS total, $APP_ERRS mentioning public objects |"
echo "| Already-applied migrations replayed before testing | ${CATCHUP_NOTE} |"
echo "| Restored public tables / rows | $TABLES_BEFORE / $ROWS_BEFORE |"
echo "| Paper bots / paper trades (existing bot paper mode) in the restore | $PAPERBOTS / $PAPERTRADES |"
echo "| Migration tested | \`$(basename "$MIG")\` (sha256 \`$(sha256sum "$MIG" | cut -c1-16)…\`) |"
echo "| Rollback tested | \`$(basename "$RB")\` (sha256 \`$(sha256sum "$RB" | cut -c1-16)…\`) |"
echo
echo "| Check | Result |"; echo "|---|---|"
printf '%s\n' "${RES[@]}"
echo
echo "Overall: $([[ $FAILED == 0 ]] && echo '**ALL CHECKS PASSED**' || echo '**FAILURES — see above**')"
} > "$OUT"
echo "Report: $OUT"; [[ $FAILED == 0 ]] && echo "ALL CHECKS PASSED" || { echo "FAILURES"; grep FAIL "$OUT"; }
