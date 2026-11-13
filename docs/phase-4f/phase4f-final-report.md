# Phase 4F — Engine Alignment & Disabled Worker — final report (13 Nov 2026)

Scope: owner brief "Phase 4F: Engine Alignment & Disabled Worker". This was offline code and tests only. No migration
was applied, and nothing was scheduled, deployed or activated. Phase 4G was **not** started.

## Status by workstream

| Workstream | Result | Summary |
|---|---|---|
| A. Migration status | **PASS** | 0046 rejected, 0047 retired, 0048 review-only, 0049 draft-only. All are byte-identical and unapplied; the journal still ends at 0039. Numbering is not finalized. |
| B. E1 expiry cancellation | **PASS** | A remainder is cancelled before the first fill time after its approval expires (reason `APPROVAL_EXPIRED`). The database accepts this for 1 m and 5 m candles. Without E1, the database refuses the payload (tested). |
| B. E2 database-authoritative budgets | **PASS** | Acceptance is sized through `riskEngineStrategyBudget` on the account, sub-budget and strategy definitions, counting closed + open + pending risk owner-wide. The core's own budget is neutralized, so there is one source. Engine and database budgets agreed to ≤ 2.8e-13 over 7,200 checks. |
| B. E3 refusal classification | **PASS** | Every `RAISE` in 0049 is either mapped to a bounded code (41-row table test) or halts for review. Unknown, inconsistent, repeated or unattributable approval refusals halt and are never retried. |
| B. E4 costs | **PASS** | `resolveCost` equals `fp3_cost` for every override combination tested. The same cost sizes the approval and is frozen on it. A missing cost is refused, and so is an unvalidated cost when validation is required. |
| C. Disabled worker | **PASS (implemented, not activated)** | Lease, compare-and-set cursor, idempotent replay, duplicate/out-of-order protection, crash recovery, bounded retries, refusal handling and monitoring codes are implemented. It is off by default, with no route, cron or schedule, and no hosted database adapter. |
| D. Validation | **PASS** | Every requested scenario is tested: PGlite, real PostgreSQL (run separately), synthetic and historical. See the evidence section below. |
| E. Market-data provenance | **PASS (documented + tested)** | Checks cover source, symbol, timeframe, open/close times, closed-candle rule, duplicates, sequence, stale/future timestamps, gaps and malformed rows. **Prices are not independently verified.** |
| G. Final report | **PASS** | This file. |
| Activation / production readiness | **BLOCKED (by design)** | Needs owner approval to apply 0049, a hosted database adapter as service-only functions (lease + snapshot read), a fresh export and restore, and separate activation and schedule approvals. |

## Implemented code (new unless marked)

| File | What | SHA-256 |
|---|---|---|
| `src/lib/futures-paper-engine-v3.ts` | 0049-aligned layer over the **unchanged** core: E1 expiry, E2 budget sizing plus a sequential 0049 mirror (levels, open + pending exposure, count, free margin), E4 `resolveCost`, E3 `planLedgerRefusalV3` with bounded code lists | `4e507828bfb32110399c755b840863a0392fb27eeecc471064478bd42267c313` |
| `src/lib/futures-paper-market-data.ts` | Provenance checks and closed-candle selection (no network) | `3ab8edacaa167186e82ed741d4069efe66b9ca4f31fcd1242d0aa10e5eb971cb` |
| `src/lib/futures-paper-worker.ts` | Worker core over injected ports. `FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT = false`. `viewFromRows` builds the ledger view from database rows. | `1e88149683c5e06459db7e07ba4c7ad8ccef3f055d938d2013ba1fb792435947` |
| `src/lib/futures-paper-worker-queries.ts` | Reference SQL only: snapshot read, owner-wide usage (same definition as `fp3_usage`), advisory lease, commit, review hold | `fca2f3b0f78ef9a685dd87d5e926e8dd1a03684186c38ed9dc043c2f1c9dd0de` |
| `scripts/futures-paper/fetch-history-fixture.ts` | One-off public GET fixture fetch (allowlisted, keyless) | `0501192f66ae991ac7088f2a16375e4480e8af2d287aa911ac176447d87c6c44` |
| `scripts/futures-paper/concurrency-check-4f-worker.sh` | Throwaway local PostgreSQL 17.11 launcher (port 55451) | `71d6848e06d285aea9869cea916a6351f855da4f6cb4598eaab03bf962b28061` |
| `src/lib/AGENTS.md` (M) | One rule added for the aligned layer and the worker | — |

