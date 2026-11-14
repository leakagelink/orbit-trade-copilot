# Phase 4H.5 — Security remediation test report

Date: 14 Nov 2026. Everything ran inside this sandbox. **No production database, live sign-in service, exchange or AI
service was contacted.** No account was created, nothing was scheduled or switched on, no order was placed.

## 1. Kinds of evidence

| Label | Meaning |
|---|---|
| **PURE** | TypeScript only; fake clock/timers/transport. Proves the code path, not any service. |
| **PGLITE** | Real PostgreSQL 17 engine compiled to WebAssembly, in memory, single connection. Proves SQL semantics, grants, RLS, triggers; **cannot** prove concurrency. Hosted roles, `auth.*` tables and the data-API role are local stand-ins (`src/test/helpers/fp-0055-harness.ts`). |
| **REAL-PG** | Throwaway PostgreSQL 17.11 server on 127.0.0.1, started and deleted by `scripts/futures-paper/concurrency-check-4h5.sh`. Real connections, real locks, real races. Stand-in `auth` schema as above. |
| **SIMULATED** | The worker's real session/binding code talking to an in-process fake sign-in service and a PGlite database behind a fake data API. |
| **MUTATION** | One protection removed at a time; the named tests must fail. |

Nothing here proves hosted behaviour (marked NOT VERIFIED where it matters).

## 2. Results

| Run | Result |
|---|---|
| Full suite `bunx vitest run` | **116 files passed, 13 skipped; 1,402 tests passed, 81 skipped, 0 failed** (before this phase: 1,335 passed / 66 skipped → +67 new tests, +15 new REAL-PG tests that run only under their runner) |
| Skipped tests | 81 = 15 new REAL-PG + 47 earlier REAL-PG (both run below) + 19 for unapplied drafts 0043–0045 (unchanged) |
| REAL-PG, new suite (`phase4h5-worker-security.pg.test.ts`) | **15 / 15 passed** (PostgreSQL 17.11) |
| REAL-PG, every earlier suite (9 files, same runner) | **47 / 47 passed** |
| Type check (`oj typecheck -b --noEmit`) | **0 errors** |
| Production build (`bun run build`) | **succeeded**; build output deleted afterwards |
| Mutation check (`MUTATIONS=1 scripts/futures-paper/concurrency-check-4h5.sh`) | **25 / 25 protections detected** (§4) |

Raw outputs are in `evidence/`, saved as `.txt` because this project never commits `.log` files (the cause of the Phase
4H.3 gap). `real-postgresql-4h5-suite.txt` is the 15-test run of the new file; `real-postgresql-all-suites.txt` is the run
of all ten REAL-PG files, taken before the two deterministic write-skew tests were added, so it shows 13 for the new file.

## 3. New tests by finding

### F4 — privilege change during a worker call
| Test | Kind |
|---|---|
| promotion to admin / super_admin refused for enabled and disabled identities, by any path | PGLITE |
| a paper account owned by a registered identity cannot be created (enabled or disabled) | PGLITE |
| ownership still immutable; registration still refuses admins and owners | PGLITE |
| **4H.4 reproduction flipped**: for admin, super_admin and worker-owned account, with an acquire **and** with a snapshot in flight: the change **waits** for the call, then is **refused**; the worker never holds the privilege (6 tests) | REAL-PG |
| disable and revoke wait for an in-flight acquire / snapshot, then every later call is refused (4 tests) | REAL-PG |
| 24 concurrent registration/promotion pairs end as worker XOR admin | REAL-PG |
| **deterministic write skew**: a promotion arriving while a registration is uncommitted waits, then is refused; and the reverse (2 tests) | REAL-PG |
| two worker calls on the same identity do not block each other; a promotion waits for both | REAL-PG |

### F13 — audit integrity
| Test | Kind |
|---|---|
| authorization refusal: original SQLSTATE and message returned, refusal row committed, nothing else written | PGLITE |
| ledger refusal inside commit: only the sub-transaction is rolled back, refusal recorded | PGLITE |
| non-identities get no record; recording capped per identity (W2) | PGLITE |
| refusal table append-only and closed to every API role | PGLITE |
| only an MFA admin may take a checkpoint | PGLITE |
| database head = independent TypeScript recomputation for all four audit tables | PGLITE |
| owner deletes **newest**, middle; modifies; inserts; swaps (triggers disabled) — all detected; later checkpoints still chain | PGLITE |
| consistent rewrite of the 0052 hash chain still fails the stored checkpoint; a disabled trigger is visible | PGLITE |
| owner trigger-disable and **superuser `session_replication_role = replica`** deletions (newest, middle) detected; SQL head = TS head | REAL-PG |
| verifier: NULL vs empty, missing column is an error, uncovered rows never "verified", newest/middle/first deletion, insert, modify, swap, reorder, duplicate; store altered/removed/reordered; whole store rewritten passes **without** a seal key (residual) and fails **with** one | PURE |

### F15 — worker-only account
| Test | Kind |
|---|---|
| `account_mfa_allowed()` false for enabled/disabled identity; identical 0011 answers for ordinary users | PGLITE |
| worker reads 0 rows / cannot write on ordinary tables, including tables whose policy does not call `account_mfa_allowed()` | PGLITE |
| every RLS table carries the restrictive guard | PGLITE |
| residual without 0056: an owner-rights function still answers the worker | PGLITE |
| 0056: the six `POST /rpc/fpw_id2_*` pass; every other path, method, missing path and lookalike refused; disabled identity; ordinary users, anon, service role unaffected | PGLITE |
| server functions: worker refused with a clear message before the function runs; refusal never depends on the lookup; ordinary users unaffected; check registered globally; every server function requires sign-in; AI routes refuse | PURE |
| with the worker token, every other data-API request refused; the binding requests nothing else | SIMULATED |

