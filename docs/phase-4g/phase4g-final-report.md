# Phase 4G — Pre-Activation Readiness — final report (13 Nov 2026)

Readiness and validation only. **Nothing was applied, enabled, scheduled, deployed or traded.** Phase 4H was not started.

## Verdicts

| Workstream | Result | Summary |
|---|---|---|
| A. 0049 review | **PASS with findings** | Sound for its scope. G1 (no wall-clock freshness for approvals) and G3 (budget race at REPEATABLE READ, reproduced on real PostgreSQL) are closed by draft 0050. **G2 is open:** 0049 does not require the exits, liquidations or funding a recorded candle implies. Full table: `migration-0049-review.md`. 0045/0046/0049 objects are absent from the hosted database. |
| B. Fresh backup and restore | **BLOCKED** | No new export exists. The only exports are 12 Nov 06:54 UTC (superseded) and 13 Nov 09:20 UTC, the one already used in Phases 4E/4F. I did not substitute it as "fresh". As extra, clearly labelled evidence, I restored that same export locally and ran 0049 + 0050 apply/rollback on it: PASS. |
| C. Hosted worker connection | **PASS (built, disabled)** | Draft 0050 plus a connection module, both off. Covers leases, a single-snapshot read, deadlines, error classification and redaction. No route, schedule or background job exists. |
| D. Operational failure tests | **PASS** | Every listed scenario is covered: in PGlite through an emulated Data API, and on a real throwaway PostgreSQL for the concurrency and connection cases. |
| E. Market-data provenance | **PASS** | Each record holds source, symbol, timeframe, open/close, closed-candle confirmation, sequence/gap checks, a payload SHA-256 and a fetch-age check. Prices are **not** independently verified, and the database refuses any record that claims they are. |
| Ready for a separate paper-only activation review? | **Not yet** | The blockers are listed below. The engineering side is ready to be *reviewed*, not to be activated. |

## B. Backup evidence (not a fresh export)

- Storage listing (read-only, 11:44 UTC): `database_export_13_11_26/orbit-trade-copilot_261113.backup` (stored 09:20:40 UTC) and the 12 Nov file. Nothing newer exists.
- I downloaded a read-only copy (mode 0444) to `/tmp`. SHA-256 `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5`, 2,525,322 bytes, MD5 `5db5e5d9…` → MATCH with the pinned identity. The stored original was not modified.
- Hosted schema now (read-only catalog query) is 60 tables, 45 functions, 125 policies, 38 triggers, column MD5 `18bf7fdd…2f5f2d`. The restored export gives identical figures. So the **schema** has not changed since the export; data may have.
- Local restore (`scripts/db-export/verify-local-restore-0050.sh`; report `restore-0049-0050-existing-export.md`) was **PASS**. Checks covered:
  - migration ordering (40 rows, latest 0039) and archive fidelity
  - 0050 refused without 0049, then 0049 → 0050 applied in single transactions
  - RLS, policies, grants, SECURITY DEFINER and EXECUTE checks
  - rolled-back probes (no lease, REPEATABLE READ, browser role)
  - 0049 rollback refused while 0050 is present; then 0050 → 0049 rollback
  - nothing left behind, and the pre-existing fingerprint unchanged
- This is not a Lovable Cloud restore and not proof of restore readiness. The next export can be taken after 09:19 UTC on 14 Nov (one per 24 h).

## C. Hosted connection architecture

```text
caller (none exists) ──► runHostedFuturesPaperWorkerTick  [enabled:true required]
                           │ per account, isolated (one failure never stops another)
                           ▼
                Phase 4F worker (unchanged) ── market port ──► public Binance data (wrapped: cached for provenance)
                           │                └─ intents port (wrapped: withheld when candle older than max data age)
                           ▼ database port = createHostedWorkerPorts
        6 allowlisted RPCs, each one READ COMMITTED transaction, 8 s deadline (AbortSignal)
   fpw_acquire_lease ─ fpw_snapshot (ONE statement) ─ fpw_evaluated ─ fpw_commit ─ fpw_mark_review ─ fpw_release_lease
                           ▼ draft 0050 (SECURITY DEFINER, service_role only)
        lease row + fence ─► READ COMMITTED guard ─► entry-age guard ─► provenance checks ─► 0049 commit ─► provenance rows
```

- **Least privilege.** Only `service_role` may execute the six functions; browser roles have no access to them or to the lease table. The 0049 commit is no longer directly executable by `service_role`. The hosted Data API offers no narrower server role, so a dedicated role would need a direct database connection (register G-4). Inside the code, an allowlist limits the connection to the six functions.
- **Secrets.** The pure module holds no credential. The server binding refuses to run unless `FUTURES_PAPER_WORKER_HOSTED=enabled`, and that flag is set nowhere. The key stays inside the generated server client and is never read, returned, logged or forwarded. Monitoring records codes only (no messages, payloads or rows). Refusal text passed to the planner has JWTs, keys, bearer tokens, `key=value` secrets and URL credentials redacted.
- **One snapshot.** `fpw_snapshot` is a single SQL statement, so it reads one MVCC snapshot. It returns nothing unless the caller holds the account's lease, and it equals the Phase 4F multi-query view (tested).
- **Locking.** The lease is a row with a fencing token. It is re-checked under `FOR UPDATE` and renewed inside the commit transaction. A stalled holder whose lease was taken over cannot commit.
- **Timeouts and connection loss.** A failure with no reply counts as an unknown outcome. The worker resends the identical payload once (0049 replays it idempotently) and otherwise leaves the candle for the next tick, which reloads the cursor. A server-reported abort (serialization, deadlock, statement timeout, terminated backend, missing function, permission) counts as transient: nothing is written and nothing is retried within the tick. There are no blind retries.
- **Isolation.** The owner always comes from the account. Asking for another owner's proposals is refused twice: by the connection before any call, and by the database.

