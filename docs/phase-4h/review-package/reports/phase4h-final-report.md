# Phase 4H finalization — owner decisions and G2 safety closure — final report (13 Nov 2026)

**Nothing was applied, enabled, scheduled or traded.**
- No migration (0049–0053) was applied to Lovable Cloud, and nothing was written to the live database. The only hosted access was one read-only catalog query.
- No worker, hosted connection, schedule, route or paper engine was activated.
- No real or Testnet order was placed.
- Autopilot, Live Futures, credentials and risk settings were not touched.
- No paid infrastructure was used and no AI call was made.
- Phase 4I was not started.

The earlier Phase 4H G2 report is kept unchanged in content as `phase4h-g2-remediation-report.md`.

## Verdicts

| Item | Result |
|---|---|
| A. Entry-fill completeness (REQUIRED) | **PASS (draft 0052).** The database derives every fill, partial fill, remainder and cancellation. A claimed refusal is accepted only if the database itself refuses that fill, with the same code |
| B. Stopped account with exposure (EXIT ONLY) | **PASS (draft 0052 + worker).** Exits, funding and time limits continue. Entries and increases are refused. Remainders are cancelled. The halt is preserved. A flat stopped account is refused |
| C. Timing and rounding (CONSERVATIVE) | **Documented** in `timing-and-rounding-register.md`. No new tolerance. Every value **NOT APPROVED** |
| 0051 independent review | **PASS** for funding/exit completeness, stop-first, gap-through-stop, ordering, atomicity, replay and rollback. Gaps fixed in 0052: entry fills (R2) and stopped accounts (R5, including its no-gap exemption for stopped accounts) |
| 0049 / 0050 / 0051 unchanged | **PASS.** Byte-identical fingerprints, enforced by tests |
| Configuration audit trail | **Implemented (draft 0052).** A write without a reason is refused |
| Hosted worker security | **BLOCKED.** Stage 2 is drafted (0053) and tested locally, but not verifiable without production actions, and the runtime still holds the service key |
| Fresh export (after 14 Nov 2026 09:19 UTC) and full restore | **BLOCKED.** That time has not arrived yet (report written 13 Nov, about 13:40 UTC). Only a synthetic-archive self-test of the extended verifier was run |
| Ready for a separate migration-application review? | **No.** Blockers are listed in §9 |
| Activation readiness | **Not claimed.** Passing tests do not establish it |

## 1. Implementation changes

**New drafts (unapplied).**
- **`0052_futures_paper_entry_completeness_and_exit_only.sql`** and its rollback.
  - Replaces `futures_paper_commit_bar_v3` with 0049's body changed in exactly two pinned places:
    - a stopped account may commit while it has a position or pending entry;
    - a "fill refused [CODE]" cancellation is verified by `fp5_verify_fill_refusal`.
  - Adds `futures_paper_commit_bar_v5`, which wraps 0051's v4: no-gap rule for every status, then per-entry derivation and the evidence table `futures_paper_entry_checks`.
  - Adds `fp5_required_fill_qty`.
  - Replaces the gateway `fpw_commit` with 0051's body calling v5.
  - Adds the configuration audit `futures_paper_config_changes` and `fp5_audit_config` triggers on budgets, cost assumptions and accounts.
  - Adds a rollback-order guard view.
- **`0053_futures_paper_worker_identity.sql`** and its rollback.
  - Identity registry (admin only) and owner enrollments.
  - Six `fpw_id_*` wrappers for signed-in users, plus `fpw_id_authorize`.
  - Audit rows.
  - The 0050 gateway is revoked from `service_role`.
  - A guard view.

**Code.**
- `src/lib/futures-paper-worker.ts` (decision B): a stopped account with a position or pending entry is processed exit-only, with no intents requested. A flat stopped account is left alone. This is the only behaviour change; the Phase 4G pin was re-pinned with a note.
- New `src/lib/futures-paper-worker-identity.ts` (pure name mapping) and `futures-paper-worker-identity.server.ts` (disabled signed-in binding, publishable key only). Nothing imports either.
- The engine (`futures-paper-engine.ts`, `-engine-v3.ts`) is **unchanged**; it already cancelled pending entries on non-active or halted accounts and kept exits running.

