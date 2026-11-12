#!/usr/bin/env bash
# Multi-session concurrency tests for DRAFT migration 0045 (Futures paper ledger) against a throwaway local PostgreSQL
# in /tmp (never the live database). Each test creates its own database, applies a minimal stand-in plus the draft
# migration verbatim, then drives the real paper worker and the commit function from separate database sessions.
# Usage: scripts/futures-paper/concurrency-check.sh
set -euo pipefail
WORK=$(mktemp -d /tmp/fpaper-cc.XXXXXX); PGL="$WORK/pg"; PORT=55437
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown 65534:65534 "$WORK"
"${AS[@]}" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" pg_ctl -D "$PGL" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$WORK/pg.log" start -w >/dev/null
echo "Throwaway PostgreSQL $(postgres --version | awk '{print $3}') on 127.0.0.1:$PORT"
FUTURES_PAPER_PG_URL="postgres://postgres@127.0.0.1:$PORT/postgres" bunx vitest run src/test/futures-paper-ledger-concurrency.pg.test.ts "$@"
