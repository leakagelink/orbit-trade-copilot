# Phase 4H.6 — Security verification matrix

Independent review of Phase 4H.5 (commit `0b49efb`). A test counts as proof only if its **assertion** checks the
security property itself (not merely that code ran). Evidence kinds: **READ** (assertion reviewed in source),
**RERUN** (re-executed in this phase), **PROBE** (new adversarial test written in this phase,
`src/test/phase4h6-independent-probes.test.ts`), **LIVE** (read-only live check, `live-service-checks.md`).

Phase 4H.5 fingerprints: `sha256sum -c docs/phase-4h5/sha256-manifest.txt` → **31 / 31 OK** (RERUN).

## F4 — privilege change during an in-flight worker call

| # | Property | Verdict | Evidence |
|---|---|---|---|
| F4.1 | Promotion to admin/super_admin of a registered identity is refused on INSERT | **PASS** | READ `phase4h5-migration-0055` §2 asserts the error text; RERUN REAL-PG |
| F4.2 | …also on UPDATE (moving an admin row onto the worker; turning its plain row into admin/super_admin) | **PASS** | PROBE "moving an existing admin role row…", "turning the worker's own plain role row…" (asserts error + 0 elevated rows) |
| F4.3 | The change **waits** for an in-flight call, then is refused | **PASS** | RERUN REAL-PG 15/15 (PostgreSQL 17.11, 04:51 UTC). READ: assertion `[waited, workerOk, changeAfterWorker] = [true,true,true]`, where `waited` = one backend in `wait_event_type='Lock'` observed while the call is held open |
| F4.4 | Worker-owned paper account refused (INSERT); ownership immutable (0049) | **PASS** | READ + RERUN (same suites) |
| F4.5 | Registration vs promotion write skew closed | **PASS** | RERUN deterministic tests (one side held uncommitted; other side must wait, then fail); mutation P3 detected |
| F4.6 | Elevated roles fully enumerated | **PASS** | LIVE LS19: enum = {user, admin, super_admin} |
| F4.7 | Enforced on the hosted database | **BLOCKED** | Not applied (LS2). Owner role can disable triggers (LS18) — residual by design |

**F4 overall: PASS (draft, local + real PostgreSQL); hosted BLOCKED until applied.**

## F13 — audit integrity

| # | Property | Verdict | Evidence |
|---|---|---|---|
| F13.1 | A refusal inside the six `fpw_id2_*` wrappers is committed with its original SQLSTATE/message, nothing else written | **PASS** | READ `phase4h5-migration-0055` §5 (asserts row contents and absence of other writes) |
| F13.2 | Refusals **outside** the wrappers are recorded | **FAIL** | PROBE: a request refused by the 0056 hook leaves no row; a call to a retired 0053/0054 wrapper (permission denied) leaves no row. SOURCE: 0055 line 221 (same clause in all six wrappers: lines 221, 235, 249, 263, 277, 291) catches only `raise_exception`, `data_exception`, `integrity_constraint_violation` — lock/statement timeouts, serialization failures and privilege errors abort without a record |
| F13.3 | Cap cannot hide later refusals | **FAIL** | PROBE: after 125 refused snapshots (120 kept), a refused `mark_review` is dropped with **no marker** that records were dropped. SOURCE: `fpw_record_refusal`, 0055 line 202 |
| F13.4 | Checkpoints detect deletion (newest, middle, first), insertion, reordering, modification of covered rows | **PASS** | READ `phase4h5-audit-checkpoint` (pure), `phase4h5-migration-0055` §6 (PGlite, owner with triggers disabled), REAL-PG superuser `session_replication_role=replica`; RERUN mutation Q9 (hash skipping a column) detected |
| F13.5 | Rows after the last checkpoint | **PARTIAL** | Reported "uncovered", never "verified" (READ). They are unprotected until the next checkpoint |
| F13.6 | Database-owner rewrite of the fingerprint chain is detected | **PARTIAL** | Detected only for checkpointed rows **and** only if checkpoints live where the owner cannot rewrite them. LIVE LS18: owner role can disable triggers. No external store exists → operationally BLOCKED |
| F13.7 | Seal key protects the store | **PARTIAL** | READ: verifier fails a consistently rewritten store **with** the key, passes it **without** (residual stated). No key exists |

**F13 overall: PARTIAL.**

## F15 — worker-only account

