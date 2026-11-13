# Strategy attribution — correction semantics review (Phase 4E, Workstream B)

Status: **draft 0048 written as the reviewed successor of draft 0047. Neither is applied.** 0048 supersedes 0047 and
reuses the same object names: **never apply both.** 0047 and its rollback are left byte-identical
(`42d3c65e…249801b` / `bb980bbc…755ae8`, checked by a test). Numbers are proposals; the owner assigns the final number.

## 1. Weaknesses found in draft 0047

| # | Weakness | Consequence | 0048 resolution |
|---|---|---|---|
| W1 | A correction had `qty = 0` and a free `amount`; nothing said whether `amount` replaced or adjusted the original | Two readers could compute different totals from the same rows; quantities of fills and reductions could not be corrected at all | A correction **restates** the full effective value of one ORIGINAL event (`corrected_qty`, `corrected_amount`) — replacement semantics, never a delta |
| W2 | Σ reductions ≤ Σ fills was checked on raw rows only | After a fill was corrected down, reductions could exceed what was actually filled | Every reduction and every correction is checked against **effective** totals (latest revision of each original) |
| W3 | Any number of corrections of the same event (different evidence refs) were allowed | Under delta semantics: double counting; under replacement: ambiguous "latest" | One linear chain per original: revisions 1, 2, … ≤ 20; the caller names the revision it creates (compare-and-set) |
| W4 | Reductions carried a free `amount` that the 0047 tests summed together with fees and funding | A second, ambiguous P&L source next to `public.trades` | Fills and reductions carry quantity only (`amount = 0`); fees and funding carry amount only; realized P&L stays in `public.trades` |
| W5 | No effective-totals read model | Every consumer would re-implement correction logic | Two security-invoker views: `futures_strategy_attribution_effective` (per original event) and `futures_strategy_attribution_totals` (per entry order) |
| W6 | Correction rows could carry their own `position_id` / `trade_id` | Lineage of a correction could diverge from the original | Corrections inherit lineage: `position_id` and `trade_id` must be NULL |

## 2. Correction rules in 0048

| Original kind | What a correction restates | Allowed restated values | Effect on totals |
|---|---|---|---|
| `entry_fill` | quantity | `corrected_qty ≥ 0` (0 = voided), `corrected_amount = 0` | `filled_qty` uses the restated quantity |
| `reduction` | quantity | `corrected_qty ≥ 0` (0 = voided), `corrected_amount = 0` | `reduced_qty` uses the restated quantity |
| `fee` | amount | `corrected_qty = 0`, `corrected_amount ≤ 0` (a correction cannot make a fee positive) | `fees` uses the restated amount |
| `funding` | amount | `corrected_qty = 0`, any finite `corrected_amount` (paid or received) | `funding` uses the restated amount |
| `correction` | — | refused: a correction never corrects a correction | — |

Invariant after every insert (fill, reduction or correction): **effective reduced ≤ effective filled**, so
`open_qty = filled − reduced ≥ 0`. A fill can be voided only while the remaining effective fills still cover the
effective reductions.

Refused correction shapes, each with a test: stale revision (someone else wrote it first), skipped revision, revision
0 / NULL / > 20, a fork (two corrections claiming the same revision — also blocked by
`UNIQUE (corrects_event_id, correction_revision)`), a no-op restatement equal to the current effective value
("repeated"), duplicate evidence (`UNIQUE (entry_order_id, kind, evidence_ref)`), a correction of a correction, a
reference to another order's event, a reference to a missing event, a self-reference (forced id), negative / NaN /
infinite values, a missing reason, and a correction carrying its own position or trade.

Circularity is impossible by construction: a correction may only reference an earlier (`corrects_event_id < id`),
existing ORIGINAL event, and originals reference nothing.

## 3. Concurrency

Every event of one attributed order (fill, reduction, fee, funding, correction) first locks that order's identity row
(`FOR UPDATE`). The effective totals and the next revision number are computed under that lock, so:

* a correction and a reduction racing on the same order are serialized; whichever commits second is re-checked against
  the committed effective totals;
* two corrections of the same original that both claim revision N: one commits, the other is refused as stale.

Real-PostgreSQL evidence (`src/test/phase4e-attribution-concurrency.pg.test.ts`, separate sessions, both orders, 3
runs): see the final report, section 6.

## 4. Preserved from 0047 (unchanged)

Identity captured only inside the claim transaction of a pending USD-M Futures entry order (testnet/production), bound
to owner, environment and idempotency key; consistent retries (`existing`) and refused conflicting retries; exit orders
never get an identity; append-only for every role; owner-only, MFA-aware reads; no browser writes and no function
execute for browser roles; **legacy trades stay UNATTRIBUTED** and nothing infers historical strategy identity from
`bot_id`, the mutable `trades.strategy_id`, symbol, notes or configuration similarity. No change to `public.orders`,
`public.positions` or `public.trades`; no backfill.

Real-export check (restored 13 Nov 2026 backup, local only): all 7 existing USD-M Futures trades read UNATTRIBUTED
after applying 0048, and an attempt (inside a rolled-back transaction) to give the oldest existing USD-M Futures order an
identity was refused.

## 5. Not done (not authorized)

Applying 0047 or 0048; the order-path change that would call `claim_futures_order_strategy_identity` inside the claim
transaction; writing attribution events from any execution path; connecting attribution to Central Risk.
