#!/usr/bin/env bash
# Phase 4H.7: DRAFTS 0049 → 0057 on a throwaway local PostgreSQL in /tmp (never the live database): parallel bounded
# invocations, concurrent refusal recording and the invocation timing measurement (phase4h7.pg.test.ts), then the
# Phase 4H.5 suite unchanged. Usage: scripts/futures-paper/concurrency-check-4h7.sh  (ONLY=<file> runs one file;
# FP_TIMING_OUT=<path> writes the timing JSON).
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE SUPABASE_DB_URL || true
WORK=$(mktemp -d /tmp/phase4h7-cc.XXXXXX); PGL="$WORK/pg"; PORT=55477
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c max_connections=300" -l "$WORK/pg.log" start -w >/dev/null
echo "Throwaway PostgreSQL $(postgres --version | awk '{print $3}') on 127.0.0.1:$PORT"
URL="postgres://postgres@127.0.0.1:$PORT/postgres"
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism ${ONLY:-src/test/phase4h7.pg.test.ts}
[ -n "${ONLY:-}" ] && exit 0
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism src/test/phase4h5-worker-security.pg.test.ts
