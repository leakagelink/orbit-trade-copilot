# Futures paper worker — technical design (Phase 4E, Workstream D)

**DESIGN ONLY.** No worker exists, nothing is deployed, started, activated or scheduled, and no route or cron entry is
added. The restored 13 Nov 2026 export contains three pre-existing scheduled jobs (`paper-engine-tick` →
`/api/public/engine/tick`, the existing bot engine; `trade-price-alerts`; `ai-autopilot-tick`) and **none** for the
Futures paper engine. Implementing this design needs: approval of draft 0046 (or its successor, see C6/C7), the
owner decisions in the register, and a separate activation approval.

## 1. Building blocks (existing, unchanged)
* `stepFuturesPaperCandle(prev, cfg, bars, intents, ctx)` — pure; one account-wide candle for every symbol of the
  account under one account cursor; validates every input before stepping anything; returns state, events, trades,
  decisions, refusals and the exact marks (candle mark opens) the payload must carry.
* `futuresPaperCommitPayloadV2(prev, next, events, marks, cost)` — pure payload builder (deterministic fill ids).
* `futures_paper_commit_bar_v2(account, expected_seq, bar_t, payload)` — draft 0046; locks the account row,
  compare-and-sets `seq`/`cursor_t`, re-validates every fill, writes events/positions/commit atomically; identical
  payload replay is idempotent.
* `planCommitRefusal(prev, attempt, message, alreadyRefused)` — classifies a refusal into `recompute` (fill refused →
  cancellation), `reload_account`, `wait` or `halt_for_review`; the same refusal twice or anything unclassified halts.

## 2. One tick for one account (state machine)

```text
LOAD   read account row (status, halted, seq, cursor_t, state, config) + strategy budgets + other-account usage (SELECT)
NEXT   bar_t = cursor_t + tf; if bar_t + tf > now − closeGrace → WAIT (candle not closed)
FETCH  public GET klines/mark/index/funding for every account symbol at bar_t (allowlisted, credential-free)
       missing / invalid / misaligned candle for ANY held symbol → DATA_GAP (no commit; retry next tick; alert after N)
STEP   r = stepFuturesPaperCandle(state, account.config ⊕ table budgets, bars, intents, ctx)    (pure; throws → DATA_GAP)
BUILD  payload = futuresPaperCommitPayloadV2(state, r.state, r.events, r.marks, account cost)
COMMIT futures_paper_commit_bar_v2(account, state.seq, bar_t, payload)  in ONE transaction, ONE account
   ok                → advance (seq, cursor) from the database's reply, record metrics, next account
   refusal           → plan = planCommitRefusal(state, r, message, refused)
        recompute    → STEP again with ctx.refused = plan.refused and freshly re-read usage (≤ 3 attempts per candle)
        reload       → re-LOAD and start over (no recompute of stale state)
        wait         → stop this account for this tick
        halt_review  → stop the account (status unchanged); record reason code; alert; never loop
   lost response     → resend the IDENTICAL payload once (0046 returns the committed seq idempotently);
                       still unknown → stop; next tick re-LOADs (cursor tells the truth)
```

## 3. Requirements by topic

| Topic | Design |
|---|---|
| Account cursor | `cursor_t` in the database is authoritative; the engine's `accountCursor` must equal it after LOAD, otherwise reload. One candle per commit; no batching across candles (keeps every commit independently verifiable). Catch-up after downtime: process missed candles in order, bounded per tick (e.g. ≤ 30 candles/account/tick) so one account cannot starve others. |
| Locking | Database: the commit function's row lock on the account + ordered budget locks (no deadlock, finding C10). Worker: at most ONE account per transaction; a lease per account (`pg_try_advisory_xact_lock(hashtext('fp-worker:' || account_id))` or a lease row) prevents two workers stepping the same account; losing the lease is harmless because the commit is compare-and-set. |
| Idempotency | Deterministic engine + deterministic fill ids + payload SHA-256 stored per commit: an interrupted tick recomputes the identical payload; a replay of the same payload returns the same seq; a different payload for a committed candle is refused (`CANDLE_ALREADY_COMMITTED` → reload). |
| Duplicate / out-of-order candles | Refused twice: the engine (account cursor and per-symbol cursors) and the database (`bar_t ≤ cursor_t` or misaligned). The fetcher requests exactly `bar_t`; extra or older candles are dropped before STEP. |
| Restart / crash recovery | No in-memory state survives a tick. Crash before COMMIT → nothing written (Phase 4D real-PostgreSQL test). Crash after COMMIT before the reply → next tick re-LOADs and continues from the committed cursor. No "resume" path replays actions. |
| Bounded retries | Fetch: ≤ 2 attempts per candle per tick with backoff; commit recompute: ≤ 3 per candle; lost-response resend: exactly 1; never a blind retry after an unclassified error. |
| Database failures | Connection/timeouts → stop the tick for that account (state unknown → reload next tick). Constraint/function refusal → `planCommitRefusal`. Serialization/deadlock errors (not expected) → one retry from LOAD, then halt_for_review. |
| Data failures | Missing mark/index/funding, stale candle, misalignment → no commit (the engine refuses the whole candle); the account waits; after a configurable number of consecutive gaps (owner decision) an alert is raised. The worker never fabricates or forward-fills prices. |
| Halt / pause | Read from the account row every LOAD; the database refuses entries while halted/paused; exits keep running. The worker cannot un-halt. |
| Isolation | Imports only the pure engine, payload builder, public market reader and a service-role database client; an import-graph test must forbid order, exchange-signing, credential, wallet, Autopilot, Central Risk shadow and AI modules (same pattern as the Spot paper worker). |
| Monitoring | Per account and tick: candles committed, lag (`now − cursor_t`), refusals by code, recompute count, halts, data gaps, commit latency, payload size. Alerts: lag > N candles, any `halt_for_review`, repeated data gaps, commit error rate. Metrics contain no prices beyond public data and no credentials. |
| Resources | Per account-candle: 3–4 public GET requests (klines, mark, index, funding) per symbol, one function call, ~1–4 KB payload. 1 m timeframe, 2 symbols: ~8 requests and 1 commit per minute per account; storage per account-year see the decision register (retention). Fits the existing cron + Worker model (one short tick per minute, bounded accounts per tick); no paid infrastructure required for a handful of accounts. |

## 4. Tests required before any activation
Crash at every step (before/after commit, before reply); lost response replay; two workers on one account; two accounts
of one owner sharing a strategy budget (exists, Phase 4D); data gap on a held symbol; duplicate and out-of-order candle
inputs; halt mid-candle; catch-up bound; refusal loop (same refusal twice → halt); import-graph isolation; no
schedule/route created by the code (static test).

## 5. Explicitly not done
No worker code, no route, no cron/schedule, no account created, no migration applied, no activation.
