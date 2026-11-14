#!/usr/bin/env bash
# LOCAL-ONLY restore and recovery verifier for the COMPLETE draft chain 0049 → 0057 (Phase 4H.7). NOT a Cloud restore
# test and NOT an approval to apply anything. Same isolation as verify-local-restore-0054.sh (prelude kept verbatim in
# substance): only an explicit local pg_dump custom-format file supplied by the owner; URLs, bucket paths, connection
# strings and extra arguments are refused; DATABASE_URL, PG*, SUPABASE_* and LOVABLE_DB_* are unset; a disposable
# PostgreSQL in a fresh /tmp directory on a private UNIX socket only; every psql/pg_restore call goes through one guarded
# helper bound to that socket. Counts, hashes and object names only — no row content is printed.
#
# Checks: restore fidelity and migration ordering (drizzle history vs this repository); prerequisites of 0055–0057; each
# draft refused without its predecessor (rolled back, nothing left); the chain applied in order, each file in ONE
# transaction (timed); every out-of-order rollback refused; destructive-rollback classification (tables a rollback DROPS
# vs RENAMES, with their row counts at that moment); history preservation (before any rollback that drops tables, each
# such table is exported with \copy to PRESERVE_DIR, row count and SHA-256 recorded); the rollback chain 0057 → 0049 as
# far as it can go; the pre-existing objects and row counts unchanged; recovery (retired history archived under a dated
# name, then the chain re-applied).
#
# Usage: scripts/db-export/verify-local-restore-0057.sh /path/to/export.backup
#   Optional env: REPORT=/path/report.md; PRESERVE_DIR=/path/dir (default: inside the disposable work dir, deleted at exit).
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
ROOT=$(cd "$(dirname "$0")/../.." && pwd); PM="$ROOT/docs/proposed-migrations"
CHAIN=(0049 0050 0051 0052 0053 0054 0055 0056 0057)
declare -A MIGF RBF
for k in "${CHAIN[@]}"; do
  MIGF[$k]=$(ls "$PM"/${k}_*.sql 2>/dev/null | grep -v '\.rollback\.sql$' | head -1 || true); RBF[$k]=$(ls "$PM"/${k}_*.rollback.sql 2>/dev/null | head -1 || true)
  [[ -f "${MIGF[$k]}" && -f "${RBF[$k]}" ]] || refuse "draft $k migration or rollback file missing"
done
FILE=$(readlink -f "$SRC"); SHA=$(sha256sum "$FILE" | cut -d' ' -f1); SIZE=$(stat -c %s "$FILE")
OUT="${REPORT:-/tmp/verify-chain-0057-$(date -u +%Y%m%dT%H%M%SZ).md}"

