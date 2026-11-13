#!/usr/bin/env bash
# Self-test for verify-local-restore-0046.sh on SYNTHETIC local backups (not a real export). Builds tiny databases in a
# disposable local PostgreSQL (UNIX socket only), dumps them, and checks that the verifier PASSes a well-formed
# post-0039 archive and FAILs archives with no migration history, a wrong migration hash, 0045 already applied, or a
# public privilege that cannot be restored (Phase 4E).
set -euo pipefail
for v in DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do unset "$v" || true; done
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d /tmp/verify-0046-selftest.XXXXXX); PGL="$WORK/pg"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
AS=(setpriv --reuid=65534 --regid=65534 --clear-groups)
cleanup(){ "${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
grep -q '^pgverify:' /etc/passwd || echo 'pgverify:x:65534:65534:pg verify:/tmp:/bin/false' >> /etc/passwd
grep -q '^pgverify:' /etc/group || echo 'pgverify:x:65534:' >> /etc/group
chown -R 65534:65534 "$WORK"
"${AS[@]}" env -i PATH="$PATH" initdb -D "$PGL" -U postgres -A trust >/dev/null
"${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -o "-c listen_addresses='' -k $SOCK -p 5432" -l "$WORK/pg.log" start -w >/dev/null
P(){ env -i PATH="$PATH" PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres psql -qAtX -v ON_ERROR_STOP=1 "$@"; }
HIST=$(python3 - "$ROOT" <<'PY'
import json,sys,hashlib
r=sys.argv[1]; j=json.load(open(f"{r}/drizzle/migrations/meta/_journal.json"))
print(";".join(f"insert into drizzle.__drizzle_migrations(hash, created_at) values ('{hashlib.sha256(open(f'{r}/drizzle/migrations/{e['tag']}.sql','rb').read()).hexdigest()}', {e['when']})" for e in j["entries"]))
PY
)
build(){ # name, extra-sql
  P -d postgres -c "create database $1" >/dev/null
  P -d "$1" >/dev/null <<SQL
do \$\$ begin create role anon; exception when duplicate_object then null; end \$\$;
do \$\$ begin create role authenticated; exception when duplicate_object then null; end \$\$;
do \$\$ begin create role service_role bypassrls; exception when duplicate_object then null; end \$\$;
grant usage on schema public to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as \$f\$ select nullif(current_setting('test.uid', true), '')::uuid \$f\$;
create function public.account_mfa_allowed() returns boolean language sql stable as \$f\$ select true \$f\$;
create table public.futures_certifications(id uuid primary key default gen_random_uuid(), user_id uuid not null);
create function public.futures_live_authorized() returns boolean language sql as \$f\$ select false \$f\$;
create table public.orders(id uuid primary key default gen_random_uuid(), user_id uuid not null, qty numeric not null);
alter table public.orders enable row level security;
create policy own_orders on public.orders for select to authenticated using (user_id = auth.uid());
grant select on public.orders to authenticated;
insert into public.orders(user_id, qty) select gen_random_uuid(), g from generate_series(1, 25) g;
create schema drizzle; create table drizzle.__drizzle_migrations(id serial primary key, hash text not null, created_at bigint);
$HIST;
$2
SQL
  env -i PATH="$PATH" PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres pg_dump -Fc -d "$1" -f "$WORK/$1.backup"
}
build good ""
build nohistory "drop schema drizzle cascade;"
build badhash "update drizzle.__drizzle_migrations set hash = repeat('0', 64) where id = 20;"
build has0045 "$(cat "$ROOT/docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql")"
# Phase 4E: a grant to a role the verifier cannot recreate (quoted mixed-case name) makes a public ACL entry fail to
# restore. That must be an UNEXPECTED error and a FAIL — the Phase 4D verifier would have reported it only as noise.
build badrole "do \$x\$ begin create role \"WeirdRole\"; exception when duplicate_object then null; end \$x\$; grant select on public.orders to \"WeirdRole\";"
"${AS[@]}" env -i PATH="$PATH" pg_ctl -D "$PGL" -m fast stop >/dev/null
chmod 644 "$WORK"/*.backup
pass=0; fail=0
expect(){ local want="$1" name="$2"; set +e; REPORT="$WORK/$name.md" DATABASE_URL="postgres://cloud.example.supabase.co/postgres" bash "$ROOT/scripts/db-export/verify-local-restore-0046.sh" "$WORK/$name.backup" >"$WORK/$name.out" 2>&1; local rc=$?; set -e
  local got=PASS; [[ $rc -ne 0 ]] && got=FAIL
  if [[ "$got" == "$want" ]]; then pass=$((pass+1)); echo "ok   $name → $got"; else fail=$((fail+1)); echo "BAD  $name → $got (wanted $want)"; cat "$WORK/$name.out"; [[ -f "$WORK/$name.md" ]] && cat "$WORK/$name.md"; fi
  grep -q "ambient connection variables ignored and unset: DATABASE_URL" "$WORK/$name.out" || { fail=$((fail+1)); echo "BAD  $name: ambient DATABASE_URL was not reported as ignored"; }
  if [[ "$name" == badrole ]]; then grep -q "pg_restore errors classified | FAIL" "$WORK/$name.md" && grep -q "privileges | FAIL" "$WORK/$name.md" && echo "     badrole failed on error classification and privilege fidelity" || { fail=$((fail+1)); echo "BAD  badrole: not failed by error classification + privilege fidelity"; }; fi
  [[ "$name" == good && -f "$WORK/$name.md" ]] && grep "^|" "$WORK/$name.md" | sed 's/^/     /'
  return 0; }
expect PASS good
expect FAIL nohistory
expect FAIL badhash
expect FAIL has0045
expect FAIL badrole
echo "self-test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
