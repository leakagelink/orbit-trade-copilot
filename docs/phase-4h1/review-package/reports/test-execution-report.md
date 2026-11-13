# Phase 4H.1 test execution report (13 Nov 2026, UTC)

Every result below is from a run in this phase. Results are grouped by where they ran.

## 1. PGlite (in-memory PostgreSQL; drafts applied only there)

| Suite | Result |
|---|---|
| `migration-0054-identity-lifecycle.test.ts` (new) | **17/17.** The requested cases:<br>1. normal registration<br>2. admin promotion<br>3. super_admin promotion<br>4. worker becomes an account owner<br>5. / 5b. disable after admin / super_admin promotion<br>6. disable after becoming an owner<br>7. re-enabling an ineligible identity refused (3 kinds), eligible re-enable works<br>8. revoked enrollment blocks all six RPCs<br>9. disabled identity blocks all six RPCs<br>10. legitimate full hosted tick (6 commits, through the v5 commit)<br>Also: registration refusals; disable still requires admin + MFA (non-admin, owner, worker itself, no MFA, signed out); unknown identity / label change refused; signed-out caller and owner refused; privilege matrix; fixed `search_path`; immutable history; rollback order and exact restoration of 0053 |
| `migration-0053-worker-identity.test.ts`, on 0053 alone | **5/5** |
| same suite with `FP_WITH_0054=1` (through 0054) | **5/5.** Existing behaviour is preserved |
| `migration-0052-entry-completeness.test.ts` | **29/29** |
| `migration-0051-completeness.test.ts` | passed (part of the 89/89 batch below) |
| `migration-0051-completeness.test.ts` + 0051 replays through 0052 (`FP_WITH_0052=1`) | **27/27** |
| Gateway + hosted suites + 0051 + 0052 suites (own drafts) | **89/89** |
| Gateway + hosted suites through 0051 + 0052 | **35/36.** The one failure is expected: 0050's own rollback is blocked by 0051's rollback-order guard |
| Change control: `phase4h1-isolation` (new, 4), `phase4h-final-isolation` (5), `phase4h-isolation`, `phase4g-isolation`, `phase4f-alignment-isolation` | **all passed (23 in the combined run).** Two earlier allowance lists were extended by one file each (the new local verifier) |

## 2. Mutation testing (each protection removed in a temporary copy, run, original restored)

The suite was pointed at a temporary copy of 0054 through `FP_0054_FILE`. Every run below used that copy; the draft file itself was never edited. Its fingerprint was re-verified unchanged afterwards: `391beac68e7de77112542f7c84b2b58628bf634fc39c8ee56a670532d3c47177`.

| Mutation | Failing tests |
|---|---|
| M1 disabling requires a plain user (0053 behaviour) | 3 |
| M2 no admin re-check | 2 |
| M3 no super_admin re-check | 1 |
| M4 no account-owner re-check | 1 |
| M5 no enabled check | 2 |
| M6 no revocation check | 1 |
| M7 enabling skips the plain-user rule | 2 |
| M8 no MFA on the admin function | 2 |
| M9 disabling skips the admin/MFA check | 1 |
| M10 read path (`fpw_id_authorize`) skips the check | 7 |
| M11 owner enrollment skips eligibility | 1 |
| M12 0054 re-grants a gateway function to `service_role` | 2 |
| M13 identity history deletable | 1 |
| MPG FOR SHARE locks removed (real PostgreSQL) | 3 of 4 |

**Every mutation was caught.** (A first M9 variant was accidentally a no-op and passed, as a no-op should. It was replaced by a real mutation, which was caught.)

## 3. Real PostgreSQL 17.11 (throwaway local instance, `scripts/futures-paper/concurrency-check-4h1.sh`)

| Suite | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `futures-paper-0054.pg.test.ts` (new):<br>• disable waits for an in-flight write, then later calls are refused;<br>• revoke waits likewise;<br>• a committed disable refuses a waiting worker call;<br>• 12-session enable/disable race leaves a consistent, ordered history | 4/4 | 4/4 | 4/4 |
| 0052, 0051, hosted, worker, ledger-v3, 4E attribution, 4D, ledger-v2 suites | 43/43 | 43/43 | 43/43 |

## 4. Whole project

| Check | Result |
|---|---|
| `bunx vitest run` (full suite) | **1,277 passed, 0 failed, 66 skipped** (117 files). Of the 66 skipped:<br>• 47 are real-PostgreSQL tests, run separately above;<br>• 19 are not run this phase (drafts 0043: 10, 0044: 7, 0045: 2) |
| TypeScript typecheck (`tsgo -b --noEmit`) | **passed** (no errors) |
| Production build (`vite build`, output to a temporary folder) | **passed** |

## 5. Synthetic replays (NOT profitability evidence)

These are synthetic and recorded-history consistency replays through 0052, re-run this phase. They test that the database and the engine agree; **they say nothing about profitability.**

| Replay | Commits | Database refusals | Exit-reason mismatches |
|---|---|---|---|
| Synthetic 1 m | 2,400 | 0 | 0 |
| Synthetic 5 m | 1,200 | 0 | 0 |
| Recorded Binance 5 m candles, 10–13 Nov 2026 | 864 | 0 | — |

The recorded candles are a stored test fixture. No market data was fetched this phase.

## 6. Hosted database verification

One **read-only** catalog query (13 Nov 2026) found:
- migration journal at 40 rows (0000–0039);
- 0 `futures_paper*` relations;
- 0 paper functions;
- `has_role(uuid, app_role)` is SECURITY DEFINER with `search_path=public`;
- roles `user`, `admin`, `super_admin`;
- `account_mfa_allowed()` present;
- PostgreSQL 17.11.

Nothing was written or applied. **0049–0054 have not been verified on the hosted database** because they are not applied.

## 7. Actual market-data testing

**None this phase.** No exchange or market-data request was made. No order of any kind was placed.

## 8. Local restore verifier

`verify-local-restore-0054.sh` was self-tested on the **synthetic** archive only: 70 PASS and 2 expected FAIL (the archive has no migration history and no 0039 objects). This is **not** a backup restore. See `backup-restore-status.md`.
