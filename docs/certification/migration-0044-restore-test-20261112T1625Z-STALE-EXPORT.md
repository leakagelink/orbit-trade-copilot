# Draft migration 0044 test on a restored export — 2026-11-12T16:25:18Z

Practice restore into a throwaway local PostgreSQL 17.11 — **not** the live database and **not** a Lovable Cloud restore. Counts and hashes only; no row contents. The downloaded copy was deleted afterwards.

| Item | Value |
|---|---|
| Export | `orbit-trade-copilot_261112.backup` |
| Archive created at | 2026-11-12 06:52:44 UTC |
| SHA-256 | `7af876652ee97596afea1736f11f170cc23d11c474c0927a077e776da3276634` |
| pg_restore errors (platform-managed objects a plain PostgreSQL lacks) | 30 total, 0 mentioning public objects |
| Already-applied migrations replayed before testing |  `0039_futures_pass_certification_and_autopilot_fencing.sql` |
| Restored public tables / rows | 60 / 409 |
| Paper bots / paper trades (existing bot paper mode) in the restore | 2 / 6 |
| Migration tested | `0044_forward_paper_trading.sql` (sha256 `202f43ef679e0923…`) |
| Rollback tested | `0044_forward_paper_trading.rollback.sql` (sha256 `82c2536fe8fc931d…`) |

| Check | Result |
|---|---|
| Migration 0044 applies cleanly in one transaction on the restored data | PASS |
| 5 paper tables exist | PASS |
| Row security enabled on all 5 | PASS |
| 5 owner-read policies, SELECT only, signed-in role only, owner + MFA | PASS |
| Indexes (5 named + primary keys + unique keys) | PASS |
| Unique keys: one record per candle, per event sequence, per settled position | PASS |
| Every fill and settlement row is forced simulated | PASS |
| No foreign key from paper tables to any real-trading, wallet or auth table | PASS |
| Triggers: 6 append-only/no-truncate on history (loop) + 4 named | PASS |
| Only paper_commit_bar is SECURITY DEFINER, with fixed search_path | PASS |
| paper_commit_bar: EXECUTE for service_role only | PASS |
| Browser roles: no write privilege of any kind on paper tables | PASS |
| Visitors cannot read; signed-in owners can (policy-limited) | PASS |
| Backend: no direct insert into history; no DELETE/TRUNCATE anywhere; INSERT/UPDATE only on accounts and strategies | PASS |
| Functional (rolled back): starts flat at the next candle; refuses out-of-sequence and unclosed candles; backend cannot edit balances (even with the flag), terms, or delete | PASS |
| Existing data byte-identical after migration (60 tables, MD5 of every row; auth users count) | PASS |
| Pre-existing grants, function grants, policies, RLS flags and SECURITY DEFINER settings unchanged by the migration (1533 entries) | PASS |
| Rollback applies cleanly in one transaction | PASS |
| Rollback removes every paper table and function | PASS |
| Rollback leaves every pre-existing grant, policy, RLS flag and SECURITY DEFINER setting exactly as before (does not weaken security) | PASS |
| Existing data byte-identical after migration + rollback | PASS |

Overall: **ALL CHECKS PASSED**
