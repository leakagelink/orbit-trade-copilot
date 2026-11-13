# Orbit Trade Copilot — Phase 4D final report
Date: 13 November 2026 (UTC). Scope: the Phase 4D brief only.

## 1. Executive summary
| Workstream | Status |
|---|---|
| A. Fresh export + 0046 restore verification | **BLOCKED** — no fresh export exists |
| B. Futures paper fill-time risk re-validation | **PASS** (code + tests; engine NOT activated) |
| C. Central Risk shadow remediation (4 issues) | **PASS** for issues 1–3; issue 4 **DESIGN ONLY** + pure classifier (not wired) |
| D. Strategy attribution migration | **DRAFT ONLY** (0047, not applied), tested |
| E. Owner decision register | Done — `owner-decision-register.md`; every value **NOT APPROVED** |

The Futures paper engine/database mismatch from Phase 4C is removed in code: the engine now re-checks every pending fill
with draft 0046's definitions and cancels a refused fill with a reason code, so the database can no longer stall an
account. Engineering readiness is not trading authorization.

## 2. Database export status — BLOCKED
Read-only listing of the export bucket (metadata only) found one archive: `orbit-trade-copilot_261112.backup`, created
2026-11-12 06:54:17 UTC, 2,092,954 bytes. It predates migration 0039 and was **not** used. No fake export was created, no
old backup substituted, and the production database was not queried for a replacement.
Required from the owner: Lovable Cloud → More → Database → Manage → Settings → Export project data → Export data →
Database → Export → Start export. Then supply: export time (UTC), archive size, SHA-256, source environment, confirmed
migration history, file-integrity result.

## 3. Migration 0046 restore verification — BLOCKED (real export) / PASS (synthetic only)
Verifier `scripts/db-export/verify-local-restore-0046.sh` (SHA-256 `f40061035a41e1d4b17cab341ada6df17f1de5e8ee496312bb378613307eca05`, unchanged) reviewed:
| Check | Result |
|---|---|
| Own disposable PostgreSQL in a fresh /tmp dir, socket-only (`listen_addresses=''`) | PASS (inspection) |
| Rejects URLs, cloud/bucket paths, connection strings, extra arguments | PASS (inspection + existing tests) |
| Ambient `DATABASE_URL`/`PG*`/`SUPABASE_*`/`LOVABLE_DB_*` cannot redirect it | PASS — every psql/pg_restore call runs under `env -i` bound to the private socket; the explicit unset list is narrower than all `PG*`/`SUPABASE_*` names (defence-in-depth note, not a defect) |
| Never connects to Lovable Cloud or any external database | PASS (inspection) |
| Synthetic self-test (good + 3 negative archives) | PASS 4/4 — **not equivalent to a real export** |
0046 and its rollback are unchanged (`eac47d85…4b623e`, `dd8b96ba…c999453`); no defect was found that requires a successor.

