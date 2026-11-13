# Strategy attribution — draft migration 0047 (DRAFT ONLY, NOT APPLIED)

Files: `docs/proposed-migrations/0047_futures_strategy_attribution.sql` (SHA-256 `42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b`)
and `.rollback.sql` (SHA-256 `bb980bbcc5849ddd1fb671064f0fb568d6e6de1345127dfc635aa7a0f3755ae8`). Number is proposed only.

## Design choice
No column, trigger or backfill is added to `orders`, `positions` or `trades`. Identity lives in a separate insert-only
table keyed by the entry order, so today's execution paths are untouched until a separately approved order-path change
captures identity inside the claim transaction.

## Lineage
```text
orders (pending claim row, created in transaction T)
   └─ futures_order_strategy_identity  [order_id PK; owner, environment, idempotency_key, strategy_id, strategy_version,
   │                                     strategy_config_sha256; insert only in T; immutable]
   ├─ futures_strategy_attribution_events  [entry_fill qty | reduction qty (+ optional trade) | fee | funding |
   │                                        correction → original event]; unique (order, kind, evidence_ref)
positions.entry_order_id ─► orders.id
trades.position_id ─► positions.id      (one Futures close per position — unchanged)
view futures_trade_strategy_attribution: trade → position → entry order → identity → ATTRIBUTED | UNATTRIBUTED
```

## Rules enforced by the draft
| Rule | Mechanism |
|---|---|
| Captured at intent creation | Insert guard: order is `pending`, `usd_m_futures`, testnet/production, and `orders.created_at = now()` (same transaction) |
| Owner/environment/key bound | Guard compares owner, environment and idempotency key with the order row |
| Immutable | UPDATE/DELETE/TRUNCATE triggers raise for every role |
| Consistent retries | `claim_futures_order_strategy_identity`: same tuple → `existing`; different tuple → refused |
| Exit orders | Refused (exits inherit the position's lineage) |
| Partial fills / reductions | Actual quantities as events; reductions need the position, not a trade row; Σ reductions ≤ Σ attributed fills, serialized by a row lock on the identity |
| No double attribution | Unique (entry order, kind, evidence reference) |
| Corrections | New rows referencing an original event of the same order, with a reason; never a correction of a correction |
| Legacy | No identity row → UNATTRIBUTED; nothing infers identity from `bot_id`, `trades.strategy_id` (mutable), symbol, notes or similarity |
| Browser roles | Owner-only, MFA-aware SELECT; no writes; no function execute |
| Guards | SECURITY DEFINER with fixed `search_path`; EXECUTE revoked from API roles; claim function runs as invoker (service role only) |

Missing attribution must yield incomplete coverage and INSUFFICIENT_DATA wherever a strategy budget would read it
(Central Risk is NOT connected to this — not authorized).

## Fees and funding allocation
Fees and funding are recorded against the entry order whose position they belong to, each with its own evidence
reference. A position belongs to exactly one entry order (one-way mode, one position per symbol), so there is no
cross-strategy allocation; mixed-strategy exposure on one symbol is refused upstream.

## Tests
- PGlite (draft verbatim, stand-in tables with the real column names, which a test checks exist): 13 passed.
- Real PostgreSQL 17.11, separate sessions, 3 runs: concurrent partial reductions (exactly one commits) and simultaneous
  duplicate evidence (attributed once) — 2/2 each run.

Not done (not authorized): applying it, the order-path change, any backfill, connecting attribution to Central Risk.
