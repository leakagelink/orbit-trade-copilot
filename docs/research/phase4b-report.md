# Orbit Trade Copilot — Phase 4B report (12 November 2026)

## 1. Executive summary
* **Central Risk shadow mode: PASS (built, not connected).** A separate evaluator turns an existing Futures ticket into a
  proposal, reads SELECT-only, and produces frozen ACCEPT / REJECT / INSUFFICIENT_DATA records in memory. Nothing in the
  order path, routes, cron or Autopilot imports it. With today's real data sources every Live and Testnet evaluation is
  INSUFFICIENT_DATA (four sources blocked).
* **Futures paper engine: inactive; NOT APPROVED for activation.** Review of draft 0045 found 3 FAIL items (null-input
  validation, wallet-field validation, no commit-time strategy-budget recheck) and 1 BLOCKED (real crash recovery). Two
  engine defects found in review were fixed with regression tests. Fresh export and practice restore: **BLOCKED**.
* **Strategy research: NO TRADE** for BTCUSDT and ETHUSDT on 3 years of 1h/4h data. One BTC strategy passed train and
  validation and then lost on the locked test.
* **Risk policy values: NOT APPROVED**; technical review written.
* **Seconds-level scalping: postponed**; nothing built or bought.
* No orders (real or Testnet), no migrations applied, no AI calls, no credentials or settings touched, no paid services,
  no workers or schedules started. Autopilot and Live Futures were not touched.

## 2. Files created and modified
Created: `src/lib/central-risk-shadow.ts`, `src/lib/central-risk-shadow.server.ts`, `src/lib/lowfreq-research.ts`,
`src/test/central-risk-shadow.test.ts` (23), `src/test/futures-paper-hardening.test.ts` (9), `src/test/lowfreq-research.test.ts` (13),
`scripts/central-risk-shadow/fixtures.ts`, `scripts/lowfreq-eval/run.ts`, `docs/design/central-risk-shadow-mode.md`,
`docs/readiness/futures-paper-activation.md`, `docs/research/phase4b-lowfreq-research.md`, `docs/research/phase4b-risk-policy-review.md`,
`docs/evaluation/phase4b-shadow-fixtures.json`, `docs/evaluation/phase4b-lowfreq-research-2026-11-12.json`, this report.
Modified: `src/lib/central-risk.ts` (proposal engine label `futures_ticket` added — shadow-only), `src/lib/futures-paper-engine.ts`
(halt cancels pending entry; per-symbol candle cursor), `src/test/engine-b-isolation.test.ts` (new pure modules added to the
purity graph), `docs/design/central-risk-futures-integration.md` (S1 status), `src/lib/AGENTS.md`, `roadmap.md`.
Not modified: any order/claim/authorization/exchange/credential module, any migration file (0045 SHA-256
`fa907f33…21cf1b`, rollback `e80f6559…3892`, unchanged).

## 3. Central Risk shadow mode — status
| Item | Status |
|---|---|
| Read-only ticket → proposal adapter (environment from the connection, ticket size never crosses over) | PASS |
| SELECT-only context reuse, read provenance with timestamps | PASS |
| Versioned shadow record (all fields in §6 of the brief; context SHA-256; duration) | PASS |
| In-memory append-only log with duplicate flagging | PASS |
| Database persistence | NOT IMPLEMENTED (needs its own migration + approval) |
| Called from the live Futures path (S1 observe-only) | NOT APPROVED / not connected |

## 4. Missing data-source readiness
| Source | Status | Blocker |
|---|---|---|
| Strategy risk budget | BLOCKED | Draft 0045 not applied |
| Per-strategy loss attribution | BLOCKED | Real orders/trades have no strategy id; migration + order-path tagging needed |
| Maintenance-margin rate | BLOCKED | Signed `leverageBracket` not on the frozen adapter allowlist (needs approval) |
| Available margin | BLOCKED | Needs credential decryption in the shadow path (needs approval) |
| Testnet mark price / lot rules | BLOCKED (by design) | Production public prices are never used for Testnet |
| All other inputs (limits, positions, exposure, orders, duplicates, daily loss, stop, Live mark, lot rules, age, strategy id) | READY |
Contracts for the blocked sources are in `docs/design/central-risk-shadow-mode.md`; a pure leverage-bracket → rate helper is tested.

