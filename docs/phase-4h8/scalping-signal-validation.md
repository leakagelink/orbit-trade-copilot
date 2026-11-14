# Phase 4H.8 — Scalping signal validation

Module: `src/lib/live-scalp-signal.ts` (`evaluateLiveSignal`, `snapshotFor`). Strategy `futures-scalp-live` v`live-scalp-v1`, features `live-scalp-features-v1`.

## Output contract
Every signal has: action (LONG / SHORT / NO_TRADE / INSUFFICIENT_DATA), entry/stop/take-profit references (entry from the executable side: ask for LONG, bid for SHORT), cost estimate (taker fee round trip, spread, book-walk slippage per side, funding if the expected hold crosses the next funding time), freshness, features, reasons, rejections, expiry, and an **UNCALIBRATED** agreement score labelled "not a probability". It carries **no quantity, leverage or authorization** (test asserts this).

## Rules (all must agree for LONG; mirrored for SHORT)
1m EMA trend, price vs VWAP, RSI band, momentum, 5m trend, book imbalance (top 10), microprice edge, aggressor-flow imbalance; gated by spread ≤ limit, book depth ≥ limit, and target ≥ 3 × estimated costs.

## INSUFFICIENT_DATA instead of guessing (tested)
Feed not ready; no synced book; no best bid/ask; no mark price; too few closed 1m or 5m candles; a candle gap; latest candle too old; trade-ID gap inside the flow window.

## Tests — `src/test/phase4h8-signal.test.ts` 20/20 PASS
| Area | Data | Result |
|---|---|---|
| LONG / SHORT with all fields, deterministic ids, funding inclusion | SYNTHETIC markets | PASS |
| 9 INSUFFICIENT_DATA cases | SYNTHETIC | PASS |
| 4 NO_TRADE cases (costs, spread, thin book, flow disagreement) | SYNTHETIC | PASS |
| Well-formed, deterministic signal on real data for both symbols | RECORDED real data | PASS |

## Live run
In the 100 s REAL run, 4 signals were emitted on 1m closes; the final ones were INSUFFICIENT_DATA because of the deliberately induced trade-ID gap. No LONG/SHORT was observed in that short window.

## Result: PARTIAL
The pipeline is implemented and behaves as specified. **The strategy is UNVALIDATED**: earlier research (`scalp-research.ts`) found no positive out-of-sample net expectancy for 1–5 minute rules after costs, and no forward evidence exists for this version. The confidence score is not calibrated. Nothing here demonstrates profitability.
