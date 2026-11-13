#!/usr/bin/env bash
# Multi-session concurrency tests for Phase 4E: draft 0048 attribution corrections/reductions (plus the Phase 4D 0046/0047
# suites and the 0046 suite) against a throwaway local PostgreSQL in /tmp — never the live database.
# Usage: scripts/futures-paper/concurrency-check-4e.sh. Files run one after another (cluster-wide CREATE ROLE races).
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE SUPABASE_DB_URL || true
WORK=$(mktemp -d /tmp/phase4e-cc.XXXXXX); PGL="$WORK/pg"; PORT=55440
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$WORK/pg.log" start -w >/dev/null
echo "Throwaway PostgreSQL $(postgres --version | awk '{print $3}') on 127.0.0.1:$PORT"
FUTURES_PAPER_PG_URL="postgres://postgres@127.0.0.1:$PORT/postgres" bunx vitest run --no-file-parallelism src/test/phase4e-attribution-concurrency.pg.test.ts src/test/phase4d-concurrency.pg.test.ts src/test/futures-paper-ledger-v2-concurrency.pg.test.ts "$@"
