# Futures paper activation readiness — review only

> **Update after this review (Phase 4B, applied in code):** two engine defects found here were fixed in
> `src/lib/futures-paper-engine.ts` with regression tests in `src/test/futures-paper-hardening.test.ts`:
> (1) emergency paper stop now cancels an unfilled pending entry instead of filling it (exits still run);
> (2) the pure engine keeps a per-symbol candle cursor and refuses duplicate or out-of-order candles, so funding cannot be
> charged twice. The draft 0045 SQL was **not** edited (it stays byte-for-byte; hashes below). Its FAIL items
> (null-sequence/wallet validation, no commit-time budget recheck) remain open and need a reviewed successor draft.
> The per-symbol cursor lives inside the state JSON; 0045's single account cursor still requires one payload per
> candle containing both symbols. Pending fills still do not re-check daily loss / budget / exposure (open item).


**Export: BLOCKED. Restore: BLOCKED. Activation: NOT APPROVED.** No owner approval or fresh export supplied. The reviewer changed no files; the proposed tests were later added to the project with the two defect checks inverted into regressions. No database outside disposable tests was accessed, no exchange/AI call made, and no worker scheduled. Historical replay was inspected, not run.

## 1. Migration 0045 review

References below use `docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql` (SQL), `src/test/futures-paper-ledger-migration.test.ts` (M), `src/test/futures-paper-ledger-concurrency.pg.test.ts` (C), and `src/lib/futures-paper-engine.ts` (E).

| Item | Status | Evidence and limitations |
|---|---|---|
| RLS policies | PASS | SQL:173–178 enables RLS, owner/MFA-aware SELECT only; M:102–116 proves owner reads and browser refusals. MFA denial itself is not tested: fixture always returns true (M:16). |
| Owner isolation | PASS | SQL:156–158 derives event owner from locked account; 176–178 filters reads. M:102,110 tests different owners. Service role intentionally cross-owner. |
| Service privileges / browser writes / EXECUTE | PASS | SQL:170–182 revokes inherited defaults, grants service account/budget writes and commit EXECUTE only; no direct service event INSERT. SECURITY DEFINER pinned public search_path SQL:137–138; relations qualified. M:82,102,110 exercises roles. Public-schema CREATE privileges in actual deployment remain unverified. |
| Append-only ledger | PASS | SQL:80–87 triggers UPDATE/DELETE/TRUNCATE refusal; SQL:170–172 prevents direct event writes; M:82. Superuser/owner DDL is outside this guarantee. |
| Atomic per-candle commit | FAIL | SQL:143–166 locks and commits in one transaction, valid-output path M:54; malformed state bypasses reconciliation (below), so atomicity does not guarantee valid state. |
| Duplicate candle protection | PASS | SQL:146–148 checks sequence/cursor, M:71 and C:62. One account-wide cursor also prevents separately committing BTC and ETH at the same timestamp; worker must aggregate symbols into ONE payload. |
| Closed-candle enforcement | PASS | SQL:147–148 checks alignment and wall time; M:71. Pure engine does not independently enforce closed or monotonic timestamps. |
| Wallet reconciliation | FAIL | SQL:160 uses nullable expressions. Disposable PGlite probe accepted `p_expected_seq=NULL`, payload `{"events":[],"state":{}}`, advancing cursor to 60000 and storing `{}` while wallet remained 1000. M:71 only proves ordinary numeric mismatch rejection. |
| Halted-account entry rejection | PASS | SQL:152 blocks accepted/fill entry events; M:93 and C:81 prove database behavior. At review time E:118–140 still filled pending orders while halted (end-to-end FAIL). **Fixed after review:** halted state cancels the pending remainder; regression test added. |
| Strategy budget enforcement | FAIL | SQL:70–78,122–132 stores/guards budgets, but commit SQL:137–167 never reads/enforces them. M:110 tests permissions, not cap enforcement. E:204–209 and central-risk.ts:99–109 enforce snapshot budget for new proposals only, not pending fills; no authoritative commit recheck. |
| Concurrent workers | PASS | SQL:143,146–148 account lock/CAS; C:62,81 passed on three independent PG17.11 runs (2 tests each). No production worker exists. |
| Crash recovery | BLOCKED | Transaction and refusal tests M:71, C:62 support rollback/replay properties. No actual process-kill/power-loss test or production recovery worker; scratch tests prove deterministic recomputation only. |
| Rollback safety | PASS | rollback SQL:1–10 drops only new objects without CASCADE; M:118 executes it. Destructive to paper history and budgets; not wrapped in BEGIN/COMMIT itself. Real-schema restore/rollback remains BLOCKED. |
| Existing production-table isolation | PASS | SQL creates only three new tables and associated functions/triggers/policies. M:118 regex checks forbidden production/Spot objects and runs rollback; no real-data fingerprint proof supplied. |

