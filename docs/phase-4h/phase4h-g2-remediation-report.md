# Phase 4H — G2 database invariant remediation — final report (13 Nov 2026)

**Owner decision implemented:** G2 is fixed in a successor draft, **0051**. It is not accepted as a paper limitation.

**Nothing was applied, enabled, scheduled or traded.**
- No migration was applied to Lovable Cloud and no hosted database write was made.
- No worker or paper engine was activated, and no Testnet or real order was placed.
- Autopilot, Live Futures, credentials and risk settings were not touched.
- No paid infrastructure was used and no AI call was made.

## Verdicts

| Item | Result |
|---|---|
| G2 invariant (successor 0051) | **PASS (draft).** The database derives every required funding charge and exit itself and refuses any difference. |
| 0049 / 0050 unchanged | **PASS.** Byte-identical to their Phase 4G fingerprints, enforced by a test. |
| Hosted service-role review | **Done.** See `hosted-service-role-review.md`. The connection stays disabled, and least privilege is not yet in place. |
| Fresh export (after 14 Nov 09:19 UTC) and full restore | **BLOCKED.** Read-only storage listing at 12:43 UTC on 13 Nov shows only the 12 Nov and 13 Nov 09:20 exports. The old export was **not** used as a substitute; no restore was run this phase. |
| Ready for a separate migration-application review? | **Not yet.** The blockers are listed at the end. |
| Activation readiness | **Not claimed.** Passing tests do not establish it. |

## 1. G2 invariant design (draft 0051)

0051 adds `futures_paper_commit_bar_v4`. It runs 0049's commit inside the same transaction, then verifies the result. It also replaces the 0050 gateway (`fpw_commit`) with 0050's own body, changed only to call v4; a test pins this. No API role can call v4 directly.

| # | Invariant | How the database enforces it |
|---|---|---|
| C1 | Funding completeness | **Grid.** BTCUSDT/ETHUSDT fund every 8 h (00/08/16 UTC). An entry counts within 1 s after a grid point, which covers Binance's observed 0–3 ms lateness.<br>**Requirement.** For a position held at the candle open, a grid point inside the candle needs exactly one funding entry and exactly one funding event, recorded before any fill, close or order event. 0049 still recomputes the cash.<br>**Refused.** A missing rate, duplicate times, two rates in one window, off-grid entries and extra or missing funding events. |
| C2 | Exit completeness | **Rebuild.** For every position exposed in the candle (held at the open and/or filled at the open, including partial fills), the database rebuilds quantity, average entry and margin. It uses its own book plus this candle's validated funding and fills.<br>**Conservative order** (the engine's documented rules): liquidation at open → stop at open (gap: filled at the open) → target at open → stop inside the candle (if before liquidation) → liquidation inside → target inside → time limit at close.<br>**Matching.** The required close must match exactly in kind, time and taker price. A close where none is required is refused; the worker is never trusted that an exit was unnecessary. |
| C3 | Frozen protection terms | When the approval is written, 0051 records:<br>• trigger source, from the frozen account config<br>• stop distance, from the approval<br>• target distance and maximum hold, from the submitted pending entry<br>All of these are fixed before any outcome is known, and every later state must carry exactly these terms and the correct candle count. |
| C4 | No silent gaps | While a position or pending entry exists, the candle must be the one directly after the cursor. |
| C5 | Ambiguity is refused | A deciding price within 1e-9 (relative) of a stop, target or liquidation level is refused, never guessed. So are a missing trigger source and missing terms. Refusals carry `futures paper completeness:`; the Phase 4F planner treats them as unclassified → review → pause. The candle stays uncommitted and is retried in full. |
| C6 | Atomic and idempotent | One transaction covers candles, events, positions, approvals, budget usage, terms and the per-candle check record (`futures_paper_candle_checks`). An identical replay returns the committed sequence without re-checking. A different payload for a committed candle is refused. |

New append-only tables have owner-only reads (with MFA awareness) and no API write grants:
- `futures_paper_protection_terms`
- `futures_paper_candle_checks`

A rollback-order guard view makes 0050's rollback fail while 0051 exists.

## 2. Fingerprints (SHA-256)

| File | SHA-256 | Bytes |
|---|---|---|
| `0049_futures_paper_ledger_v3.sql` (unchanged) | `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` | — |
| `0049_…rollback.sql` (unchanged) | `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb` | — |
| `0050_futures_paper_worker_gateway.sql` (unchanged) | `40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa` | — |
| `0050_…rollback.sql` (unchanged) | `93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b` | — |
| **`0051_futures_paper_event_completeness.sql`** | `58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788` | 32,233 |
| **`0051_futures_paper_event_completeness.rollback.sql`** | `41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf` | 5,782 |

**Apply order:** 0049 → 0050 → 0051.
**Rollback order:** 0051 → 0050 → 0049.

The 0051 rollback:
- restores 0050's gateway definition and permissions byte-for-byte (tested with `pg_get_functiondef` and the ACL);
- drops the two evidence tables (export them first).

## 3. Test evidence

