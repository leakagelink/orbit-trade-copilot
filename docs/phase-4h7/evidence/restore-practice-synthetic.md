# Local-only restore and recovery verification — draft chain 0049 → 0057 — 2026-11-14T06:12:33Z

**Verdict: FAIL** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice
restore, not a Lovable Cloud restore and not an approval to apply any of 0049–0057. Nothing was applied anywhere else.

- Archive: `synthetic-4h7.backup`, 22694 bytes, SHA-256 `e077d6d23a70c2faff2dbf35184ef909c198246acc4bedffef582d10138686a9`, created at: 2026-11-14 05:51:39 UTC
- pg_restore errors: 0 total — 0 tolerated (managed-extension objects: cron/net/vault), 0 unexpected
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- Drafts: 0049 `fe4dd56c3f75`/`e593132115ee` 0050 `40c2fdbf9bfb`/`93197b8c39b8` 0051 `58828556c870`/`41d1aa85f486` 0052 `e6ed1a01ca93`/`562128f7033b` 0053 `d436091177e4`/`11fec84bcca2` 0054 `391beac68e7d`/`4e78cebeedf8` 0055 `b157a84482d3`/`e05e410751d3` 0056 `55d20793cef1`/`dc8fbaa49e39` 0057 `49353babb0b7`/`9275ce3be034` 

