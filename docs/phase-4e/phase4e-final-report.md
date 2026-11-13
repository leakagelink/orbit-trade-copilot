# Orbit Trade Copilot — Phase 4E final report: fresh backup verification and safety hardening
Date: 13 November 2026 (UTC). Scope: the Phase 4E brief only. Verification and design only.

## 1. Summary

| Workstream | Status |
|---|---|
| A. Fresh backup verification (integrity + real-export local restore + 0046 round trip) | **PASS** — with one caveat: the ZIP named in the brief was not attached (A1 below); the same-day export object was verified instead |
| B. Strategy attribution corrections | **PASS** — weaknesses found in 0047; successor **draft 0048** written and tested (not applied) |
| C. Futures Paper Engine accounting review | **PASS** (review) — 10 mismatches documented, 2 rated High; nothing changed |
| D. Paper worker architecture | **PASS** (design only; nothing built, deployed or scheduled) |
| E. Owner decision register | **PASS** — updated; every value NOT APPROVED |
| F. Testing | **PASS** — all executed suites green; not-executed items listed in §6 |
| G. Final report | this file |

## 2. Fresh backup (Workstream A)

| Item | Result |
|---|---|
| A1 Attached archive `bucket-database_export_13_11_26-files.zip` | **BLOCKED — not received.** No ZIP is present in this conversation's uploads. Its identity with the object below cannot be confirmed. |
| Export object actually verified | `database_export_13_11_26/orbit-trade-copilot_261113.backup` in the project's export storage (created 2026-11-13 09:20:40 UTC). A read-only copy was downloaded to a temporary folder (mode 0444) and deleted after verification. The stored original was not modified (size, eTag `a10797fb0a42e8e28ffa8b7fc8e2b242-1` and `updated_at = created_at` unchanged at the end). |
| SHA-256 | `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5` |
| Exact size | 2,525,322 bytes |
| Format | PostgreSQL custom-format dump (magic `PGDMP`), archive version 1.16, zstd compression, 1,256 TOC entries; dumped from PostgreSQL 17.11 by pg_dump 18.6; archive created 2026-11-13 09:19:04 UTC |
| Readability | `pg_restore --list` and a full read-through of every data block (`pg_restore -f /dev/null`): PASS |
| Restore target | A newly created disposable PostgreSQL 17.11 cluster in `/tmp`, private UNIX socket only (`listen_addresses=''`), run as an unprivileged user; ambient `PG*`/`SUPABASE_*` variables unset. Never connected to Lovable Cloud, production or any external database. |

### Verifier review and the defect found on the real export
The Phase 4D verifier (`f4006103…7eca05`) was reviewed and run first, unchanged: **FAIL** — 121 `pg_restore` errors.
Diagnosis (separate disposable restore, same isolation): 91 errors were `role "sandbox_exec" does not exist`; because
each ACL entry is restored as one statement group, **all 60 public-table privilege entries were lost**, so the restored
copy silently had no table grants. The remaining 30 errors were objects of managed extensions that cannot exist in a
plain local server (pg_cron, pg_net, supabase_vault: schemas `cron`, `net`, `vault`).

Revised verifier (`scripts/db-export/verify-local-restore-0046.sh`, `67343158…c54fba`): creates every role the archive
grants to (10 found, incl. `sandbox_exec`); tolerates only managed-extension errors and FAILs on anything else (reporting
only object descriptors, never command text or row data); adds fidelity checks against the archive's own table of
contents; reports draft presence and scheduled-job counts. The synthetic self-test gained a negative case (an
unrestorable grant must FAIL): 5/5.

### Real-export restore result — PASS (report: `restore-0046-real-export.md`)
| Check | Result |
|---|---|
| pg_restore errors | 30, all tolerated managed-extension objects; 0 unexpected |
| Fidelity vs archive | public tables 60/60, views 0/0, functions 45/45, RLS-enabled tables 60/60, policies 125/125, triggers 38/38, PK/unique 83/83, foreign keys 44/44, indexes 38/38, table ACL entries 60/60 restored, row counts equal for all 60 tables (723 rows) |
| Migration history | 40 rows in `drizzle.__drizzle_migrations`; every timestamp and SHA-256 equals `drizzle/migrations` in order; **latest applied: `0039_futures_pass_certification_and_autopilot_fencing`** (created_at 1794466478200) |
| 0039 present | PASS (`futures_certifications`, `futures_live_authorized()`) |
| Drafts 0040–0047 (and 0048) | **all ABSENT** — none applied |
| Scheduled jobs in the archive | 3 (`paper-engine-tick` → existing bot engine `/api/public/engine/tick`, `trade-price-alerts`, `ai-autopilot-tick`); none for the Futures paper engine. Pre-existing; not changed. |
| Migration 0046 on the restored copy | applied in one transaction: PASS; RLS 5/5, owner-read policies, no anon privilege, authenticated SELECT-only, service role cannot write events/positions/commits directly, commit function service-role-only + SECURITY DEFINER + pinned search_path, constraints, fill-once index, triggers, malformed-input probe refused: all PASS |
| Rollback 0046 | one transaction: PASS; nothing left; pre-existing fingerprint (columns, policies, grants, functions, triggers, row counts) identical before, after migration and after rollback |

