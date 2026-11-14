# Phase 4H.8 — Owner decisions required (all NOT APPROVED)

| # | Decision | Status |
|---|---|---|
| 1 | Paper risk limits (exposure, daily loss, positions, loss/trade, margin/trade, leverage, strategy budget) — empty by default | NOT APPROVED |
| 2 | Paper values you proposed earlier (5 % liquidation buffer, 5 s price age, 60 s expiry, 0.13 % cost) | NOT APPROVED (offered as a preset only) |
| 3 | Signal parameters in `PROPOSED_SIGNAL_CONFIG` (spread, depth, RSI band, cost multiple, TTL) | NOT APPROVED |
| 4 | Whether to run a forward paper evaluation of `live-scalp-v1` and what sample size / pass rule counts as evidence | NOT APPROVED |
| 5 | Whether a server-side always-on feed is wanted (needs hosting with persistent sockets; would be a purchase — not done) | NOT APPROVED |
| 6 | Whether paper ledgers should be stored in the database (needs a new migration) instead of browser storage | NOT APPROVED |
| 7 | Any change of `LIVE_ORDER_EXECUTION_ENABLED` | NOT APPROVED |

## Exact requirements before real-money (or Testnet) execution can be separately approved
1. Forward paper evidence for this exact strategy version over an owner-approved sample, net of real costs, with a pre-registered pass rule. Today: none; earlier research was negative.
2. Calibrated confidence (or removal of the score from any decision).
3. Testnet first: protection order parameters re-verified against Binance's current conditional-order API; reduce-only close and cancel paths exercised; lookup-only recovery of an uncertain submit demonstrated.
4. A durable server-side order path reusing the existing Futures controls (per-account lease, durable client ids, intent claim before submit, latest PASS certification for the bound account and revision, live opt-in, emergency stop, DB order gate). The browser must never submit.
5. Account-bracket maintenance margin and the 50 USDT BTCUSDT minimum reconciled with your Testnet limits (10 USDT exposure cannot trade BTCUSDT).
6. Durable audit storage for refusals and orders with known retention (today: platform logs, retention not verified).
7. Pending migrations 0040–0057 decisions from earlier phases resolved where the order path depends on them.
8. A separate code change, reviewed and approved, that turns the flag on — plus an owner-typed live opt-in per account.
