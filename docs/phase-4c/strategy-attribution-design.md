# Strategy attribution design

## Status
BLOCKED (design only)

**Designed but not implemented:** no existing order path or historical production record changes in Phase 4C. Implementing this needs a migration, an order-path change and explicit owner approval.

## Existing evidence

| Classification | Fact / citation |
|---|---|
| Blocked by missing data | Real `orders`, `positions` and `trades` have no strategy id/version column (verified: no `strategy_id` on these tables in `drizzle/migrations/*`); the source matrix records the gap (`src/lib/central-risk-shadow.ts:58-59`) |
| Implemented and tested | `orders.bot_id` references `trading_bots` with `ON DELETE SET NULL` (`drizzle/migrations/0000_phase1_schema.sql:175`) — a mutable, nullable link; a bot's current strategy is **not** evidence of the strategy at order time |
| Implemented and tested | Order identity: `unique(user_id, idempotency_key)` (`drizzle/migrations/0000_phase1_schema.sql:181-183`) |
| Implemented and tested | Futures linkage: `positions.entry_order_id`, `trades.position_id`, one Futures close per position (`drizzle/migrations/0036_futures_execution_hardening.sql:59-66`) |
| Implemented and tested | Durable client order ids scoped to connection (`drizzle/migrations/0036_futures_execution_hardening.sql:60-63`); `execution_environment` on positions/trades (same file) |
| Blocked by missing data | `manual-futures` is a caller/default label, not historical attribution (`src/lib/central-risk-shadow.server.ts:45`) |
| Implemented and tested | Accounting contract net = gross + funding − fees (`src/lib/trade-accounting.ts`); attribution additionally requires complete verified evidence |

## 1. Immutable identity at order creation

| Proposed property | Contract |
|---|---|
| `strategy_id` | Captured at intent-claim time (the existing `orders` claim row); owner- and environment-bound |
| `strategy_version` | Positive integer captured with the order — never looked up later from the strategy's current version |
| `strategy_config_sha256` | Hash of the canonical effective configuration, captured before submission |
| Database protection | Trigger refuses any UPDATE of identity/version/hash; NULL → value only at INSERT |
| Retries | Same `idempotency_key` must carry the same tuple; a conflicting tuple is refused |
| Projection | Positions/trades inherit lineage through existing ids (`entry_order_id`, `position_id`, `order_id`); any copied identity must equal its origin (checked by trigger) |
| Manual trades | Explicit approved manual strategy identity/version; never reinterpret today's default as history |

## 2. Trade-to-strategy linkage

```text
orders (claim): strategy_id, strategy_version, strategy_config_sha256  [immutable]
    |  attributed entry fills (filled quantity, fees)
positions.entry_order_id -> orders.id
    |
trades.position_id -> positions.id ; trades.order_id -> entry order
    |
strategy loss attribution snapshot (derived) + append-only correction events
```

## 3. Partial fills and position reductions

- Exposure, fees and reserved risk use **actual filled quantity**, never requested quantity.
- Reductions attribute pro-rata by filled quantity of the attributed entry order; cumulative reductions reconcile against remaining attributed quantity.
- Funding and fees require evidence-backed allocation without double counting; unverified costs mean coverage is not COMPLETE.
- One-way mode with one position per symbol forbids netting across strategies on the same connection/environment/symbol: a second strategy on the same symbol is refused (the evaluator already refuses an open position on the symbol, `src/lib/central-risk.ts:76-77`, but that is not attribution). Discovered mixed exposure → coverage PARTIAL → INSUFFICIENT_DATA.
- Must reconcile with `trades_one_futures_close_per_position` (`0036:66`): partial reductions cannot assume one trade row per reduction — a separate reduction-event table is required.

## 4. Legacy trades without identity

- Marked UNATTRIBUTED; **never back-filled** (no inference from bot links, symbols, notes or configuration similarity).
- Any unattributed trade in the evaluation window, or any unattributed open position, makes coverage PARTIAL → INSUFFICIENT_DATA, even if attributed losses alone fit the budget.
- COMPLETE only when the approved window contains no unattributed trades and all open risk and costs are covered.
- Freshness: `asOf` ≤ 5 s before evaluation — PROPOSED, NOT APPROVED.

## 5. Reconciliation and correction records

| Classification | Contract |
|---|---|
| Designed but not implemented | Deterministic, idempotent, evidence-linked reconciliation with internal order/position/trade references and a cursor |
| Designed but not implemented | Corrections are append-only events: id, owner/environment, affected evidence reference, reason, actor, time, prior-event reference, signed delta |
| Designed but not implemented | Original orders/positions/trades and captured identity are never UPDATEd |
| Designed but not implemented | A correction without contemporaneous evidence is refused; uncertainty stays PARTIAL |
| Designed but not implemented | Replay yields identical totals and coverage; duplicate evidence cannot charge or release risk twice |
| Requires separate owner approval | Evidence standards, correction permissions, retention and coverage-resolution policy |

## 6. Prevention of retroactive attribution

Identity columns are writable only in the INSERT of the claim row; corrections cannot set identity on legacy rows; the coverage calculation counts UNATTRIBUTED rows explicitly, so missing identity can never be read as "no loss".

## Required tests and approvals (all **Requires separate owner approval**)

- [ ] Migration + order-path identity capture approved separately from Phase 4C.
- [ ] Identity/version/hash immutable at claim and on retries.
- [ ] Owner, connection, strategy and environment isolation.
- [ ] Partial fills, reductions, fees/funding, reservation release.
- [ ] Mixed-strategy symbol refusal and PARTIAL fallback.
- [ ] Legacy UNATTRIBUTED windows and unattributed open positions.
- [ ] Append-only corrections, evidence rejection, replay, duplicates.
- [ ] Budget aggregation across strategy versions; UTC-day loss/netting policy.
- [ ] Review of successor 0046 (draft, not applied) — it implements Futures **paper** attribution only (strategy id on paper fills); it does not attribute real trades.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
