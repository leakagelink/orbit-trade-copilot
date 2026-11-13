# Local-only restore verification — draft 0046 — 2026-11-13T09:48:23Z

**Verdict: PASS** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not proof of production readiness. Nothing was applied anywhere else.

- Archive: `orbit-trade-copilot_261113.backup`, 2525322 bytes, SHA-256 `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5`, created at: 2026-11-13 09:19:04 UTC
- pg_restore errors: 30 total — 30 tolerated (managed-extension objects: cron/net/vault), 0 unexpected (restore log is deleted with the work dir)
- Roles created from the archive's grants: 10 (anon authenticated dashboard_user pgbouncer sandbox_exec service_role supabase_admin supabase_auth_admin supabase_functions_admin supabase_storage_admin )
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- Migration `0046_futures_paper_ledger_v2.sql` SHA-256 `eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e`; rollback SHA-256 `dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453`

| Check | Result | Detail |
|---|---|---|
| Migration ordering | PASS | 40 entries; every timestamp and SHA-256 equals drizzle/migrations in order; latest 1794466478200 |
| 0039 safety objects present | PASS | export must postdate 0039 |
| 0045/0046 objects absent before | PASS | never apply on top of 0045 |
| account_mfa_allowed() exists | PASS | required by the RLS policies |
| pg_restore errors classified | PASS | 30 errors, all managed-extension objects (cron/net/vault) absent from a plain local server |
| Fidelity: public tables | PASS | archive 60 = restored 60 |
| Fidelity: public views | PASS | archive 0 = restored 0 |
| Fidelity: public functions | PASS | archive 45 = restored 45 |
| Fidelity: public RLS-enabled tables | PASS | archive 60 = restored 60 |
| Fidelity: public policies | PASS | archive 125 = restored 125 |
| Fidelity: public triggers | PASS | archive 38 = restored 38 |
| Fidelity: public PK/unique/exclusion constraints | PASS | archive 83 = restored 83 |
| Fidelity: public foreign keys | PASS | archive 44 = restored 44 |
| Fidelity: public indexes (non-constraint) | PASS | archive 38 = restored 38 |
| Fidelity: public table/view privileges | PASS | 60 ACL entries in the archive, all restored |
| Fidelity: public row counts | PASS | 60 tables in the archive data, 723 rows; every table's restored count equals the archive |
| Latest applied migration | INFO | 0039_futures_pass_certification_and_autopilot_fencing (created_at 1794466478200); 40 rows |
| Draft 0040 | INFO | ABSENT (trigger futures_certifications_no_truncate) |
| Draft 0041 | INFO | ABSENT (table futures_harness_runs) |
| Draft 0042 | INFO | ABSENT (testnet_emergency_stops / testnet_futures_limits()) |
| Draft 0043 | INFO | ABSENT (ai_decision_records / ai_risk_evaluations) |
| Draft 0044 | INFO | ABSENT (paper_accounts / paper_bars) |
| Draft 0045/0046 | INFO | ABSENT (futures_paper_* / strategy_risk_budgets / fp2_*) |
| Draft 0047/0048 | INFO | ABSENT (futures_order_strategy_identity / futures_strategy_attribution_events) |
| Scheduled jobs in archive | INFO | 3 cron job rows; 1 mention 'paper' (commands not printed) |
| Apply 0046 (single transaction) | PASS | migration SHA-256 eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e |
| RLS enabled on all 5 tables | PASS |  |
| 5 owner-read policies, all SELECT for authenticated | PASS |  |
| anon has no table privilege | PASS |  |
| authenticated: SELECT only | PASS |  |
| service_role cannot write events/positions/commits directly | PASS |  |
| commit function: EXECUTE for service_role only | PASS |  |
| commit function SECURITY DEFINER with pinned search_path | PASS |  |
| event constraints present | PASS |  |
| fill-once unique index present | PASS |  |
| append-only / guard triggers present | PASS |  |
| Malformed-input probe (NULL sequence) | PASS | refused |
| Pre-existing objects unchanged after migration | PASS | fingerprint 0f15af6b266e3660663af7694b609692 |
| Rollback (single transaction) | PASS | rollback SHA-256 dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453 |
| Nothing left after rollback | PASS |  |
| Pre-existing objects unchanged after rollback | PASS | fingerprint 0f15af6b266e3660663af7694b609692; 60 public tables |

