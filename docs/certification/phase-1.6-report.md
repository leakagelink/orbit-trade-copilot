# Phase 1.6 — Testnet Certification Harness

**Overall status: FAIL / NOT CERTIFIED** (Phase 1.5 status preserved; the harness never creates a PASS.)

## State on 12 Nov 2026
- Harness code, fault injection, crash checkpoints and offline tests: built.
- Exchange scenarios: **not run** — blocked on Gate 1 (dedicated test sign-in, fresh Testnet key, temporary Elite, owner-stated limits).
- Database changes 0040 (certification permissions) and 0041 (harness evidence table): written and tested in a throwaway database, **not applied** — blocked on Gate 0 (export of the current database).
- Read-only refusal check against the live database: running the harness with the production owner as the "test" account was refused before any exchange call.

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

## Running (after both gates)
```
HARNESS_CONFIRM=TESTNET HARNESS_TEST_USER_ID=<test> HARNESS_OWNER_USER_ID=<owner> HARNESS_CONNECTION_ID=<testnet> \
  bun scripts/futures-harness/run.ts all
```
Evidence is written to `docs/certification/phase-1.6-evidence-<time>.json`.
