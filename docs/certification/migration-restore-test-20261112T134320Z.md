# Draft migration test on a restored export — 2026-11-12T13:43:24Z

Practice restore into a throwaway local PostgreSQL 17.11 — **not** the live database and **not** a Lovable Cloud restore. Counts and fingerprints only; no row contents are in this report. The downloaded copy was deleted afterwards.

| Item | Value |
|---|---|
| Export | `orbit-trade-copilot_261112.backup` |
| Archive created at | 2026-11-12 06:52:44 UTC |
| SHA-256 | `7af876652ee97596afea1736f11f170cc23d11c474c0927a077e776da3276634` |
| pg_restore errors (platform-managed objects a plain PostgreSQL lacks) | 30 total, 0 involving research tables |
| Already-applied migrations replayed on the restore before testing |  `0039_futures_pass_certification_and_autopilot_fencing.sql` |
| Restored public tables / rows | 60 / 409 |
| Research runs in the restore | 3 (failed=1, partial=2) |
| Migration tested | `0043_ai_decision_records_and_research_budget.sql` (sha256 `894eee2b382a27fa…`) |
| Rollback tested | `0043_ai_decision_records_and_research_budget.rollback.sql` (sha256 `70bb2a3c8fae4ab4…`) |

| Check | Result |
|---|---|
| Pre-check: research run status constraint present (dropped/re-added by 0043) | PASS |
| Pre-check: no 0043 object names already exist | PASS |
| Pre-check: browser roles hold hosted default write grants on research tables (what 0043 removes) | PASS |
| Migration applies cleanly in one transaction (ON_ERROR_STOP) | PASS |
| New tables exist | PASS |
| RLS enabled on every new table | PASS |
| Owner-read policies on decision records and risk evaluations | PASS |
| Existing research owner-read policies unchanged | PASS |
| Run worker columns added | PASS |
| Status constraint allows the 7 lifecycle statuses | PASS |
| All 30 triggers the migration creates exist (append-only, no-truncate, append guards, validation, lifecycle) | PASS |
| SECURITY DEFINER functions: exactly the 5 intended, all with fixed search_path | PASS |
| Ledger functions: EXECUTE for service_role only | PASS |
| Admin limits RPC: not executable by visitors | PASS |
| Browser roles: no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any research table | PASS |
| Visitors (anon) cannot read research tables | PASS |
| Signed-in owners keep SELECT on research tables | PASS |
| Backend: insert-only on decision records/risk evaluations; read-only on limits and ledger | PASS |
| SHA-256 available | PASS |
| Functional: one worker, reserve/settle, database SHA-256 on a decision record, closed run refuses reservations (rolled back) | PASS |
| Finished restored runs are frozen | PASS |
| Restored research history cannot be deleted, even by the table owner | PASS |
| Existing data unchanged after migration: row counts of all 60 public tables | PASS |
| Rollback applies cleanly in one transaction | PASS |
| Rollback removes every new table, function and column | PASS |
| Rollback does NOT reintroduce browser write or TRUNCATE privileges | PASS |
| Rollback does NOT reintroduce visitor reads; owners keep SELECT | PASS |
| Original 4-status constraint restored | PASS |
| Existing data unchanged after rollback: row counts of all 60 public tables | PASS |
| Existing research rows byte-identical after migration + rollback (MD5 of every row, 7 tables) | PASS |

Overall: **ALL CHECKS PASSED**
