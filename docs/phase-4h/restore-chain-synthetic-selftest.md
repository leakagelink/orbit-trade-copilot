# Local-only restore verifier self-test on a SYNTHETIC archive — draft chain 0049 → 0053 (13 Nov 2026)

> **Tooling self-test only. This is NOT a backup, NOT a restore of Lovable Cloud data and NOT migration-application evidence.** The archive is a 4.6 KB pg_dump of a throwaway local PostgreSQL holding only stubs (auth.uid, account_mfa_allowed, app_role/user_roles/has_role) and one example table, built to exercise every chain step of `scripts/db-export/verify-local-restore-0052.sh`. The two FAIL rows are expected: a synthetic archive has no migration history and no 0039 objects. Every chain step (apply, guards, probes, out-of-order rollbacks, rollbacks, fingerprint) passed. The mandatory fresh export (after 14 Nov 2026 09:19 UTC) does not exist yet.

**Verdict: FAIL** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply any of 0049–0053. Nothing was applied anywhere else.

- Archive: `synthetic.backup`, 5372 bytes, SHA-256 `92d8f9f46ce1bdc9ee129d7aa6c4709ad28d40775c6c970c032c992380b92245`, created at: 2026-11-13 13:29:51 UTC
- pg_restore errors: 0 total — 0 tolerated (managed-extension objects: cron/net/vault), 0 unexpected
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- 0049 SHA-256 `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` / rollback `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb`; 0050 SHA-256 `40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa` / rollback `93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b`
- 0051 SHA-256 `58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788` / rollback `41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf`; 0052 SHA-256 `e6ed1a01ca93e71cbf680edde7000be724621e0f81a1aae96aaf3886b4ef40d9` / rollback `562128f7033b21238af5fe54e78fbde0d7bea4438cfaa8a5e1b892f938ad84d3`; 0053 SHA-256 `d436091177e43ab5bab3522fad29e633561966e9c6b6b1a370b3553f1d48d2bf` / rollback `11fec84bcca216a11ae581b1e36d2268742981c8a23e726356328cb0b41923d2`

