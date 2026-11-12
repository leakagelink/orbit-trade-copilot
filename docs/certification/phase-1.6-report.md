# Phase 1.6 — Testnet Certification Harness

**Overall status: FAIL / NOT CERTIFIED** (Phase 1.5 status preserved; the harness never creates a PASS.)

## State on 12 Nov 2026
- Harness code, fault injection, crash checkpoints and offline tests: built.
- Exchange scenarios: **not run** — blocked on Gate 1 (dedicated test sign-in, fresh Testnet key, temporary Elite, owner-stated limits).
- Database changes 0040 (certification permissions) and 0041 (harness evidence table): written and tested in a throwaway database, **not applied** — blocked on Gate 0 (export of the current database).
- Read-only refusal check against the live database: running the harness with the production owner as the "test" account was refused before any exchange call.

## Preparation status — 12 Nov 2026 09:10 UTC (read-only, no execution)
- **Export gate:** only export present is `orbit-trade-copilot_261112.backup` (06:52 UTC). Practice restore: readable, 59 app tables with data, 41 functions, 35 triggers, 124 policies, RLS on 59 tables, sign-in accounts included; row counts match live for all 59. Verdict **NOT SUITABLE** — it predates safety migration 0039 (6 of 7 safety objects missing). Waiting for tomorrow's export; 0040 and 0041 stay unapplied.
- **Test-account gate:** no dedicated test sign-in yet; the only Testnet link belongs to the production sign-in. Read-only preflight refused and made no exchange call.
- **Production now:** Autopilot ON = 0 accounts, Live Futures ON = 0, certification records = 0 (PASS = 0), production Futures orders pending = 0, positions open = 0, execution leases = 0, halted accounts = 0; production fingerprint unchanged by the preflight.

## Final report layout (filled in only after owner-approved execution)
1. **Unit / injected simulation results** — offline tests and injected faults (labelled `injected`). Partial fills are listed here as **SIMULATED**: app entries are MARKET orders and Testnet cannot reliably produce a real partial fill.
2. **Actual Binance Testnet results** — scenarios run against Testnet with provenance `real` or `real_broker_response_to_injected_input`.
3. **Not-testable scenarios** — anything Testnet cannot produce (e.g. real partial fills, broker outages), with the reason.
4. **Production isolation checks** — production fingerprint before/after every scenario, Autopilot/Live Futures OFF, zero PASS records, no production orders.

## Scenarios and pass rules
| Scenario | Provenance | Pass requires |
|---|---|---|
| partial_fill | injected (terminal partial lookup) | entry refuses, one broker entry, contained and closed, trade qty = real broker qty. A real partial fill is not exercised: entries are MARKET orders. |
| protection_rejection | real broker rejection of a wrong-side stop; injected TP rejection | failure reported, flattened reduce-only, no orphan algo orders |
| unknown_submission | injected lost response after a real send | settled by lookup, one broker entry, one intent, protection confirmed |
| isolated_kill_switch | real | test account's own emergency stop closes the position, halts only the test account, new entry refused; test halt cleared afterwards |
| concurrent_requests | real | broker entries = successes, ≤1 concurrent entry, repeated request ID → ≤1 intent |
| crash_restart | real (SIGKILL at 4 checkpoints) | fresh process recovers to closed, no entry replayed |
| funding_reconciliation | real | held across funding time, Binance funding events exist and equal stored funding, net = gross + funding − fees |
| final_broker_state | real | every harness trade reconciles, no certification records |

Every scenario also requires: broker and app flat afterwards, and an unchanged production-owner fingerprint (settings, limits, Autopilot, connections, credentials, certifications, production orders/positions).

## Read-only checks (no orders, no writes)
- Export: `scripts/db-export/verify-export.sh <bucket>/<object>` — practice restore in a throwaway local database; not a Lovable Cloud restore.
- Test account: `PREFLIGHT_TEST_USER_ID=… PREFLIGHT_OWNER_USER_ID=… PREFLIGHT_CONNECTION_ID=… bun scripts/futures-harness/preflight.ts` — isolation, Elite, limits, per-sign-in kill switch, Testnet GET-only reads.

## Running (after both gates AND explicit owner approval)
```
HARNESS_CONFIRM=TESTNET HARNESS_TEST_USER_ID=<test> HARNESS_OWNER_USER_ID=<owner> HARNESS_CONNECTION_ID=<testnet> \
  bun scripts/futures-harness/run.ts all
```
Evidence is written to `docs/certification/phase-1.6-evidence-<time>.json`.
