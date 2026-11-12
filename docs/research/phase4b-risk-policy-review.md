# Risk policy values — technical review (Phase 4B)

**Status of every value: NOT APPROVED.** They live only in `CENTRAL_RISK_POLICY_PROPOSAL`
(`src/lib/central-risk-context.server.ts`) and are used by research, paper simulation and shadow evaluation. No production
or Testnet setting, limit or order path reads them.

| Parameter | Proposed | Controls |
|---|---:|---|
| Liquidation buffer | 2 % of entry | Minimum distance between the stop and the estimated isolated liquidation price; the engine lowers leverage until it holds, never raises it |
| Max mark-price age | 5 s | Oldest exchange mark timestamp accepted when a proposal is evaluated |
| Max proposal age | 60 s | Oldest proposal (signal) accepted |
| Estimated execution cost | 0.13 % round trip | Fees + spread + slippage added to the per-unit loss when sizing |

## Liquidation buffer (2 %)
* **Why proposed:** stops are stop-market orders; in fast moves the fill can slip past the trigger. 2 % sits above typical
  BTC/ETH 1-minute extreme moves and leaves room for maintenance-margin bracket changes.
* **Too permissive (e.g. 0.5 %):** a slipped stop or a funding debit can let liquidation occur before the stop, losing the whole isolated margin plus clearance fee.
* **Too restrictive (e.g. 10 %):** forces leverage to 1–2× for tight stops, so most small-account trades fail minimum notional or margin limits — silent loss of strategy viability rather than a safety gain.
* **Calibration:** measure the distribution of (stop trigger → actual fill) slippage per symbol from Testnet/production fills and the worst 1-minute mark moves; set buffer ≥ the 99.9th percentile slippage + funding over max hold + bracket uncertainty.
* **By symbol/strategy:** yes by symbol (ETH is more volatile than BTC); by strategy only through holding period (longer holds accumulate funding).
* **Evidence needed:** ≥ 100 real stop fills per symbol (Testnet acceptable for mechanics, not for slippage), plus the signed leverage-bracket source.

## Max mark-price age (5 s)
* **Why:** public `premiumIndex` updates every ~1 s; 5 s tolerates one slow request.
* **Too permissive (60 s):** sizing and stop validation can use a price that has moved by more than the stop distance.
* **Too restrictive (< 1 s):** clock skew and request latency refuse almost every proposal (fail-closed, but useless).
* **Calibration:** measure exchange-time vs. server-time skew and request latency from the hosting region; set age ≥ p99 latency + skew, and ≤ the time in which the p99 price move stays below ~10 % of the tightest stop.
* **By symbol/strategy:** by strategy timeframe — seconds-level would need ≤ 1–2 s; 1h/4h research could tolerate 30 s.
* **Evidence:** a week of timestamped latency/skew measurements from the actual runtime.

## Max proposal age (60 s)
* **Why:** a signal evaluated on a closed 1-minute candle should be acted on within the next minute.
* **Too permissive:** stale signals enter after the setup has moved; duplicate signals across restarts become likelier.
* **Too restrictive:** queueing or a slow risk read refuses valid signals.
* **Calibration:** set to a fraction of the strategy's bar length (≤ 1 bar for 1m; ≤ ~15 min for 1h) and measure signal→evaluation latency.
* **By strategy:** yes — it must scale with timeframe; one global value is wrong for both scalping and 1h/4h research.
* **Evidence:** latency logs from shadow evaluations once connected.

## Estimated execution cost (0.13 %)
* **Why:** taker 0.05 % × 2 + spread 0.01 % + slippage 0.01 % × 2 ≈ 0.13 % at regular-tier list fees.
* **Too permissive (low):** positions are oversized relative to the real loss at stop; daily-loss limits are breached sooner than planned.
* **Too restrictive (high):** undersizes trades — safe, but distorts research and paper comparisons.
* **Calibration:** the account's actual fee tier (signed `commissionRate`, not wired), measured spread at entry times (no historical bid/ask data is stored), and realized slippage on fills.
* **By symbol/strategy:** by symbol (spread/slippage) and by execution mode (maker entries cost less but show adverse selection — see the Phase 4B research report).
* **Evidence:** ≥ 100 measured fills per symbol and mode, fee tier from the exchange.

## Recommendation
Keep all four NOT APPROVED. Before approval: connect shadow evaluation to collect latency and price-age data, add the
leverage-bracket and commission reads (each a separate adapter approval), and make proposal age and cost per-strategy /
per-symbol rather than global constants.