**Tooling.**
- `scripts/db-export/verify-local-restore-0052.sh` covers the full chain 0049 → 0053, with apply, guards and out-of-order rollbacks.
- `scripts/futures-paper/concurrency-check-4h-final.sh`.

**Tests.**
- New:
  - `migration-0052-entry-completeness.test.ts` (29)
  - `migration-0053-worker-identity.test.ts` (5)
  - `phase4h-final-isolation.test.ts` (5)
  - `futures-paper-0052.pg.test.ts` (5, real PostgreSQL)
- `FP_WITH_0052=1` re-runs the 0051 suite, the replays and (with `FP_WITH_0051=1`) the gateway/hosted suites through 0052.
- Three earlier isolation tests were given narrow allowances for the new files.

## 2. Fingerprints (SHA-256)

| File | SHA-256 | Bytes |
|---|---|---|
| `0049_futures_paper_ledger_v3.sql` (unchanged) | `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` | — |
| `0049_….rollback.sql` (unchanged) | `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb` | — |
| `0050_futures_paper_worker_gateway.sql` (unchanged) | `40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa` | — |
| `0050_….rollback.sql` (unchanged) | `93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b` | — |
| `0051_futures_paper_event_completeness.sql` (unchanged) | `58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788` | 32,233 |
| `0051_….rollback.sql` (unchanged) | `41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf` | 5,782 |
| **`0052_futures_paper_entry_completeness_and_exit_only.sql`** | `e6ed1a01ca93e71cbf680edde7000be724621e0f81a1aae96aaf3886b4ef40d9` | 64,301 |
| **`0052_….rollback.sql`** | `562128f7033b21238af5fe54e78fbde0d7bea4438cfaa8a5e1b892f938ad84d3` | 31,213 |
| **`0053_futures_paper_worker_identity.sql`** | `d436091177e43ab5bab3522fad29e633561966e9c6b6b1a370b3553f1d48d2bf` | 14,055 |
| **`0053_….rollback.sql`** | `11fec84bcca216a11ae581b1e36d2268742981c8a23e726356328cb0b41923d2` | 1,478 |

**Apply order:** 0049 → 0050 → 0051 → 0052 → 0053.
**Rollback order:** 0053 → 0052 → 0051 → 0050 → 0049.

Each out-of-order rollback fails as a whole (guard views / dependencies). The 0052 rollback restores 0049's v3 and 0051's gateway byte-for-byte; this was checked with `pg_get_functiondef` and the ACL.

## 3. Entry-fill completeness (decision A)

For every pending entry open at the candle open, the database derives the outcome from its own approval row and the recorded candle. The rules, in order:
1. **Expired** (open > `expires_t`): cancel the whole remainder at the open, reason `[APPROVAL_EXPIRED]`.
2. **Halted:** cancel at the open, reason `[ACCOUNT_HALTED]`.
3. **Paused or stopped:** cancel at the open, reason `[ACCOUNT_NOT_ACTIVE]`.
4. **Otherwise:** the required quantity q is the whole remainder, or the volume cap rounded down to the lot (ambiguous within 1e-9 lot → refused).
   - A q > 0 must be filled exactly once at the open. 0049 recomputes price, fee and margin.
   - The only exception is a `fill refused [CODE]` cancellation. It passes only if a **rolled-back trial of that very fill**, inside the same transaction and with 0049's own checks, is refused with the same CODE.
5. **After the fill:**
   - nothing left → filled, nothing may be cancelled;
   - `W ≥ entryTtlBars` → the rest is cancelled at the open;
   - the position closed in this candle → the rest is cancelled at the close;
   - otherwise the approval stays open and any cancellation is refused.