**The three Phase 4G G2 cases under 0051** (`migration-0051-completeness.test.ts`):
1. A stop crossing with no exit is now **refused**; the engine's own exit commits.
2. A funding entry with no funding event is now **refused**.
3. Control: an out-of-range exit is still refused.

The 0049-alone characterization test still passes, because 0049 itself is unchanged.

**Adversarial cases (24/24 pass):**
- gap through the stop (exit must be at the worse open)
- stop and target in one candle (stop required)
- fabricated exit refused
- gap through the target at the open
- liquidation at open beats stop at open
- omitted time exit refused
- partial position: protection covers the next partial fill too
- ambiguous touch refused
- funding: missing rate, two rates in one window, off-grid entry and duplicated event are all refused; ms jitter is accepted; no charge for flat accounts or positions opened at the funding open
- skipped candle while exposed refused (allowed while flat)
- altered target/hold in the state refused
- missing trigger source refused
- atomic rollback of a refused candle, then recovery
- identical replay and conflicting payload
- gateway path refuses an omission
- privileges and owner-only reads
- migration order and byte-exact rollback

**Mutation check:** three checks were disabled one at a time (required exit, funding count, unrequired exit). Each was caught by 4, 2 and 1 failing tests respectively. The file was restored and its fingerprint re-verified.

**Replays through 0051** (unchanged Phase 4F engine; `docs/phase-4h/replay-0051-*.json`):

| Replay | Commits | DB refusals | DB outcomes | Engine exit reasons | Funding charges |
|---|---|---|---|---|---|
| Synthetic 1 m (MARK + CONTRACT accounts) | 2,400 | **0** | stop 172, target 46, target_open 1, time 36, liquidation_open 2 | stop 172, target 47, time 36, liquidation 2 | 5 |
| Synthetic 5 m (≈ 50 h) | 1,200 | **0** | stop 79, stop_open 1, target 24, time 21, liquidation_open 1 | stop 80, target 24, time 21, liquidation 1 | 7 |
| Historical Binance 5 m (10–13 Nov, real funding times with jitter, through the worker) | 864 | **0** | stop 12, target 2, time 13 (399 exposed-symbol candles checked) | — | 2 |

Every engine exit reason equals the database's outcome; there were **0 mismatches**. Funding coverage is thin (5, 7 and 2 charges) because funding only happens every 8 h.

**Full suite and other checks:**

| Run | Result |
|---|---|
| Full suite (`bunx vitest run`) | **1,217 passed, 0 failed, 57 skipped** (110 files) |
| Real PostgreSQL 17.11, `scripts/futures-paper/concurrency-check-4h.sh` (throwaway, local) | **46/46 on three consecutive runs**:<br>• 0051 suite 4/4: six identical concurrent commits → one commit; omitting vs correct writer ×5 → the omission never commits; same-owner concurrent stop-outs; backend killed while waiting → nothing written<br>• Phase 4G hosted suite re-run **through 0051**: 8/8<br>• Earlier suites: 34/34 |
| PGlite Phase 4G gateway/hosted suites re-run with 0051 (`FP_WITH_0051=1`) | 35/36. The one failure is 0050's own rollback test, blocked by 0051's rollback-order guard as designed. |
| Type check (`tsgo -b --noEmit`) | exit 0 |

**Skipped tests (57).** 38 ran separately on real PostgreSQL as above. **19 were not run this phase** (drafts 0043: 10, 0044: 7, 0045: 2).

**Test-config change.** `vitest.config.ts` now sets a 30 s default test timeout. Without it, fresh in-memory database tests exceeded 5 s under full-suite load (observed on three different pre-existing tests).

## 4. Residual limitations (documented, not hidden)

- **R1.** Prices are worker-supplied public data (G12). 0051 checks events against the recorded candle, not against the market.
- **R2.** Entry fills are not *required*. A worker may omit a fill or cancel a remainder. That never hides a loss or a charge, and the fill quantity under the volume cap is not recomputed.
- **R3.** Target and maximum hold are strategy inputs, frozen from the submitted pending entry at approval. There is no look-ahead, but they are not independently sourced.
- **R4.** The 8 h funding grid is a constant. If Binance changes a symbol's interval, held accounts are refused (fail closed) until a successor draft.
- **R5.** A **stopped** account with an open position can no longer commit (0049 semantics), so its exits are frozen. This needs an owner decision.
- **R6.** Following the engine convention, a position filled at the open of the funding candle is not charged.
- **R7.** Ambiguous touches pause the account. None occurred in 4,464 replayed commits.
- **R8.** A refused candle blocks its account until valid data arrives. No partial history is written, but the simulated position stays open until then.

## 5. Remaining blockers before a migration-application review

1. A **fresh export** after 09:19 UTC on 14 Nov, then a local restore with 0049 → 0050 → 0051 apply and rollback. The restore script has not yet been extended to 0051; that is the next step once the export exists.
2. Owner review of **0051** and of its engineering constants (8 h grid, 1 s jitter, 1e-9 band, hold ceiling).
3. Owner decisions on **R2** and **R5**.
4. Security: stage 1 (configuration audit) and stage 2 (machine identity) from the service-role review, before any activation.
5. The earlier open items still apply: policy values, budgets and retention, plus separate approvals for enabling and scheduling.