## 5. Proof shadow mode cannot affect order execution
Import-graph tests: the six order-path entry files reach no `central-risk*` module; no non-test file imports the shadow
modules; the shadow graph reaches no order, lease, authorization, credential, exchange-adapter, wallet, bot or AI module.
Behaviour tests: write/RPC spies never fire; exchange access is GET-only on the public allowlist with no key header;
Testnet fetches nothing; every exception resolves to INSUFFICIENT_DATA; ACCEPT carries `executionAuthorized:false`;
identical inputs give identical records and hashes. **PASS.**

## 6. Migration 0045 review (review only, not applied)
RLS PASS · owner isolation PASS · service privileges PASS · append-only PASS · atomic valid-state commit **FAIL** ·
duplicate candle PASS · closed-candle PASS · wallet reconciliation **FAIL** · halted entry rejection (DB) PASS ·
strategy budget enforcement (DB) **FAIL** · concurrent workers PASS · crash recovery **BLOCKED** · rollback (disposable) PASS ·
production-table isolation PASS. Details and proposed SQL fixes: `docs/readiness/futures-paper-activation.md`.
A reviewed successor draft is needed before any application.

## 7. Fresh export and restore
**BLOCKED.** The only export (`orbit-trade-copilot_261112.backup`, 06:52 UTC 12 Nov) predates 0039. Owner path:
Lovable Cloud → More → Database → Manage → Settings → Export project data → Export data → Database → Export → Start export.
The existing restore script for migrations has 0043-specific checks; a 0045-specific restore verifier is still needed.

## 8. Futures paper engine readiness
Covered by tests: BTC/ETH, long/short, isolated margin, Risk-Engine leverage, mark vs index, funding both signs,
mark liquidation, stop/target, stop-first, gap through stop, partial fills, volume caps, costs, daily loss, strategy
budget (new proposals), exposure, emergency stop, reconciliation/tamper, duplicate candle, deterministic recovery.
Fixed in this sprint: halted account no longer fills pending entries; duplicate/out-of-order candles refused.
Open: pending fills do not re-check daily loss/budget/exposure; no worker exists; no scheduler. Activation: **NOT APPROVED**.

## 9. Strategy research
384 pre-declared variants per symbol, 2023-11-13 → 2026-11-12, 0 data gaps, 14-day purge/embargo.
BTC: 4 train passers (one strategy: 4h mean-reversion) passed validation, **locked test −3.40 $/trade over 19 trades → NO TRADE**.
ETH: 2 train passers (4h Donchian-55) failed validation → NO TRADE. Walk-forward: BTC 0/11 folds traded; ETH 3 traded,
1 positive, pooled −88.63 $. Maker fills save fees but show slightly worse 4-bar markouts (adverse selection).
Full tables: `docs/research/phase4b-lowfreq-research.md`.

## 10. Risk policy review
Liquidation buffer 2 %, mark age 5 s, proposal age 60 s, cost 0.13 % — all **NOT APPROVED**. Proposal age and cost should
become per-strategy / per-symbol; evidence requirements listed in `docs/research/phase4b-risk-policy-review.md`.

## 11. Test results (actually executed)
* Full suite: **800 passed, 19 skipped** (73 files; the 19 skipped are the three multi-session PostgreSQL files, run separately below). 0 failed.
* Multi-session PostgreSQL, 3 runs each: Futures paper 2/2 ×3, Spot paper 7/7 ×3, research budget 10/10 ×3.
* Draft 0045 PGlite: 8/8. Shadow: 23/23. Paper hardening: 9/9. Low-frequency research: 13/13. Isolation graph: 7/7.
* Typecheck: clean after fixing 8 strict-null/index errors in the new files. Production build: platform build OK after the fixes.

## 12. Security and isolation findings
* Testnet shadow evaluation previously had no rule against using the production price feed — now explicitly blocked and tested.
* Production pending-order check stays account-wide (stricter, mirrors today's order path).
* Shadow records hold no credentials; context hash covers numeric context only.
* 0045 null-validation defects allow a malformed state to commit (service role only) — FAIL until a successor draft.

## 13. Blockers
Fresh export; 0045 successor draft + review; strategy attribution migration; leverage-bracket and available-margin reads
(adapter approvals); shadow-decision ledger migration; owner decisions on policy values.

## 14. Next owner decisions
1. Approve connecting shadow mode to the live Futures path in observe-only mode (it would still never block)?
2. Approve adding the signed leverage-bracket read and the available-margin read to shadow mode?
3. Approve drafting the 0045 successor (validation fixes + commit-time budget recheck) and a shadow-decision ledger migration?
4. Create the fresh database export so practice restore can run.
5. Decide the four policy values (or ask for per-strategy versions).