The following are refused:
- duplicate fills: same time (0049's unique fill id) or a second fill in the candle (0052);
- missing, excessive, contradictory or unexplained fills and cancellations;
- mislabelled reasons.

Replays return the committed sequence without writing.

## 4. Stopped account with open positions (decision B)

- **Database.** A stopped account with exposure commits only these events:
  - cancellation of the pending remainder;
  - funding;
  - stop, target and liquidation exits;
  - time exits.

  Every other rule still applies:
  - 0051's completeness rules apply, including the no-gap rule, now enforced for stopped accounts too;
  - entries and fills are refused (0049: not active or halted);
  - a close must equal the open quantity and side, so nothing reverses or grows;
  - missing data refuses the candle.

  The commit never changes status or halt. A stopped account stays stopped for ever (0049 trigger), and a halt is lifted only by an explicit, audited manual change. Once flat, a stopped account's commits are refused again (`futures paper account is stopped`).
- **Worker.** Same policy: exit-only processing, no intents.
- **Engine.** Same policy (unchanged).
- **Verified by:**
  - PGlite B tests (10);
  - a worker test (exit-only, no intents asked, lost reply resent identically, then `ACCOUNT_STOPPED`);
  - real-PostgreSQL races:
    - six concurrent identical stop-outs → one commit;
    - a stop request racing a filling commit → either the fill commits before the stop, or the fill is refused; never a fill after the stop;
    - a killed backend → nothing written.

## 5. Timing and rounding register (decision C)

See `timing-and-rounding-register.md` (T1–T11). It gives each value's units, boundaries, inclusive/exclusive comparisons, time source and failure behaviour. Six pre-existing tolerances that had not been documented are now listed; none was changed. Every value remains **NOT APPROVED**.

## 6. Test evidence

| Run | Result |
|---|---|
| `migration-0052-entry-completeness.test.ts` (PGlite) | **29/29.** Covers:<br>• missing implied fill<br>• wrong partial quantity (too little and too much)<br>• fill beyond the remainder<br>• duplicate fills (both kinds)<br>• replay and conflicting payload<br>• early time-limit cancel and the correct one<br>• early / mislabelled expiry and the correct one<br>• cancel at the close<br>• a refusal the database would not make<br>• a database-verified refusal and a wrong code<br>• ambiguous lot boundary<br>• stopped: commit, required stop exit, flat refusal, no un-stop, no new entry, pending cancelled / fill refused / wrong reason, exit qty×2 and wrong side refused, skipped candle refused, time exit required, missing candle refused<br>• halted: funding required and halt preserved, pending cancelled `[ACCOUNT_HALTED]`<br>• audit trail (5)<br>• privileges<br>• rollback and order<br>• worker exit-only and crash recovery |
| Mutation check (each check disabled, file restored, hash re-verified) | Seven mutations, each caught by at least one failing test: required fill, refusal trial, stopped exit-only (reverted to 0049 behaviour), cancel at close, reason-code equality, one fill per candle, gate reason. **Every mutation caught.** An initially ineffective close-cancel mutation was sharpened until it was caught |
| 0051 suite through 0052 (`FP_WITH_0052=1`) | **24/24.** Covers stop / target / max-hold omissions, missing / duplicate / off-grid funding, stop+target, gap through the stop, ambiguous touch, skipped candles, frozen terms |
| Replays through 0052 (`docs/phase-4h/replay-0052-*.json`) | **0 database refusals; 0 exit-reason mismatches.**<br>• Synthetic 1 m (2,400 commits): entries filled 220, partial 103, expired 22, cancelled at close 15, database-verified refusal 2<br>• Synthetic 5 m (1,200 commits): filled 78, partial 42, expired 42, cancelled at close 7, refused 1<br>• Historical Binance 5 m (864 commits): filled 27 |
| Gateway + hosted PGlite suites through 0051 + 0052 | 35/36. The one failure is 0050's own rollback, blocked by the rollback-order guard as designed |
| `migration-0053-worker-identity.test.ts` | **5/5.** Admin-only registry, plain-user rule, owner-only enrollment, non-enrolled / revoked / disabled refused, full hosted tick (6 commits) as the signed-in identity through v5, service role locked out, rollback order |
| `phase4h-final-isolation.test.ts` | **5/5.** Pins, two-hunk body diff, no app/route/schedule references, identity binding without the service key |
| Real PostgreSQL 17.11, `concurrency-check-4h-final.sh` (throwaway, local) | **43/43 on three consecutive runs:** 0052 5/5, plus 0051 4/4, plus 34 earlier suites |
| Full suite `bunx vitest run` | **1,256 passed, 0 failed, 62 skipped** (114 files) |

**Skipped tests (62).**
- 43 ran separately on real PostgreSQL, as above.
- **19 were not run** this phase: drafts 0043 (10), 0044 (7) and 0045 (2).

**Not exercised.**
- The earlier real-PostgreSQL suites (including the Phase 4G hosted suite) ran in their own setups. Only `futures-paper-0052.pg.test.ts` exercises 0052 on real PostgreSQL.
- A worker crash inside a real-PostgreSQL commit was covered by the backend-kill test, not by a worker-process kill.

## 7. Worker security verdict

**BLOCKED.** Details are in `hosted-service-role-review.md` §4.
- The authorization model exists on the hosted database. This was checked read-only: `auth.uid()`, `has_role`, `account_mfa_allowed`.
- 0053 implements it as a draft and is tested locally.
- It cannot be verified without owner-approved production actions: creating a worker user, storing a secret, applying 0049–0053.
- The runtime would still hold the service key, so code allowlisting is **not** least privilege.

## 8. Configuration audit trail

**Implemented in 0052 (draft).**
- **What is recorded.** One append-only, hash-chained record per change of account budget (including the Research/Scalping sub-budgets), strategy budget, cost assumption/override, account creation (frozen policy config + `config_sha256`) and account status/halt.
- **Record fields.** Old value, new value, actor role, `auth.uid()`, label (e.g. `worker`), reason, timestamp, per-entity version and SHA-256 chain.
- **Rules.**
  - Writes without a reason are refused.
  - No-op updates are not recorded.
  - Records are owner-read only and immutable.
  - Concurrent writers get gap-free versions with an unbroken chain (8-session real-PostgreSQL test).
- **What it does not do.** No existing value was changed. The audit approves nothing.

## 9. Fresh backup and restore

**BLOCKED.**
- The required export must postdate 14 Nov 2026 09:19 UTC, which is still in the future. No fresh export exists and none is claimed.
- The 13 Nov exports were not used as a substitute.
- The verifier now covers 0049 → 0053 and passed every chain step on a synthetic archive (`restore-chain-synthetic-selftest.md`). That is a tooling self-test only; it is not restore or migration evidence.

## 10. Blockers and unapproved decisions

1. **Fresh export** after 14 Nov 09:19 UTC, then `verify-local-restore-0052.sh` on it.
2. **Owner review** of 0052 and 0053, including the two-hunk replacement of 0049's commit function.
3. **Every timing and rounding value T1–T11 (NOT APPROVED).** This includes:
   - the 8 h grid and 1 s lateness;
   - the 1e-9 bands;
   - the 100,000-candle hold ceiling;
   - entry time limit and volume cap;
   - 5 s price age, 60 s expiry, 5 s proposal skew;
   - 2 s close grace, 120 s / 900 s fetch age;
   - the 8 s RPC deadline and 120 s lease.
4. **Hosted worker security (BLOCKED):**
   - apply and verify stage 2 (worker user + secret);
   - decide on stage 3 (a deployment without the service key).
5. **Earlier open items:**
   - policy values, budgets and retention;
   - final migration numbering;
   - separate approvals for enabling the hosted connection and for any schedule.
6. **Residual limits.**
   - Recorded prices are worker-supplied public data (G12).
   - A strict reason-code match may pause an account when engine and database fail different checks first (conservative by design; not observed in the replays).

**Not ready for a separate migration-application review** until items 1, 2 and 4 are resolved.