| Check | Result | Detail |
|---|---|---|
| pg_restore errors classified | PASS | 0 errors, all managed-extension objects (cron/net/vault) |
| Migration ordering | PASS | 40 entries equal drizzle/migrations in order (latest 1794466478200) |
| 0039 safety objects present | FAIL | the export must postdate applied migration 0039 |
| No draft 0049–0057 object present before | PASS | the chain must start from a database without 0045–0057 objects |
| Prerequisites of 0055 (auth.sessions, auth.mfa_factors, workspace_sessions, user_roles, has_role) | PASS | 0055 refuses without them |
| Prerequisites of 0057 (auth.users / auth.identities sign-in columns) | PASS | 0057 refuses without them |
| auth schema in the archive | INFO | 4 auth tables, 0 auth.users rows (counts only) |
| Draft 0050 refused without its predecessor | PASS | ERROR:  0050 requires draft 0049 (futures paper ledger v3) to be applied first; rolled back, nothing left |
| Draft 0051 refused without its predecessor | PASS | ERROR:  0051 requires drafts 0049 and 0050 to be applied first; rolled back, nothing left |
| Draft 0052 refused without its predecessor | PASS | ERROR:  0052 requires drafts 0049, 0050 and 0051 to be applied first; rolled back, nothing left |
| Draft 0053 refused without its predecessor | PASS | ERROR:  0053 requires drafts 0049–0052 and the app's has_role/account_mfa_allowed functions; rolled back, nothing left |
| Draft 0054 refused without its predecessor | PASS | ERROR:  0054 requires draft 0053 (and through it drafts 0049–0052); rolled back, nothing left |
| Draft 0055 refused without its predecessor | PASS | ERROR:  0055 requires draft 0054 (and through it drafts 0049–0053); rolled back, nothing left |
| Draft 0056 refused without its predecessor | PASS | ERROR:  0056 requires draft 0055; rolled back, nothing left |
| Draft 0057 refused without its predecessor | PASS | ERROR:  0057 requires draft 0056 (and through it drafts 0049–0055); rolled back, nothing left |
| Apply 0049 | PASS | 0049_futures_paper_ledger_v3.sql in one transaction, 89 ms |
| Apply 0050 | PASS | 0050_futures_paper_worker_gateway.sql in one transaction, 45 ms |
| Apply 0051 | PASS | 0051_futures_paper_event_completeness.sql in one transaction, 52 ms |
| Apply 0052 | PASS | 0052_futures_paper_entry_completeness_and_exit_only.sql in one transaction, 52 ms |
| Apply 0053 | PASS | 0053_futures_paper_worker_identity.sql in one transaction, 48 ms |
| Apply 0054 | PASS | 0054_futures_paper_worker_identity_lifecycle.sql in one transaction, 37 ms |
| Apply 0055 | PASS | 0055_futures_paper_worker_security_remediation.sql in one transaction, 82 ms |
| Apply 0056 | PASS | 0056_worker_identity_api_boundary.sql in one transaction, 37 ms |
| Apply 0057 | PASS | 0057_worker_credential_pin_and_refusal_tally.sql in one transaction, 61 ms |
| Synthetic history seeded (disposable copy) | INFO | identities 1, identity changes 2, worker audit 3, refusals 4, credential events 1, tally 1 |
| Pre-existing row counts unchanged after the chain | PASS | 4 tables |
| Intended changes to pre-existing objects (0055/0056) | INFO | 23 restrictive worker-guard policies; account_mfa_allowed replaced: true; user_roles guard trigger: true; data-API hook: true |
| Rollback 0049 refused while 0050 is applied | PASS | ERROR:  cannot drop table futures_paper_commits because other objects depend on it |
| Rollback 0050 refused while 0051 is applied | PASS | ERROR:  cannot drop table futures_paper_worker_leases because other objects depend on it |
| Rollback 0051 refused while 0052 is applied | PASS | ERROR:  cannot drop table futures_paper_candle_checks because other objects depend on it |
| Rollback 0052 refused while 0053 is applied | PASS | ERROR:  cannot drop table futures_paper_config_changes because other objects depend on it |
| Rollback 0053 refused while 0054 is applied | PASS | ERROR:  cannot drop view futures_paper_0053_requires_0052 because other objects depend on it |
| Rollback 0054 refused while 0055 is applied | PASS | ERROR:  cannot drop view futures_paper_0054_requires_0053 because other objects depend on it |
| Rollback 0055 refused while 0056 is applied | PASS | ERROR:  roll back draft 0056 before 0055 |
| Rollback 0056 refused while 0057 is applied | PASS | ERROR:  cannot drop function fpw_api_pre_request() because other objects depend on it |
| Rollback 0057 | PASS | one transaction, 40 ms; every object of 0057 removed or restored exactly (retired history excluded) |
| Rollback 0056 | PASS | one transaction, 25 ms; every object of 0056 removed or restored exactly (retired history excluded) |
| Rollback 0055 | PASS | one transaction, 39 ms; every object of 0055 removed or restored exactly (retired history excluded) |
| Rollback 0054 | PASS | one transaction, 33 ms; every object of 0054 removed or restored exactly (retired history excluded) |
| Rollback 0053 | PASS | one transaction, 25 ms; every object of 0053 removed or restored exactly (retired history excluded) |
| Rollback 0052 | PASS | one transaction, 36 ms; every object of 0052 removed or restored exactly (retired history excluded) |
| Rollback 0051 | PASS | one transaction, 35 ms; every object of 0051 removed or restored exactly (retired history excluded) |
| Rollback 0050 | PASS | one transaction, 31 ms; every object of 0050 removed or restored exactly (retired history excluded) |
| Recovery step: retired-history triggers re-bound | INFO | 7 trigger(s) moved to a stand-alone append-only guard; no rows touched |
| Rollback 0049 (after the recovery step) | PASS | one transaction, 45 ms |
| Rollback 0049 without the recovery step | FAIL | ERROR:  cannot drop function futures_paper_history_immutable() because other objects depend on it (retired history depends on 0049's guard) |
| Retired history tables kept | INFO | futures_paper_worker_credential_events_0057_retired=1 futures_paper_worker_credential_pins_0057_retired=0 futures_paper_worker_refusal_tally_0057_retired=1 futures_paper_worker_refusals_0055_retired=4 |
| Pre-existing objects and row counts identical after the full rollback | PASS | fingerprint 94840988dc2a7eab6b3a1eb2022a73e3 |
| Recovery: chain re-applied | PASS | catalog equals the first application; archived history tables: 4 |

## Rollback classification (row counts at the moment of rollback; preserved copies: table:rows:sha256-prefix)

| Rollback | Class | Drops tables | Renames to | Rows at rollback | Preserved before rollback |
|---|---|---|---|---|---|
| 0057 | PRESERVING (renames) | — | fpw_cred_events_0057_retired_id_seq fpw_cred_events_0057_retired_pkey fpw_cred_events_0057_retired_worker fpw_cred_pins_0057_retired_pkey fpw_refusal_tally_0057_retired_pkey fpw_refusal_tally_guard_0057_retired futures_paper_worker_credential_events_0057_retired futures_paper_worker_credential_pins_0057_retired futures_paper_worker_refusal_tally_0057_retired  | — | — |
| 0056 | NO TABLES | — | — | — | — |
| 0055 | PRESERVING (renames) | — | futures_paper_worker_refusals_0055_retired  | — | — |
| 0054 | DESTRUCTIVE | futures_paper_worker_identity_changes  | — | futures_paper_worker_identity_changes=2  | futures_paper_worker_identity_changes:2:ced021b50986  |
| 0053 | DESTRUCTIVE | futures_paper_worker_enrollments futures_paper_worker_identities  | — | futures_paper_worker_enrollments=0 futures_paper_worker_identities=1  | futures_paper_worker_enrollments:0:ce36f7650764 futures_paper_worker_identities:1:e247aa35d297  |
| 0052 | DESTRUCTIVE | futures_paper_config_changes futures_paper_entry_checks  | — | futures_paper_config_changes=0 futures_paper_entry_checks=0  | futures_paper_config_changes:0:aaba0ea0a415 futures_paper_entry_checks:0:5f5da633e05b  |
| 0051 | DESTRUCTIVE | futures_paper_candle_checks futures_paper_protection_terms  | — | futures_paper_candle_checks=0 futures_paper_protection_terms=0  | futures_paper_candle_checks:0:2e61bdbfbdee futures_paper_protection_terms:0:bb635e95cd76  |
| 0050 | DESTRUCTIVE | futures_paper_candle_provenance futures_paper_worker_audit futures_paper_worker_leases  | — | futures_paper_candle_provenance=0 futures_paper_worker_audit=3 futures_paper_worker_leases=0  | futures_paper_candle_provenance:0:88c59675595a futures_paper_worker_audit:3:19db517f1109 futures_paper_worker_leases:0:f46f43b4e87f  |
| 0049 | DESTRUCTIVE | account_risk_budgets futures_paper_accounts futures_paper_candles futures_paper_commits futures_paper_cost_assumptions futures_paper_events futures_paper_positions futures_paper_risk_approvals strategy_risk_budgets  | — | account_risk_budgets=0 futures_paper_accounts=0 futures_paper_candles=0 futures_paper_commits=0 futures_paper_cost_assumptions=0 futures_paper_events=0 futures_paper_positions=0 futures_paper_risk_approvals=0 strategy_risk_budgets=0  | account_risk_budgets:0:2ef075cf6282 futures_paper_accounts:0:fd24c89419c0 futures_paper_candles:0:054e03c7bb9b futures_paper_commits:0:b98d972b0b2a futures_paper_cost_assumptions:0:37b20dcd74ad futures_paper_events:0:e522fc673db2 futures_paper_positions:0:dd3db829c774 futures_paper_risk_approvals:0:fed498a512dc strategy_risk_budgets:0:4d8fdd050ecc  |

