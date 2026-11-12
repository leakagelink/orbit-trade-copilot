# Shadow input contract

## Status
DESIGN ONLY

**Designed but not implemented:** this document specifies future boundary validation. Existing types are not proof of runtime validation at every boundary. Missing inputs never become permissive defaults. REJECT and INSUFFICIENT_DATA affect only the shadow record.

## Common rules

Every external snapshot must match owner, connection (where applicable), immutable environment and symbol/strategy scope, with finite numbers, valid timestamps, explicit provenance and an approved freshness policy. Missing/stale source snapshots → INSUFFICIENT_DATA; invalid ticket/schema or known limit violations → REJECT. A simultaneous explicit failure dominates missing data in the existing evaluator (`src/lib/central-risk.ts:59-61`).

All freshness limits below are **PROPOSED, NOT APPROVED**. "Same evaluation" reads are not a transactionally consistent snapshot.

## 1. Ticket and invocation inputs

Authoritative ticket schema: `src/lib/futures.ts:2-8`. Shadow subset: `src/lib/central-risk-shadow.ts:19-24`.

| Canonical input / type | Authoritative source | Freshness / validation | Failure |
|---|---|---|---|
| `connectionId: string` | Validated ticket + stored connection | UUID; equals bound connection | REJECT |
| `symbol: string` | Ticket | `^[A-Z0-9]{2,16}/USDT$`; normalized only for lookups | REJECT |
| `side: "buy"\|"sell"` | Ticket | Exact enum | REJECT |
| `margin: number` | Ticket | Finite, positive; comparison only | REJECT |
| `leverage: number` | Ticket | Integer 1–20; comparison only | REJECT |
| `slPct`, `tpPct: number` | Ticket | Finite, 0.05–5 % | REJECT |
| `holdMin: number` | Ticket only | Integer 1–240; intentionally absent from ShadowTicket | REJECT malformed ticket; no invented field |
| `requestId: string` | Ticket | UUID; original value retained | REJECT |
| `confirmation: "TESTNET"\|"LIVE"` | Ticket | Must match stored immutable environment | REJECT |
| `account.connectionId`, `account.testnet` | Owner-bound stored connection | Never inferred from `confirmation` | INSUFFICIENT_DATA if unverified; REJECT on mismatch |
| `userId: string` | Authenticated owner context | Ownership verified before evaluation | INSUFFICIENT_DATA |
| `strategyId: string` | Approved intent identity; today caller/default | Non-empty ≤ 200; default `manual-futures` is not attribution | INSUFFICIENT_DATA when attribution unverified |
| `proposalCreatedAt: number` | Captured intent timestamp | Positive integer ms; proposed ≤ 60 s age | REJECT invalid/expired; INSUFFICIENT_DATA unknown |
| `ports.now(): number` | Trusted server clock | Finite integer epoch ms | INSUFFICIENT_DATA |
| Verified `{markPrice,time}` | Environment-specific mark source | Finite > 0; proposed age ≤ 5 s | INSUFFICIENT_DATA (missing) |

**Implemented and tested:** the adapter checks account/environment and derives stop/target from the verified mark, not ticket prices (`src/lib/central-risk-shadow.ts:35-45`); the shape-compatibility test covers `holdMin` only on the real ticket (`src/test/central-risk-shadow.test.ts:199-201`).

## 2. Source-to-field mapping matrix

Statuses reproduce `SHADOW_SOURCE_MATRIX` (`src/lib/central-risk-shadow.ts:55-71`). READY means a declared source exists, not that integration is approved.

| Input / matrix status | Context fields | Source and validation | Freshness / failure |
|---|---|---|---|
| Account risk limits / READY | `limits.maxExposure, maxDailyLoss, maxPositions` | `risk_settings`; finite positive caps, integer positions | Same evaluation; missing → INSUFFICIENT_DATA |
| Futures limits / READY | `limits.maxLossPerTrade, maxMarginPerTrade, maxLeverage` | Production `futures_settings`; Testnet fixed `TESTNET_FUTURES_LIMITS` | Same evaluation; missing → INSUFFICIENT_DATA |
| Strategy budget / BLOCKED | `strategy.budget` | `strategy_risk_budgets.max_loss` (draft); owner/strategy/environment match | Same evaluation; missing → INSUFFICIENT_DATA |
| Strategy attribution / BLOCKED | `strategy.usedLoss` | COMPLETE attribution: realized net loss + reserved open risk, ≥ 0 USDT | Proposed ≤ 5 s; incomplete/missing/stale → INSUFFICIENT_DATA |
| Open positions / READY | `account.openPositions`, `orders.openPositionOnSymbol` | Owner/environment-filtered open positions | Same evaluation; unknown → INSUFFICIENT_DATA; existing symbol → REJECT |
| Current exposure / READY | `account.openExposure` | Σ entry × quantity, finite ≥ 0 USDT | Same evaluation; invalid → INSUFFICIENT_DATA |
| Pending/unknown orders / READY | `orders.unresolvedOrders` | Production account-wide; Testnet Testnet-only | Unknown → INSUFFICIENT_DATA; > 0 → REJECT |
| Duplicate / READY | `orders.sameProposalSeen` | Owner + `idempotency_key = futures:<requestId>` | Unknown → INSUFFICIENT_DATA; true → REJECT |
| Daily loss / READY | `account.dayNet` | UTC-day `tradeNet` + negative unrealized | Incomplete → INSUFFICIENT_DATA |
| Emergency stop / READY (shared) | `account.halted, environmentHalted` | `risk_settings.trading_halted` | Unknown → INSUFFICIENT_DATA; on → REJECT |
| Mark/time / READY Live only | `market.markPrice, markTimestamp` | Live `premiumIndex`; Testnet none | Proposed ≤ 5 s; missing → INSUFFICIENT_DATA |
| Lot/minNotional / READY Live only | `market.stepSize, minNotional` | Live `exchangeInfo` | Unknown → INSUFFICIENT_DATA |
| Maintenance rate / BLOCKED | `market.maintenanceMarginRate` | Bracket covering candidate notional; `0 < ratio < 1` | Proposed ≤ 1 h; uncovered/missing/stale → INSUFFICIENT_DATA |
| Available margin / BLOCKED | `account.availableMargin` | Bound Futures account `availableBalance`, ≥ 0 USDT | Proposed ≤ 5 s; unknown/stale → INSUFFICIENT_DATA |
| Proposal age / READY, policy unapproved | `now`, `createdAt`, `limits.maxProposalAgeMs` | Server clock vs preserved timestamp | Expired → REJECT |
| Strategy identity / READY (label only) | `proposal.strategyId` | Caller label; not lineage | Unverifiable coverage → INSUFFICIENT_DATA |
| Not in matrix | `account.equity` | Builder sets null; unused for sizing | No fallback |
| Policy / NOT APPROVED | `limits.liquidationBufferPct, maxDataAgeMs, maxProposalAgeMs, roundTripCostPct` | Proposed 2 %, 5000 ms, 60000 ms, 0.13 % | Owner approval required |

