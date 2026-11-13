# Local-only restore verification — drafts 0049 + 0050 — 2026-11-13T12:08:12Z

**Verdict: PASS** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply 0049 or 0050. Nothing was applied anywhere else.

- Archive: `orbit-trade-copilot_261113.backup`, 2525322 bytes, SHA-256 `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5`, created at: 2026-11-13 09:19:04 UTC
- pg_restore errors: 30 total — 30 tolerated (managed-extension objects: cron/net/vault), 0 unexpected
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- 0049 SHA-256 `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` / rollback `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb`; 0050 SHA-256 `40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa` / rollback `93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b`

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
| Schema equals hosted catalog | PASS | tables|functions|policies|triggers|columns-md5 = 60|45|125|38|18bf7fdd6e815a2d3d4686d302415f2d (schema unchanged since the export; data may differ) |
| 0050 refused without 0049 | PASS | guard raised; nothing created |
| Nothing changed by the refused 0050 | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |
| Apply 0049 → 0050 (each a single transaction) | PASS | 0049 fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35; 0050 40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa |
| RLS enabled on the 3 new tables | PASS |  |
| 2 owner-read MFA-aware policies (provenance, audit); none on leases | PASS |  |
| anon: no privilege on the new tables | PASS |  |
| authenticated: SELECT on provenance/audit only; nothing on leases | PASS |  |
| service_role: read-only on the new tables | PASS |  |
| 6 gateway functions: SECURITY DEFINER, pinned search_path, EXECUTE for service_role only | PASS |  |
| 0049 commit no longer executable by service_role (gateway is the only path) | PASS |  |
| append-only / no-truncate / status-audit triggers present (6) | PASS |  |
| Probe: commit without a lease (rolled back) | PASS | refused |
| Probe: commit at REPEATABLE READ (rolled back) | PASS | refused |
| Probe: browser role calls the gateway (rolled back) | PASS | permission denied |
| No rows created | PASS |  |
| Pre-existing objects unchanged after 0049 + 0050 | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |
| 0049 rollback refused while 0050 is present | PASS | the whole transaction failed; nothing dropped |
| Rollback 0050 (single transaction) | PASS | rollback SHA-256 93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b |
| 0049 grant restored after 0050 rollback | PASS |  |
| Rollback 0049 (single transaction) | PASS | rollback SHA-256 e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb |
| Nothing left after both rollbacks | PASS |  |
| Pre-existing objects unchanged at the end | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a; 60 public tables |

