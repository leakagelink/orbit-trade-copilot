# Phase 4H.7 — Worker timing report (Task 1: five-second execution architecture)

Date: 14 Nov 2026. Nothing was deployed, scheduled, applied or activated. All measurements are local.

## 1. The limit

| Fact | Value | Source |
|---|---|---|
| Scheduled HTTP call limit | **5,000 ms** (7 of 1,080 calls timed out at exactly 5,000 ms) | `docs/phase-4h6/live-service-checks.md` LS21 (read-only) |
| Previous worker minimum | 13,000 ms (sign-in 3,000 + call 8,000 + sign-out 2,000) | Phase 4H.6 |

Reducing one timeout does not solve it: a worker tick also needs sign-in, several data calls, market data and sign-out, and
must stay correct when any of them stalls, the platform stops it, or two runs overlap.

## 2. Architecture (implemented, disabled)

```text
scheduler slot (every 60 s) ──► ONE invocation (≤ 3,600 ms of work + 1,200 ms reserved margin ≤ 5,000 ms)
   sign in (≤600) ─► [account chosen by slot] ─► acquire lease (≤450, commits a fence + 15 s TTL)
        ─► per candle, at most 6:  snapshot (≤450, read) ─► market (≤600) ─► intents (≤200) ─► evaluated (≤450, read)
                                    ─► commit (≤450, ONE atomic compare-and-set transaction)
        ─► release lease (best effort) ─► sign out (≤400)
next invocation: reloads the committed cursor from the database and continues
```

- **Independent, idempotent stages.** Every data call is its own one-request transaction. The only state-changing
  stages are: lease acquire (a fence number + TTL), candle commit (compare-and-set on the ledger sequence; an identical
  replay returns the same sequence), lease release. Reads never change state.
- **Progress persisted only in the database.** Ledger cursor/sequence and the lease row. Nothing is carried in memory
  between invocations. No transaction is ever held across requests, let alone invocations.
- **No concurrent processing of one account.** Overlapping invocations of one slot pick the same account
  (`pickAccount`) and the database lease admits one holder; every invocation uses a fresh random holder id.
- **Resumable after a timeout or kill.** An uncommitted candle is simply recomputed next time; a committed one is never
  repeated (the sequence moved); a stale fence or sequence is refused by the database. A dead invocation's lease expires
  after 15 s, well before the next 60 s slot.
- **Partial state is never "completed".** `classifyInvocation` is strict: only `CAUGHT_UP` (session completed, nothing
  uncertain, account waiting for the next candle) is `completed: true`. Commits before a budget stop are `PROGRESS`
  (durable, not completed); anything uncertain is `INCOMPLETE`; plus `SKIPPED_BUSY`, `HALTED`, `SESSION_FAILED`,
  `CONFIG_INVALID`, `DISABLED`, `NO_ACCOUNT`.
- **Strict budget.** The session refuses any call that cannot finish before the budget minus the sign-out reserve; each
  market/intents call runs through `boundedCall` (timer armed first, one abort signal, late results ignored); one
  market attempt, no backoff sleep, no refresh.
- **Refuses profiles that cannot fit.** `validateInvocationLimits` rejects any profile where budget + margin > 5,000 ms,
  where one full entry step at every call's own limit exceeds the budget, or where the lease TTL is shorter than one
  invocation or outlives the slot. The old 8 s call limit is refused.

Files: `src/lib/worker-invocation.ts` (pure), `runBoundedIdentityInvocation` in
`src/lib/futures-paper-worker-identity.server.ts` (disabled by the same two unset environment flags; nothing imports or
schedules it). The locked hosted file is unchanged; S1–S8 defaults are unchanged (the invocation passes its own limits).

## 3. Proposed limits (NOT APPROVED — I1–I10)

| Id | Value | Why |
|---|---|---|
| I1 budget | 3,600 ms | session work, sign-in to sign-out acknowledgement |
| I2 margin | 1,200 ms | platform start, scheduler network, response; I1 + I2 = 4,800 ≤ 5,000 |
| I3 sign-in | 600 ms | |
| I4 data call | 450 ms | |
| I5 sign-out | 400 ms | |
| I6 market | 600 ms | |
| I7 intents | 200 ms | |
| I8 lease TTL | 15 s | > one invocation, < one slot (database accepts 10–300 s) |
| I9 slot | 60 s | the existing schedules' interval |
| I10 candles | 6 per invocation | the budget usually stops earlier |

