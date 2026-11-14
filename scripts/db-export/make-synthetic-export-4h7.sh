#!/usr/bin/env bash
# Builds a SYNTHETIC practice archive (pg_dump custom format) on a throwaway local PostgreSQL — NOT a backup and not real
# data — for the self-test of verify-local-restore-0057.sh. Usage: scripts/db-export/make-synthetic-export-4h7.sh OUT.backup
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 OUT.backup" >&2; exit 2; }
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSSLMODE SUPABASE_DB_URL || true
OUTF=$(readlink -f "$1"); ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d /tmp/synth57.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
(cd "$ROOT" && bun scripts/db-export/make-synthetic-export-4h7.ts) > "$WORK/base.sql"
chown -R 65534:65534 "$WORK"
"${AS[@]}" env -i PATH="$PATH" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -o "-c listen_addresses='' -k $SOCK -p 5432" -l "$WORK/pg.log" start -w >/dev/null
P(){ env -i PATH="$PATH" PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres "$@"; }
P psql -qAtX -d postgres -c "create database synth" >/dev/null
P psql -qAtX -v ON_ERROR_STOP=1 -d synth -f "$WORK/base.sql" >/dev/null
P pg_dump -Fc -d synth -f "$WORK/out.backup"
cp "$WORK/out.backup" "$OUTF"; echo "synthetic archive: $OUTF ($(stat -c %s "$OUTF") bytes, sha256 $(sha256sum "$OUTF" | cut -d' ' -f1))"
