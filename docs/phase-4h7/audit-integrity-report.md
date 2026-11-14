# Phase 4H.7 — Audit integrity report (Task 3: refusal completeness)

No paid logging service, external store, schedule or key was created. Draft 0057 is **NOT APPLIED**.

## 1. What the database can and cannot record

A database cannot record a request that never reaches database code. Every refusal therefore belongs to exactly one category:

| Category | Where it is recorded | Cases |
|---|---|---|
| **A — DATABASE** | A refusal row written by the worker envelope (0055), or — above the per-identity cap — the explicit `dropped_total` counter of the 0057 tally (a count, not a row) | refusals inside the six worker functions: identity, enrollment, lease, fence, sequence, data and integrity checks, **including the credential-change refusal** (which also disables the identity) |
| **B — PLATFORM LOGS ONLY** | The worker's invocation journal (written to the worker host's log by the caller's logger) plus the platform's request logs | data-API request hook (42501), privilege errors, rejected tokens (PGRST30x), statement/lock timeouts (57014: the whole transaction aborts, so no row by design), lost replies, calls cancelled by the worker's own limits, calls the worker refused to send (budget, closed session) |
| **C — NOT DURABLY RECORDABLE** | Nowhere | the worker host died before writing its journal line **and** the request never reached the platform; a platform log that expired; rows removed by the database owner (detectable, not recoverable) |

Platform-log retention and the ability to export those logs were **not verified** (no live call this phase).

## 2. Implemented

| Need | Implementation | Category |
|---|---|---|
| Refusals before database code | `kindOfHostedMetric` maps the hosted adapter's bounded metrics to call kinds; `createJournal` writes an append-only, sequence-numbered journal per invocation (start, every refused/lost call, end) and hands each event to the caller's logger, never blocking the worker | B |
| Refusals caused by timeouts | `TIMED_OUT` (worker's own limit; the database may or may not have run it) and `DB_TIMEOUT` (aborted transaction, no row by design) are separate kinds | B |
| Cap exhaustion | 0057 tally: above the cap the recorder increments `dropped_total` and sets first/last dropped time instead of silently skipping | A (counter) |
| Explicit dropped markers | `dropped_total`, `first_dropped_at`, `last_dropped_at`; monotonic (a trigger refuses decreases, deletes and baseline edits) | A |
| Missing-record detection | 0057 `recorded_total` counts every row written; `fpw_audit_refusal_completeness()` (admin + MFA) reports rows, recorded, missing (= deleted rows) and dropped per worker. `reconcileRefusals` compares the journal with rows and tally: `MISSING_IN_DB`, `DROPPED_BY_CAP`, `DB_ONLY_REFUSAL` (someone else used the identity), `ROWS_DELETED`, `ROWS_ADDED`, `TALLY_MISSING`, `JOURNAL_GAP`, `JOURNAL_INCOMPLETE` | A/B/C |
| Concurrency | the tally row lock serializes one identity's recorders, so counts, cap and rows stay consistent | A |

## 3. Tests (all passing)

| Scenario | Test | Evidence |
|---|---|---|
| Rows counted; cap drops counted, never silent | phase4h7-credential-0057 | PGLITE |
| Deleted row → missing = 1; counters cannot decrease; tally cannot be deleted | phase4h7-credential-0057 | PGLITE |
| Completeness report admin + MFA only; API roles cannot read the tally | phase4h7-credential-0057 | PGLITE |
| 4 connections × 35 concurrent refusals (140): 120 rows (cap), recorded_total 120, dropped_total 20 — none silent | phase4h7.pg | REAL PG |
| Metric → kind/category mapping; journal sequence, freezing, closing; logger failure ignored | phase4h7-units | pure |
| Reconciliation: matched, missing, dropped by cap, DB-only, deleted, added, no tally, gap, incomplete | phase4h7-units | pure |
| Invocation journal end-to-end (statement timeout → B, database refusal → A, reconciled with rows and tally) | phase4h7-invocation | PGLITE + fake API |
| Deliberate breaks: silent cap drop, uncounted rows, decreasing counters, ignored drops, unreported deletes, misfiled request-hook refusal | mutation-check-4h7 | `evidence/mutation-check-4h7.txt` |
| Checkpoint gaps (0055 checkpoint tooling: deletion, insertion, reorder, modification, rewrite) | earlier Phase 4H.5 suites, re-run in the full suite | PGLITE / pure |

## 4. Residual risks

1. **Consistent rewrite by the database owner.** The owner can rewrite rows and the tally together. Only checkpoints stored
   outside the database detect this (Phase 4H.6 options; owner decision OD-A1). The tally is not yet part of the checkpoint
   hash — proposed for the checkpoint job once its store is chosen.
2. **Category B depends on log retention** of the worker host and the platform (not verified).
3. **Category C is irreducible** by design; it is reported as `JOURNAL_INCOMPLETE` when the journal exists but has no end.

## 5. Verdict

| Item | Result |
|---|---|
| Refusals before database code classified and journaled (B) | **PASS** (local) — durable retention **NOT VERIFIED** |
| Timeout refusals | **PASS** |
| Cap exhaustion → explicit dropped counter | **PASS** (PGlite + real PostgreSQL) |
| Missing-record detection (deletion, insertion) | **PASS** |
| Detection of a consistent owner rewrite | **BLOCKED** — needs the external checkpoint store (owner decision) |
| Task 3 overall | **PARTIAL** |
