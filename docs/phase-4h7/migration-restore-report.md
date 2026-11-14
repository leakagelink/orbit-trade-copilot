# Phase 4H.7 — Migration restore and recovery report (Task 4)

Drafts 0049–0057 were **not applied** to the live project. Nothing was written to production. No owner export exists yet.

## 1. Tooling

| File | Purpose |
|---|---|
| `scripts/db-export/verify-local-restore-0057.sh` | Restores **one local export file** into a disposable PostgreSQL (fresh `/tmp` directory, private UNIX socket, every connection variable unset, URLs and connection strings refused) and runs every check below. Prints counts, hashes and object names only. |
| `scripts/db-export/make-synthetic-export-4h7.{sh,ts}` | Builds a **synthetic** practice archive (role/auth/app stand-ins, the 40-entry migration journal). Only for testing the verifier; it is not owner data. |

## 2. Procedure (owner export)

1. Owner takes a fresh export after the latest applied migration (custom format) and keeps it local.
2. `REPORT=/tmp/r.md PRESERVE_DIR=/tmp/keep scripts/db-export/verify-local-restore-0057.sh /path/export.backup`
   (`SEED_HISTORY=0` skips the synthetic history rows; with a real export, real history counts are used anyway).
3. Read the report: every row must be PASS or INFO, except the known recovery finding R3 below.
4. Keep `PRESERVE_DIR` (CSV per dropped table, with row count and SHA-256) for as long as the export.
5. Only then, with separate owner approval, apply the drafts in order; never byte-modified.

Checks: restore errors classified; migration journal equals the repository's order; 0039 safety objects present; no
0045–0057 object present; prerequisites of 0055 and 0057; each draft refused without its predecessor (nothing left);
each draft in one timed transaction; pre-existing row counts unchanged; every out-of-order rollback refused; rollback
classification; history exported before any destructive rollback; rollback chain 0057 → 0049 with catalog comparison
after each step; pre-existing objects and rows identical after the full rollback; recovery (retired history archived
under a dated name, chain re-applied, catalog equal to the first application).

## 3. Practice run (synthetic archive, not owner data)

Raw report: `evidence/restore-practice-synthetic.md` (PostgreSQL 17.11, local).

| Check | Result |
|---|---|
| Restore errors | PASS (0) |
| Migration ordering (40 entries) | PASS |
| 0039 safety objects | **FAIL — expected**: the synthetic archive has none; a real export must |
| Each draft refused without its predecessor (8) | PASS |
| Chain 0049 → 0057 applied, one transaction each (25–69 ms) | PASS |
| Pre-existing row counts unchanged | PASS |
| Out-of-order rollbacks refused (8) | PASS |
| Rollback 0057 → 0050, catalog restored exactly each step | PASS |
| Rollback 0049 without the recovery step | **FAIL** (finding R3) |
| Rollback 0049 after the recovery step | PASS |
| Pre-existing objects and rows identical after full rollback | PASS |
| Recovery: chain re-applied, catalog equal to the first application | PASS |

## 4. Rollback classification

| Rollback | Class | Effect on history |
|---|---|---|
| 0057 | PRESERVING | renames pins, credential events and tally to `*_0057_retired` (with indexes, sequence and guard function) |
| 0056 | NO TABLES | functions, hook and policies only |
| 0055 | PRESERVING | renames the refusal table to `*_0055_retired` |
| 0054 | **DESTRUCTIVE** | drops identity changes |
| 0053 | **DESTRUCTIVE** | drops identities and enrollments |
| 0052 | **DESTRUCTIVE** | drops config changes and entry checks |
| 0051 | **DESTRUCTIVE** | drops candle checks and protection terms |
| 0050 | **DESTRUCTIVE** | drops candle provenance, worker audit and leases |
| 0049 | **DESTRUCTIVE** | drops the whole paper ledger and both risk budget tables |

The verifier exports every table a destructive rollback drops before running it (practice run: identity changes 2 rows,
identities 1, worker audit 3 — row counts and SHA-256 recorded). In production a destructive rollback would delete those
rows from the database; the export is the only copy. Owner decision OD-M2.

## 5. Findings

| Id | Finding | Status |
|---|---|---|
| R1 | Rollbacks 0049–0054 drop tables (history deleted from the database) | Documented; mitigated by export-before-rollback. Drafts not modified (forbidden). |
| R2 | 0055's rollback renames its table but not its index, so re-applying 0055 failed: `relation "futures_paper_worker_refusals_worker" already exists` | **Fixed in the recovery procedure**: retired tables (and their indexes/sequences) are archived under a dated name before re-applying. 0055 itself unchanged. |
| R3 | Retired 0055/0057 history keeps append-only triggers that use 0049's `futures_paper_history_immutable()`, so rollback 0049 fails: `cannot drop function futures_paper_history_immutable() because other objects depend on it` | **Recovery step** (verifier, disposable copy): re-bind those triggers to a stand-alone append-only guard (7 triggers, no row touched), then 0049 rolls back. In production: owner approval required. |
| R4 | 0057's first rollback left index, sequence and guard-function names in place, blocking re-application | **Fixed in the 0057 rollback draft**; re-application verified |

## 6. Verdict

| Item | Result |
|---|---|
| Reproducible isolated restore procedure | **PASS** |
| Ordering and compatibility verified (synthetic) | **PASS** |
| Rollback and recovery without deleting irreplaceable history | **PARTIAL** — 0055/0057 preserve; 0049–0054 delete (exported first); 0049 needs recovery step R3 |
| Destructive rollbacks identified | **PASS** |
| Restore of a fresh owner export | **BLOCKED** — no owner export supplied |
| Task 4 overall | **PARTIAL** |
