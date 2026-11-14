
#### `src/test/futures-paper-0051.pg.test.ts` — 4 skipped
- 0051 completeness on real PostgreSQL sessions > six sessions commit the same stop-out candle at once: one commit, one exit, one completeness record; all return the same sequence
- 0051 completeness on real PostgreSQL sessions > an omitting writer racing a correct writer (5 accounts): the omission never commits; every account ends stopped out
- 0051 completeness on real PostgreSQL sessions > two accounts of one owner stop out concurrently: both commit; strategy usage equals the closed losses in the ledger
- 0051 completeness on real PostgreSQL sessions > a backend killed while its commit waits on the account lock writes nothing; the retried candle commits once

#### `src/test/futures-paper-0052.pg.test.ts` — 5 skipped
- 0052 on real PostgreSQL sessions > six sessions commit the same stop-out of a STOPPED account at once: one commit, one exit; the account stays stopped
- 0052 on real PostgreSQL sessions > an omitted entry fill racing the correct writer (5 accounts): the omission never commits; each entry fills exactly once
- 0052 on real PostgreSQL sessions > a stop request racing a commit that fills: either the fill commits before the stop, or the stopped account refuses the fill — never a fill after the stop
- 0052 on real PostgreSQL sessions > eight sessions change one strategy budget at once: versions 1..9 without gaps or forks, one unbroken hash chain
- 0052 on real PostgreSQL sessions > a backend killed while its stopped-account exit waits on the account lock writes nothing; the retried candle commits once

#### `src/test/futures-paper-0054.pg.test.ts` — 4 skipped
- 0054 on real PostgreSQL (throwaway, local) > a disable waits for an in-flight writing worker call, then every later call is refused
- 0054 on real PostgreSQL (throwaway, local) > an owner revocation waits for an in-flight writing worker call, then the account is unreachable
- 0054 on real PostgreSQL (throwaway, local) > a disable committed first refuses a worker call that was waiting for it (the worker re-reads the row)
- 0054 on real PostgreSQL (throwaway, local) > twelve sessions racing enable/disable leave one consistent state and a gap-free, alternating history

#### `src/test/futures-paper-ledger-concurrency.pg.test.ts` — 2 skipped
- draft 0045 under real concurrent sessions > racing workers commit every candle exactly once; the ledger reconciles with a single-threaded replay
- draft 0045 under real concurrent sessions > concurrent halts and commits: no entry event is ever written after the halt commits

#### `src/test/futures-paper-ledger-v2-concurrency.pg.test.ts` — 3 skipped
- draft 0046 under real concurrent sessions > racing workers commit every candle exactly once; the ledger and the database book reconcile with a single-threaded replay
- draft 0046 under real concurrent sessions > two accounts of one owner filling at the same moment cannot jointly exceed one strategy budget
- draft 0046 under real concurrent sessions > a worker killed before COMMIT leaves nothing behind; the retry commits exactly once; a lost response replays idempotently

#### `src/test/futures-paper-ledger-v3-concurrency.pg.test.ts` — 5 skipped
- draft 0049 under real concurrent sessions > racing workers commit every candle exactly once; approvals, fills, ledger and book reconcile with a single-threaded replay
- draft 0049 under real concurrent sessions > two accounts of one owner approving at the same moment cannot jointly exceed one strategy budget (pending risk counts)
- draft 0049 under real concurrent sessions > one approval can be consumed only once: a racing fill and cancellation of the same candle — exactly one commits
- draft 0049 under real concurrent sessions > concurrent budget configuration writes cannot over-allocate a sub-budget (serialized on the account budget row)
- draft 0049 under real concurrent sessions > a worker killed before COMMIT leaves nothing behind (no approval, candle or event); the retry commits once; a lost response replays

#### `src/test/futures-paper-worker-hosted.pg.test.ts` — 8 skipped
- hosted worker connection on real PostgreSQL sessions > four workers compete for one account: fenced lease rows serialize them; every candle commits exactly once; no lease is left held
- hosted worker connection on real PostgreSQL sessions > a stalled holder whose lease was taken over cannot commit (fencing); the new holder finishes; nothing is duplicated
- hosted worker connection on real PostgreSQL sessions > client timeout WITH server-side cancellation: nothing is written; the next tick commits each candle once
- hosted worker connection on real PostgreSQL sessions > client timeout WITHOUT cancellation (the server finishes later): the first attempt commits, the resend replays it; the next tick continues — exactly once
- hosted worker connection on real PostgreSQL sessions > a backend killed in the middle of a commit: the transaction rolls back; no halt; the candle is committed once later
- hosted worker connection on real PostgreSQL sessions > two independent accounts (different owners) processed concurrently: both complete; neither waits for the other's lease
- hosted worker connection on real PostgreSQL sessions > same-owner budget race through the gateway: one approval is refused and becomes a rejection — usage never exceeds the budget
- hosted worker connection on real PostgreSQL sessions > G3: on 0049 alone a REPEATABLE READ caller overspends a shared budget; READ COMMITTED does not; the 0050 gateway refuses REPEATABLE READ

