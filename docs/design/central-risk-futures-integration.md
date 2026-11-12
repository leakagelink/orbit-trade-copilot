# Central Risk Engine → existing Futures order path: integration design (Phase 4A)

Status: **DESIGN ONLY. Not connected.** No code path that submits, claims or prepares an order calls the Central Risk
Engine today (enforced by `src/test/engine-b-isolation.test.ts`). Wiring it in changes live-order behaviour and needs a
separate, explicit owner approval.

## 1. What exists now

| Piece | File | State |
|---|---|---|
| Pure engine: `evaluateProposal` → ACCEPT / REJECT / INSUFFICIENT_DATA, sizing + leverage chosen by the engine, `executionAuthorized: false` always | `src/lib/central-risk.ts` | built, tested |
| Engine adapters (research, 1–5 m, seconds-level) → one `TradeProposal` with no size/leverage fields | `src/lib/central-risk-proposals.ts` | built, tested |
| **Context builder (SELECT-only)** | `src/lib/central-risk-context.server.ts` | built, tested, **not called** |
| Credential-free mark price / lot rules (GET allowlist) | `src/lib/futures-public-market.server.ts` | built, tested |
| Futures paper engine (uses the Central Risk Engine for every entry) | `src/lib/futures-paper-engine.ts` | built, tested |

### Context builder reads (all `from(..).select(..)`; the handle cannot insert/update/delete/rpc)

| Input | Source | If the read fails |
|---|---|---|
| Account limits: max daily loss, max exposure, max positions, emergency stop | `risk_settings` | limits = null → INSUFFICIENT_DATA |
| Futures limits: max loss/trade, max margin/trade, max leverage | `futures_settings` (production) · fixed `TESTNET_FUTURES_LIMITS` (Testnet) | INSUFFICIENT_DATA |
| Strategy budget | `strategy_risk_budgets` (**draft 0045, not applied** → read fails today) | INSUFFICIENT_DATA |
| Strategy loss used | port (no per-strategy attribution on real trades yet) | INSUFFICIENT_DATA |
| Open positions, exposure, one-position-per-symbol | `positions` (open, same environment) | INSUFFICIENT_DATA |
| Open / unknown-outcome orders | `orders` status pending/open/partially_filled (production: account-wide, as today; Testnet: Testnet only) | INSUFFICIENT_DATA |
| Duplicate proposal | `orders.idempotency_key = futures:<proposalId>` | INSUFFICIENT_DATA |
| Daily loss | `trades` closed since 00:00 UTC (same `tradeNet` as `accountRiskBlock`) + negative unrealized | INSUFFICIENT_DATA |
| Mark price + exchange timestamp | `/fapi/v1/premiumIndex` (public GET) | INSUFFICIENT_DATA; stale → REJECT |
| Lot step, min notional | `/fapi/v1/exchangeInfo` (public GET) | INSUFFICIENT_DATA |
| Maintenance-margin rate | needs signed `/fapi/v1/leverageBracket` — **not on the frozen adapter allowlist** | INSUFFICIENT_DATA |
| Available margin | existing signed GET `/fapi/v3/account` (`futuresAccountState`) — port not wired | INSUFFICIENT_DATA |
| Policy: liquidation buffer 2 %, data age 5 s, proposal age 60 s, cost 0.13 % | `CENTRAL_RISK_POLICY_PROPOSAL` code constants — **proposed values, owner approval needed** | — |

Production limits are only **read**; nothing changes them. With today's real inputs the builder returns
**INSUFFICIENT_DATA** for every live/Testnet proposal (no strategy budget table, no attribution, no maintenance margin,
no available-margin port) — by design, it can never guess.

## 2. Existing order path (`openFutures`, `src/lib/futures.server.ts`)

1. Elite check → load account (immutable environment) → typed confirmation.
2. Ticket limits (Testnet fixed limits / production `futures_settings`).
3. `authorizeEntry` (latest PASS certification + Live opt-in + not halted).
4. Symbol rules, quantity from ticket margin × leverage, bracket prices.
5. `accountRiskBlock` / `testnetRiskBlock`; production daily-loss reserve check.
6. `acquireExecution` lease → re-check risk → pending-order check → exchange account state → symbol exposure checks.
7. Durable `orders` claim (`futures:<requestId>`) + position intent.
8. `authorizeEntry` again → broker mode / isolated margin / leverage changes → `authorizeEntry` again.
9. Single submit, lookup-only settlement, protection orders.

## 3. Proposed gate (not implemented)

Strictly **additive**: every existing check stays. The Central Risk Engine can only make an entry stricter.

* **G1 — preflight**, after step 5 and before the lease: build the context, evaluate the proposal derived from the
  ticket. REJECT or INSUFFICIENT_DATA → refuse with the failing check list. ACCEPT → continue (it authorizes nothing).
* **Size rule**: the ticket's quantity must be ≤ the engine's `sizing.qty` and its leverage ≤ `sizing.leverage`.
  Otherwise refuse. Never silently resize a user's ticket.
* **G2 — after the durable claim** (inside the lease, before any broker setting change): re-evaluate with fresh
  context. The duplicate check must exclude the row just claimed by this request (match on claim id).
* **G3 — immediately before submit**, next to the third `authorizeEntry`: re-read mark price and emergency stop only
  (cheap, fail-closed).
* **Persistence**: each evaluation appended to a new `risk_decisions` table (append-only, service-role insert,
  owner read) keyed by proposal id. Needs its own draft migration — not written yet.
* **Errors / timeouts** in any read → INSUFFICIENT_DATA → refuse. No retries of reads inside the gate.

## 4. Rollout (each step needs owner approval)

| Step | Behaviour | Precondition |
|---|---|---|
| S0 (now) | Not connected. Paper engine + offline tests only. | — |
| S1 Shadow | Evaluate at G1, record decision, never block. Compare with existing outcomes. | 0045 applied, `risk_decisions` migration, available-margin + leverage-bracket ports, policy values approved |
| S2 Enforce on Testnet | G1–G3 block on Testnet only. | Dedicated Testnet account, 0040–0042 applied, S1 shows no unexplained divergence |
| S3 Enforce on production | G1–G3 block on production. | Separate approval; Live Futures and Autopilot stay under their existing gates |

## 5. Gaps that block S1

1. `strategy_risk_budgets` table (draft 0045) and per-strategy attribution on real orders/positions (new migration).
2. Maintenance-margin source: add `GET /fapi/v1/leverageBracket` to the frozen adapter allowlist (adapter change).
3. Available-margin port from the existing `/fapi/v3/account` read.
4. Owner decision on the policy values in `CENTRAL_RISK_POLICY_PROPOSAL`.
5. Testnet-only emergency stop (draft 0042); until then the shared account stop applies to both environments.

## 6. Tests to add before S1

Ticket-vs-sizing refusal; G2 duplicate exclusion of own claim; each read failure → refusal at G1/G2; G3 stop flip
between claim and submit; shadow mode never changes outcome; import-graph proof that ACCEPT cannot reach submit
without the existing `authorizeEntry`.
