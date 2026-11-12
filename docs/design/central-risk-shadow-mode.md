# Central Risk Engine — shadow mode (Phase 4B)

Status: **BUILT, NOT CONNECTED.** The shadow evaluator exists as code and tests only. No order, claim, broker-setting,
authorization, route, cron or Autopilot path calls it (import-graph test). Connecting it — even in observe-only mode —
to the live `openFutures` path is a separate owner decision.

## Flow

```text
existing Futures ticket (FuturesTicket shape)
  -> ticketToProposal            read-only adapter; stop/target from ticket % x VERIFIED mark price;
                                 ticket margin/leverage never cross over
  -> buildFuturesRiskContext      SELECT-only handle + read ports (central-risk-context.server.ts)
  -> evaluateProposal            ACCEPT / REJECT / INSUFFICIENT_DATA (central-risk.ts)
  -> buildShadowRecord           frozen, versioned record; executionAuthorized:false, affectsOrderPath:false
  -> createShadowLog             in-memory, append-only, duplicate-flagging
```

Files: `src/lib/central-risk-shadow.ts` (pure: adapter, record, log, source matrix, leverage-bracket contract),
`src/lib/central-risk-shadow.server.ts` (ports + `runShadowEvaluation`, never throws),
`src/test/central-risk-shadow.test.ts` (23 tests), `scripts/central-risk-shadow/fixtures.ts` (offline artifact).

## Shadow record (`central-risk-shadow-v1`)

proposalId · correlationId (`futures:<requestId>`, the existing idempotency key) · accountId (connection id) · strategyId ·
environmentLabel (from the connection's immutable flag, never the ticket) · symbol · direction · proposal / evaluation /
market-data timestamps · Risk Engine version · policy version (`... (NOT APPROVED)`) · verdict · failed checks · missing
inputs (field-level) · sizing · proposed leverage · proposed liquidation buffer · ticket-vs-engine comparison
(informational) · read provenance with timestamps · context snapshot SHA-256 · evaluation duration · internal error.
No credentials, keys or exchange account identifiers are stored.

**Persistence: in-memory/offline only.** No existing table has verified ownership/append-only controls for this data, and
this sprint forbids new migrations. A `risk_shadow_decisions` table (append-only, service-role insert, owner read) needs
its own draft migration and approval.

## Source-readiness matrix

| Input | Source | Status |
|---|---|---|
| Account risk limits | `risk_settings` SELECT | READY |
| Futures limits | `futures_settings` SELECT (production) / fixed Testnet limits | READY |
| Strategy risk budget | `strategy_risk_budgets` (draft 0045) | **BLOCKED** — 0045 not applied |
| Per-strategy loss attribution | port `strategyUsedLoss` | **BLOCKED** — real orders/trades carry no strategy id (needs migration + order-path tagging) |
| Open Futures positions / exposure | `positions` open, same environment | READY |
| Pending / unknown-outcome orders | `orders` pending/open/partially_filled | READY |
| Duplicate proposal | `orders.idempotency_key = futures:<requestId>` | READY |
| Daily realized + unrealized loss | `trades` since 00:00 UTC (`tradeNet`) + negative unrealized | READY |
| Emergency stop | `risk_settings.trading_halted` (shared; Testnet-only stop needs draft 0042) | READY (shared) |
| Mark price + exchange time | Live: public `premiumIndex`; **Testnet: none** | READY (Live) / unknown (Testnet) |
| Lot size + min notional | Live: public `exchangeInfo`; Testnet: none | READY (Live) |
| Maintenance-margin rate | signed `GET /fapi/v1/leverageBracket` | **BLOCKED** — not on frozen adapter allowlist |
| Available margin | existing signed `GET /fapi/v3/account` | **BLOCKED** — needs credential decryption inside shadow path |
| Proposal timestamp / age | caller clock vs. proposed max age | READY (policy NOT APPROVED) |
| Strategy identity | caller-supplied (`manual-futures` default) | READY |

With today's sources every Live and Testnet evaluation is **INSUFFICIENT_DATA** (verified by test and by the offline
artifact `docs/evaluation/phase4b-shadow-fixtures.json`).

### Data contracts for the blocked sources (designed, not connected)

* `strategy_risk_budgets(user_id, strategy_id, environment, max_loss)` — 0045 shape; read by the existing builder.
* `strategyUsedLoss(strategyId) → number | null` — needs `strategy_id` on orders/positions/trades written at claim time.
* `LeverageBracket { notionalFloor, notionalCap, maintMarginRatio, initialLeverage }[]` + pure
  `maintenanceMarginRateFor(brackets, notional)` (implemented and tested; returns null when uncovered).
* `availableMargin() → number | null` from `futuresAccountState(...).availableBalance`, read through the frozen adapter
  for the account's own environment only.

## Why shadow mode cannot affect execution

1. Import graph: `futures.server.ts`, `futures.functions.ts`, `futures-execution.ts`, `engine.server.ts`,
   `autopilot-tools.server.ts`, `futures-harness.server.ts` reach no `central-risk*` module; no non-test file imports the
   shadow modules.
2. The shadow graph reaches no order, lease, authorization, credential, exchange-adapter, wallet, bot or AI module.
3. The database handle exposes only `from().select()`; a spy proves no insert/update/delete/upsert/rpc is reached.
4. Exchange access is credential-free GET to the fixed public allowlist; Testnet never fetches production prices.
5. `runShadowEvaluation` always resolves (failures → INSUFFICIENT_DATA record), so even a future observe-only caller
   could not be interrupted by it.
6. Every record has `executionAuthorized:false`, `affectsOrderPath:false`; the adapter never carries ticket size.
