#!/usr/bin/env bash
# Multi-session tests for Phase 4H.5: DRAFTS 0055/0056 over 0049 → 0054 (phase4h5-worker-security.pg.test.ts), then the
# 0054 suite and every earlier real-PostgreSQL suite unchanged — against a throwaway local PostgreSQL in /tmp, never
# the live database. Usage: scripts/futures-paper/concurrency-check-4h5.sh (ONLY=<file> runs one file; MUTATIONS=1 runs
# scripts/worker-auth/mutation-check-4h5.ts against the throwaway server instead).
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE SUPABASE_DB_URL || true
WORK=$(mktemp -d /tmp/phase4h5-cc.XXXXXX); PGL="$WORK/pg"; PORT=55475
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
if [ -n "${MUTATIONS:-}" ]; then FUTURES_PAPER_PG_URL="$URL" bun scripts/worker-auth/mutation-check-4h5.ts; exit 0; fi
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism ${ONLY:-src/test/phase4h5-worker-security.pg.test.ts}
[ -n "${ONLY:-}" ] && exit 0
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism src/test/futures-paper-0054.pg.test.ts src/test/futures-paper-0052.pg.test.ts src/test/futures-paper-0051.pg.test.ts src/test/futures-paper-worker-hosted.pg.test.ts src/test/futures-paper-worker.pg.test.ts src/test/futures-paper-ledger-v3-concurrency.pg.test.ts src/test/phase4e-attribution-concurrency.pg.test.ts src/test/phase4d-concurrency.pg.test.ts src/test/futures-paper-ledger-v2-concurrency.pg.test.ts