This is a practice restore in a local disposable server, **not** a Lovable Cloud restore and not proof of production
readiness.

## 3. Strategy attribution (Workstream B) — draft 0048, NOT APPLIED
Details: `attribution-corrections-review.md`. 0047 weaknesses: undefined correction effect (replacement vs delta;
quantities not correctable), raw-row reduction check ignoring corrections, unlimited repeated corrections, reductions
carrying an ambiguous amount, no effective-totals model, corrections carrying their own lineage. 0048 (supersedes 0047,
same object names — never apply both): replacement semantics per original event, linear revision chain 1…20 with
compare-and-set, no-op/stale/fork/self/cross-order/correction-of-correction refusals, effective-total invariant on every
reduction and correction, `futures_strategy_attribution_effective` and `_totals` security-invoker views. Legacy trades
stay UNATTRIBUTED; no inference; no change to orders/positions/trades. On the restored real export: 0048 applied and
rolled back cleanly, all 7 existing USD-M Futures trades UNATTRIBUTED, the oldest existing Futures order refused an
identity (rolled-back probe), browser-role write refused, coexistence 0046 → 0048 → rollbacks clean
(`restore-0048-real-export.md`).

## 4. Paper engine accounting (Workstream C)
Details: `paper-engine-accounting-review.md`. Engine, payload builder and 0046 unchanged. High: **C6** 0046 trusts the
worker's `risk_amount` (a fill understated as 0 passes a budget the true risk exceeds — characterized) and **C7** a fill
needs no prior accepted order (characterized). Medium: C1 acceptance ignores reserved risk (characterized), C3
missing-mark fallbacks in the single-symbol path, C5 two budget sources, C9 symbol-order dependence. Low: C2, C4, C8
(UTC day of the candle open), C10.

## 5. Paper worker (Workstream D)
Design only: `paper-worker-design.md` (cursor, lease + compare-and-set, idempotent payload replay, duplicate/out-of-order
refusal, crash recovery, bounded retries, database/data failure handling, monitoring, resource estimate).

## 6. Test results (run separately; types distinguished)

| Suite | Type | Result |
|---|---|---|
| Fresh backup integrity (SHA-256, size, format, TOC, full read-through) | Real archive, local tools | PASS |
| Real-export local restore + 0046 apply/rollback (revised verifier) | **Real PostgreSQL 17.11, real export** | PASS (0 FAIL rows) |
| Real-export local restore with the unchanged Phase 4D verifier | Real PostgreSQL, real export | FAIL (defect above; fixed) |
| Real-export local restore + 0048 apply/rollback + 0046 coexistence | **Real PostgreSQL, real export** | PASS |
| Verifier self-test | Synthetic archives, real PostgreSQL | 5/5 PASS (synthetic — not a real-export result) |
| Verifier refusal/source tests (0046 + 0048 scripts) | Unit (spawned script, no database) | 18/18 PASS |
| Migration 0046 + rollback | PGlite (`futures-paper-ledger-v2-migration`) | 15/15 PASS |
| Migration 0047 (unchanged draft) | PGlite | 13/13 PASS (in full suite) |
| Migration 0047 | Real PostgreSQL, separate sessions (Phase 4D b/c) | 2/2 PASS ×3 runs |
| Migration 0048 | PGlite | 13/13 PASS |
| Migration 0048 concurrency (corrections vs reductions, revision races, both orders) | **Real PostgreSQL, separate sessions** | 7/7 PASS ×3 runs |
| `concurrency-check-4e.sh` total (0048 + Phase 4D + 0046 suites) | Real PostgreSQL | 13/13 PASS ×3 runs |
| Other multi-session suites: 0045 Futures paper, Spot paper 0044, research budget 0043 | Real PostgreSQL | 2/2, 7/7, 10/10 PASS (1 run each) |
| Paper-engine regression (engine, hardening, fill re-validation, 0045/0046 ledgers) | Pure + PGlite | 63/63 PASS |
| Accounting characterization (C1, C6, C7) | Pure + PGlite, synthetic candles | 3/3 PASS (pins current behaviour) |
| Phase 4E change control (174 protected files, draft hashes, journal) | Unit | 4/4 PASS |
| Full regression (vitest) | Mixed: pure, PGlite, existing mocked suites | **971 passed, 32 skipped, 0 failed** (82 files passed, 6 skipped). The 32 skipped are exactly the six real-PostgreSQL suites, executed separately above |
| Typecheck (`tsgo -b --noEmit`) | — | PASS (no errors) |
| Production build | harness build log | PASS ("build OK", 2026-11-13 09:48:40Z) |

