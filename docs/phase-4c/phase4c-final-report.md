# Orbit Trade Copilot — Phase 4C final report (12 November 2026)

## 1. Executive summary

Phase 4C ran as an isolated engineering, safety and offline-research sprint. Results:

- **A. Central Risk Shadow — DESIGN ONLY.** Architecture, full input contract, source-to-field matrix, correlation/privacy design, safety invariants with their enforcing tests, unresolved dependencies and an approval checklist. No code in the shadow modules changed; nothing was connected.
- **B. Migration 0046 (successor of 0045) — DRAFT ONLY, not applied; restore verification BLOCKED.** All eight 0045 defects resolved in a standalone draft with a rollback; 15 PGlite tests + 3 genuine multi-session PostgreSQL tests (×3 runs); a new local-only restore verifier with refusal tests and a synthetic self-test. Not restore-verified on a real export (none fresh exists).
- **C. Risk data sources — DESIGN ONLY / BLOCKED.** Contracts for strategy budget, loss attribution, maintenance-margin brackets, available margin and Testnet market data; approval matrix; strategy-attribution design; pure validators (42 tests) that are not wired to anything.
- **D. EMA forward evaluation — RESEARCH ONLY. Verdict: NO TRADE for BTCUSDT and ETHUSDT.** Specification hash-frozen and committed before any new candle was fetched.

## 2. Owner decisions followed

| Area | Decision | Followed |
|---|---|---|
| Central Risk Shadow | Design only | Yes — documents only; shadow modules unchanged (manifest test) |
| Migration 0045 | Draft a reviewed successor | Yes — 0046 draft + rollback; 0045 byte-for-byte unchanged |
| Missing risk data sources | Design contracts only | Yes — documents + pure validators; no endpoint, decryption, allowlist or adapter change |
| Strategy research | EMA forward evaluation | Yes — offline, public data, pre-declared rule |

## 3. Files created and modified

Created — documents: `docs/phase-4c/central-risk-shadow-design.md`, `shadow-input-contract.md`, `shadow-safety-invariants.md`, `risk-data-contracts.md`, `risk-source-approval-matrix.md`, `strategy-attribution-design.md`, `migration-0046-design-review.md`, `ema-forward-research.md`, `ema-forward-spec.json`, `protected-files.sha256`, this report; `docs/evaluation/phase4c-ema-forward-2026-11-12.json`.
Created — drafts: `docs/proposed-migrations/0046_futures_paper_ledger_v2.sql`, `0046_futures_paper_ledger_v2.rollback.sql`.
Created — code (pure, imported by nothing in the app): `src/lib/ema-forward-research.ts`, `src/lib/risk-data-contracts.ts`, `src/lib/futures-paper-ledger-v2.ts`.
Created — scripts: `scripts/ema-forward/run.ts`, `scripts/futures-paper/concurrency-check-0046.sh`, `scripts/db-export/verify-local-restore-0046.sh`, `scripts/db-export/test-verify-local-restore-0046.sh`.
Created — tests: `src/test/ema-forward-research.test.ts`, `risk-data-contracts.test.ts`, `futures-paper-ledger-v2-migration.test.ts`, `futures-paper-ledger-v2-concurrency.pg.test.ts`, `verify-local-restore-0046.test.ts`, `phase4c-isolation.test.ts`.
Modified: `roadmap.md`; `src/lib/AGENTS.md` (one rule); `src/test/futures-paper-ledger-migration.test.ts` (test-only: the PGlite start-up hook timeout raised to 120 s because it timed out under full-suite load — no assertion changed).

## 4. Exact code changes

- `ema-forward-research.ts`: frozen `EMA_FORWARD_SPEC`, `emaAlwaysInTrades` (exact reproduction of Phase 4B `emaAlwaysIn` plus trades and marked equity), metrics, rolling windows, the frozen decision rule `emaVerdict`, data hashing.
- `risk-data-contracts.ts`: five validators returning `VALID` or `INSUFFICIENT_DATA` with reasons; proposed max ages (NOT APPROVED).
- `futures-paper-ledger-v2.ts`: builds the 0046 commit payload from engine output (strategy id + reserved risk per entry fill, deterministic fill ids, marks).
- No change to any exchange execution, order authorization, credential, wallet, Autopilot, Live Futures, scheduler, route, applied migration, shadow, Futures-paper-engine or Phase 4B module (174 files pinned by SHA-256 before the first edit; test passes).

## 5. Architecture and dependency changes

None to the running application. No new package. No new route/endpoint (test checks no new file under `src/routes`). No new import edge from app code to the new modules (test).

## 6. Migration successor status

`0046_futures_paper_ledger_v2.sql` SHA-256 `eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e`; rollback SHA-256 `dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453`. **DRAFT ONLY.** Latest applied migration verified as 0039 via read-only Drizzle history; final number unresolved. Details: `migration-0046-design-review.md`.

## 7. Restore-verification status — BLOCKED

Local-only verifier implemented and self-tested on synthetic backups (PASS on a well-formed archive; FAIL on missing history, wrong hash, 0045 present). Not run on a real export: no fresh export exists. The migration is **not** restore-verified.

