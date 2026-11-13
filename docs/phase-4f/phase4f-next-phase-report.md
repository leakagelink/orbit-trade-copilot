# Phase 4F — proposed next phase (proposal only; nothing here is authorized)

Starting point (13 Nov 2026): draft 0049 replaces the rejected 0046 and is verified on PGlite, real PostgreSQL and the
real 13 Nov export, but NOT applied; 0048 is approved for review/validation, NOT applied; policy values (5% liquidation
buffer, 5 s price age, 60 s proposal expiry, 0.13% cost) are proposals NOT APPROVED for execution; retention is a
proposal; no worker exists.

## Owner decisions needed to start
1. Review 0049 (and confirm it, not 0046, is the paper ledger to carry forward).
2. 0048 validation outcome → separate approval to apply, and separately the order-path change capturing identity.
3. Confirm the closed-loss budget definition (wins never refill) and the UTC candle-day for daily loss.
4. Budget amounts for the account, Research and Scalping sub-budgets (configuration; none proposed by me).
5. Retention: confirm table mappings marked "confirm"; legal review; whether to build the erasure/expiry migration.
6. Approve the engine alignment items E1–E4 (paper-only behaviour changes).

## Proposed work (still offline, draft-only)
| Workstream | Content | Tests |
|---|---|---|
| A. Engine alignment (if E1–E4 approved) | Expiry cancellation; acceptance uses database budgets via `riskEngineStrategyBudget`; planner codes for approval refusals; per-instrument cost at acceptance | Engine → 0049 end-to-end on PGlite with zero refusals over long synthetic and historical replays; refusal-planner coverage |
| B. Worker behind a disabled flag | `paper-worker-design.md` against 0049: lease + compare-and-set, idempotent replay, bounded retries, monitoring | Crash/lease tests on real PostgreSQL; import-graph isolation; no schedule |
| C. Retention migration draft (if approved) | Erasure/expiry function, erasure log, archive-before-delete | PGlite + real PostgreSQL + real-export restore |
| D. Fresh export before any apply | New export, identity check against `check-backup-identity.sh`, practice restore of every draft to be applied | Real export |

## Not in scope without separate approval
Applying any migration; starting or scheduling a worker; any real or Testnet order; Autopilot or Live Futures changes;
connecting the Central Risk shadow or the budget module to an order path; AI calls; paid infrastructure.