## D/E. Test results (all run this phase)

| Suite | Kind | Result |
|---|---|---|
| Full suite (`bunx vitest run`) | PGlite + pure + mocked | **1,187 passed, 0 failed, 53 skipped** (106 files) |
| `futures-paper-worker-gateway.test.ts` | PGlite (0049+0050) | 14/14 — privileges, RLS, fenced leases, snapshot, cross-account, provenance (13 refusal cases), G1, G3, audit, rollback order |
| `futures-paper-worker-hosted.test.ts` | PGlite via emulated Data API | 22/22 — DB unavailable, commit timeout, reply lost after commit, restart mid-transaction, snapshot loss, lease takeover, competing workers, 2 independent accounts, duplicate/out-of-order/missing/stale/unverified data, approval refusal, commit refusal → halt → recovery, secret leakage, cross-account |
| `futures-paper-worker-hosted-classify.test.ts` | pure / mocked RPC | 24/24 |
| `futures-paper-market-provenance.test.ts` | pure | 11/11 |
| `migration-0049-review.test.ts` | PGlite (0049) | 3/3 characterization of G2 (the gap is pinned, not fixed) |
| `phase4g-isolation.test.ts` | static | 6/6 — Phase 4F files byte-identical, drafts pinned/unapplied, connection off, no imports/routes/schedules |
| Real PostgreSQL 17.11 launcher `concurrency-check-4g.sh` | real PostgreSQL, throwaway | **34/34, three consecutive runs** (hosted 8 + Phase 4F worker 8 + 0049 5 + 0048 7 + Phase 4D 3 + 0046 3) |
| Local restore of the 13 Nov export with 0049 + 0050 | real PostgreSQL, throwaway | PASS (see B) |
| Type check (`tsgo -b --noEmit`) | — | exit 0 |
| Production build | preview build log | `build OK` (12:17:42 UTC) |

**Skipped in the full suite (53).** These need a real PostgreSQL URL:
- 34 were run separately above.
- 19 were **not run this phase** (unrelated drafts): `futures-paper-ledger-concurrency.pg` (0045, 2), `paper-ledger-concurrency.pg` (0044, 7) and `research-budget-concurrency.pg` (0043, 10).

**Real PostgreSQL highlights.**
- Four workers competed for one account: each candle was committed once, with no duplicate fill ids and no lease left held.
- A client timeout with server-side cancellation wrote nothing.
- A client timeout without cancellation: the server finished later, the resend replayed it, and the result was exactly once.
- A backend killed mid-commit rolled back, with no halt.
- The same-owner budget race stayed ≤ budget.
- G3 reproduced: 19.9988 against a budget of 12.

**Test-harness note.** postgres.js 3.4.9 schedules a write on a dead socket when a backend is killed inside its `begin()`. The killed-backend test therefore uses single-statement calls on a `service_role` session (asserted to run at READ COMMITTED). This is a test-driver artefact, not product behaviour.

## Executed / not executed

- **Executed.**
  - Read-only queries of the hosted catalog, migration history, storage listing and schedule list.
  - One read-only download of the existing export to `/tmp`.
  - Local throwaway PostgreSQL instances and PGlite.
  - File edits: new draft 0050 + rollback, new modules, tests, scripts and docs. One narrow allowlist change in `phase4f-alignment-isolation.test.ts` hands the three new modules to the Phase 4G isolation test.
- **Not executed.**
  - No migration was applied to Lovable Cloud (0049 and 0050 remain drafts).
  - No order, Testnet or real.
  - No paper-engine activation, worker enablement or schedule.
  - No Autopilot or Live Futures connection.
  - No change to credentials or risk settings.
  - No AI call.
  - No paid service.
- **Existing schedules, unchanged.** `paper-engine-tick` (existing bot engine, `/api/public/engine/tick`), `trade-price-alerts` and `ai-autopilot-tick`. None targets the Futures paper worker.

## Remaining blockers before a paper-only activation review

1. A **fresh export** (after 09:19 UTC on 14 Nov), then rerun `verify-local-restore-0050.sh` on it.
2. Owner review and separate approval to **apply 0049 and 0050** (in that order, never with 0045/0046).
3. **G2 decision:** close it in a 0049 successor, or accept worker-trust for paper evidence.
4. Owner decisions on the **policy values** (5 % liquidation buffer, 5 s price age, 60 s expiry, 0.13 % cost), budget amounts, retention and the Phase 4G operational constants (register §6). All are still NOT APPROVED.
5. Separate approvals for **enabling** the hosted connection and for any **schedule**.

No real hosted run of the connection has happened (it cannot, since 0049/0050 are not applied), so hosted operational readiness is **not** claimed.
