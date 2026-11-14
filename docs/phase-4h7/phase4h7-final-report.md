# Orbit Trade Copilot — Phase 4H.7 final report: final worker blocker remediation

Date: 14 Nov 2026. Phase 4I was **not** started.

## 1. Results

| Task | Item | Result |
|---|---|---|
| 1 | Bounded, resumable invocation inside the 5,000 ms scheduler limit (budget 3,600 + margin 1,200) | **PASS** (local) |
| 1 | Idempotent independently committed stages; no transaction across invocations; one lease holder; resume after timeout/kill; partial ≠ complete | **PASS** (PGlite + real PostgreSQL) |
| 1 | Timing measured: max 3,134 ms at 300 ms injected latency per request (real PostgreSQL, two runs) | **PASS** (local) |
| 1 | Hosted measurement on a safe test route | **BLOCKED** — needs a deployed probe (deployment forbidden this phase) |
| 1 | **Task 1 overall** | **PARTIAL** |
| 2 | Draft 0057 credential pin: password/email/pending change/linked identity → refused, identity disabled, enrollments revoked, leases ended (sticky) | **PASS** (PGlite, mutation-checked) |
| 2 | Stolen/stale tokens cannot restore authority; re-registration + re-enrollment recovery | **PASS** |
| 2 | Server-side check of every session's user object, before any data call | **PASS** |
| 2 | Ordinary user authentication unchanged | **PASS** |
| 2 | Hosted fingerprint stability and definer read | **BLOCKED** until 0057 is applied with approval |
| 2 | **Task 2 overall** | **PASS (local)** / hosted **BLOCKED** |
| 3 | Refusal categories A (database rows + counters), B (platform logs via journal), C (unrecordable) — no false claim | **PASS** |
| 3 | Timeout refusals, cap exhaustion with explicit dropped counter, missing/added-row detection | **PASS** (PGlite + real PostgreSQL) |
| 3 | Category B log retention | **NOT VERIFIED** |
| 3 | Consistent owner rewrite of rows + tally | **BLOCKED** — external checkpoint store (owner decision) |
| 3 | **Task 3 overall** | **PARTIAL** |
| 4 | Reproducible isolated restore + recovery procedure for 0049–0057 | **PASS** (synthetic practice archive) |
| 4 | Destructive rollbacks identified (0049–0054); history exported before each | **PASS** |
| 4 | Full rollback without deleting history | **PARTIAL** — 0049 needs recovery step R3 while retired history exists |
| 4 | Restore of a fresh owner export | **BLOCKED** — none supplied |
| 4 | **Task 4 overall** | **PARTIAL** |
| 5 | Regression and adversarial tests | **PASS** (below) |

Details: `worker-timing-report.md`, `credential-security-report.md`, `audit-integrity-report.md`,
`migration-restore-report.md`, `owner-decisions-required.md`.

## 2. What changed

| File | Change |
|---|---|
| `src/lib/worker-invocation.ts` (new, pure) | invocation limits + validation against the 5,000 ms limit, slot → account choice, bounded abortable port calls, strict outcome classification, server-side credential check |
| `src/lib/worker-refusal-audit.ts` (new, pure) | A/B/C classification, invocation journal, reconciliation with rows and tally |
| `src/lib/worker-auth-session.ts` | optional `verifyUser` on sign-in/refresh replies (`TOKEN_USER_REFUSED`, fail closed, signed out once) |
| `src/lib/futures-paper-worker-identity.server.ts` | disabled `runBoundedIdentityInvocation` (same unset flags; imported and scheduled by nothing) |
| `docs/proposed-migrations/0057_…sql` + rollback | credential pin, sticky invalidation, refusal tally, completeness report; rollback preserves history (renames tables, indexes, sequence, guard). **Not applied.** |
| `scripts/db-export/verify-local-restore-0057.sh`, `make-synthetic-export-4h7.*` | local disposable restore/recovery verifier and practice archive builder |
| `scripts/futures-paper/concurrency-check-4h7.sh`, `scripts/worker-auth/mutation-check-4h7.ts` | real-PostgreSQL runner and mutation check |
| tests | `phase4h7-*.test.ts`, `phase4h7.pg.test.ts`, helpers; isolation allow-lists extended for the two new local tools |

Unchanged (verified by git and the pinned-hash tests): drafts 0049–0056 and their rollbacks, the locked hosted worker
files, worker core, T1–T11, S1–S8 defaults, risk settings, sign-in settings.

## 3. Verification

| Run | Result | Evidence type |
|---|---|---|
| Full suite (`bunx vitest run`) | 1,475 passed, 84 skipped, 0 failed (121 files) | mixed; PGlite / pure / mocked |
| `phase4h7-credential-0057` / `-invocation` / `-units` / `-isolation` | all passed | PGLITE / PGLITE + fake API / pure / static |
| Real PostgreSQL 17.11, throwaway: 4H.7 (3) + 4H.5 (15) | 18/18 passed | REAL PG |
| Real PostgreSQL earlier suites: 4H-final 5 + 38, 4H.1 4 + 43, 4H 4 + 8 + 34 | all passed | REAL PG |
| Mutation check 4H.7 | 25/25 deliberate breaks detected; files restored by SHA-256 | mutation |
| Restore practice (synthetic) | 42 PASS; 2 expected FAIL (no 0039 objects in synthetic data; R3 without recovery step) | REAL PG (local) |
| Type check (`tsgo -b --noEmit`) | 0 errors (one test-only optional-property type fixed afterwards; that file re-run: 14/14) | static |
| Production build (`vite build`) | succeeded | build |

Mocked/synthetic boundaries: the sign-in service and data API are local fakes; the auth schema is a stand-in; latency is
injected. Nothing here proves hosted behaviour.

## 4. Restrictions honoured

No migration applied; no live database, sign-in setting, credential or risk change; no account, schedule, secret or
worker activation; no exchange, Testnet or real order; no AI call; no hosting or service bought; Autopilot and Live
Futures untouched; no locked file modified.

## 5. Remaining activation blockers

Engineering (none open without an owner decision). Owner decisions, all **NOT APPROVED** (`owner-decisions-required.md`):

1. Hosted timing probe (OD-T2) and the invocation limits I1–I10 (OD-T1); capacity (OD-T3).
2. Fresh export + restore through 0057 (OD-10); recovery step R3 (OD-M1); destructive-rollback policy (OD-M2/OD-13).
3. Apply 0049–0057 (OD-11) and post-apply live checks incl. 0057 fingerprint stability (OD-12).
4. Deployment architecture (OD-2); log retention for category B (OD-A2); checkpoint store, key and schedule (OD-A1, OD-6–8).
5. W1–W5 (OD-9), paper risk values (OD-15), sign-in settings (OD-4).
6. Worker account, registration, enrollment, job secret, flags, schedule — each separately (OD-17).