Mocked tests: no new mocked tests; pre-existing mocked suites ran inside the full regression and are **not** database
verification. **Not executed:** Lovable Cloud restore; restoring the original 0047 on the real export (superseded by
0048); drafts 0040–0045 on the real export; any real/Testnet order; any worker run; any AI call.

## 7. Files changed since Phase 4D (`d977dde`) and SHA-256
Part of this work was saved by the platform's automatic checkpoint `38cafbe`; it is kept.

| Status | File | SHA-256 |
|---|---|---|
| M | `AGENTS.md` (two rules updated) | `b53cd44c…fa6d0c`* |
| M | `docs/phase-4d/owner-decision-register.md` (superseded note only) | `5314aee0b3275bcbf2e7916d8026aec15d3ca964603950e996d35ded11fa6d0c` |
| A | `docs/phase-4e/attribution-corrections-review.md` | `ac29903544aa9ed61531543d7b88002dd2df8ac99dc6540520a2a73bff419ccd` |
| A | `docs/phase-4e/owner-decision-register.md` | `cdecb4a9ae3333287d97b5caa7a6f1c4e38092a93f738a41d140cbb220ed7b1c` |
| A | `docs/phase-4e/paper-engine-accounting-review.md` | `a8946378a5c9ef350cecfa5dc4ceb17ddde552f2ea077634b3adba3cd9bfc3f8` |
| A | `docs/phase-4e/paper-worker-design.md` | `cd3df35e7769b07502f18bad0979c0e22996dbac0cebd9a27b790c42e9172558` |
| A | `docs/phase-4e/protected-files-at-start.sha256` | `b437e7a78b1e4a3baa080dd925a7069e871fc55c2c1da79b2b792f870b1bf969` |
| A | `docs/phase-4e/restore-0046-real-export.md` | `174aefb29d9e13127069dbd906423b196eb2e4a0c609c00c0e95994a96f2de73` |
| A | `docs/phase-4e/restore-0048-real-export.md` | `e21a1fb9246989d040b1c2528b218078f272cfea39c8b8b9e16081f67017f4fd` |
| A | `docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql` (DRAFT) | `93305df74b2636e47f0464b9d57fd14d455ba15604d9b619c872fe61e0ba60bb` |
| A | `docs/proposed-migrations/0048_futures_strategy_attribution_v2.rollback.sql` (DRAFT) | `9930d14841197737a46b57ac845d08fc6ace840170693226e6586aac6fea504f` |
| M | `scripts/db-export/verify-local-restore-0046.sh` | `673431580f250fa54973ff79e5f609c2aace4422a2ee3e89361ee81a70c54fba` (was `f4006103…7eca05`) |
| M | `scripts/db-export/test-verify-local-restore-0046.sh` | `8799dde4aefb46a0318413cf87a59593ff982aa17c4d53615ecc6c61f20625d6` |
| A | `scripts/db-export/verify-local-restore-0048.sh` | `62477ae4d3fb352b1d85ff809bfcb176202d73331f9609bd40dca044402ebf2c` |
| A | `scripts/futures-paper/concurrency-check-4e.sh` | `8ebe1e8588f118f815333f693fd978b718dc8920ba62cc2d3c27e42def2f5505` |
| A | `src/test/phase4e-accounting-characterization.test.ts` | `3cd4ef3a22ca4a2de5ea26dee589cf76cc28128f7a900e20a792082ccc0b5892` |
| A | `src/test/phase4e-attribution-concurrency.pg.test.ts` | `74bef26d90f24d01b457a5f39fdf518637436c73d41c5c5e82e693eda662299a` |
| A | `src/test/phase4e-isolation.test.ts` | `387bf109c52df64759cdc69b21df8569e1501ac725bfa2ac9a6081f303d5ea4d` |
| A | `src/test/strategy-attribution-0048-migration.test.ts` | `4345e704789ac82058a283369724c59aaf42923b12955624741c1b91664ff574` |
| M | `src/test/verify-local-restore-0046.test.ts` | `6adeadf3adfc934abe4d7f648ab2f9eb0662ae01910f449cd95d9004dde9d7e9` |
| A | `docs/phase-4e/phase4e-final-report.md` | this file (hash not self-contained); `roadmap.md` updated |