#### `src/test/futures-paper-worker.pg.test.ts` — 8 skipped
- Futures paper worker on real PostgreSQL sessions > lease contention: four workers on one account — advisory-lock leases serialize them; every candle commits exactly once
- Futures paper worker on real PostgreSQL sessions > no lease at all: racing workers still commit every candle exactly once (compare-and-set + idempotent identical replay)
- Futures paper worker on real PostgreSQL sessions > a torn (non-snapshot) load is re-read once instead of pausing the account; a persistent mismatch still halts
- Futures paper worker on real PostgreSQL sessions > crash BEFORE COMMIT (backend killed inside the transaction): nothing is written, the lease dies with the session, another worker continues
- Futures paper worker on real PostgreSQL sessions > crash AFTER COMMIT (process dies before reading the reply): the next worker reloads the committed cursor; nothing is duplicated
- Futures paper worker on real PostgreSQL sessions > restart recovery: a worker killed every few candles ends identical to an uninterrupted run
- Futures paper worker on real PostgreSQL sessions > cross-account budget race: two workers on two accounts of one owner approve at once; the database serializes on the budget row, one approval is refused and becomes a rejection — usage never exceeds the budget
- Futures paper worker on real PostgreSQL sessions > multi-symbol atomicity: a candle refused for one symbol writes nothing for the other; the account is paused for review

#### `src/test/paper-ledger-concurrency.pg.test.ts` — 7 skipped
- draft 0044 under genuinely concurrent database sessions > two workers processing the same account at once: every candle once, ledger identical to a single worker
- draft 0044 under genuinely concurrent database sessions > duplicate candle: 12 sessions commit the same candle, exactly one succeeds
- draft 0044 under genuinely concurrent database sessions > two strategies competing for the same exposure: the database refuses the stale one, it recovers, limits never exceeded
- draft 0044 under genuinely concurrent database sessions > concurrent entry near the daily loss limit: an entry committed after the loss is refused, one committed before it stands
- draft 0044 under genuinely concurrent database sessions > emergency paper stop during an active candle: the stop waits for the candle, later entries are refused; a stop first refuses the entry
- draft 0044 under genuinely concurrent database sessions > worker crash mid-commit (connection killed): nothing partial is stored; recovery equals an uninterrupted run
- draft 0044 under genuinely concurrent database sessions > two users processed simultaneously by separate workers: separate ledgers, identical to running each alone

#### `src/test/phase4d-concurrency.pg.test.ts` — 3 skipped
- (a) draft 0046 + engine: concurrent fills against one strategy budget (real PostgreSQL, separate sessions) > one fill wins, the other is refused by the ledger, planned and recomputed into a cancellation; both accounts advance
- (b/c) draft 0047: concurrent attribution writes (real PostgreSQL, separate sessions) > two simultaneous partial reductions of 0.6 against a 1.0 fill: exactly one commits
- (b/c) draft 0047: concurrent attribution writes (real PostgreSQL, separate sessions) > the same evidence inserted simultaneously from two sessions is attributed once

#### `src/test/phase4e-attribution-concurrency.pg.test.ts` — 7 skipped
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > fill 1.0 restated to 0.5 vs a 0.6 reduction (correction first): exactly one commits; reductions never exceed effective fills
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > fill 1.0 restated to 0.5 vs a 0.6 reduction (reduction first): exactly one commits; reductions never exceed effective fills
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > two simultaneous revision-1 corrections of one fee (identical values): exactly one commits, the other is stale
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > two simultaneous revision-1 corrections of one fee (different values): exactly one commits, the other is stale
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > reduction 0.5 restated to 0.8 vs a new 0.4 reduction on a 1.0 fill (correction first): exactly one commits
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > reduction 0.5 restated to 0.8 vs a new 0.4 reduction on a 1.0 fill (reduction first): exactly one commits
- draft 0048: concurrent corrections and reductions (real PostgreSQL, separate sessions, both orders) > two simultaneous 0.3 reductions against a fill corrected down to 0.5: exactly one commits

#### `src/test/research-budget-concurrency.pg.test.ts` — 10 skipped
- atomic research budget reservations under concurrent sessions > platform monthly cap: 24 users racing in 24 sessions never exceed it
- atomic research budget reservations under concurrent sessions > per-user daily cap: two runs of the same user racing in 20 sessions never exceed it
- atomic research budget reservations under concurrent sessions > per-user monthly cap under concurrency
- atomic research budget reservations under concurrent sessions > per-run cap: parallel calls inside one run never exceed it
- atomic research budget reservations under concurrent sessions > call limit under concurrency
- atomic research budget reservations under concurrent sessions > a second reservation waits for the first session's transaction, then sees it
- atomic research budget reservations under concurrent sessions > settlement reconciles concurrently: freed headroom is granted exactly once
- atomic research budget reservations under concurrent sessions > exactly one of 20 concurrent workers can claim a run
- atomic research budget reservations under concurrent sessions > cancellation racing a reservation: closing the run waits for the reservation, then every later call is refused
- atomic research budget reservations under concurrent sessions > control: the same checks without the lock DO overshoot (so these tests can detect a race)
