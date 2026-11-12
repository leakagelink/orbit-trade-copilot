# Risk source approval matrix

## Status
BLOCKED

**Requires separate owner approval:** this matrix requests no permission and enables nothing. Every approval belongs to the owner and must be explicit, scoped and recorded separately.

| Input | Current status | Approval needed | Risk of granting | Tests required before enabling | Approver |
|---|---|---|---|---|---|
| `strategy_risk_budget` | BLOCKED — table only in drafts | Review and apply proposed successor 0046 (supersedes 0045); approve budget semantics (per strategy, per environment, cumulative) | Wrong owner/environment budget; draft mistaken for deployed schema | missing relation/row → INSUFFICIENT_DATA; RLS/owner isolation; environment isolation; invalid/future timestamps; revision races | Owner |
| `strategy_loss_attribution` | BLOCKED — no strategy identity on real orders/positions/trades | Attribution migration + order-path change capturing immutable strategy id/version/config hash at intent claim; correction ledger; accounting policy | Retroactive fabricated lineage; omitted losses; cross-strategy netting; changed execution behaviour | claim-time immutability; partial-fill/reduction pro-rata; legacy coverage; duplicate reconciliation; append-only corrections; fees/funding completeness | Owner |
| `maintenance_margin_rate` | BLOCKED — endpoint not allowlisted | Allowlist signed `GET /fapi/v1/leverageBracket` on the Live adapter AND permit credential decryption in a read-only shadow port (Testnet reviewed separately) | Expanded signed capability; secret exposure; wrong liquidation estimates; environment leakage | exact host/path/method; environment-bound credentials; bracket coverage/boundaries; stale/future; redaction | Owner |
| `available_margin` | BLOCKED — decryption in shadow path not approved | Permit credential decryption inside a narrowly scoped read-only port using the already allowlisted `GET /fapi/v3/account` (no allowlist change) | Account-data disclosure; stale margin treated as capital | owner/connection/environment binding; no wallet or Spot fallback; zero balance; timestamps; timeout/redaction; no write capability | Owner |
| Testnet mark + lot/minNotional | DESIGN ONLY — ports return null by design | Approve use of the Testnet host's public `premiumIndex`/`exchangeInfo` (already on the frozen Testnet adapter's allowlist) through a narrow unsigned read port | Production/Testnet contamination; accidental signed request; stale price/filter pairing | Testnet host only; those two paths only; no signing; no production fallback; symbol/age/range | Owner |
| Policy values (2 % buffer, 5 s data age, 60 s proposal age, 0.13 % cost) | NOT APPROVED | Individual owner decision per value (or per strategy) | Over-permissive or over-restrictive limits | regression tests pinning each approved value | Owner |

## Verified boundaries

| Classification | Fact |
|---|---|
| Implemented and tested | Exact allowlist includes GET `premiumIndex`, `exchangeInfo`, `/fapi/v3/account`; `leverageBracket` absent (`src/lib/binance-futures-env.ts:42-49`) |
| Implemented and tested | Hosts frozen: Testnet `https://testnet.binancefuture.com`, Live `https://fapi.binance.com` (`src/lib/binance-futures-env.ts:6-9`) |
| Implemented and tested | Separate frozen adapters delegate to the core, which validates before signing (`binance-futures-live.server.ts`, `binance-futures-testnet.server.ts`, `binance-futures-core.server.ts`) |
| Blocked by missing data | Shadow Testnet ports deliberately return null despite adapter capability (`src/lib/central-risk-shadow.server.ts:28-29`) |
| Requires separate owner approval | Adapter capability is not permission for shadow to import it; the import-graph test forbids it (`src/test/central-risk-shadow.test.ts:230-234`) |

Missing or stale sources → INSUFFICIENT_DATA. No signed call, decryption, allowlist edit, database deployment or live observation occurred in Phase 4C. Approving a data source does not approve integration, persistence, execution or a scheduler.

No migrations were applied. No orders were placed. Nothing in this document is connected to any order path.
