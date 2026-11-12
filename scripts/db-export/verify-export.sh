#!/usr/bin/env bash
# Read-only verification of a Lovable Cloud database export (pg_dump custom-format .backup).
# Usage: scripts/db-export/verify-export.sh <bucket>/<object>   (downloads with the backend service key)
#    or: scripts/db-export/verify-export.sh /path/to/file.backup
# Restores into a throwaway local PostgreSQL in /tmp (never the live database), compares per-table row counts with the live
# database (SELECT only), checks the safety-migration objects, writes a counts-only report, and deletes the downloaded copy.
# This is a practice restore, not a Lovable Cloud restore: it proves the file is readable and restorable, not restore readiness.
set -euo pipefail
SRC="${1:?export path or bucket/object required}"
WORK=$(mktemp -d /tmp/export-verify.XXXXXX); PGL="$WORK/pg"; PORT=55432
cleanup(){ setpriv --reuid=65534 --regid=65534 --clear-groups pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
if [[ -f "$SRC" ]]; then FILE="$SRC"; else
  FILE="$WORK/export.backup"
  curl -fsS -o "$FILE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_URL/storage/v1/object/$SRC"
fi
SHA=$(sha256sum "$FILE" | cut -d' ' -f1); SIZE=$(stat -c %s "$FILE")
OUT="${REPORT:-docs/certification/export-verification-$(date -u +%Y%m%dT%H%M%SZ).md}"
TOC="$WORK/toc.txt"; pg_restore --list "$FILE" > "$TOC"
DUMPED_AT=$(grep -m1 "Archive created at" "$TOC" | sed "s/.*Archive created at //" || true)
kind(){ grep -E "^[0-9]+; [0-9]+ [0-9]+ $1 " "$TOC" | wc -l; }
pubkind(){ grep -E "^[0-9]+; [0-9]+ [0-9]+ $1 public " "$TOC" | wc -l; }

# PostgreSQL refuses to run as root: run the throwaway server as an unprivileged sandbox user.
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"; AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null
L(){ PGHOST=$WORK PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres PGPASSWORD= PGSSLMODE=disable psql -qAtX "$@"; }
for r in sandbox_exec anon authenticated service_role authenticator supabase_admin supabase_auth_admin supabase_storage_admin dashboard_user pgbouncer supabase_realtime_admin supabase_replication_admin supabase_read_only_user; do L -c "create role $r" 2>/dev/null || true; done
set +e
PGHOST=$WORK PGPORT=$PORT PGUSER=postgres PGPASSWORD= PGSSLMODE=disable pg_restore --no-owner -d postgres "$FILE" > "$WORK/restore.log" 2>&1
set -e
ERRS=$(grep -c '^pg_restore: error' "$WORK/restore.log" || true)
ERR_SAMPLE=$(grep '^pg_restore: error' "$WORK/restore.log" | sed -E 's/ at character [0-9]+//' | sort | uniq -c | sort -rn | head -12)

# Per-table counts: restored copy vs live (SELECT only). Live keeps changing, so differences are reported, not hidden.
TABLES=$(L -c "select tablename from pg_tables where schemaname='public' order by 1")
ROWS=""; SAME=0; DIFF=0; MISSING_LIVE=0
for t in $TABLES; do
  a=$(L -c "select count(*) from public.\"$t\"" 2>/dev/null || echo ERR)
  b=$(psql -qAtX -c "select count(*) from public.\"$t\"" 2>/dev/null || echo n/a)
  [[ "$b" == n/a ]] && MISSING_LIVE=$((MISSING_LIVE+1))
  if [[ "$a" == "$b" ]]; then SAME=$((SAME+1)); else DIFF=$((DIFF+1)); ROWS+="| $t | $a | $b |"$'\n'; fi
done
LIVE_ONLY=$(comm -13 <(echo "$TABLES" | sort) <(psql -qAtX -c "select tablename from pg_tables where schemaname='public'" | sort) | tr '\n' ' ')
q(){ L -c "$1" 2>/dev/null || echo ERR; }
chk(){ [[ "$(q "$2")" == t ]] && echo "| $1 | present |" || echo "| $1 | **MISSING** |"; }
SAFETY=$(
  chk "0039 table futures_certifications" "select to_regclass('public.futures_certifications') is not null"
  chk "0039 function futures_live_authorized" "select exists(select 1 from pg_proc where proname='futures_live_authorized')"
  chk "0039 function guard_futures_live_intent" "select exists(select 1 from pg_proc where proname='guard_futures_live_intent')"
  chk "0039 trigger futures_certifications_immutable" "select exists(select 1 from pg_trigger where tgname='futures_certifications_immutable')"
  chk "0039 trigger autopilot_run_terminal_guard" "select exists(select 1 from pg_trigger where tgname='autopilot_run_terminal_guard')"
  chk "0039 column autopilot_runs.lease_holder" "select exists(select 1 from information_schema.columns where table_name='autopilot_runs' and column_name='lease_holder')"
  chk "RLS policy on futures_certifications" "select exists(select 1 from pg_policies where tablename='futures_certifications')"
)
SUIT=SUITABLE; grep -q MISSING <<<"$SAFETY" && SUIT="NOT SUITABLE (taken before the current safety changes)"
[[ "$(q "select count(*) from pg_tables where schemaname='public'")" -lt 1 ]] && SUIT="NOT SUITABLE (no app tables restored)"

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<MD
# Database export verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)

Practice restore into a throwaway local PostgreSQL $(postgres --version | awk '{print $3}') — **not** a Lovable Cloud restore; restore readiness is not claimed. Counts only; no row contents copied into this report. The downloaded copy was deleted afterwards.

| Item | Value |
|---|---|
| Source | \`$(basename "$SRC")\` |
| Archive created at | $DUMPED_AT |
| Size / SHA-256 | $SIZE bytes / \`$SHA\` |
| Readable (archive table of contents) | yes — $(wc -l < "$TOC") lines |
| Verdict for use before the next migration | **$SUIT** |

## Contents (archive table of contents)
| Object | All schemas | public |
|---|---|---|
| Tables | $(kind TABLE) | $(pubkind TABLE) |
| Table data | $(kind "TABLE DATA") | $(pubkind "TABLE DATA") |
| Functions | $(kind FUNCTION) | $(pubkind FUNCTION) |
| Triggers | $(kind TRIGGER) | $(pubkind TRIGGER) |
| Policies | $(kind POLICY) | $(pubkind POLICY) |
| Row security enabled | $(kind "ROW SECURITY") | $(pubkind "ROW SECURITY") |
| Grants (ACL) | $(kind ACL) | $(pubkind ACL) |
| Indexes | $(kind INDEX) | $(pubkind INDEX) |
| Sequences | $(kind SEQUENCE) | $(pubkind SEQUENCE) |
| Types | $(kind TYPE) | $(pubkind TYPE) |
| Extensions | $(kind EXTENSION) | — |
| Sign-in accounts table (auth.users) data | $(grep -cE 'TABLE DATA auth users ' "$TOC") | — |

Not in a database export: storage files, server code, secrets, sign-in provider settings, database role passwords and cluster settings.

## Restore result
- Restored public tables: $(q "select count(*) from pg_tables where schemaname='public'"); functions: $(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"); triggers: $(q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"); policies: $(q "select count(*) from pg_policies where schemaname='public'"); RLS-enabled tables: $(q "select count(*) from pg_tables where schemaname='public' and rowsecurity").
- pg_restore errors: $ERRS (platform-managed schemas/extensions that a plain PostgreSQL lacks are expected). Grouped:
\`\`\`
$ERR_SAMPLE
\`\`\`

## Safety-migration objects
| Object | In restored copy |
|---|---|
$SAFETY

## Row counts vs live database
$SAME tables match exactly; $DIFF differ (live activity after the export, or tables missing on one side). Tables only in live: ${LIVE_ONLY:-none}.

| Table | Restored | Live now |
|---|---|---|
${ROWS:-| — | — | — |}
MD
echo "Report: $OUT"; echo "Verdict: $SUIT"