| # | Surface | Verdict | Evidence |
|---|---|---|---|
| F15.1 | Server actions (`createServerFn`) | **PASS** | READ `phase4h5-f15-server`: global middleware registered; every server function requires sign-in; worker refused **before** the handler runs; refusal does not depend on the worker lookup |
| F15.2 | AI routes (`/api/chat`, `/api/autopilot`) | **PASS** | READ same file: `verifyAiRequest` refuses when `account_mfa_allowed()` is false; with 0055 that is true for a worker (PGlite) |
| F15.3 | Table rows (wallet, exchange keys, strategies, bots…) | **PASS** | READ PGlite tests (0 rows read, writes refused, including tables whose policy ignores the shared check). LIVE LS4: all 60 tables have RLS, no views → the guard would cover every table |
| F15.4 | Owner-rights functions via direct data requests | **PARTIAL** | Closed only by 0056 (READ PGlite: residual without 0056 asserted). LIVE LS5 lists 10 reachable functions. 0056 hosted support PARTIAL (LS14), path format BLOCKED (LS15) |
| F15.5 | Storage, Realtime, GraphQL | **PASS** | LIVE LS16 (no policies/publications; no GraphQL) |
| F15.6 | Sign-in itself | **N/A by design** | The worker must sign in; nothing else is reachable after F15.1–F15.4 |
| F15.7 | Password / email change through the sign-in service | **FAIL** | No control exists in code or drafts. The sign-in service's self-service endpoints are outside the database and the data API. LIVE LS11: email confirmation is off (`mailer_autoconfirm=true`); secure-password-change setting not readable. A worker token obtained during its validity can set a new password → persistent control of the worker identity (six paper operations on enrolled accounts) until an admin disables it |
| F15.8 | Account creation | **N/A** | Accounts are created by the sign-in service (open sign-up, LS11); a new account is an ordinary user, never a worker, unless an MFA admin registers it |
| F15.9 | Admin rights | **PASS** | = F4.1/F4.2 |

**F15 overall: PARTIAL.**

## L2–L5 — session and token

| # | Property | Verdict | Evidence |
|---|---|---|---|
| L2 | Token unusable for worker calls after sign-out | **PARTIAL** | Local PASS (PGlite "unknown (signed-out) session" refused; SIMULATED tick). Hosted: depends on sign-out deleting the `auth.sessions` row — **BLOCKED** (LS8). Draft prerequisites verified live (LS6) |
| L3 | Late refresh cannot restore access | **PARTIAL** | Local PASS (refresh with a different session refused; late replies discarded; refreshed token bound to the same session age). Hosted "refresh keeps session id" BLOCKED (LS9) |
| L4 | Failed sign-out | **PARTIAL** | Worker calls stop at 600 s session age (local PASS). The access token stays valid elsewhere for ≈ 1 h (LS10, indicative) → sign-in-service self-service remains usable (F15.7) |
| L5 | Lost sign-in reply | **PARTIAL** | Same bound; the unknown session's refresh token is never held by the worker |
| L-ord | Ordinary users' sign-in settings unchanged | **PASS** | No setting changed (code + LS3 byte-identical shared check) |

## L7 — per-request timeout

| # | Property | Verdict | Evidence |
|---|---|---|---|
| L7.1 | Timer that cannot be armed → nothing sent | **PASS** | READ: asserts `sent = []`, outcome `CALL_REFUSED_TIMER`, one sign-out. RERUN mutation S1 detected |
| L7.2 | Own limit cancels the underlying request | **PASS** | READ: asserts the transport's signal is aborted and the reply is "outcome unknown"; SOURCE `futures-paper-worker-identity.server.ts` line 46 passes that signal to `fetch` |
| L7.3 | Timer never fires → backup timer | **PASS** | READ + mutation S4 |
| L7.4 | Tick end cancels in-flight requests | **PASS** | READ + mutation S3 |
| L7.5 | Late reply never changes state | **PASS** | READ (late 401 ignored) + mutation S7 |
| L7.6 | Bounded in-flight / no duplicate send | **PASS** | READ + mutations S5, S6 |
| L7.7 | Root cause in locked `futures-paper-worker-hosted.ts` | **BLOCKED** | Unchanged by design; diff in `phase4h6-final-report.md` §5 needs approval |

## Timing (activation-relevant)

| # | Property | Verdict | Evidence |
|---|---|---|---|
| T-J | Scheduled-call limit measured | **PASS** | LIVE LS21: 5,000 ms |
| T-fit | Current session limits fit inside it | **FAIL** | `worker-auth-session.ts` line 180 requires `authTimeout (3,000) + rpcTimeout (8,000 default, identity binding line 65) + signOutTimeout (2,000) ≤ tickBudget` → ≥ 13,000 ms > 5,000 ms |
| T-DB | Per-call limit vs database limit | **Recorded** | `authenticated` statement_timeout 8 s = default call limit 8 s (LS17): no margin |
| T-W | Hosting time after the caller disconnects | **BLOCKED** | LS22 |

## Mutation and regression re-runs

- Deliberate-break check re-run: see `evidence/mutation-recheck-4h6.txt`.
- REAL-PG new suite: 15 / 15 (`evidence/real-postgresql-recheck-4h6.txt`).
- New probes: 7 / 7 (`evidence/independent-probes-4h6.txt`).
- Full suite: 1,409 passed, 81 skipped, 0 failed; type check 0 errors.