WORK=$(mktemp -d /tmp/verify-chain57.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
PRESERVE="${PRESERVE_DIR:-$WORK/preserved}"; mkdir -p "$PRESERVE"; chmod 0777 "$PRESERVE"
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
# Applies one file in ONE transaction; prints elapsed ms on success, returns non-zero (and changes nothing) on failure.
APPLY(){ local f="$1" t0 t1; t0=$(date +%s%3N); if local_pg psql -qAtX -v ON_ERROR_STOP=1 --single-transaction -f "$f" >"$WORK/last.log" 2>&1; then t1=$(date +%s%3N); echo $((t1-t0)); return 0; else return 1; fi; }
LASTERR(){ grep -m1 -oE 'ERROR: .{0,140}' "$WORK/last.log" | sed 's/|/\\|/g' || echo "error"; }

TOC="$WORK/toc.txt"; pg_restore --list "$FILE" > "$TOC" || refuse "not a readable pg_dump custom-format archive"
DUMPED_AT=$(grep -m1 "Archive created at" "$TOC" | sed "s/.*Archive created at //" || true)
SCRIPT_SQL="$WORK/archive.sql"; pg_restore --file=- "$FILE" > "$SCRIPT_SQL" || refuse "archive could not be read end to end"
ARCHIVE_ROLES=$(grep -oE '^(GRANT|REVOKE) .* (TO|FROM) [a-z_][a-z0-9_]*( WITH GRANT OPTION)?;$' "$SCRIPT_SQL" | sed -E 's/ WITH GRANT OPTION;$/;/; s/.* (TO|FROM) ([a-z_][a-z0-9_]*);$/\2/' | sort -u | grep -vxE 'postgres|public' || true)
for r in anon authenticated "service_role BYPASSRLS" authenticator supabase_admin supabase_auth_admin supabase_storage_admin dashboard_user pgbouncer supabase_realtime_admin supabase_replication_admin supabase_read_only_user $ARCHIVE_ROLES; do Q "create role $r" >/dev/null 2>&1 || true; done
set +e; local_pg pg_restore --no-owner -d verify "$FILE" > "$WORK/restore.log" 2>&1; set -e
ERRS=$(grep -c '^pg_restore: error' "$WORK/restore.log" || true)
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

FAIL=0; ROWS=""; DESTR=""
row(){ ROWS+="| $1 | $2 | $3 |"$'\n'; [[ "$2" == FAIL ]] && FAIL=$((FAIL+1)); return 0; }
chk(){ if [[ "$(Q "$2" 2>/dev/null || echo ERR)" == t ]]; then row "$1" PASS "$3"; else row "$1" FAIL "$3"; fi; }
[[ "$ERR_UNEXPECTED" == 0 ]] && row "pg_restore errors classified" PASS "$ERRS errors, all managed-extension objects (cron/net/vault)" || row "pg_restore errors classified" FAIL "$ERR_UNEXPECTED unexpected in: $ERR_WHERE"

# --- migration ordering: drizzle history in the archive vs this repository's journal (timestamps and SHA-256) ---
JOURNAL="$ROOT/drizzle/migrations/meta/_journal.json"
EXPECTED=$(python3 - "$JOURNAL" "$ROOT/drizzle/migrations" <<'PY'
import json,sys,hashlib
j=json.load(open(sys.argv[1]))
for e in j["entries"]:
    print(f"{e['when']}|{hashlib.sha256(open(f'{sys.argv[2]}/{e[chr(116)+chr(97)+chr(103)]}.sql','rb').read()).hexdigest()}")
PY
)
if [[ "$(Q "select to_regclass('drizzle.__drizzle_migrations') is not null")" == t ]]; then
  APPLIED=$(Q "select created_at::text || '|' || hash from drizzle.__drizzle_migrations order by created_at, id")
  if [[ "$APPLIED" == "$EXPECTED" ]]; then row "Migration ordering" PASS "$(wc -l <<<"$APPLIED") entries equal drizzle/migrations in order (latest $(tail -1 <<<"$EXPECTED" | cut -d'|' -f1))"
  else row "Migration ordering" FAIL "restored history ($(grep -c . <<<"$APPLIED" || true) rows) differs from drizzle/migrations ($(wc -l <<<"$EXPECTED") entries)"; fi
else row "Migration ordering" FAIL "drizzle.__drizzle_migrations not in the archive: applied schema version cannot be established"; fi
chk "0039 safety objects present" "select to_regclass('public.futures_certifications') is not null and exists(select 1 from pg_proc where proname='futures_live_authorized')" "the export must postdate applied migration 0039"
chk "No draft 0049–0057 object present before" "select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (relname like 'futures_paper%' or relname in ('strategy_risk_budgets','account_risk_budgets'))) and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname ~ '^(fp[2-5]_|fpw_|futures_paper_)'))" "the chain must start from a database without 0045–0057 objects"
chk "Prerequisites of 0055 (auth.sessions, auth.mfa_factors, workspace_sessions, user_roles, has_role)" "select to_regclass('auth.sessions') is not null and to_regclass('auth.mfa_factors') is not null and to_regclass('public.workspace_sessions') is not null and to_regclass('public.user_roles') is not null and to_regprocedure('public.has_role(uuid,app_role)') is not null" "0055 refuses without them"
chk "Prerequisites of 0057 (auth.users / auth.identities sign-in columns)" "select (select count(*) from pg_attribute where attrelid=to_regclass('auth.users') and attnum>0 and not attisdropped and attname in ('id','email','encrypted_password','email_change','email_change_sent_at','phone','phone_change','phone_change_sent_at','recovery_sent_at','reauthentication_sent_at','banned_until','deleted_at','is_sso_user','is_anonymous','role','aud','raw_app_meta_data'))=17 and (select count(*) from pg_attribute where attrelid=to_regclass('auth.identities') and attnum>0 and not attisdropped and attname in ('user_id','provider','provider_id','email'))=4" "0057 refuses without them"
row "auth schema in the archive" INFO "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE auth ' "$TOC" || true) auth tables, $(awk '/^COPY auth\.users /{f=1;next} f&&/^\\\.$/{f=0} f' "$SCRIPT_SQL" | grep -c . || true) auth.users rows (counts only)"

# --- fingerprints: pre-existing objects (worker objects excluded) and every public object ---
W_REL="(relname like 'futures_paper%' or relname in ('strategy_risk_budgets','account_risk_budgets'))"; W_FN="(proname ~ '^(fp[2-5]_|fpw_|futures_paper_|guard_futures_paper|guard_account_risk_budget|guard_strategy_risk_budget)')"
FP_PRE="select md5(coalesce(string_agg(x, E'\n' order by x),'')) from (
  select 'col:'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull x from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped and not $W_REL
  union all select 'pol:'||tablename||'.'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname='public' and tablename not like 'futures_paper%' and tablename not in ('strategy_risk_budgets','account_risk_budgets')
  union all select 'acl:'||c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not $W_REL
  union all select 'fn:'||p.proname||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not $W_FN
  union all select 'trg:'||tgrelid::regclass::text||'.'||tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid where not tgisinternal and not (c.relname like 'futures_paper%' or c.relname in ('strategy_risk_budgets','account_risk_budgets'))
  union all select 'role:'||r.rolname||':'||coalesce(array_to_string(s.setconfig, ','),'') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
) s"
FP_ALL="select md5(coalesce(string_agg(x, E'\n' order by x),'')) from (
  select 'rel:'||c.relname||':'||c.relkind||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity x from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','p','S') and c.relname not like '%\_retired' and c.relname not like '%\_archived\_%'
  union all select 'col:'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v') and a.attnum>0 and not a.attisdropped and c.relname not like '%\_retired' and c.relname not like '%\_archived\_%'
  union all select 'fn:'||p.oid::regprocedure::text||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'')||':'||p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  union all select 'pol:'||tablename||'.'||policyname||':'||coalesce(qual,'') from pg_policies where schemaname='public' and tablename not like '%\_retired' and tablename not like '%\_archived\_%'
  union all select 'trg:'||c.relname||'.'||t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname not like '%\_retired' and c.relname not like '%\_archived\_%'
  union all select 'role:'||r.rolname||':'||coalesce(array_to_string(s.setconfig, ','),'') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
) s"
rowcounts(){ local acc=""; for t in $(Q "select tablename from pg_tables where schemaname='public' and not (tablename like 'futures_paper%' or tablename in ('strategy_risk_budgets','account_risk_budgets')) order by 1"); do acc+="$t=$(Q "select count(*) from public.\"$t\"") "; done; echo "$acc"; }
FP0=$(Q "$FP_PRE"); RC0=$(rowcounts)
# Configuration writes under 0052 need a reason; set for this disposable database only.
Q "alter database verify set futures_paper.change_reason = 'local restore verification (disposable)'" >/dev/null

