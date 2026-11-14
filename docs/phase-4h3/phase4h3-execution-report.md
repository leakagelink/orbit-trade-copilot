# Phase 4H.3 — execution report

Supersedes `docs/phase-4h3/execution-report.md` of commit `7695eab` (renamed to this file; content rewritten).

**Every result in this report is a local result in this sandbox.** No hosted verification of any kind was performed:
the hosted database, the hosted sign-in service and the hosted data API were not contacted (not even read-only), and
no AI provider was called. Raw output of the 14 Nov 2026 runs is kept in `docs/phase-4h3/evidence/`.

## 1. Two independent runs

| Run | When (UTC) | Source state | Who ran it |
|---|---|---|---|
| A — implementation run | 13 Nov 2026, 17:41–18:03 | the code committed as `7695eab` | agent, during Phase 4H.3 |
| B — evidence re-run (this package) | 14 Nov 2026, 02:56–03:02 | the same code; `src/lib/worker-auth-session.ts` SHA-256 `8605ced84a9c42aae34e3d1a474eb45e53941da33c64b2b0aabed431618774b8` before and after | agent, for this audit |

Run B reproduced every number of run A. The table below quotes run B; run A's numbers were identical.

## 2. Commands and results

Environment: Linux sandbox, Bun 1.4.4, Vitest 4.1.11 (Node 22.23.5), `tsgo` 7.0.0-dev.20260707.2, PostgreSQL 17.11 binaries for the
throwaway local cluster. Commands are shown as run (bash); on Windows PowerShell the same `bunx …` / `bun …` commands
apply unchanged, while the PostgreSQL runner is a bash script and needs WSL or Git Bash.

| # | What | Exact command | Result (run B) | Evidence |
|---|---|---|---|---|
| 1 | 21 new Phase 4H.3 tests | `bunx vitest run src/test/phase4h3-token-cleanup.test.ts` | **21 passed / 21**, 0 failed, 0 skipped | console output (below) |
| 2 | 37 Phase 4H.2 regression tests | `bunx vitest run src/test/worker-auth-session.test.ts src/test/phase4h2-security-regression.test.ts src/test/phase4h2-isolation.test.ts` | **37 passed / 37** (19 + 11 + 7), 0 failed | console output (below) |
| 3 | Local real PostgreSQL | `bash scripts/futures-paper/concurrency-check-4h1.sh` | **4 passed / 4** (first invocation: 0054) and **43 passed / 43** (second invocation: 8 files); exit 0 | `evidence/local-postgresql-4h1-runner.log` |
| 4 | Full suite | `bunx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/ev4h3/full.json` | **1,335 passed, 0 failed, 66 skipped** — 1,401 tests in 121 files (109 passed, 12 skipped) | `evidence/full-suite-summary.txt`, `evidence/skipped-tests.md` |
| 5 | Typecheck | `tsgo -b --noEmit` | **exit 0, no diagnostics** | `evidence/typecheck.txt` |
| 6 | Production build | `bunx vite build --outDir /tmp/build4h3e` | **exit 0** (client, SSR and server bundles built) | `evidence/build-summary.txt` |
| 7 | Mutation tests | `bun scripts/worker-auth/mutation-check-4h3.ts` | **17 / 19 detected**; source restored byte-identical | `evidence/mutation-check-4h3.log`, `phase4h3-mutation-report.md` |
| 8 | Redundancy diagnostics (new in this package) | `bun scripts/worker-auth/mutation-redundancy-4h3.ts` | 5 runs, 4 as predicted, 1 prediction wrong (explained in the mutation report); source restored byte-identical | `evidence/mutation-redundancy-4h3.log` |

Console output of rows 1 and 2 (run B):

```
 ✓ src/test/phase4h3-token-cleanup.test.ts (21 tests) 117ms
      Tests  21 passed (21)

 ✓ src/test/phase4h2-isolation.test.ts (7 tests) 159ms
 ✓ src/test/worker-auth-session.test.ts (19 tests) 738ms
 ✓ src/test/phase4h2-security-regression.test.ts (11 tests) 2597ms
      Tests  37 passed (37)
```

Row 3 output (run B): `Throwaway PostgreSQL 17.11 on 127.0.0.1:55473`, then `Tests 4 passed (4)`, then
`Test Files 8 passed (8)` / `Tests 43 passed (43)`.

**Build side effect (disclosed).** Although `--outDir` points to `/tmp`, the server bundler also wrote its standard
output folder `dist/` in the project (and its cache under `node_modules/.nitro`). Both are git-ignored generated
output; `dist/` was deleted right after the build. No tracked file changed (`git status` showed only the new
diagnostics script at that point).

## 3. What kind of test is each result

