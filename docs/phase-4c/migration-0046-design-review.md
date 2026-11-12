# Migration 0046 (successor of draft 0045) — design review and test report

**Status: DRAFT ONLY — NOT APPLIED. Restore verification: BLOCKED (no fresh export).** Final migration number: **unresolved** (0046 is proposed).

## 1. Integrity of the original 0045 (verified, unchanged)

| File | Full SHA-256 (computed 12 Nov 2026) | Brief abbreviation | Match |
|---|---|---|---|
| `0045_futures_paper_ledger_and_strategy_budgets.sql` | `fa907f33269f0b2ef583e161b37b7a79b1f3db084bcb6813a7b25dfbb021cf1b` | `fa907f33…21cf1b` | yes |
| `0045_futures_paper_ledger_and_strategy_budgets.rollback.sql` | `e80f65593d19ecb35d9d22aceae6f2dac9be75853769975fe464b0c3ea7d3892` | `e80f6559…3892` | yes |

0045 was not edited; `src/test/phase4c-isolation.test.ts` pins both full hashes.

## 2. Migration sequence

- Applied history (read-only Drizzle history inspection, 12 Nov 2026): `0000_phase1_schema` … `0039_futures_pass_certification_and_autopilot_fencing` (40 entries), consistent, no findings. This checkout has `drizzle/migrations/` (not `supabase/migrations/`), matching that history.
- Unapplied drafts in `docs/proposed-migrations/`: 0039 copy, 0040, 0041, 0042 (+rollback), 0043 (+rollback), 0044 (+rollback), 0045 (+rollback).
- **0046** is the next free draft number. It is **standalone and supersedes 0045** (same table names; applying it on top of 0045 fails, which the restore verifier and self-test check). Its final number depends on which of 0040–0044 the owner applies first — unresolved.

## 3. Files

| File | SHA-256 |
|---|---|
| `docs/proposed-migrations/0046_futures_paper_ledger_v2.sql` | `eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e` |
| `docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql` | `dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453` |
| `src/lib/futures-paper-ledger-v2.ts` (pure payload builder, imported by nothing in the app) | `9de66743013ed7d2db94107a1f0c8efc6639262b8590218533874caa253af941` |
| `scripts/db-export/verify-local-restore-0046.sh` (local-only verifier) | `f40061035a41e1d4b17cab341ada6df17f1de5e8ee496312bb378613307eca05` |

## 4. Defects resolved (each has a focused test in `src/test/futures-paper-ledger-v2-migration.test.ts` unless noted)