\* `AGENTS.md` full hash `b53cd44ca91646375a8f749d95e6d285bb331e76ab155317899375db30aeafe5`.

Unchanged and verified: `src/lib/futures-paper-engine.ts` `588d782d…a263c3a9`, `central-risk-shadow.ts`
`76f27f3e…cf`, `central-risk-shadow.server.ts` `dda46802…037`, 0046 `eac47d85…4b623e` / rollback `dd8b96ba…999453`,
0047 `42d3c65e…249801b` / rollback `bb980bbc…755ae8`; all 174 protected files identical to the Phase 4E start manifest.
No application source under `src/lib` or `src/routes` changed.

## 8. Remaining blockers
1. The ZIP named in the brief was not received; if it differs from the verified export object, it is unverified.
2. Owner approval of 0046 — recommended only after a successor fixes C6 and C7 (database recomputes reserved risk; fills
   require an accepted order).
3. Owner approval of 0048 (and never 0047), then separately the order-path change that captures identity.
4. Policy values, budget semantics, retention (decision register) — all NOT APPROVED.
5. Lovable Cloud restore readiness is not established by a local practice restore.

## 9. Owner decisions required
See `owner-decision-register.md`: four policy values; budget definition, acceptance alignment, scope, single budget
source, daily-loss day; retention and archival; 0046 vs successor; 0048; candle ordering (C9) and missing-mark refusal
(C3); worker implementation and, separately, activation.

## 10. Recommended next phase (proposal only)
Phase 4F, still draft-only: a 0046 successor that stores stop distance and accepted quantity, recomputes `risk_amount`
and requires an accepted order before any fill (C6, C7), with acceptance-time budget alignment (C1) and a single budget
source (C5) if the owner approves those semantics; real-export restore verification of that successor with the revised
verifier; worker code behind a disabled flag with the crash/lease tests of the design — no schedule, no activation.

## 11. Confirmation
No migration was applied anywhere (0046 and 0048 ran only in disposable local servers that were deleted). No production
database, settings, credentials or risk limits were changed; the stored export was only read. No real or Testnet orders
were placed. The Futures Paper Engine was not activated; no worker was started, deployed or scheduled. No AI provider
was reconnected or called. No paid infrastructure was purchased. Central Risk Shadow remains disconnected from execution.
Autopilot and Live Futures were not touched.

---

# Phase 4E follow-up — owner decisions of 13 Nov 2026 (code, documentation and isolated validation only)

## F1. Summary

| # | Owner instruction | Status |
|---|---|---|
| 1 | Do not approve/apply 0046; replacement fixing both high-risk issues | **PASS (draft)** — 0046 untouched and NOT APPROVED; replacement **draft 0049** written, tested on PGlite, real PostgreSQL and the real export; NOT APPLIED |
| 2 | 0048 to review/validation stage; 0047 permanently superseded; do not apply 0048 | **PASS** — 0048 byte-identical, re-verified on the real export (40 PASS, 0 FAIL), not applied; register updated |
| 3 | Decision register: 5% / 5 s / 60 s / 0.13% configurable, NOT APPROVED for execution | **PASS** — `owner-decision-register.md` §1 |
| 4 | Account budget with Research and Scalping sub-budgets; open + pending in shared checks; no additive overflow | **PASS (code + draft)** — `src/lib/account-risk-budget.ts` and 0049; not connected to any order path |
| 5 | Configurable retention: 2 years / 90 days / 30 days; deletion, anonymization, audit rules | **PASS (proposal + contract)** — `retention-and-deletion-policy.md`, `src/lib/retention-policy.ts`; nothing enforced |
| 6 | Backup SHA-256 discrepancy; authoritative identity | **PASS** — two different exports, both intact; 13 Nov `448bb1c2…` is authoritative (`backup-identity.md`) |
| 7 | Full suite, restore, up/down, RLS, concurrency, build | **PASS** — §F6 |
| 8 | Update this report; next-phase report | **PASS** — this section; `docs/phase-4f/phase4f-next-phase-report.md` |