| Category | What it means | Where it appears |
|---|---|---|
| **Real PostgreSQL** | Real PostgreSQL 17.11 server binaries, a throwaway cluster created in `/tmp` under an unprivileged user, listening on 127.0.0.1 only; many genuinely concurrent sessions; drafts loaded from `docs/proposed-migrations/`. The runner unsets every `PG*`, `DATABASE_URL` and `SUPABASE_DB_URL` variable first and deletes the cluster on exit. **Not the hosted database.** | Row 3 only (47 tests). In row 4 these same files are skipped. |
| **In-process PostgreSQL (PGlite)** | PostgreSQL compiled to WebAssembly running inside the test process; one connection, so no real concurrency. Draft SQL is executed for real, but this is a local simulation of a database, not a server. | `phase4h2-security-regression.test.ts` (row 2: drafts 0049–0054 with a fake sign-in service and fake data API); 24 test files / 404 of the 1,335 passed tests in row 4 |
| **Mocks / fake transports** | The sign-in service, data API and `fetch` are fakes defined in the tests (`src/test/helpers/fake-auth.ts` and inline fakes). Every request is recorded; unexpected endpoints fail the test. The fake backend URL is `https://backend.test`. | Row 1 (all 21), `worker-auth-session.test.ts` (19), the fake auth/data side of `phase4h2-security-regression.test.ts` |
| **Static / isolation checks** | Read files only: SHA-256 pins of drafts 0049–0054 and rollbacks, import-graph rules, environment-flag absence, forbidden names. | `phase4h2-isolation.test.ts` (7) and other `*isolation*` files in row 4 |
| **Synthetic data** | Generated candles / scenarios (e.g. synthetic 1m/5m replays). | Parts of row 4 |
| **Historical fixtures** | Replays of committed historical candle fixtures; no network. | Parts of row 4 |
| **Mutation tests** | Deliberate edits of the source file, then rows-1-and-lifecycle tests; restored by SHA-256. | Rows 7–8 |

No test in this package talks to the hosted backend, a real sign-in service, an exchange or an AI provider.

## 4. Every skipped test (66) and why

All 66 skips come from `describe.skipIf(!URL)` guards: the suites need a real PostgreSQL server URL in an environment
variable, which a plain `bunx vitest run` does not provide. They are not failures and are not hidden: 47 of them are
exactly the tests executed against the throwaway real PostgreSQL in row 3; the other 19 belong to older drafts
(0043, 0044, 0045) that are outside Phase 4H.3 and were not run in this phase.

| File | Skipped | Guard variable | Run in this package? |
|---|---|---|---|
| `src/test/futures-paper-0054.pg.test.ts` | 4 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3, first invocation (4/4) |
| `src/test/futures-paper-0052.pg.test.ts` | 5 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 (part of 43/43) |
| `src/test/futures-paper-0051.pg.test.ts` | 4 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/futures-paper-worker-hosted.pg.test.ts` | 8 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/futures-paper-worker.pg.test.ts` | 8 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/futures-paper-ledger-v3-concurrency.pg.test.ts` (draft 0049) | 5 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/phase4e-attribution-concurrency.pg.test.ts` (draft 0048) | 7 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/phase4d-concurrency.pg.test.ts` (drafts 0046/0047) | 3 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/futures-paper-ledger-v2-concurrency.pg.test.ts` (draft 0046) | 3 | `FUTURES_PAPER_PG_URL` | **Yes** — row 3 |
| `src/test/futures-paper-ledger-concurrency.pg.test.ts` (draft 0045) | 2 | `FUTURES_PAPER_PG_URL` | No — 0045 is superseded and outside this phase; not part of the 4H.1 runner |
| `src/test/paper-ledger-concurrency.pg.test.ts` (draft 0044) | 7 | `PAPER_PG_URL` | No — Spot paper draft, outside this phase |
| `src/test/research-budget-concurrency.pg.test.ts` (draft 0043) | 10 | `RESEARCH_PG_URL` | No — AI research budget draft, outside this phase |
| **Total** | **66** | | 47 run in row 3, 19 not run |

The full list of all 66 test names, grouped by file, is `docs/phase-4h3/evidence/skipped-tests.md` (generated from the
run-B JSON report).

## 5. Changes to existing tests (deliberate; behaviour changed)

| File | Change | Why |
|---|---|---|
| `src/test/worker-auth-session.test.ts` | (a) the shared fixture now passes `expectedUserId: WORKER`; (b) the sign-out test now expects 401 and 404 logout replies to be `SIGN_OUT_FAILED` with `HTTP_401` / `HTTP_404` and `signedOut: false` (Phase 4H.2 expected `SIGNED_OUT` / `ALREADY_INVALID` / `true`), and a 403 case was added; (c) two direct `verifyIssuedSession` calls pass `expectedSub: WORKER` | The expected identity is now mandatory; a non-2xx logout reply does not prove the server-side session ended |
| `src/test/phase4h2-security-regression.test.ts` | The fake backend sets `FUTURES_PAPER_WORKER_USER_ID` to the test worker with `vi.stubEnv` | The binding now refuses to run without the expected worker id |

`src/test/phase4h2-isolation.test.ts` and `src/test/helpers/fake-auth.ts` are unchanged. No assertion was loosened:
change (b) makes the expectation stricter.

## 6. Problems met during implementation (run A)

- A new test failed because the body ran although its deadline timer could not be armed. **Real defect**, fixed in the
  code (timers are armed outside Promise executors before any request or body starts). Mutation M15 re-introduces it
  and is detected.
- A new test first passed without exercising its scenario (the refresh never started). It was rewritten with manual
  timers and now asserts that the refresh is in flight before the cut-off.
- Three earlier isolation checks (Phase 4G, 4H final, 4H.1) flagged a code comment naming a draft 0054 database
  function. The comment was reworded; those checks were not changed.