| # | 0045 defect | 0046 resolution | Test |
|---|---|---|---|
| 1 | NULL `p_expected_seq` accepted (`<>` with NULL) | all four arguments required; `IS DISTINCT FROM` sequence check | "corrected invariant 1" |
| 2 | `{events:[],state:{}}` accepted; nullable wallet comparison; account creation let missing keys through | strict JSON typing helpers (`fp2_num/int/txt`), payload must have `events[]`, `state{}`, `marks{}`; state needs version, wallet, seq, halted, positions, pending; numeric columns reject NaN/±Infinity; account INSERT uses `IS DISTINCT FROM` and requires every key; limits extracted and frozen | "corrected invariant 2" (2 tests) |
| 3 | budget never checked at commit | each entry fill locks the owner's `(strategy, 'paper')` budget row (account row first, then budgets in strategy order) and checks closed losses + reserved open risk + fill risk across **all** the owner's paper accounts; no budget → refused | PGlite "no budget" + "across all accounts"; **multi-session** "two accounts … cannot jointly exceed" |
| 4 | pending fills not re-validated | entry fills re-checked at commit: active and not halted | "halted (stale worker)" |
| 5 | daily loss / budget / exposure not enforced at fill | daily loss (today's ledger cash + negative unrealized at supplied marks), exposure cap, position count and free margin re-checked after the fill; a missing mark for an open position refuses the commit | "daily loss … exposure … missing mark" |
| 6 | atomic commit could store invalid state | all validation precedes COMMIT; any failure rolls back every write of the candle (asserted unchanged counts after each refusal) | "atomically", "writing nothing" |
| 7 | wallet reconciliation only against payload numbers | per-kind cash arithmetic as table CHECK (`entry_fill wallet = −fee`, `exit wallet = pnl − fee`, `liquidation wallet = margin = pnl`, `funding wallet = margin`); database position book (`futures_paper_positions`) must match submitted state (side, qty, margin, strategy) both ways; full-close quantity and margin release checked | "tampered per-kind arithmetic … partial close" |
| 8 | crash recovery not proven | `futures_paper_commits` (one row per account+candle, payload SHA-256): identical retry returns the original sequence and writes nothing; a different payload for a committed candle is refused; unique `(account, fill_id)` | PGlite replay + fill-once; **multi-session** process killed before COMMIT → nothing persisted → retry commits once → lost-response replay idempotent |

Preserved 0045 controls (tested): RLS owner-only MFA-aware reads on all 5 tables; browser roles cannot write or execute; service role cannot write events/positions/commits directly nor change ledger columns (flag bypass refused); append-only events and commits (UPDATE/DELETE/TRUNCATE refused; budgets TRUNCATE also refused); duplicate/older candle and not-yet-closed candle refused; halted account refuses entries; stopped account stays stopped; concurrent workers commit each candle exactly once; no reference to any production table; rollback removes everything without CASCADE and re-apply works.

## 5. Known limitations and open items (not hidden)

- **Engine/DB mismatch → fail-closed stall (BLOCKER for activation).** The pure engine (`futures-paper-engine.ts`, protected in Phase 4C) still does not re-check daily loss, budget or exposure before a pending fill. When the database refuses such a fill, the worker cannot commit that candle until the engine cancels the pending entry. This is safe (nothing is recorded) but would halt progress; the engine needs a matching fill-time re-check (as Phase 3 did for Spot) — **requires separate approval**.
- Daily loss in the database uses the candle's UTC day and the ledger's cash plus marks supplied in the payload. Marks are worker-supplied; the database validates type/range/scope but cannot verify them against the exchange.
- Strategy budget semantics are cumulative per strategy (closed-trade losses, wins not netted, plus reserved open risk). The owner must confirm this (versus daily or net).
- Liquidation/maintenance-margin modelling is unchanged from the engine (first bracket, estimate only).
- `futures_paper_commits` grows one row per account per candle (retention decision needed).
- Multi-symbol accounts must commit both symbols of a candle in ONE payload (one account cursor), as in 0045.
- No worker, scheduler or endpoint exists or was created.

## 6. Test report

| Suite | Environment | Result |
|---|---|---|
| `src/test/futures-paper-ledger-v2-migration.test.ts` | PGlite (in-memory PostgreSQL) | **15 passed** |
| `src/test/futures-paper-ledger-v2-concurrency.pg.test.ts` via `scripts/futures-paper/concurrency-check-0046.sh` | **real multi-session PostgreSQL 17.11**, throwaway local server | **3 passed, run 3 times** (9/9) |
| `src/test/verify-local-restore-0046.test.ts` | local shell (refusals + source guarantees) | **9 passed** |
| `scripts/db-export/test-verify-local-restore-0046.sh` | disposable local PostgreSQL 17.11 on a UNIX socket, **synthetic** backups | **4/4**: well-formed post-0039 archive PASS (20/20 checks); missing history FAIL; wrong migration hash FAIL; 0045 already present FAIL |
| Real export restore | — | **NOT RUN — BLOCKED**: no fresh export exists (latest known export 06:52 UTC predates 0039) |

## 7. Restore verification (local only)

`scripts/db-export/verify-local-restore-0046.sh <local .backup>`: accepts exactly one existing local file; refuses URLs, connection strings, bucket paths, directories and extra arguments (exit 2); unsets and ignores `DATABASE_URL`, `PG*`, `SUPABASE_*`, `LOVABLE_DB_*`; starts its own PostgreSQL with `listen_addresses=''` on a private socket; verifies archive SHA-256, migration ordering (every timestamp and SHA-256 in `drizzle.__drizzle_migrations` equals `drizzle/migrations` in order), 0039 objects present, 0045/0046 absent, applies 0046 and its rollback each in one transaction, checks RLS, policies, grants, EXECUTE, constraints, triggers, SECURITY DEFINER/search_path, a malformed-input probe, and a fingerprint of every pre-existing public object and row counts before/after migration and after rollback. `verify-export.sh` was not reused (it can download from storage and compare against the ambient live database).

**The migration is NOT restore-verified**: that requires a fresh, valid export, independently verified and restored with this script.

## 8. Approvals required before anything is applied

- [ ] Owner creates a fresh export (Lovable Cloud → More → Database → Manage → Settings → Export project data → Export data → Database → Export → Start export) and supplies it as a local file.
- [ ] Run the local verifier on it; review the report.
- [ ] Owner decides the final number and confirms 0045 will never be applied.
- [ ] Owner approves budget semantics, the engine fill-time re-check change, retention, and only then applying 0046.
- [ ] Worker/scheduler: separate later approval.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