## 8. Central Risk shadow design status — DESIGN ONLY

Docs complete. Discrepancies recorded: today a stale mark yields REJECT (not INSUFFICIENT_DATA); the last-resort fallback record is shallow-frozen; exception text could reach `internalError`; a post-claim observation would see its own order as a duplicate. None was fixed in code (design-only scope).

## 9. Risk-data contract status — DESIGN ONLY / BLOCKED

All five inputs remain BLOCKED at source. Note: `/fapi/v3/account`, `premiumIndex` and `exchangeInfo` are already on the frozen adapter allowlist (for the order path), and the Testnet host is already frozen; the blockers are shadow-path decryption/import approval, the missing `leverageBracket` allowlisting, the unapplied budget table and the absence of strategy identity on real orders/positions/trades.

## 10. EMA research results — RESEARCH ONLY

| Symbol | Unseen history (2019/2020 → 2023-10-30) | Validation | Test | Walk-forward | Forward | Verdict |
|---|---|---|---|---|---|---|
| BTCUSDT | 39 trades, net +4431.19 $, PF 3.40, t 1.18 | −240.58 $ (10) | +339.84 $ (7) | 11/16 positive | 1 force-closed position over 4 candles | **NO TRADE** (R1, R2 fail) |
| ETHUSDT | 47 trades, net +2353.28 $, PF 1.88, t 0.97 | −159.48 $ (10) | −341.32 $ (13) | 8/15 positive | 1 force-closed position over 4 candles | **NO TRADE** (R1, R2, R3 fail) |

Per-trade on 1000 USDT notional, assumed costs, actual funding. Full tables, baselines, sensitivity and limitations: `ema-forward-research.md`.

## 11. Test results (exact counts)

| Check | Result |
|---|---|
| Full regression suite (`bunx vitest run`, 79 files) | **887 passed, 0 failed, 22 skipped** (skipped = PostgreSQL-only suites that need their throwaway server, run separately below). An earlier full run had 1 timeout in `scalp-research.test.ts` and two PGlite start-up hook timeouts under load; hook timeout raised; re-run clean. |
| EMA reproducibility / equivalence / causality / frozen spec / decision rule | 14 passed |
| Risk-data contract validators | 42 passed |
| 0046 PGlite (every corrected invariant + preserved controls) | 15 passed |
| 0046 **real multi-session PostgreSQL 17.11** | 3 passed × 3 runs (reported separately from PGlite) |
| Local-only restore verifier refusals + source guarantees | 9 passed |
| Restore verifier synthetic self-test (shell) | 4/4 |
| Phase 4C isolation: protected files unchanged, no new route, 0045 hashes, import isolation | 7 passed |
| Existing Central Risk shadow tests (incl. import graph) | passed within the full suite (unchanged) |
| TypeScript typecheck / production build | **PASS** — platform build log "build OK" (18:44 and 18:45 UTC) after fixing two test-file type errors |
| Real-export restore | **NOT RUN (BLOCKED)** |
| 0045 / Spot-paper / research-budget PostgreSQL suites | NOT RE-RUN (files unchanged) |

## 12. Security and isolation verification

- Protected-file manifest (174 files, taken at `b16ba49` with a clean worktree before any edit) unchanged at completion.
- New modules import no order/exchange/credential/wallet/Autopilot/AI/database/shadow module and contain no `fetch`, Supabase client, `process.env` or server function.
- The EMA runner used only credential-free public Binance GET endpoints; the restore verifier and concurrency scripts use throwaway local PostgreSQL only; the only production-database interaction was a read-only migration-history inspection.
- Change control note: the platform auto-saved in-progress Phase 4C files as commit `d133dd6` ("Added successor draft logic", bot author) mid-sprint; its content is exclusively this sprint's own new files — no unrelated or external change was found.

## 13. Unresolved blockers

1. Fresh database export (owner) → then local restore verification of 0046.
2. Engine fill-time re-check matching 0046 (otherwise a refused fill stalls the account fail-closed).
3. Strategy identity on real orders (migration + order-path change) before any attribution.
4. `leverageBracket` allowlisting and shadow-path credential decryption (each separately).
5. Testnet market sourcing for shadow; Testnet-only emergency stop (draft 0042).
6. Forward data for the EMA candidate (≥ 30 closed trades ≈ years).

## 14. Risks requiring owner decisions

Budget semantics (cumulative vs daily, wins netted or not); the four NOT APPROVED policy values; proposed data max ages; retention of paper commit records; whether to keep pursuing the EMA candidate at all given NO TRADE.

## 15. Recommended Phase 4D scope (for owner consideration — not started)

Owner export + local restore run of 0046; engine fill-time re-check (paper only) with tests; decision on the shadow redaction/deep-freeze fixes as a small reviewed code change; strategy-attribution migration draft (not applied). No live wiring.

**No migrations were applied. No real or Testnet orders were placed. No production settings or credentials were changed. No workers or schedulers were activated. No paid infrastructure was purchased. Autopilot and Live Futures remain untouched.**