## F2. Draft 0049 — how both high-risk issues are fixed

**C6 — never trust worker risk figures.** A payload containing `risk_amount` or `fill_id` is refused outright. The
commit stores the public candle it was computed from (`futures_paper_candles`, append-only) and recomputes from database
data only: approval risk = qty × (|mark close − stop| + mark close × cost), fill risk = qty × stop distance + qty × fill
price × cost (cost frozen on the approval), fee = price × qty × taker fee, margin = price × qty / approved leverage,
funding cash from the recorded funding rate and mark open, exit P&L from the database's own average entry, liquidation
price and loss from the database position (and the recorded mark must actually reach it). Any difference is refused.

**C7 — no fill without a valid matching approval.** `order_accepted` creates a `futures_paper_risk_approvals` row only
after the database re-runs: budget rows exist, proposal never evaluated before (unique per owner across accounts), no
position or pending entry on the symbol, approval at the candle close, price age ≤ max, proposal age ≤ max, index basis,
stop side, integer leverage within max, lot-size multiple above minimum notional, per-trade risk and margin maxima,
liquidation buffer, daily loss, then strategy/sub-budget/account budgets, open + pending exposure, position count and
free margin. Every `entry_fill` must match an OPEN approval of the same account, proposal, strategy, symbol and side,
approved in an earlier candle, not expired (approval time + max proposal age), with Σ fills ≤ approved quantity and the
fill price equal to the taker price of the recorded candle open. Cancelled/filled approvals cannot fill again. The
submitted state's pending entries must equal the open approvals exactly (identity, quantities, leverage, stop distance).

**Transactional, idempotent, concurrency-safe.** One call per candle; any failure rolls back the whole candle (candles,
approvals, events, positions). Lock order: account → owner's account budget row → strategy budget rows (sorted) →
approval rows, so two accounts of one owner serialize on the budget row. Identical retries return the original result
without writing; fill ids are derived by the database and unique. Same object names as 0045/0046 — it fails if either
exists (tested). Approvals, candles, events, positions and commits are read-only for every API role; configuration tables
are writable only by service_role; all reads are owner-only and MFA-aware.

Residual (documented, not hidden): candle prices are still public market data observed by the worker; the database
checks them for internal consistency and every derived figure against them, but has no independent price source.