SHA-256 (computed directly):

- Migration: `fa907f33269f0b2ef583e161b37b7a79b1f3db084bcb6813a7b25dfbb021cf1b`
- Rollback: `e80f65593d19ecb35d9d22aceae6f2dac9be75853769975fe464b0c3ea7d3892`

No CHECKSUMS/sha256-named manifest found under proposed-migrations; reviewed migration tests read SQL verbatim, not a pinned file hash. Database config SHA is not a migration checksum.

### Tests actually run

- Requested vitest command: engine **12 passed**, migration **8 passed**, total **20 passed**, 2 files, zero failures/skips.
- `bash scripts/futures-paper/concurrency-check.sh`: runs 1, 2, 3 each **2 passed**, zero failures/skips; PostgreSQL 17.11.
- Scratch-only `bunx vitest run --config /tmp/fp-vitest.config.mjs`: **9 passed**, zero failures/skips. Two checks characterize defects (assert existing unsafe behavior), not successful safety regressions.
- Separate PGlite malformed payload probe succeeded in reproducing SQL defect; not counted as a vitest test.

### Engine coverage and readiness gaps

Existing engine tests: :25 risk-selected leverage, isolated margin, costs and target; :41 SHORT stop; :49 stop-first; :54 MARK versus CONTRACT; :61 funding both signs LONG; :77 mark liquidation; :88 partial fills/volume/TTL; :102 daily loss/gap stop; :115 cross-symbol exposure; :128 forbidden sizing and duplicate proposal; :138 index basis/missing mark; :147 determinism/tamper detection.

Nine proposed scratch tests: BTC/ETH × LONG/SHORT funding-sign, isolated-margin and deterministic recovery (4); exhausted budget (1); halted existing exits/new proposal rejection (1); pending-fill halt defect (1); duplicate-candle funding defect (1); wallet tampering (1). Actual ETH fills now exercised. Engine file unchanged. Scratch file uses absolute sandbox import; applying agent should replace it with `@/lib/futures-paper-engine` and place at `src/test/futures-paper-hardening.test.ts`.