Builder queries and mappings: `src/lib/central-risk-context.server.ts:53-100`. Context types: `src/lib/central-risk.ts:29-43`.

**Designed but not implemented:** strict snapshot validators (see `risk-data-contracts.md` and the pure validators in `src/lib/risk-data-contracts.ts`) must run before scalar port adaptation; today's ports omit most source timestamps and scope metadata (`src/lib/central-risk-context.server.ts:28-36`).

**Implemented and tested (discrepancy noted):** today a stale mark is REJECT, not INSUFFICIENT_DATA (`src/lib/central-risk.ts:82-84`; `src/test/central-risk-shadow.test.ts:94-97`). The future source contract (stale → INSUFFICIENT_DATA at the source boundary) must not be described as implemented.

## 3. Proposal and decision contracts

| Classification | Fields / mapping / validation |
|---|---|
| Implemented and tested | `TradeProposal`: `proposalId=requestId`; `engine="futures_ticket"`; `strategyId`; `symbol`; `market="usdm_futures"`; environment `testnet`/`live`; LONG/SHORT; `referencePrice=null`; stop/target = mark × ticket %; `createdAt=proposalCreatedAt` (`src/lib/central-risk-shadow.ts:40-45`) |
| Implemented and tested | Strict proposal schema; no quantity/leverage/authorization fields (`src/lib/central-risk.ts:14-26`) |
| Implemented and tested | `RiskDecision {version, proposalId, verdict, checks, sizing, executionAuthorized:false, note}` (`src/lib/central-risk.ts:10-12,44-46`) |
| Implemented and tested | Sizing `{qty, notional, margin, leverage, riskAmount, entryEstimate, liquidationPrice, binding}`, null unless ACCEPT (`src/lib/central-risk.ts:44,59-61,149`) |
| Designed but not implemented | Non-finite financial output → INSUFFICIENT_DATA; never zeros or a manufactured ACCEPT |

## 4. ShadowRecord projection

Record construction is **Implemented and tested** (`src/lib/central-risk-shadow.ts:89-133`); the strengthening above is **Designed but not implemented**.

| Fields | Source / rule |
|---|---|
| `recordVersion, riskEngineVersion, policyVersion` | Constants; policy explicitly NOT APPROVED |
| `proposalId` | Adapted proposal id or null |
| `correlationId` | `futures:<requestId>` |
| `accountId` | Internal connection UUID (not an exchange account id) |
| `strategyId, environmentLabel, symbol, direction` | Invocation identity, stored environment, ticket symbol/side |
| `proposalTimestamp, evaluationTimestamp, marketDataTimestamp` | Captured proposal time, finish clock, mark time or null |
| `verdict` | Evaluator result; adapter failure REJECT; missing/error INSUFFICIENT_DATA |
| `failedChecks, checks` | Failed subset and full `{id,status,detail}[]` |
| `missingInputs` | Sorted, deduplicated missing checks, context fields and failed reads |
| `sizing` | `{qty, notional, margin, riskAmount, binding}` only on ACCEPT |
| `proposedLeverage, proposedLiquidationBufferPct, liquidationPriceEstimate` | Engine values on ACCEPT; estimates, not exchange liquidation authority |
| `ticketComparison` | `{ticketNotional = margin×leverage, ticketLeverage, withinEngineSize, withinEngineLeverage}`; null comparisons without sizing |
| `reads` | `{source, ok, detail, observedAt}[]` (observation time ≠ source update time) |
| `contextSnapshotHash` | Hash of context only, or null |
| `evaluationDurationMs` | `max(0, finishedAt − startedAt)` |
| `internalError` | Text or null; future safe-code redaction required |
| `executionAuthorized, affectsOrderPath, shadowOnly` | Literal `false`, `false`, `true` |
| `note` | Fixed non-authorizing note |

**Designed but not implemented:** the last-resort record is only shallow-frozen (`src/lib/central-risk-shadow.server.ts:70-80`), unlike the deep-freeze path.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