## F3. Account budget (owner decision 4)
`account_risk_budgets` (account total, Research and Scalping sub-budgets; CHECK research + scalping ≤ total) and
`strategy_risk_budgets.engine` (frozen sub-budget membership; Σ strategy budgets ≤ sub-budget, serialized on the account
row). Usage = closed losses + open reserved risk + pending approval risk, checked at strategy, sub-budget and account level
on every approval and fill. The pure module computes the same numbers (database/TypeScript agreement test) and exposes
`riskEngineStrategyBudget` (tightest room as the Risk Engine's `{budget, usedLoss}`) for a later, separately approved
engine alignment.

## F4. Backup identity
See `backup-identity.md`. 12 Nov `7af87665…` (pre-0039) and 13 Nov `448bb1c2…` are two different exports; both still
match their recorded hashes and the storage eTags. A ZIP container's checksum never equals the backup inside (shown).
Authoritative: 13 Nov backup, preserved in `authoritative-backup.sha256` / `.json`, pinned by a test.

## F5. Engine and worker alignment still required (not done — behaviour changes)
E1 expiry-driven cancellation, E2 budgets from the database at acceptance (C1/C5), E3 classification of approval
refusals, E4 per-instrument cost at acceptance — `owner-decision-register.md` §5. Until then 0049 refuses safely and the
existing planner halts for review on approval-time refusals.

## F6. Test results (run separately; types distinguished)

| Suite | Type | Result |
|---|---|---|
| Draft 0049 + rollback (21 tests: recomputation, approval/fill rules, expiry, state, budgets, costs, funding/exit/liquidation, idempotency, privileges/RLS, refusal on top of 0046, database/TS agreement) | PGlite, real engine output | 21/21 PASS |
| Draft 0049 concurrency (racing workers, joint budget race, fill vs cancellation, configuration race, crash before COMMIT) | **Real PostgreSQL 17.11, separate sessions** | 5/5 PASS ×3 |
| `concurrency-check-4f.sh` total (0049 + 0048 + Phase 4D + 0046) | Real PostgreSQL | 18/18 PASS ×3 |
| Other multi-session suites: 0045, Spot paper 0044, research budget 0043 | Real PostgreSQL | 2/2, 7/7, 10/10 PASS (0043 run on port 55443: port 55433 is occupied in this sandbox) |
| Real-export restore + 0049 up/down, RLS/grants/EXECUTE, rolled-back probes, 0048 coexistence, refusal on top of 0046 | **Real PostgreSQL, real 13 Nov export** | PASS — 44 PASS, 0 FAIL (`restore-0049-real-export.md`) |
| Real-export restore + 0048 up/down + 0046 coexistence (re-run) | Real PostgreSQL, real export | PASS — 40 PASS, 0 FAIL (`restore-0048-real-export-rerun.md`) |
| Account budget module | Pure | 11/11 PASS |
| Retention policy contract | Pure | 10/10 PASS |
| Phase 4F change control + isolation + backup identity | Unit (+ spawned script) | 7/7 PASS |
| Full regression (vitest) | Mixed: pure, PGlite, pre-existing mocked suites | **1020 passed, 37 skipped, 0 failed** (86 files passed, 7 skipped — the 37 skipped are exactly the seven real-PostgreSQL suites, run separately above) |
| Typecheck (`tsgo -b --noEmit`) | — | PASS |
| Production build | harness build log | PASS ("build OK", 2026-11-13 10:26:35Z) |

Not executed: Lovable Cloud restore; any real/Testnet order; any worker run or schedule; any AI call; restore of 0049 on
top of other drafts 0040–0045.

## F7. Files changed in the follow-up (SHA-256)

| Status | File | SHA-256 |
|---|---|---|
| A | `docs/proposed-migrations/0049_futures_paper_ledger_v3.sql` (DRAFT) | `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` |
| A | `docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql` (DRAFT) | `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb` |
| A | `src/lib/futures-paper-ledger-v3.ts` (unused payload builder) | `65be37d3a01a4cfbac5b5a9ef69676e06a1d5aa1d8135934b9b23315c3b18dbd` |
| A | `src/lib/account-risk-budget.ts` (unused pure module) | `59375a134ba71905beafd6e0c753a899baaf2461ebc88befbe2b35f85005dbac` |
| A | `src/lib/retention-policy.ts` (unused pure module) | `df8738f04a2ae1ed591382131605b8ee18296847149e0a9a2cca3b5611652825` |
| A | `scripts/db-export/verify-local-restore-0049.sh` | `593f6f61d68ee01d0738d15118f2df6ca1a162e6ec62d1f8b8f88cc7f3e14b0f` |
| A | `scripts/db-export/check-backup-identity.sh` | `14b5a68877841722225f551ed912e4f749ecb3a363a9eb0860b1cf1f7a296742` |
| A | `scripts/futures-paper/concurrency-check-4f.sh` | `1e66990873485017c6be6d20c90dbca8f48bc2b2818aa7a6b95d20a755907ea5` |
| A | tests: `futures-paper-ledger-v3-migration`, `futures-paper-ledger-v3-concurrency.pg`, `account-risk-budget`, `retention-policy`, `phase4f-isolation` | see git |
| A | docs: `backup-identity.md`, `authoritative-backup.sha256`, `authoritative-backup.json`, `retention-and-deletion-policy.md`, `restore-0049-real-export.md`, `restore-0048-real-export-rerun.md`, `docs/phase-4f/phase4f-next-phase-report.md` | see git |
| M | `docs/phase-4e/owner-decision-register.md`, this report, `src/lib/AGENTS.md` (one rule updated, one added), `roadmap.md` | — |

Unchanged and verified: drafts 0045, 0046 (+rollback), 0047, 0048 (+rollback) byte-identical; `futures-paper-engine.ts`,
`central-risk.ts`, both Central Risk shadow modules; all 174 Phase 4E protected files; applied journal ends at 0039.

## F8. Confirmation
No migration was applied anywhere except disposable local servers (deleted afterwards). No production database, setting,
credential or risk limit changed; stored exports were only read. No real or Testnet orders. No worker started, deployed
or scheduled; the Futures Paper Engine is inactive. No Autopilot or Live Futures change. No AI provider called. No paid
infrastructure.
