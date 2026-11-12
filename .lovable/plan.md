# Phase 1.6 — Testnet Certification Harness (plan only, not started)

## Status going in
- Phase 1.5 stays **FAIL / NOT CERTIFIED**. Zero certification records exist; this phase never creates a PASS.
- Production: Autopilot OFF, Live Futures OFF, no positions or open orders. Nothing in this phase changes production limits, keys, connections or settings.
- Task 1 (certification permissions) is written and tested, but **not applied** to the live database — it is waiting on the backup gate below.

## Gate 0 — before any database change (owner decision needed)
Today's export (06:52 UTC) restores correctly, but it was taken ~3 minutes **before** the earlier safety update was applied, so it does not contain that update. Only one export is allowed per 24 hours. Choose one:
- **A. Wait** for a fresh export after ~06:53 UTC 13 Nov, verify it the same way, then apply the permission fix and any harness table.
- **B. Accept** today's export plus the saved safety-update file as the backup basis and apply the permission fix now.

## Gate 1 — dedicated test account (owner)
1. New AlgoVirt sign-in, no admin role, no production exchange or Deriv connection, Autopilot OFF.
2. Fresh Binance Futures **Testnet** key under that sign-in only (withdrawals off).
3. Temporary Elite access for that sign-in (owner approves the grant).
4. Owner-stated Testnet limits (margin, leverage, max loss, daily loss, exposure).
5. I verify all of this read-only and wait for your explicit go-ahead.

## Isolation rules built into the harness
- Refuses to run unless the signed-in user is the configured dedicated test account, the connection is Testnet, and that user owns no production connection.
- Uses only the test account's own emergency stop; the production owner's kill switch is never read for pass/fail and never touched.
- Takes a fingerprint of the production owner's settings, limits, connections, Autopilot and certification records before and after every run; any difference fails the run.
- Cannot write certification records (blocked by permissions after Task 1, and no code path exists).

## Scenarios (each ends with a broker-state check)
| # | Scenario | How it is produced | Must hold |
|---|---|---|---|
| 1 | Partial fill | Real IOC limit order sized past top-of-book; plus injected partial response | Position = actually filled qty; protection sized to fill; remainder never resubmitted |
| 2 | Protection rejection | Real Binance rejection (stop on the wrong side) and injected rejection | Position flattened reduce-only; marked unprotected→closed; no new entries until reconciled |
| 3 | Unknown submission status | Request really sent, response dropped (injected timeout) | No resubmission; settled only by client-order-ID lookup |
| 4 | Isolated kill switch | Test account's emergency stop during an open position | Entries blocked, exits allowed; production fingerprint unchanged |
| 5 | Concurrent requests | Same and different request IDs fired in parallel | Exactly one exchange order per request; lease fencing rejects stale writers |
| 6 | Worker crash/restart | Child process force-killed at 4 checkpoints (after claim, after submit-start, after fill before protection, after protection before save) | Fresh process recovers to a single correct state; nothing replayed |
| 7 | Funding reconciliation | Tiny position held across a funding time (00/08/16 UTC) | Funding from Binance income history matches stored funding; net = gross + funding − fees |
| 8 | Final broker state | After every scenario and at the end | 0 positions, 0 regular/algo orders, leases released, no pending orders, ledger matches broker fills |

Real vs injected faults are labelled separately in the report; an injected-only result is never presented as a real exchange result.

## Output
- A report with per-scenario evidence (broker IDs, timings, before/after state) and an overall **FAIL / NOT CERTIFIED** status regardless of results; certification is a separate owner decision later.
- Then STOP for approval; no Phase 2.

## Technical details

Task 1 (ready, unapplied)
- `docs/proposed-migrations/0040_futures_certifications_least_privilege.sql`: revoke all from `anon`; `authenticated` keeps SELECT only (owner RLS policy unchanged); `service_role` keeps writes; agent inspection role loses INSERT; new statement-level TRUNCATE block (row triggers never fired on TRUNCATE — browser roles could previously TRUNCATE in raw SQL).
- `src/test/futures-cert-grants.test.ts`: real-role tests (passing). Also verified on a restored copy of the export with 0039+0040: anon denied everything; authenticated SELECT only (owner sees own row, other user sees none); service_role insert OK, update/delete/truncate blocked as append-only; binding trigger intact.
- After applying: repeat role probes against the live database (anon key via the Data API, authenticated session, all writes rejected, nothing persisted).

Harness files (new unless noted)
- `src/lib/futures-faults.server.ts` — Testnet-only fault plan (drop response, inject rejection/partial) wrapped around Futures calls; hard-fails on production accounts.
- `src/lib/binance-futures.server.ts` (edit) — optional transport hook, inert unless a Testnet fault plan is supplied.
- `src/lib/futures.server.ts` (edit) — optional named checkpoints for crash tests; no behaviour change when absent.
- `src/lib/futures-harness.server.ts` — scenario runner, isolation checks, production fingerprints, broker-state verification.
- `scripts/futures-harness/run.ts`, `scripts/futures-harness/crash-child.ts` — runner and killable child process.
- `src/test/futures-harness.test.ts` — offline tests of fault plan, isolation refusal and checkpoint recovery.
- `docs/certification/phase-1.6-report.md` — results.

Database objects (proposed, gated by Gate 0)
- `0041_futures_harness_evidence.sql`: `public.futures_harness_runs` — append-only, Testnet connection only (trigger-checked), service-role writes, owner read, no browser write grants.
- Not touched: `futures_certifications` rows, production `futures_settings`, `risk_settings`, `autopilot_settings`, `exchange_connections`, `connection_credentials`.

Backup verification facts (Task 2)
- Export file is a readable PostgreSQL custom-format archive (1,211 entries). Restored into an isolated throwaway database: all 59 app tables, 41 functions, 35 triggers, 124 security policies, row security on all tables, grants, default grants, 5 sign-in accounts with password hashes. Table-by-table row counts and content fingerprints matched the live database (only differences: the later safety update and a session "last seen" time).
- Restored with expected gaps: scheduled jobs and vault secrets need platform extensions not available outside Lovable Cloud.
- Not included: the 0039 safety update, storage files, sign-in provider settings, API keys/secrets, database roles and server settings.
- This was an isolated practice restore, not a restore into Lovable Cloud — restore readiness is **not** claimed. The downloaded copy was deleted afterwards.