Unchanged and verified (hash-pinned in `phase4f-alignment-isolation.test.ts`):

- `futures-paper-engine.ts` (`588d782d…`), `central-risk.ts` (`0d1006bb…`), both shadow modules, `account-risk-budget.ts` and `futures-paper-ledger-v3.ts`.
- The core engine stays byte-frozen because the 0045/0046 tests reference it. All alignment lives in the separate layer.

### Migration hashes (all unapplied, byte-identical this phase)

| Draft | SHA-256 |
|---|---|
| 0045 / rollback | `fa907f33…cf1b` / `e80f6559…d3892` |
| 0046 (rejected) / rollback | `eac47d85…623e` / `dd8b96ba…9453` |
| 0047 (retired) / rollback | `42d3c65e…801b` / `bb980bbc…5ae8` |
| 0048 (review only) / rollback | `93305df7…60bb` / `9930d148…504f` |
| 0049 (draft) / rollback | `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` / `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb` |

## Test evidence (type of each test stated)

| Suite | Type | Result |
|---|---|---|
| `futures-paper-engine-v3.test.ts` | Real engine output committed to **0049 in PGlite**, plus pure tests | 57/57 |
| `futures-paper-v3-replay.test.ts`, synthetic | PGlite; synthetic prices | PASS (see the replay results below) |
| `futures-paper-v3-replay.test.ts`, historical | PGlite; **real public Binance 5 m data** (fixture `4cb0299d…e269`, 10–13 Nov 2026) through the worker | PASS |
| `futures-paper-market-data.test.ts` | Pure | 9/9 |
| `futures-paper-worker.test.ts` | Worker over PGlite 0049; leases are an in-memory map; crash and lost-reply cases are **simulated in ports** | 14/14 |
| `futures-paper-worker.pg.test.ts` | **Real PostgreSQL 17.11, separate sessions** | 8/8 |
| `concurrency-check-4f-worker.sh` (worker + 0049 + 0048 + 4D + 0046 suites) | Real PostgreSQL | 26/26 on **six consecutive runs** after the fix below |
| `phase4f-alignment-isolation.test.ts` + updated 4D/4F isolation tests | Static change control | 35/35 (isolation suites) |
| Full regression (vitest) | Mixed | **1,107 passed, 0 failed, 45 skipped.** The skips are the 8 real-PostgreSQL files, run separately above. |
| Typecheck (`tsgo -b --noEmit`) | — | PASS |
| Production build | Harness log | `build OK` (11:11:27Z) |

The real-PostgreSQL worker tests cover:

- Advisory-lock lease contention with four workers.
- Racing workers with no lease.
- A backend killed inside the transaction, before COMMIT.
- A process dying after COMMIT.
- Restart recovery that ends identical to an uninterrupted run.
- A cross-account budget race. All 3 rounds hit a genuine database refusal, which was classified `APPROVAL_STRATEGY_BUDGET` and turned into a rejection; usage stayed ≤ budget.
- Multi-symbol atomicity.
- A torn read.

**Defect found and fixed:**

- Racing workers without a lease hit `LEDGER_STATE_MISMATCH` in 2 of 5 runs. The cause was a load whose six reads were not one snapshot.
- Fix: the port contract now requires one REPEATABLE READ, READ ONLY snapshot (`FP_SQL.snapshotBegin`).
- Defensive change: the worker re-reads a torn view up to `maxReloads` times, then halts. Both behaviours are tested.

**Not executed:**

- Lovable Cloud restore and any hosted database adapter (none exists).
- Any real or Testnet order, any AI call, any schedule.
- Re-runs of the unchanged 0045, 0044 and 0043 concurrency suites (last run in Phase 4E, all passed).
- Liquidations were not observed in the long replays. They are covered by a dedicated PGlite test: gap → liquidation → loss beyond reserved risk → the sub-budget binds the next strategy.

