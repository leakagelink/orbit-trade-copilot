# Local-only restore verification — draft 0049 — 2026-11-13T10:18:40Z

**Verdict: PASS** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply 0049. Nothing was applied anywhere else.

- Archive: `orbit-trade-copilot_261113.backup`, 2525322 bytes, SHA-256 `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5`, created at: 2026-11-13 09:19:04 UTC
- pg_restore errors: 30 total — 30 tolerated (managed-extension objects: cron/net/vault), 0 unexpected
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- Migration `0049_futures_paper_ledger_v3.sql` SHA-256 `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35`; rollback SHA-256 `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb`; coexistence used 0048 `93305df74b2636e4…` / rollback `9930d14841197737…`; refusal step used 0046 `eac47d85843e9c1e…`

| Check | Result | Detail |
|---|---|---|
| Migration ordering | PASS | 40 entries; every timestamp and SHA-256 equals drizzle/migrations in order; latest 1794466478200 |
| 0039 safety objects present | PASS | export must postdate 0039 |
| 0047/0048 objects absent before | PASS | needed for the 0048 coexistence step |
| 0045/0046/0049 objects absent before | PASS | 0049 must be applied on a database without 0045/0046 |
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
| Draft 0045/0046/0049 | INFO | ABSENT (futures_paper_* / strategy_risk_budgets / account_risk_budgets / fp2_* / fp3_*) |
| Draft 0047/0048 | INFO | ABSENT (futures_order_strategy_identity / futures_strategy_attribution_events) |
| Scheduled jobs in archive | INFO | 3 cron job rows; 1 mention 'paper' (commands not printed) |
| Apply 0049 (single transaction) | PASS | migration SHA-256 fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35 |
| RLS enabled on all 9 tables | PASS |  |
| 9 owner-read policies, SELECT for authenticated, MFA-aware | PASS |  |
| anon: no privilege on any table | PASS |  |
| authenticated: SELECT only | PASS |  |
| service_role: ledger tables read-only (events, positions, commits, candles, approvals) | PASS |  |
| service_role: INSERT/UPDATE on configuration tables, never DELETE/TRUNCATE | PASS |  |
| commit function: SECURITY DEFINER, pinned search_path, EXECUTE for service_role only | PASS |  |
| risk helpers (fp3_*): no EXECUTE for any API role | PASS |  |
| guard / append-only / no-truncate triggers present (20) | PASS |  |
| nesting constraint and one-open-approval index present | PASS |  |
| No rows created (no backfill) | PASS |  |
| Probe: fill without a risk approval (rolled back) | PASS | refused by the commit function |
| Probe: worker-supplied risk figure (rolled back) | PASS | refused by the commit function |
| Probe: browser-role budget write (rolled back) | PASS | authenticated INSERT refused |
| Probe: service-role direct approval write (rolled back) | PASS | INSERT refused (approvals are written only by the commit function) |
| Probes left no rows | PASS |  |
| Pre-existing objects unchanged after migration | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |
| Rollback 0049 (single transaction) | PASS | rollback SHA-256 e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb |
| Nothing left after rollback | PASS |  |
| Pre-existing objects unchanged after rollback | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a; 60 public tables |
| Coexistence 0049 → 0048 → rollback 0048 → rollback 0049 | PASS | all four steps committed |
| Nothing left after coexistence round trip | PASS |  |
| Pre-existing objects unchanged after coexistence round trip | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |
| 0049 refused on top of 0046 | PASS | the whole transaction failed (same object names); nothing of 0049 was created |
| Nothing left after the 0046 refusal step | PASS |  |
| Pre-existing objects unchanged at the end | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a; 60 public tables |