### L2–L5 — session and token
| Test | Kind |
|---|---|
| no session id, unknown (signed-out) session, other user's session, old session, expired session, expired token — all six operations refused | PGLITE |
| token without session id / `iat` / too old refused (still signed out once) | PURE |
| refresh returning a different session refused; original token signed out once | PURE |
| unacknowledged sign-out reports the residual lifetime | PURE |
| finished tick's token refused at once by the database; attempt recorded | SIMULATED |
| unacknowledged sign-out: leftover session usable for worker calls only until the maximum session age | SIMULATED |

### L7 — per-call timeout
| Test | Kind |
|---|---|
| timer cannot be armed → call refused **before** anything is sent | PURE |
| reply never arrives → aborted at its own limit; transport signal fires; "outcome unknown" | PURE |
| injected timer never fires → platform backup timer ends the call | PURE |
| caller deadline (hosted adapter) cancels the request | PURE |
| no request outlives the tick; nothing recorded later | PURE |
| late reply after cancellation never changes state | PURE |
| identical in-flight request never sent twice | PURE |
| at most 4 in flight (W4) | PURE |
| listeners/timers released after every call | PURE |
| restart: a late reply from an earlier tick has no effect on the next | PURE |
| S1–S8 defaults unchanged | PURE |

### Change control
`phase4h5-isolation.test.ts` (7): the four new files pinned; applied history still ends at 0039; each draft and rollback
is one statement with no transaction control; no draft deletes history; every definer function fixes `search_path`;
locked Phase 4G hosted files byte-identical; checkpoint module pure and imported by nothing; offline tool uses local files
only; activation flags unset. Three earlier isolation tests received **named** Phase 4H.5 exceptions for
`src/lib/account-security.ts` (names `fpw_caller_is_worker`) and `src/lib/audit-checkpoint.ts` (names audit tables);
both files are constrained by the new tests.

Earlier tests changed: `phase4h2-security-regression.test.ts` and `phase4h3-token-cleanup.test.ts` now issue fake
tokens with a session id and select the 0054 operations explicitly (their behaviour under 0054 is unchanged);
`phase4h2-isolation.test.ts` admits drafts 0055/0056. `src/test/helpers/fake-auth.ts` adds a default `session_id`.

## 4. Mutation check

Each mutation removes one protection; the listed tests must then fail. Session mutations edit the session file in place and restore it (SHA-256 verified: `e589eac9…a7ab20` before and after). SQL mutations are applied to temporary copies only; the draft's SHA-256 is checked unchanged at the end.

| Id | Removed protection | Where | Result |
|---|---|---|---|
| S1 | ignore a timer fault and send the call without its own limit | session code (PURE tests) | **DETECTED** |
| S2 | give the transport the caller's signal instead of the combined one | session code (PURE tests) | **DETECTED** |
| S3 | do not cancel in-flight calls at the end of the tick | session code (PURE tests) | **DETECTED** |
| S4 | no platform backup timer for injected timers | session code (PURE tests) | **DETECTED** |
| S5 | send an identical in-flight request again | session code (PURE tests) | **DETECTED** |
| S6 | no limit on requests in flight | session code (PURE tests) | **DETECTED** |
| S7 | use the late reply after cancellation | session code (PURE tests) | **DETECTED** |
| S8 | accept a token without a session id | session code (PURE tests) | **DETECTED** |
| S9 | accept a refresh that changes the session id | session code (PURE tests) | **DETECTED** |
| S10 | accept a stale token | session code (PURE tests) | **DETECTED** |
| S11 | do not report the residual token lifetime after a failed sign-out | session code (PURE tests) | **DETECTED** |
| Q1 | no role guard for registered worker identities | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q2 | no account-ownership guard | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q3 | accept a signed-out (unknown) session | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q4 | no maximum session age | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q5 | no session id required | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q6 | refused acquire not recorded | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q7 | account_mfa_allowed() without the worker condition | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q8 | no restrictive worker guard on tables | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q9 | checkpoint hash skips a column (code) of the worker audit | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q10 | old 0053/0054 wrappers stay reachable | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| Q11 | checkpoints open to any signed-in user | draft 0055, temporary copy (PGLITE tests) | **DETECTED** |
| P1 | worker calls do not hold the shared identity lock | draft 0055, temporary copy (REAL-PG tests) | **DETECTED** |
| P2 | worker reads take no row locks (snapshot) | draft 0055, temporary copy (REAL-PG tests) | **DETECTED** |
| P3 | registration does not take the identity lock (write skew with promotion) | draft 0055, temporary copy (REAL-PG tests) | **DETECTED** |

**25 / 25 detected.** A first run found P3 SURVIVED: the random 24-pair race test was not sensitive enough to notice registration without the identity lock. Two deterministic write-skew tests (one side held uncommitted) were added; P3 is now detected. Raw output: `evidence/mutation-check-4h5.txt`.

## 5. What is not proven

- Hosted sign-in service: whether sign-out deletes the session row immediately; refresh keeps `session_id`; token
  lifetime; `auth.sessions` columns. **NOT VERIFIED.**
- Hosted data API: support for `pgrst.db_pre_request`, the `request.path` format, permission to set it. **NOT VERIFIED.**
- Hosted `account_mfa_allowed()` body equal to 0011. **NOT VERIFIED** (0055 refuses to apply otherwise).
- Concurrency in PGlite (single connection) — only REAL-PG results count for F4.
- Scheduled-job time limit (D-TIME) — not measured.