Worst case with every call at its own limit: one entry step = 600 + 4 × 450 + 600 + 200 + 400 = **3,600 ms = I1**, so
an invocation always makes progress when every call meets its own limit, and never exceeds 4,800 ms.

## 4. Measurements

**Real PostgreSQL 17.11 (throwaway, local)** — real code path (session, hosted adapter, worker core, engine, drafts
0049–0057 SQL), fake auth/data API with injected per-request network latency; 8 invocations per profile, each with its
own 60-candle backlog. Raw: `evidence/invocation-timing-real-postgresql.json`.

| Latency per request | Run 1 min / p50 / p95 / max (ms) | Run 2 min / p50 / p95 / max (ms) | Candles per invocation | Status |
|---|---|---|---|---|
| 0 ms | 209 / 217 / 357 / 357 | 159 / 170 / 262 / 262 | 6 | PROGRESS (backlog) |
| 25 ms | 648 / 659 / 706 / 706 | 582 / 609 / 636 / 636 | 6 | PROGRESS |
| 75 ms | 1,483 / 1,540 / 1,609 / 1,609 | 1,470 / 1,537 / 1,627 / 1,627 | 6 | PROGRESS |
| 150 ms | 2,586 / 2,600 / 2,793 / 2,793 | 2,565 / 2,604 / 2,775 / 2,775 | 5 | PROGRESS |
| 300 ms | 2,782 / 2,807 / 3,134 / 3,134 | 2,769 / 2,799 / 3,124 / 3,124 | 2 | PROGRESS |

Run 2 is the final verification run (`evidence/invocation-timing-real-postgresql-run2.json`). Maximum observed: **3,134 ms**, inside I1 (3,600) and far inside 5,000 ms. PGlite suites
(`phase4h7-invocation.test.ts`) additionally assert every invocation ≤ I1 + 150 ms under hangs, timeouts and slow calls.

**Not measured (BLOCKED):** the hosted request latency from the worker host to the database and the auth service, cold
start, and the scheduler-to-worker network. Measuring them needs a deployed probe route (a deployment change this phase
forbids) — owner decision OD-T2. The 1,200 ms margin is a proposal until then.

## 5. Capacity

One invocation per minute processes one account. Measured candles per invocation: 6 at ≤ 75 ms, 5 at 150 ms, 2 at 300 ms
per request. A one-minute-timeframe account needs ≥ 1 candle per minute to keep up; with *n* accounts each is visited
every *n* minutes and needs *n* candles per visit. So one schedule keeps up with at most 6 one-minute accounts at ≤ 75 ms
per request (2 at 300 ms); five-minute timeframes multiply that by 5. Beyond that: more slots (more schedules) or longer
timeframes — owner decision OD-T3. Nothing is lost when it falls behind: the backlog is committed later, candle by candle.

## 6. Tests (all passing)

| Scenario | Test | Evidence |
|---|---|---|
| ≤ 6 candles, resumes next invocation; only CAUGHT_UP completed | phase4h7-invocation | PGLITE |
| Timeout before the database ran the commit | phase4h7-invocation | PGLITE |
| Timeout after the database committed (lost reply), never repeated | phase4h7-invocation | PGLITE |
| Restart with a dead invocation's lease: SKIPPED_BUSY until TTL, then resumes | phase4h7-invocation | PGLITE |
| Duplicate invocation of one slot | phase4h7-invocation | PGLITE |
| Overlapping invocations (one backend) | phase4h7-invocation | PGLITE |
| Parallel invocations on 3 connections, 10 candles committed exactly once | phase4h7.pg | REAL PG |
| Partial completion at 250 ms per call; every data call slower than its limit; statement timeout | phase4h7-invocation | PGLITE |
| Profiles over 5,000 ms / not fitting a step refused before any request | phase4h7-invocation, units | PGLITE / pure |
| Timing under latency | phase4h7.pg | REAL PG |

## 7. Verdict

| Item | Result |
|---|---|
| Bounded invocation inside 5,000 ms (local, every scenario) | **PASS** |
| Resumable, idempotent, no duplicate commits, one lease holder | **PASS** (PGlite + real PostgreSQL) |
| Partial state never reported complete | **PASS** |
| Hosted latency / cold start measured on a safe test route | **BLOCKED** (needs a deployed probe; owner decision) |
| Task 1 overall | **PARTIAL** — engineering complete and locally proven; the hosted fit is unmeasured |