## 4. Futures paper engine fill-time changes (`src/lib/futures-paper-engine.ts`)
Before each pending entry fill, on the ACTUAL fill quantity, in 0046's definitions: account active and not halted;
pending validity; paper environment; identity vs the open position; eligible marks for every held symbol (missing,
invalid, future-dated or stale → refused); daily loss (UTC candle day cash + negative unrealized at the marks);
cumulative strategy budget (closed losses, wins not netted, + reserved open risk + this fill's risk, including the
owner's other paper accounts from the ledger view — unknown usage refuses, never zero); exposure, position count and
free margin after the fill. A refusal never fills: the remainder is cancelled (`entry_cancelled`, reason
`fill refused [CODE]: …`), recorded in `refusals[]`.
New: `stepFuturesPaperCandle` (all symbols of one candle under one account-wide cursor; every input validated before any
symbol is stepped; marks = the candle's own mark opens, returned for the payload) and `planCommitRefusal` (database
message → bounded code; refused fill → deterministic recompute as a cancellation; the same refusal twice or anything
unclassified → halt for review; sequence/cursor/already-committed → reload state; lost response → resend the identical
payload, which 0046 returns idempotently). Spot accounting was not copied.

## 5. Before / after
| Situation | Before (4C) | After (4D) |
|---|---|---|
| Daily loss / budget / exposure / position count breached between acceptance and fill | Engine fills; 0046 refuses; recomputation repeats the same fill → **stall** | Engine refuses and cancels with a code; 0046 accepts the cancellation |
| Free margin short at fill | No fill, pending waits to its time limit (no event) | Refused with `FREE_MARGIN`, cancelled, event recorded (**behaviour change**, documented) |
| Paused account | Pending could be accepted/filled; 0046 refuses → stall | Pending cancelled, new intents rejected (`ACCOUNT_NOT_ACTIVE`) |
| Missing mark for a held symbol | 0046 raises on the whole candle → stall | Fill refused (`MARK_MISSING`); in account-candle mode the candle is refused before anything is applied |
| Cross-account race | Stall | One wins; loser planned + recomputed into a cancellation (real PostgreSQL test) |
| Multi-symbol candle | Caller-assembled; partial snapshot possible | One function, one result, one cursor; invalid second symbol refuses the whole candle |
Accounting mismatches kept and documented (owner decision): acceptance budget excludes reserved risk; acceptance exposure
includes pending remainders while fill-time (0046) counts positions only; acceptance uses mark closes, fills use the
candle's mark opens (the marks 0046 re-checks with).

## 6. Central Risk shadow remediation
| Issue | Result |
|---|---|
| 1 Stale market data | PASS — stale or future-dated mark → INSUFFICIENT_DATA before a proposal is formed; a defensive layer reclassifies any `market_data` fail as missing; invalid tickets and verified limit violations remain REJECT. Existing Phase 4B test updated from REJECT to INSUFFICIENT_DATA (intended). |
| 2 Deep freeze | PASS — normal and last-resort records deeply frozen (nested checks, reads, sizing, comparison, arrays); mutation throws and changes nothing; fallback reads a hostile ticket defensively |
| 3 Redaction | PASS — raw exception text never copied; bounded codes `SHADOW_EVALUATION_FAILED`/`SHADOW_RECORD_BUILD_FAILED`; record text filtered to the engine's own phrases; adversarial synthetic keys, secrets, bearer headers, connection strings, ciphertext, signatures and account-like ids injected through mark, rules, margin, clock, attribution and database errors — none reach records or console output |
| 4 Post-claim duplicate | DESIGN ONLY + pure `classifyOrderSnapshot`: pre-claim any own-key order = duplicate; post-claim exactly one own-key order recognised by its key (not excluded), extra own rows = duplicate, none = inconsistent (unknown), unrelated orders always counted. Not connected to anything. |
`executionAuthorized:false` and `affectsOrderPath:false` unchanged; import-graph isolation tests unchanged and passing.

## 7. Strategy attribution — DRAFT ONLY
See `strategy-attribution-migration.md`. Draft 0047 + rollback; separate insert-only identity and event tables; no change
to real orders/positions/trades; legacy rows stay UNATTRIBUTED.

## 8. Owner decision register
`docs/phase-4d/owner-decision-register.md` — four NOT APPROVED policy values, budget semantics, retention growth, open decisions.

## 9. Files
Modified (authorized by the brief): `src/lib/futures-paper-engine.ts`, `src/lib/central-risk-shadow.ts`,
`src/lib/central-risk-shadow.server.ts`. Modified tests: `src/test/central-risk-shadow.test.ts` (stale expectation),
`src/test/phase4c-isolation.test.ts` (excludes exactly the three authorized files). Created:
`docs/proposed-migrations/0047_futures_strategy_attribution{,.rollback}.sql`, `docs/phase-4d/*`,
`src/test/futures-paper-fill-revalidation.test.ts`, `src/test/central-risk-shadow-remediation.test.ts`,
`src/test/strategy-attribution-0047-migration.test.ts`, `src/test/phase4d-concurrency.pg.test.ts`,
`src/test/phase4d-isolation.test.ts`, `scripts/futures-paper/concurrency-check-4d.sh`.

## 10. SHA-256
| File | SHA-256 |
|---|---|
| 0047 migration (draft) | `42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b` |
| 0047 rollback (draft) | `bb980bbcc5849ddd1fb671064f0fb568d6e6de1345127dfc635aa7a0f3755ae8` |
| 0046 migration (unchanged) | `eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e` |
| 0046 rollback (unchanged) | `dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453` |
| 0045 migration / rollback (unchanged) | `fa907f33…1cf1b` / `e80f6559…3d9892` |
| futures-paper-engine.ts | `588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9` |
| central-risk-shadow.ts | `76f27f3e2e8c3eff0cb11e27297cd26f7202f07062bb1e9878d17cdf103aa4cf` |
| central-risk-shadow.server.ts | `dda46802ad54f209c139ed48c1bdd0acfc5acefb6a16c57e4eb69ed6ca377037` |
Start-of-sprint protected manifest: `docs/phase-4d/protected-files-at-start.sha256` (174 files, identical to Phase 4C's).

## 11. Test report
| Suite | Result |
|---|---|
| Full regression (vitest) | **942 passed, 25 skipped, 0 failed** (79 files passed, 5 skipped). Skipped = real-PostgreSQL suites that need `FUTURES_PAPER_PG_URL` (run separately below) and other server-gated suites |
| Typecheck | PASS (no errors) |
| Production build | PASS (latest build log "build OK") |
| Futures paper regression (engine, hardening, 0045/0046 PGlite) | PASS |
| Fill-time re-validation (16 required cases + extras; pure + PGlite with draft 0046) | 19/19 PASS |
| Shadow safety (existing 23 + remediation 18) | 41/41 PASS |
| Strategy attribution 0047 (PGlite) | 13/13 PASS |
| Isolation (4C, 4D, Engine B) | PASS |
| Restore verifier synthetic self-test | 4/4 PASS (synthetic only) |
| Real-export restore | **BLOCKED** (no fresh export) |
PGlite results are single-session and are reported separately from real PostgreSQL below.

## 12. Real PostgreSQL concurrency evidence
Throwaway local PostgreSQL 17.11 (`scripts/futures-paper/concurrency-check-4d.sh`, files run sequentially), 3 runs, each
**6/6 PASS**: (a) two workers of one owner commit fills simultaneously against a 12 USDT strategy budget → exactly one
fill, the other refused by 0046, planned `recompute:STRATEGY_BUDGET_EXCEEDED`, committed as a cancellation, both cursors
advanced; (b) concurrent 0.6 + 0.6 reductions of a 1.0 attributed fill → exactly one commits; (c) the same evidence
inserted simultaneously → attributed once; plus the three existing 0046 multi-session tests. A first attempt failed
twice on a test-harness race (two files creating cluster-wide roles at the same time); fixed by running files
sequentially — not a product defect.

## 13. Security and isolation evidence
Import-graph tests: engine and shadow modules reach no order, exchange, credential, wallet, Autopilot, route or AI
module; the new entry points are used only by tests; no new route; nothing added to the applied Drizzle journal; only the
three authorized protected files changed. No signed exchange call, allowlist change, credential read or AI call was made.

## 14. Unresolved blockers
1. Fresh database export (owner) → real restore verification of 0046 and 0047.
2. Approval of 0046 + the Phase 4D engine, final migration numbering.
3. Approval of 0047 and, separately, the order-path change that captures identity.
4. Policy values, budget semantics and retention (decision register).
5. AI Prime Tech not connected in the new workspace (owner skipped the connection card).

## 15. Recommended Phase 4E scope (proposal only)
Real-export restore of 0046/0047 once supplied; a reviewed, still-unscheduled paper worker design that uses
`stepFuturesPaperCandle` + `planCommitRefusal`; owner decisions on the register; wiring the post-claim classifier into
shadow mode only after review; no activation, orders or scheduling without separate approval.

No migrations were applied. No real or Testnet orders were placed. No production database, settings or credentials were changed. No Futures Paper Engine was activated. No workers or schedulers were started. No paid infrastructure was purchased. Central Risk Shadow remains disconnected. Autopilot and Live Futures remain untouched.
