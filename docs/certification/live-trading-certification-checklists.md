# Live trading certification checklists (12 November 2026)

Each item is PASS only with the stated evidence. Code being complete never counts as PASS. Synthetic or constructed-test results never count as trading evidence. "Status" is the state today.

## 1. Research AI (Engine A)

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| R1 | ≥ 3 signed-in runs where all 12 agents record `completed` (not `unavailable`), on ≥ 2 symbols | Any of the 3 has a failed or unavailable agent | FAIL — no full 12-agent run has been recorded; AI Prime Tech is disabled by the owner |
| R2 | Migration 0043 applied after a fresh-export restore test passes | Not applied, or restore test fails | FAIL — draft only |
| R3 | Every run stays within the configured per-run, daily and platform token caps in the 0043 ledger | Any cap exceeded, or caps not atomic | FAIL — atomic caps need 0043 |
| R4 | Provider cost is recorded as ACTUAL or ESTIMATED from a published rate | Cost UNKNOWN | FAIL — provider reports no price |
| R5 | ≥ 30 closed forward outcomes of stored directional proposals | < 30 | FAIL — 0 directional outcomes for the owner |
| R6 | Research proposals are evaluated only through the Central Risk Engine, for the paper environment, and never reach an order path (import-graph test) | Any path from research to order code | PASS (tests) |

## 2. 1–5 minute Futures scalping AI (Engine B, intraday)

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| I1 | Point-in-time features: features at candle i are identical with and without later candles (test) | Any difference | PASS (tests) |
| I2 | Out-of-sample test period (chronological, purged) shows positive net expectancy after fees, spread, slippage and funding on ≥ 2 symbols with ≥ 200 trades each | Net expectancy ≤ 0 on any symbol | **FAIL** — 60-day test: BTCUSDT 1m −909.9 / 686 trades, 5m −237.8 / 218; ETHUSDT 1m −902.9 / 723, 5m −205.8 / 204 (per 1,000 notional) |
| I3 | Walk-forward model: test AUC > 0.55 in ≥ 75% of folds, and Brier score below the base-rate baseline | Otherwise | **FAIL** — AUC 0.39–0.65, Brier worse than baseline in every fold |
| I4 | Validation-chosen confidence threshold exists (model trades only when it cleared costs on validation) | No threshold → model stays NO TRADE | FAIL (correctly NO TRADE: no fold qualified) |
| I5 | ≥ 100 settled forward paper trades with net expectancy within the backtest's 95% interval and > 0 | Fewer, or outside | FAIL — needs 0044 + forward paper for Futures (not built: paper is Spot-only) |
| I6 | Testnet certification (checklist 5) PASS for this strategy's exact config hash | Otherwise | FAIL |

## 3. Ultra-fast Futures scalping AI (Engine B, ultrafast)

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| U1 | A persistent market-data runtime (WebSocket) approved and deployed, with measured feed age p99 < 250 ms and exchange→receipt latency p99 < 150 ms over 7 days | Not available or limits missed | **FAIL — blocked**: current hosting is request-scoped; needs an owner infrastructure decision |
| U2 | Recorded order-book plus trade data (≥ 14 days) for spread, imbalance and microprice research | Missing | FAIL — Binance no longer publishes UM bookTicker archives; needs a live recorder (U1) |
| U3 | Measured mean markout after signals ≥ 1.5× round-trip cost, out of sample | Below | **FAIL** — 10 Nov BTCUSDT: strong trade-flow imbalance gives +0.09 to +0.31 bps against ≈ 12 bps taker round trip |
| U4 | Adverse selection measured for the actual order type (maker queue position modelled if maker) | Not measured | FAIL |
| U5 | Testnet certification PASS | Otherwise | FAIL |

## 4. Shared Central Risk Engine

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| C1 | Unit tests cover every check: schema refusal of AI quantity/leverage/authorization, stop-loss, stale data, emergency stop, duplicates, unknown outcomes, daily loss, strategy budget, position count, exposure, margin, leverage, liquidation buffer, minimum notional, determinism | Any check uncovered | PASS (16 tests) |
| C2 | A server context builder reads limits, account, strategy budget, mark price with timestamp and order state SELECT-only, and fails to INSUFFICIENT_DATA when any read fails | Missing | FAIL — not built (needs strategy-budget storage; owner approval) |
| C3 | Wired as a mandatory gate before every existing Futures submit (manual, Autopilot), after the existing checks, with existing limits unchanged | Not wired | FAIL — wiring changes live execution; awaits owner approval |
| C4 | Every evaluation is persisted append-only and bound to the order intent it allowed | Not persisted | FAIL — needs a reviewed migration |
| C5 | Fault tests on Testnet: stale feed, halt, duplicate, unknown outcome each produce REJECT and no order | Otherwise | FAIL — no Testnet run |

## 5. Binance Futures Testnet

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| T1 | Separate frozen Testnet/Live adapters with exact endpoint allowlists; credentials bound to environment at decryption (tests) | Any cross-environment path | PASS (tests) |
| T2 | Dedicated non-admin Testnet-only account with a fresh key, Elite, Autopilot/Live off and the fixed limits (5 USDT margin, 2 loss/trade, 2 daily, 10 exposure, 1 position, ≤ 10×) | Owner account or shared connections | FAIL — not created |
| T3 | Drafts 0040, 0041 (and 0042 for a Testnet-only stop) applied after a fresh-export restore test | Not applied | FAIL |
| T4 | All 8 harness scenarios run on Testnet: partial fills, protection rejection, unknown submit, kill switch, concurrency, restart, funding, final flat state; production fingerprint unchanged | Any scenario fails or is skipped | FAIL — never run (no Testnet orders authorized) |
| T5 | Exchange-side STOP_MARKET/TAKE_PROFIT_MARKET with closePosition verified on the exchange after each entry | Missing or unverified | FAIL on exchange (PASS in unit tests) |
| T6 | A separate Testnet emergency stop that does not halt production | Shared halt | FAIL — today one account-wide halt (draft 0042) |

## 6. Restricted live trading

| # | PASS condition | FAIL condition | Status |
|---|---|---|---|
| L1 | Checklists 4 and 5 fully PASS, plus the strategy's own checklist (2 or 3) | Any FAIL | FAIL |
| L2 | Latest production-environment PASS certification for the account and the current execution revision | Missing or stale | FAIL |
| L3 | Owner sets explicit live limits in writing (margin, loss per trade, daily loss, exposure, leverage) and confirms by typed opt-in | Missing | FAIL |
| L4 | Kill switch tested live: halt → no new orders, open positions closed reduce-only, within 10 s | Not tested | FAIL |
| L5 | First 30 live trades at minimum size reconcile exactly (fees, funding, PnL) against exchange records | Any mismatch | FAIL |
| L6 | Owner approval recorded for each step | Missing | FAIL |
