# Risk data contracts

## Status
BLOCKED (design only — every source is blocked; pure validators exist and are not wired to anything)

**Designed but not implemented:** the canonical snapshots below are the target contract for each missing input. `src/lib/risk-data-contracts.ts` implements them as pure validators (no I/O, no imports of any order, exchange, credential or database module; nothing imports it — `src/test/phase4c-isolation.test.ts`; behaviour in `src/test/risk-data-contracts.test.ts`). A passing validator is not a data source and authorizes nothing.

## Shared boundary

- Money is finite USDT; ratios are unitless in (0, 1); timestamps are integer Unix epoch ms.
- Every snapshot is bound to owner, immutable connection environment and exact symbol/strategy scope. Contract `"production"` maps to evaluator `"live"` only after validation; `"testnet"` never maps to Live; paper never uses real account snapshots.
- Missing, null, non-finite, out-of-range, stale, future-dated, wrong-environment, wrong-scope or incomplete → **INSUFFICIENT_DATA**. No inferred substitute ever.
- Every maximum age is **PROPOSED, NOT APPROVED** (owner decision).
- Critical constraints: do not add or call signed endpoints; do not expand the adapter allowlist; do not decrypt credentials; do not infer available margin from wallet balance; do not infer maintenance margin from leverage alone; do not substitute Spot balances for Futures account data.

## Canonical types

```typescript
type Environment = "paper" | "testnet" | "production";
type StrategyRiskBudgetSnapshot = { userId: string; strategyId: string; environment: Environment; maxLossUsdt: number; updatedAt: number; observedAt: number; source: "strategy_risk_budgets" };
type StrategyLossAttributionSnapshot = { strategyId: string; strategyVersion: number; environment: Environment; realizedNetLossUsdt: number; openRiskReservedUsdt: number; coverage: "COMPLETE" | "PARTIAL" | "NONE"; unattributedTradeCount: number; asOf: number };
type MaintenanceMarginBracketsSnapshot = { symbol: string; environment: Environment; brackets: { notionalFloorUsdt: number; notionalCapUsdt: number; maintMarginRatio: number; maintAmountUsdt: number; initialLeverage: number }[]; exchangeTime: number; fetchedAt: number; source: string };
type AvailableMarginSnapshot = { environment: Environment; connectionRef: string; availableBalanceUsdt: number; exchangeTime: number; fetchedAt: number; source: string };
type TestnetMarketSnapshot = { symbol: string; environment: "testnet"; markPrice: number; markTime: number; stepSize: number; minNotionalUsdt: number; fetchedAt: number; source: string };
```

## Per-input requirements

Every row is **Blocked by missing data**.

| Input (canonical) | Authoritative source · environment · scope | Units / validation | Timestamp · max age (PROPOSED) | Missing / stale |
|---|---|---|---|---|
| `strategy_risk_budget` → StrategyRiskBudgetSnapshot | `strategy_risk_budgets` row (draft 0045 → proposed successor 0046, not applied) · environment exact · owner + strategy | `maxLossUsdt` finite, > 0, ≤ 1,000,000 (zero budget = no allowance → REJECT downstream) | Read within the same evaluation; `updatedAt ≤ observedAt ≤ now` | INSUFFICIENT_DATA |
| `strategy_loss_attribution` → StrategyLossAttributionSnapshot | Evidence-linked immutable order → position → trade lineage (does not exist yet) · environment exact · owner + strategy (+ version scope) | Loss and reservation ≥ 0 USDT; version positive integer; `coverage = COMPLETE` and `unattributedTradeCount = 0` required | `asOf` ≤ 5 s before evaluation, not in the future | INSUFFICIENT_DATA; PARTIAL / NONE also INSUFFICIENT_DATA |
| `maintenance_margin_rate` → MaintenanceMarginBracketsSnapshot | Signed `GET /fapi/v1/leverageBracket` for the bound connection (not allowlisted) · exact environment + symbol · never paper | Non-empty, ordered, contiguous, non-overlapping; `0 ≤ floor < cap`; `0 < ratio < 1`; `maintAmountUsdt ≥ 0`; positive integer leverage; must cover the candidate notional | `fetchedAt` ≤ 1 h; `exchangeTime` not in the future | INSUFFICIENT_DATA |
| `available_margin` → AvailableMarginSnapshot | Bound Futures account `availableBalance` (signed `/fapi/v3/account`, already allowlisted for the order path; shadow decryption not approved) · exact environment · owner + connection | Finite ≥ 0 USDT; `connectionRef` is an internal reference, never an exchange UID | `fetchedAt`, `exchangeTime` ≤ 5 s; not in the future | INSUFFICIENT_DATA; wallet, equity or Spot balance never substituted |
| Testnet mark + lot/minNotional → TestnetMarketSnapshot | Testnet host `premiumIndex` + `exchangeInfo` (public, unsigned) through the frozen Testnet adapter only · `environment = testnet` · exact symbol | `markPrice`, `stepSize`, `minNotionalUsdt` finite > 0; source must be the Testnet host | `markTime` ≤ 5 s; `fetchedAt` within the evaluation | INSUFFICIENT_DATA; production prices never substituted |