# --- each draft is refused without its predecessor (on the restored base) ---
for k in "${CHAIN[@]:1}"; do
  B=$(Q "$FP_ALL")
  if APPLY "${MIGF[$k]}" >/dev/null; then row "Draft $k refused without its predecessor" FAIL "it applied on the base"; else
    [[ "$(Q "$FP_ALL")" == "$B" ]] && row "Draft $k refused without its predecessor" PASS "$(LASTERR); rolled back, nothing left" || row "Draft $k refused without its predecessor" FAIL "refused but left objects behind"; fi
done

# --- the chain, in order, each file in ONE transaction ---
declare -A FPB TIMES
for k in "${CHAIN[@]}"; do
  FPB[$k]=$(Q "$FP_ALL")
  if ms=$(APPLY "${MIGF[$k]}"); then TIMES[$k]=$ms; row "Apply $k" PASS "$(basename "${MIGF[$k]}") in one transaction, ${ms} ms"; else row "Apply $k" FAIL "$(LASTERR)"; break; fi
done
FP_TOP=$(Q "$FP_ALL")
[[ "$(rowcounts)" == "$RC0" ]] && row "Pre-existing row counts unchanged after the chain" PASS "$(wc -w <<<"$RC0") tables" || row "Pre-existing row counts unchanged after the chain" FAIL "row counts changed"
CHG=$(Q "select (select count(*) from pg_policies where schemaname='public' and policyname='fpw_worker_identity_guard')||' restrictive worker-guard policies; account_mfa_allowed replaced: '||(select (prosrc like '%futures_paper_worker_identities%')::text from pg_proc where proname='account_mfa_allowed')||'; user_roles guard trigger: '||exists(select 1 from pg_trigger where tgname='fpw_worker_role_guard')::text||'; data-API hook: '||exists(select 1 from pg_db_role_setting s, unnest(s.setconfig) c(v) where c.v='pgrst.db_pre_request=public.fpw_api_pre_request')::text")
row "Intended changes to pre-existing objects (0055/0056)" INFO "$CHG"