**NOT IMPLEMENTED:** ~~pure-engine candle cursor/idempotence~~ (fixed after review: per-symbol cursor refuses duplicate/out-of-order candles; closed-time is still the worker's job); production Futures paper worker, scheduling and durable recovery orchestration; database budget recheck; full semantic/cryptographic tamper detection. Reconciliation checks wallet/quantity/margin/sequence gaps (E:226–247), not all position fields or state.seq against ledger tail. Determinism is not equivalent to crash recovery proof.

Additional risks: E:113–140 never rechecks halted/day/budget/exposure limits before pending fills. E:105–110 processes all funding before exits, even funding later inside a candle where an exit is modeled at open; intrabar ordering is an explicit simulation limitation needing an owner-approved model. E:200–209 falls back to entry price or zero for absent other-symbol marks; worker must require complete fresh marks. MMR first-bracket estimates are assumptions, not broker liquidation certification.

### Exact proposed changes (SQL items NOT applied; engine items 3–4 applied after review as noted at the top)

1. SQL:146 replace `IF a.seq <> p_expected_seq THEN` with `IF a.seq IS DISTINCT FROM p_expected_seq THEN`. Preserve original draft bytes; prepare separately reviewed successor draft.
2. SQL:160–162 replace the IF block with:
```sql
IF jsonb_typeof(p_payload->'wallet') IS DISTINCT FROM 'number'
   OR jsonb_typeof(p_payload->'state') IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_payload->'state'->'wallet') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'wallet and state.wallet must be numeric';
END IF;
IF abs(v_wallet - (p_payload->>'wallet')::numeric) > 0.000001
   OR abs(v_wallet - (p_payload->'state'->>'wallet')::numeric) > 0.000001 THEN
  RAISE EXCEPTION 'wallet does not reconcile with the event ledger';
END IF;
```
Also add separately specified strict state schema, sequence and flat-initialization validation; SQL:101 nullable positions/pending comparisons accept missing keys. Numeric NaN/infinity and null event sequence need explicit rejection tests.
3. E:118 replace `if (pend) {` with `if (pend && !s.halted) {` as a minimal halt-fill guard; exit processing remains outside. Add a safety regression expecting no entry_fill after halt (invert scratch characterization). Define cancellation/resumption policy and all risk rechecks separately before activation.
4. Do not silently add engine candle persistence: version the state schema and specify per-symbol monotonic cursors, duplicates/refusal and DB account batching together. Add failing safety regression for same-candle funding replay before implementing.
5. Commit-time budget enforcement requires a reviewed contract for strategy IDs, loss/reservation accounting, and lock ordering; no speculative SQL patch supplied.

## 2. Fresh export verification checklist — BLOCKED

- [ ] Owner follows exact path: **Lovable Cloud → More → Database → Manage → Settings → Export project data → Export data → Database → Export → Start export**.
- [ ] Provide completed archive, export UTC timestamp, byte size and full SHA-256, with custody/access controls; do not expose row contents in reports.
- [ ] Verify timestamp is AFTER latest actually applied migration and schema version; compare archive migration history with deployment history and latest file in `supabase/migrations`. That directory is absent in this checkout, so latest applied version is NOT independently verified. Proposed filenames are not proof of application.
- [ ] Owner-supplied known export `orbit-trade-copilot_261112.backup`, created **06:52 UTC on 12 Nov 2026**, predates migration 0039 and is **NOT acceptable**. This provenance is supplied context, not archive metadata inspected in this run.
- [ ] Freeze original 0045 hashes above; a successor draft needs new hashes and separate review/approval.

## 3. Practice restore checklist — BLOCKED

- [ ] Use isolated throwaway PostgreSQL only, no production connection, no exchange/AI calls, reports outside repository.
- [ ] Inspect `scripts/db-export/verify-export.sh /path/to/fresh.backup` (usage :3–4). **Do not run unchanged under this review policy**: :43,47 call ambient `psql` for live counts/schema; :15 can access Cloud storage for non-file inputs. Owner must authorize a later workflow or provide a local-only verifier, with all host/database values explicitly pinned to throwaway.
- [ ] Real migration-test interface is `REPORT=/tmp/0045-restore.md bash scripts/db-export/test-migration-on-restore.sh /path/to/fresh.backup docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.rollback.sql [catch-up.sql ...]`.
- [ ] **Do not treat that command as 0045-ready**: despite generic arguments (:5,9), checks :40–60 and later are hard-coded to 0043 AI research objects. Build/review a dedicated 0045 local restore verifier first. `test-0044-on-restore.sh` is likewise Spot-specific, not a Futures substitute.
- [ ] Supply only reviewed catch-ups demonstrably missing from archive, never unapproved drafts. Record restore errors, extensions/roles/schema differences; validate actual auth/MFA helpers and public schema CREATE permissions.
- [ ] Fingerprint all pre-existing public tables, auth count, grants/RLS/functions before migration, after migration and after rollback; run full 0045 assertions, malformed-input regressions and concurrency tests against restored schema. Retain counts/hashes only. Local restore is not proof of Cloud restore readiness.

## 4. Rollback verification checklist

- [ ] Export all Futures paper history/accounts and strategy budgets before any destructive rollback.
- [ ] Check dependency graph, stop only approved paper worker, take final reconciliation/cursors, keep exits and history accessible.
- [ ] In throwaway restore apply rollback with `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <rollback.sql>` using explicitly local connection.
- [ ] Verify all three new tables/functions removed; no existing data/grants/RLS/objects changed; missing budget fails closed. Restore exported paper data in isolated rehearsal if retention/recovery required.
- [ ] Obtain separate owner migration/rollback approval; passing PGlite is insufficient.

## 5. Paper account initialization plan

- [ ] Dedicated owner, simulated balance only, supported BTCUSDT/ETHUSDT, frozen timeframe/config/version and approved modeled costs/MMR.
- [ ] Service role creates flat state with wallet exactly starting balance, seq 0, empty positions/pending; verify DB-calculated config hash and forward-only cursor (SQL:92–105).
- [ ] Set explicit paper strategy budgets, daily/exposure/margin/leverage/position limits; no signal-provided sizing. Every entry calls evaluateProposal (E:204, central-risk.ts:124–149).
- [ ] Never touch Spot paper, demo wallets, production order/position/trade tables, credentials or broker state. Pause until initial state and archive audit pass.

## 6. Paper worker activation plan — NOT IMPLEMENTED / NOT APPROVED

`src/lib/paper.server.ts:4,104,175` uses `stepPaperBar`/`paper_commit_bar`: separate SPOT forward-paper system, not Futures. References to stepFuturesPaper are pure engine, tests and historical replay (`scripts/scalp-eval/futures-paper-replay.ts:1–10`); no production Futures worker found. Concurrency script comment claiming a “real paper worker” refers to test helper orchestration, not a deployed worker.

- [ ] Build credential-free public-data reader with closed, aligned, fresh trade/mark/index/funding candles; require complete multi-symbol marks and handle missing/late/duplicate observations fail-closed.
- [ ] Build one account-wide candle batch including both symbols, deterministic ordering and a single CAS RPC. Separate same-timestamp symbol commits conflict with SQL cursor.
- [ ] Read latest account halt/status, budgets and loss/exposure reservations; enforce pending-fill risk again and preserve exits during halt.
- [ ] Recover from last committed state only; never persist tentative state after refused commit. Re-read account on CAS conflict, discard stale calculation. Test crashes before/during/after commit and empty-event candles.
- [ ] Bound cadence, retries/backoff and processing time; add owner-only stop/pause controls and read-only monitoring. No cron/worker is created here.
- [ ] Scheduling and activation require **separate later owner approval** after fresh export, practice restore and all blocking defects resolved. ACCEPT is not execution authorization.

## 7. Monitoring and reconciliation plan

- [ ] Each commit: ledger sequence continuity, tail equals state.seq, wallet sum, per-symbol qty/margin, nonnegative wallet/free margin, no halted fills, cap/budget compliance, mark/index basis and source age.
- [ ] Daily: independent deterministic replay from checkpoint and immutable events, cost/funding attribution and cash net = gross + funding − fees; compare state fields beyond current reconcile helper.
- [ ] Alert/stop new entries on gaps, stale prices, reconciliation mismatches, repeated refusals, worker lag or unsafe budgets; preserve protective exits and evidence. No fabricated liquidation precision or strategy performance claims.
- [ ] Record approved code/config/migration hashes, data provenance, owner/version, simulated labels and restart/incident audit trail. No credential or private data in reports.

## 8. Owner approval checklist

- [ ] Fresh post-migration export delivered and SHA verified.
- [ ] Latest applied schema version established (not merely inferred from draft filenames).
- [ ] Isolated practice restore and 0045-specific verification accepted.
- [ ] SQL null-validation and budget enforcement defects resolved in separately reviewed draft.
- [ ] Pending-fill emergency stop and pending-fill risk regressions resolved.
- [ ] Multi-symbol batching, duplicate protection, crash recovery and monitoring proven.
- [ ] Rollback/export retention rehearsal accepted.
- [ ] Paper initialization and modeled assumptions explicitly approved.
- [ ] Worker implementation reviewed; separate scheduling authorization recorded.
- [ ] Explicit later owner activation approval recorded. **Currently NOT APPROVED.**

Workspace observation: initial status was clean; later `roadmap.md` and `src/lib/central-risk.ts` appeared modified by an external/concurrent actor. This reviewer did not write either file or revert them. Test results describe the workspace when each run executed, not an immutable revision certification.
