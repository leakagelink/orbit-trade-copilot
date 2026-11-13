# Phase 4H.3 — full execution report (13 Nov 2026, 17:41–18:03 UTC)

All results below are **local test results** in this sandbox. **No hosted verification was performed**: the hosted
database, auth service and data API were not contacted at all (not even read-only).

| # | Run | Command | Result |
|---|---|---|---|
| 1 | New lifecycle regression tests | `bunx vitest run src/test/phase4h3-token-cleanup.test.ts` | **21/21 passed** |
| 2 | Existing Phase 4H.2 tests | `bunx vitest run src/test/worker-auth-session.test.ts src/test/phase4h2-security-regression.test.ts src/test/phase4h2-isolation.test.ts` | **37/37 passed** (19 + 11 + 7) |
| 3 | Local real PostgreSQL (throwaway 17.11 in /tmp, never the live database) | `scripts/futures-paper/concurrency-check-4h1.sh` | **4/4** (0054) + **43/43** (0052, 0051, hosted, worker, ledger v3/v2, 4E, 4D) |
| 4 | Full suite | `bunx vitest run` | **1,335 passed, 0 failed, 66 skipped** (121 files; 1,401 tests). Phase 4H.2 was 1,314 passed / 66 skipped; +21 new |
| 5 | Typecheck | `tsgo -b --noEmit` | **clean** |
| 6 | Production build | `bunx vite build --outDir /tmp/build4h3` (throwaway output, deleted) | **succeeded** |
| 7 | Mutation tests | `bun scripts/worker-auth/mutation-check-4h3.ts` | **17/19 caught**, 2 equivalent (see `mutation-report.md`); file restored byte-identical |

The 66 skipped tests are the same as Phase 4H.2: real-PostgreSQL suites that only run when a local server URL is given
(run separately in row 3) and the 0043–0045 draft suites, which were not run.

## Changes to existing tests (deliberate, behaviour changed)

| File | Change | Why |
|---|---|---|
| `src/test/worker-auth-session.test.ts` | Default options now pass `expectedUserId`; the sign-out test now expects 401/403/404 to be `SIGN_OUT_FAILED` (was `SIGNED_OUT` "ALREADY_INVALID"), with a 403 case added; two direct `verifyIssuedSession` calls pass `expectedSub` | Expected identity is mandatory; a non-2xx logout does not prove the server session ended |
| `src/test/phase4h2-security-regression.test.ts` | The fake backend sets `FUTURES_PAPER_WORKER_USER_ID` to the test worker | The binding now requires the expected worker id |

No assertion was loosened; every other Phase 4H.2 test is unchanged.

## Errors met during the work

- One new test first failed because the body ran although its deadline timer could not be armed. This was a **real
  defect** and was fixed in the code (timers armed outside Promise executors).
- One new test first passed without exercising its scenario (the refresh never started). It was rewritten with manual
  timers and now asserts the refresh is in flight.
- Three earlier isolation checks (4G, 4H final, 4H.1) flagged a code comment naming a draft 0054 database function. The
  comment was reworded; those checks were not changed.
