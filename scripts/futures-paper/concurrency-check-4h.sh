#!/usr/bin/env bash
# Multi-session tests for Phase 4H: DRAFT 0051 completeness checks (over 0049 + 0050) and the Phase 4G hosted connection re-run through 0051, plus every
# earlier real-PostgreSQL suite (Phase 4F worker, 0049, 0048, Phase 4D, 0046), against a throwaway local PostgreSQL in
# /tmp — never the live database. Usage: scripts/futures-paper/concurrency-check-4g.sh. Files run one after another.
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGSSLMODE SUPABASE_DB_URL || true
WORK=$(mktemp -d /tmp/phase4h-cc.XXXXXX); PGL="$WORK/pg"; PORT=55471
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
# 1) the 0051 suite; 2) the Phase 4G hosted-connection suite re-run THROUGH 0051; 3) every earlier suite unchanged.
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism ${ONLY:-src/test/futures-paper-0051.pg.test.ts}
[ -n "${ONLY:-}" ] && exit 0
FP_WITH_0051=1 FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism src/test/futures-paper-worker-hosted.pg.test.ts
FUTURES_PAPER_PG_URL="$URL" bunx vitest run --no-file-parallelism src/test/futures-paper-worker-hosted.pg.test.ts src/test/futures-paper-worker.pg.test.ts src/test/futures-paper-ledger-v3-concurrency.pg.test.ts src/test/phase4e-attribution-concurrency.pg.test.ts src/test/phase4d-concurrency.pg.test.ts src/test/futures-paper-ledger-v2-concurrency.pg.test.ts