## Replay results and refusal statistics (engine and ledger consistency only — not performance)

| | Synthetic (1 m, 1,200 candles × 2 accounts) | Historical (5 m, 864 candles, BTCUSDT + ETHUSDT) |
|---|---|---|
| Commits / database refusals | 2,400 / **0** | 864 / **0** (no halts, no data errors) |
| Approvals / fills / exits | 297 / 383 / 295 | 22 / 22 / 22 |
| Engine rejections and cancellations, all with bounded codes | `APPROVAL_BUDGET_MISSING` 172 (a deliberately unbudgeted strategy); `APPROVAL_STRATEGY_BUDGET` 99; `APPROVAL_EXPIRED` 26 | `APPROVAL_STRATEGY_BUDGET` 173 |
| Other rejections | Central Risk Engine checks (one position per symbol, daily loss, size) | Same |
| Budget equality engine ↔ database | 7,200 checks, max difference 2.6e-13 | Database re-read every candle by the worker |

**Unexplained refusals: 0.** The historical strategy-free test intents exhausted their loss budgets (wins never refill), which is why budget rejections dominate. The final simulated wallet (919.23 from 1,000) is a byproduct of arbitrary test intents and fees, not a result. Full figures are in `replay-synthetic.json` and `replay-historical.json`.

## Worker disabled-state proof
1. `FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT = false`. `runFuturesPaperWorkerTick` returns `disabled` unless `enabled === true`. A test passes ports that throw on any access, and nothing is touched; `enabled: "true"` (a string) is also refused.
2. No file in the app imports the worker, the aligned engine, the market-data module or the query strings. The real Futures, Autopilot, Spot paper and manual paths cannot reach them (import-graph test).
3. No route, server function, `supabase/` file or deploy config names the worker or `futures_paper_commit_bar_v3`. Nothing in `src` or `scripts` schedules Futures paper work (static test). The hosted database has none of the 0049 objects.

## Market-data provenance (workstream E)
- Every candle must come from source `binance-public-usdm`.
- Symbol set and timeframe must match the request.
- Open time must be aligned, and close time = open + timeframe − 1.
- The candle must be closed when fetched, and closed by now plus a grace period.
- Rows must be strictly ascending. Identical duplicates are dropped; conflicting duplicates refuse.
- A future open, a feed behind the requested candle (`CANDLE_STALE_FEED`), a gap (`CANDLE_MISSING`), a missing mark or malformed OHLC/funding all refuse the whole account candle.
- Nothing is forward-filled. A missing index is allowed, but entries are then refused by both engine and database.
- Each candle carries a provenance record labelled "prices NOT independently verified".
- 0049 stores the candles but not fetch provenance. Database arithmetic proves internal consistency, **not authenticity**.

## Unresolved blockers and owner decisions
1. Owner review of 0049, then a separate approval to apply it.
2. A hosted database adapter. It needs service-only functions for the snapshot load and the lease, plus a draft migration of its own; nothing is drafted yet.
3. A fresh export and practice restore before any apply.
4. Activation and schedule approvals, kept separate from each other.
5. Still NOT APPROVED:
   - The 5% / 5 s / 60 s / 0.13% values.
   - The closed-loss budget definition (wins never refill).
   - UTC day for daily loss.
   - Budget amounts.
   - Retention.
6. Design limits accepted in this phase:
   - At most one intent per symbol per candle (`APPROVAL_INTENT_LIMIT`).
   - A database-refused approval becomes a rejection; it is never re-sized.
   - The engine refuses all approvals when the budget configuration is not nested, which is stricter than the database's per-level checks.
   - Core state `seen` grows without bound.

## Confirmation
- No migrations were applied; all databases used were PGlite or throwaway local PostgreSQL, deleted afterwards.
- No real or Testnet orders.
- No production settings, credentials or risk limits changed.
- No AI calls and no paid infrastructure.
- No Central Risk execution integration.
- No worker scheduling, deployment or activation.
- No Autopilot or Live Futures changes, and no changes to real Futures order paths.
- The only network access was keyless public Binance market-data GET requests for the test fixture.
- Phase 4G was not started.