| Check | Result | Detail |
|---|---|---|
| Migration ordering | FAIL | drizzle.__drizzle_migrations not in the archive: applied schema version cannot be established |
| 0039 safety objects present | FAIL | export must postdate 0039 |
| 0047/0048 objects absent before | PASS | needed for the 0048 coexistence step |
| 0045/0046/0049 objects absent before | PASS | 0049 must be applied on a database without 0045/0046 |
| account_mfa_allowed() exists | PASS | required by the RLS policies |
| pg_restore errors classified | PASS | 0 errors, all managed-extension objects (cron/net/vault) absent from a plain local server |
| Fidelity: public tables | PASS | archive 2 = restored 2 |
| Fidelity: public views | PASS | archive 0 = restored 0 |
| Fidelity: public functions | PASS | archive 2 = restored 2 |
| Fidelity: public RLS-enabled tables | PASS | archive 0 = restored 0 |
| Fidelity: public policies | PASS | archive 0 = restored 0 |
| Fidelity: public triggers | PASS | archive 0 = restored 0 |
| Fidelity: public PK/unique/exclusion constraints | PASS | archive 3 = restored 3 |
| Fidelity: public foreign keys | PASS | archive 0 = restored 0 |
| Fidelity: public indexes (non-constraint) | PASS | archive 0 = restored 0 |
| Fidelity: public table/view privileges | PASS | 2 ACL entries in the archive, all restored |
| Fidelity: public row counts | PASS | 2 tables in the archive data, 2 rows; every table's restored count equals the archive |
| Latest applied migration | INFO | unknown (created_at ); ? rows |
| Draft 0040 | INFO | ABSENT (trigger futures_certifications_no_truncate) |
| Draft 0041 | INFO | ABSENT (table futures_harness_runs) |
| Draft 0042 | INFO | ABSENT (testnet_emergency_stops / testnet_futures_limits()) |
| Draft 0043 | INFO | ABSENT (ai_decision_records / ai_risk_evaluations) |
| Draft 0044 | INFO | ABSENT (paper_accounts / paper_bars) |
| Draft 0045/0046/0049 | INFO | ABSENT (futures_paper_* / strategy_risk_budgets / account_risk_budgets / fp2_* / fp3_*) |
| Draft 0047/0048 | INFO | ABSENT (futures_order_strategy_identity / futures_strategy_attribution_events) |
| Scheduled jobs in archive | INFO | 0 cron job rows; 0 mention 'paper' (commands not printed) |
| Schema equals hosted catalog | INFO | not compared (HOSTED_SCHEMA not supplied); restored: 2|2|0|0|fbf1744d72baacfd4f9c841cd539e98d |
| 0050 refused without 0049 | PASS | guard raised; nothing created |
| Nothing changed by the refused 0050 | PASS | fingerprint 18ea55e8b716dc5b954865884a021fbe |
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
| Pre-existing objects unchanged after 0049 + 0050 | PASS | fingerprint 18ea55e8b716dc5b954865884a021fbe |
| 0052 refused before 0051 | PASS | guard raised; nothing created |
| Apply 0051 (single transaction) | PASS | SHA-256 58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788 |
| 0053 refused before 0052 | PASS | guard raised; nothing created |
| Apply 0052 (single transaction) | PASS | SHA-256 e6ed1a01ca93e71cbf680edde7000be724621e0f81a1aae96aaf3886b4ef40d9 |
| Apply 0053 (single transaction) | PASS | SHA-256 d436091177e43ab5bab3522fad29e633561966e9c6b6b1a370b3553f1d48d2bf |
| RLS enabled on the 6 chain tables | PASS |  |
| Chain tables: no write privilege for anon/authenticated/service_role | PASS |  |
| Owner-read MFA-aware policies on the 5 owner-visible chain tables | PASS |  |
| Commit functions v4/v5 and helpers executable by no API role | PASS |  |
| After 0053 the gateway is reachable only through the signed-in wrappers | PASS |  |
| Probe: service role calls the gateway after 0053 (rolled back) | PASS | permission denied |
| Probe: unregistered signed-in caller (rolled back) | PASS | refused |
| Probe: budget write without a reason (rolled back) | PASS | refused |
| No rows created by the chain | PASS |  |
| Pre-existing objects unchanged after the whole chain | PASS | fingerprint 18ea55e8b716dc5b954865884a021fbe |
| 0049 rollback refused while 0050 is present | PASS | the whole transaction failed; nothing dropped |
| 0050 rollback refused while 0051 is present | PASS | the whole transaction failed; nothing dropped |
| 0051 rollback refused while 0052 is present | PASS | the whole transaction failed; nothing dropped |
| 0052 rollback refused while 0053 is present | PASS | the whole transaction failed; nothing dropped |
| Rollback 0053 (single transaction) | PASS | rollback SHA-256 11fec84bcca216a11ae581b1e36d2268742981c8a23e726356328cb0b41923d2 |
| Service-role gateway grants restored after 0053 rollback | PASS |  |
| Rollback 0052 (single transaction) | PASS | rollback SHA-256 562128f7033b21238af5fe54e78fbde0d7bea4438cfaa8a5e1b892f938ad84d3 |
| Rollback 0051 (single transaction) | PASS | rollback SHA-256 41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf |
| Rollback 0050 (single transaction) | PASS | rollback SHA-256 93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b |
| 0049 grant restored after 0050 rollback | PASS |  |
| Rollback 0049 (single transaction) | PASS | rollback SHA-256 e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb |
| Nothing left after the five rollbacks | PASS |  |
| Pre-existing objects unchanged at the end | PASS | fingerprint 18ea55e8b716dc5b954865884a021fbe; 2 public tables |

