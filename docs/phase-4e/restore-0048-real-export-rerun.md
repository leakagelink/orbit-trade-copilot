# Local-only restore verification — draft 0048 — 2026-11-13T10:18:58Z

**Verdict: PASS** (local disposable PostgreSQL 17.11, private UNIX socket only). This is a practice restore,
not a Lovable Cloud restore and not an approval to apply 0048. Nothing was applied anywhere else.

- Archive: `orbit-trade-copilot_261113.backup`, 2525322 bytes, SHA-256 `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5`, created at: 2026-11-13 09:19:04 UTC
- pg_restore errors: 30 total — 30 tolerated (managed-extension objects: cron/net/vault), 0 unexpected
- Ambient connection variables ignored: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE SUPABASE_URL SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY 
- Migration `0048_futures_strategy_attribution_v2.sql` SHA-256 `93305df74b2636e47f0464b9d57fd14d455ba15604d9b619c872fe61e0ba60bb`; rollback SHA-256 `9930d14841197737a46b57ac845d08fc6ace840170693226e6586aac6fea504f`; coexistence used 0046 `eac47d85843e9c1e…` / rollback `dd8b96bafee966a2…`

| Check | Result | Detail |
|---|---|---|
| Migration ordering | PASS | 40 entries; every timestamp and SHA-256 equals drizzle/migrations in order; latest 1794466478200 |
| 0039 safety objects present | PASS | export must postdate 0039 |
| 0047/0048 objects absent before | PASS | never apply on top of 0047 |
| 0045/0046 objects absent before | PASS | needed for the coexistence step |
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
| Apply 0048 (single transaction) | PASS | migration SHA-256 93305df74b2636e47f0464b9d57fd14d455ba15604d9b619c872fe61e0ba60bb |
| RLS enabled on both tables | PASS |  |
| 2 owner-read policies, SELECT for authenticated, MFA-aware | PASS |  |
| anon: no privilege on tables or views | PASS |  |
| authenticated: SELECT only (tables and views) | PASS |  |
| service_role: INSERT on tables, never UPDATE/DELETE/TRUNCATE | PASS |  |
| views are security_invoker | PASS |  |
| guards SECURITY DEFINER with pinned search_path | PASS |  |
| claim function: invoker rights, EXECUTE for service_role only | PASS |  |
| effective-qty helper: no EXECUTE for API roles | PASS |  |
| guard/append-only/no-truncate triggers present (6) | PASS |  |
| correction constraints present | PASS |  |
| No identity or attribution rows created (no backfill) | PASS |  |
| Every existing USD-M Futures trade reads UNATTRIBUTED | PASS | 7 existing USD-M Futures trades |
| Legacy-order identity probe (rolled back) | PASS | the oldest existing USD-M Futures order was refused |
| Browser-role write probe (rolled back) | PASS | authenticated INSERT refused |
| Pre-existing objects unchanged after migration | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |
| Rollback 0048 (single transaction) | PASS | rollback SHA-256 9930d14841197737a46b57ac845d08fc6ace840170693226e6586aac6fea504f |
| Nothing left after rollback | PASS |  |
| Pre-existing objects unchanged after rollback | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a; 60 public tables |
| Coexistence 0046 → 0048 → rollback 0048 → rollback 0046 | PASS | all four steps committed |
| Nothing left after coexistence round trip | PASS |  |
| Pre-existing objects unchanged after coexistence round trip | PASS | fingerprint a0043f1ebf151261c563e7b44d2ca67a |