Open design questions (owner): whether all strategy versions share one budget; UTC-day vs cumulative loss window and netting; fee/funding completeness rules; open-risk reservation method. Proposed used loss = `realizedNetLossUsdt + openRiskReservedUsdt`, released reservations never double-charged.

## Provenance, security and approvals

| Input | Audit metadata | Signed endpoint? | Credential decryption? | Security implications | Required tests before enabling | Approval |
|---|---|---|---|---|---|---|
| Budget | owner, row identity/revision, query time, payload hash, validator version | No | No | RLS owner isolation; service-role writes only | missing table/row, owner/env isolation, zero/negative/NaN, future update, revision race | Owner: apply 0046 + budget semantics |
| Attribution | owner/connection envelope, window, evidence ids, reconciliation cursor, correction-chain hash | No (pure computation); exchange reconciliation separate | No | Retroactive fabrication risk; must be append-only | partial fills, reductions, fees/funding, legacy gaps, mixed strategies, correction replay, staleness | Owner: migration + order-path tagging + accounting policy |
| Brackets | internal connection ref, exact host/path, symbol, response hash, acquisition time | **Yes** (`/fapi/v1/leverageBracket`) | **Yes** | Expands signed-account capability; secrets in a shadow port | allowlist refusal, cross-environment refusal, gaps/overlaps, cap boundaries, maint amount, stale/future | Owner: endpoint permission AND credential capability, separately |
| Available margin | owner, connection ref, endpoint, response hash, acquisition time | Yes (existing `/fapi/v3/account`) | **Yes** | Account-data disclosure; confused deputy; stale margin read as capital | no wallet/Spot fallback, zero margin, env mismatch, missing exchange time, staleness, redaction | Owner: read-only shadow credential capability |
| Testnet market | Testnet host/path, symbol, acquisition times, response hashes | No (public) | No | Production/Testnet contamination; accidental signing | Testnet host only, no signing headers, no production fallback, symbol/age/range | Owner: Testnet sourcing + cache policy |

## Verified current boundaries

| Classification | Fact |
|---|---|
| Implemented and tested | Shadow margin and attribution ports return null; Testnet market ports return null (`src/lib/central-risk-shadow.server.ts:24-31`) |
| Implemented and tested | Public market helper fixed to production host and exact GET paths (`src/lib/futures-public-market.server.ts`) |
| Blocked by missing data | `leverageBracket` absent from the exact allowlist; `/fapi/v3/account` present (`src/lib/binance-futures-env.ts:42-49`) |
| Implemented and tested | Core checks environment/endpoint before signing (`src/lib/binance-futures-core.server.ts`); credentials bound at decryption (`src/lib/credential-environment.server.ts`) |
| Designed but not implemented | `maintAmountUsdt` is not used by the current liquidation estimate, which ignores fees/funding (`src/lib/central-risk.ts:51-54`; simple helper `src/lib/central-risk-shadow.ts:156-163`) |

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