# --- every out-of-order rollback is refused while its successor is applied ---
for i in $(seq 0 $((${#CHAIN[@]}-2))); do
  k=${CHAIN[$i]}
  if APPLY "${RBF[$k]}" >/dev/null; then row "Rollback $k refused while ${CHAIN[$((i+1))]} is applied" FAIL "it ran"; break; fi
  [[ "$(Q "$FP_ALL")" == "$FP_TOP" ]] && row "Rollback $k refused while ${CHAIN[$((i+1))]} is applied" PASS "$(LASTERR)" || row "Rollback $k refused while ${CHAIN[$((i+1))]} is applied" FAIL "refused but changed objects"
done

# --- rollback chain 0057 → 0049 with destructive classification and history preservation ---
for (( i=${#CHAIN[@]}-1; i>=0; i-- )); do
  k=${CHAIN[$i]}; f="${RBF[$k]}"
  DROPS=$(grep -oiE 'DROP TABLE (IF EXISTS )?public\.[a-z0-9_]+' "$f" | sed -E 's/.*public\.//' | sort -u | tr '\n' ' ')
  RENAMES=$(grep -oE 'RENAME TO [a-z0-9_]+' "$f" | sed 's/RENAME TO //' | sort -u | tr '\n' ' ')
  rows_at=""; saved=""
  for t in $DROPS; do
    [[ "$(Q "select to_regclass('public.$t') is not null")" == t ]] || continue
    c=$(Q "select count(*) from public.\"$t\""); rows_at+="$t=$c "
    mkdir -p "$PRESERVE/$k"; chmod 0777 "$PRESERVE/$k"
    local_pg psql -qAtX -v ON_ERROR_STOP=1 -c "\\copy (select * from public.\"$t\") to '$PRESERVE/$k/$t.csv' with (format csv, header true)" >/dev/null
    lines=$(( $(wc -l < "$PRESERVE/$k/$t.csv") - 1 ))
    [[ "$lines" == "$c" ]] || row "Preserve $t before rollback $k" FAIL "exported $lines of $c rows"
    saved+="$t:$c:$(sha256sum "$PRESERVE/$k/$t.csv" | cut -c1-12) "
  done
  if [[ -n "$DROPS" ]]; then CLS="DESTRUCTIVE"; elif [[ -n "$RENAMES" ]]; then CLS="PRESERVING (renames)"; else CLS="NO TABLES"; fi
  DESTR+="| $k | $CLS | ${DROPS:-—} | ${RENAMES:-—} | ${rows_at:-—} | ${saved:-—} |"$'\n'
  if ms=$(APPLY "$f"); then
    if [[ "$(Q "$FP_ALL")" == "${FPB[$k]}" ]]; then row "Rollback $k" PASS "one transaction, ${ms} ms; every object of $k removed or restored exactly (retired tables kept)"; else row "Rollback $k" FAIL "ran, but the catalog differs from before $k was applied"; fi
  else row "Rollback $k" FAIL "$(LASTERR)"; ROLLBACK_STOP=$k; break; fi
done
RET=$(Q "select coalesce(string_agg(relname||'='||(xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', relname), false, true, '')))[1]::text, ' ' order by relname),'none') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and relname like '%\_retired'")
row "Retired history tables kept" INFO "$RET"
if [[ -z "${ROLLBACK_STOP:-}" ]]; then
  [[ "$(Q "$FP_PRE")" == "$FP0" && "$(rowcounts)" == "$RC0" ]] && row "Pre-existing objects and row counts identical after the full rollback" PASS "fingerprint $FP0" || row "Pre-existing objects and row counts identical after the full rollback" FAIL "fingerprint or row counts changed"
else row "Full rollback" FAIL "stopped at $ROLLBACK_STOP (see the row above); objects below it remain applied"; fi

# --- recovery: archive retired history under a dated name, then re-apply the chain from where the rollback stopped ---
STAMP=$(date -u +%Y%m%d%H%M%S)
for t in $(Q "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and relname like '%\_retired' order by 1"); do
  Q "alter table public.\"$t\" rename to \"${t%_retired}_archived_$STAMP\"" >/dev/null
done
START=0; if [[ -n "${ROLLBACK_STOP:-}" ]]; then for i in "${!CHAIN[@]}"; do [[ "${CHAIN[$i]}" == "$ROLLBACK_STOP" ]] && START=$((i+1)); done; fi
RECOK=1
for k in "${CHAIN[@]:$START}"; do if ! APPLY "${MIGF[$k]}" >/dev/null; then row "Recovery: re-apply $k" FAIL "$(LASTERR)"; RECOK=0; break; fi; done
[[ $RECOK == 1 ]] && { [[ "$(Q "$FP_ALL")" == "$FP_TOP" ]] && row "Recovery: chain re-applied" PASS "catalog equals the first application; archived history: $(Q "select coalesce(string_agg(relname, ' ' order by relname),'none') from pg_class where relname like '%\_archived\_$STAMP'")" || row "Recovery: chain re-applied" FAIL "catalog differs from the first application"; }

VERDICT=PASS; [[ $FAIL -gt 0 || "${ERR_UNEXPECTED:-1}" != 0 ]] && VERDICT=FAIL
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<MD
# Local-only restore and recovery verification — draft chain 0049 → 0057 — $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Verdict: $VERDICT** (local disposable PostgreSQL $(postgres --version | awk '{print $3}'), private UNIX socket only). This is a practice
restore, not a Lovable Cloud restore and not an approval to apply any of 0049–0057. Nothing was applied anywhere else.

- Archive: \`$(basename "$FILE")\`, $SIZE bytes, SHA-256 \`$SHA\`, created at: ${DUMPED_AT:-unknown}
- pg_restore errors: $ERRS total — $ERR_EXPECTED tolerated (managed-extension objects: cron/net/vault), $ERR_UNEXPECTED unexpected
- Ambient connection variables ignored: ${AMBIENT:-none}
- Drafts: $(for k in "${CHAIN[@]}"; do echo -n "$k \`$(sha256sum "${MIGF[$k]}" | cut -c1-12)\`/\`$(sha256sum "${RBF[$k]}" | cut -c1-12)\` "; done)

| Check | Result | Detail |
|---|---|---|
$ROWS
## Rollback classification (row counts at the moment of rollback; preserved copies: table:rows:sha256-prefix)

| Rollback | Class | Drops tables | Renames to | Rows at rollback | Preserved before rollback |
|---|---|---|---|---|---|
$DESTR
MD
echo "$VERDICT — report: $OUT"
[[ "$VERDICT" == PASS ]]
