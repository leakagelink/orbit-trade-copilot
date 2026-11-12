# Phase 4B — lower-frequency Futures strategy research (offline)

**Verdict: NO TRADE for BTCUSDT and ETHUSDT.** Historical simulation only on public Binance USD-M data; no orders, AI, credentials or database. Nothing here is a viable strategy.

- Version `lowfreq-research-v1`; grid fixed in code before scoring: **384 variants per symbol** (1h/4h × EMA cross 20/50 & 50/200, Donchian 20 & 55, mean-reversion z 2.0/3.0 vs EMA50 × ATR stop 2/3 × reward:risk 2/4 × volatility filter any/mid-percentile × funding filter off/on × taker/maker).
- Costs (assumptions, not verified against an account): taker 0.05 %, maker 0.02 %, spread 0.01 % (no historical bid/ask data — spread is assumed), slippage 0.01 % per taker side. Funding: actual historical rates at the exchange's funding mark, charged for events strictly while held. Fixed 1000 USDT notional per trade.
- Fills: signal on a closed bar, entry at the next open (taker) or post-only at the signal close filling only on trade-through (maker; if the fill bar touches the stop, the stop is assumed hit). Stop-first inside a bar; gaps through the stop fill at the open.
- Split: train / validation / **locked test**, separated by 14-day purge+embargo gaps (longest hold 8 days).
- Pre-declared rule: train ≥ 30 trades, net expectancy > 0, t-stat ≥ 2; the top 5 by t-stat must show ≥ 15 trades and net expectancy > 0 on validation; only survivors are scored once on the locked test (≥ 15 trades, net expectancy > 0).

## BTCUSDT — NO TRADE

Data: 2023-11-13 → 2026-11-12 (exclusive), 26280 1h bars (6570 4h), 0 gaps; 3285 funding events, 0 gaps.

Periods: train 2023-11-13 → 2025-08-14; validation 2025-08-28 → 2026-03-29; test 2026-04-12 → 2026-11-12

- Train: 93 of 384 variants had positive net expectancy with ≥ 30 trades (in-sample, multiple-comparison inflated); **4** met the t ≥ 2 rule.
- Validation: **4** of 4 checked survived.
- Locked test: 4 scored; candidates with positive test net expectancy: **0**.

| Candidate / period | Trades | Gross exp $ | Net exp $ | Net exp % | Fees $ | Spread $ | Slippage $ | Funding $ | Max DD $ (realized) | PF | Win % | Daily Sharpe | t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `4h-reversion-50-30-s3-r2-any-foff-maker` train | 80 | 15.65 | 15.53 | 1.553 | 56.28 | 4.03 | 8.06 | 58.27 | 232.89 | 1.81 | 55 | 1.64 | 2.31 |
| `4h-reversion-50-30-s3-r2-any-foff-maker` validation | 30 | 5.88 | 4.96 | 0.496 | 20.91 | 1.49 | 2.98 | -2.11 | 249.8 | 1.25 | 43.3 | 0.6 | 0.51 |
| `4h-reversion-50-30-s3-r2-any-fon-maker` train | 80 | 15.65 | 15.53 | 1.553 | 56.28 | 4.03 | 8.06 | 58.27 | 232.89 | 1.81 | 55 | 1.64 | 2.31 |
| `4h-reversion-50-30-s3-r2-any-fon-maker` validation | 30 | 5.88 | 4.96 | 0.496 | 20.91 | 1.49 | 2.98 | -2.11 | 249.8 | 1.25 | 43.3 | 0.6 | 0.51 |
| `4h-reversion-50-30-s3-r2-any-foff-taker` train | 80 | 15.62 | 15.05 | 1.505 | 80.28 | 8.03 | 16.06 | 59.03 | 236.04 | 1.78 | 53.8 | 1.59 | 2.24 |
| `4h-reversion-50-30-s3-r2-any-foff-taker` validation | 30 | 5.88 | 4.51 | 0.451 | 29.91 | 2.99 | 5.98 | -2.11 | 252.05 | 1.22 | 43.3 | 0.54 | 0.47 |
| `4h-reversion-50-30-s3-r2-any-fon-taker` train | 80 | 15.62 | 15.05 | 1.505 | 80.28 | 8.03 | 16.06 | 59.03 | 236.04 | 1.78 | 53.8 | 1.59 | 2.24 |
| `4h-reversion-50-30-s3-r2-any-fon-taker` validation | 30 | 5.88 | 4.51 | 0.451 | 29.91 | 2.99 | 5.98 | -2.11 | 252.05 | 1.22 | 43.3 | 0.54 | 0.47 |
| `4h-reversion-50-30-s3-r2-any-foff-maker` **locked test** | 19 | -2.53 | -3.4 | -0.34 | 13.22 | 0.94 | 1.88 | -0.59 | 188.47 | 0.82 | 52.6 | -0.47 | -0.37 |
| `4h-reversion-50-30-s3-r2-any-fon-maker` **locked test** | 19 | -2.53 | -3.4 | -0.34 | 13.22 | 0.94 | 1.88 | -0.59 | 188.47 | 0.82 | 52.6 | -0.47 | -0.37 |
| `4h-reversion-50-30-s3-r2-any-foff-taker` **locked test** | 19 | -2.53 | -3.86 | -0.386 | 18.92 | 1.89 | 3.78 | -0.59 | 190.72 | 0.8 | 47.4 | -0.53 | -0.42 |
| `4h-reversion-50-30-s3-r2-any-fon-taker` **locked test** | 19 | -2.53 | -3.86 | -0.386 | 18.92 | 1.89 | 3.78 | -0.59 | 190.72 | 0.8 | 47.4 | -0.53 | -0.42 |

The four survivors are **one** strategy (4h mean-reversion, z ≥ 3.0 vs EMA50, 3 ATR stop, 2:1): the funding filter never triggered for it and maker/taker twins entered the same trades. It weakened on validation (t 0.5) and **lost on the locked test** (19 trades, −3.40 $/trade maker, −3.86 taker).

Diagnostic only (did not drive any choice): best-train variant `4h-reversion-50-30-s3-r2-any-foff-maker` — validation net exp 4.96 $ over 30 trades; test -3.4 $ over 19 trades.
Parameter sensitivity (train, one dimension changed): 6/11 neighbours positive; net exp range -8.45 to 20.26 $ — not a stable plateau.

Walk-forward inside train+validation (180-day select, 14-day embargo, 60-day test, same rule with ≥ 20 trades): 11 folds, 0 traded, 0 positive, pooled OOS 0 trades, net 0 $.

Maker vs taker (train, 192 twin pairs): maker had better net expectancy in 170 pairs (fee saving), fill rate 99.03 %, average 4-bar markout maker -4.16 bps vs taker -3.57 bps (maker fills are slightly more adverse), 3.46 % of maker fills stopped on the fill bar.

Benchmarks (same periods, same costs, funding included):

| Period | Buy & hold net $ | B&H max DD $ (marked) | EMA 50/200 always-in 1h net $ (trades) | EMA 50/200 always-in 4h net $ (trades) |
|---|---|---|---|---|
| train | 1988.44 | 904.68 | 67.9 (95) | 709.57 (19) |
| validation | -422.97 | 567.63 | -188.98 (37) | 70.96 (9) |
| test | -13.37 | 331.95 | 65.45 (32) | 229.48 (8) |

Leakage checks: 11 sampled variants recomputed on truncated data — all identical: True.

## ETHUSDT — NO TRADE

Data: 2023-11-13 → 2026-11-12 (exclusive), 26280 1h bars (6570 4h), 0 gaps; 3285 funding events, 0 gaps.

Periods: train 2023-11-13 → 2025-08-14; validation 2025-08-28 → 2026-03-29; test 2026-04-12 → 2026-11-12

- Train: 124 of 384 variants had positive net expectancy with ≥ 30 trades (in-sample, multiple-comparison inflated); **2** met the t ≥ 2 rule.
- Validation: **0** of 2 checked survived.
- Locked test: 0 scored; candidates with positive test net expectancy: **0**.

| Candidate / period | Trades | Gross exp $ | Net exp $ | Net exp % | Fees $ | Spread $ | Slippage $ | Funding $ | Max DD $ (realized) | PF | Win % | Daily Sharpe | t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `4h-donchian-55-0-s2-r4-any-fon-maker` train | 61 | 22.08 | 20.91 | 2.091 | 43.08 | 3.09 | 6.18 | -19.24 | 190.29 | 2.01 | 45.9 | 1.64 | 2.15 |
| `4h-donchian-55-0-s2-r4-any-fon-maker` validation | 24 | -18.9 | -19.98 | -1.998 | 16.73 | 1.19 | 2.39 | -5.61 | 575.68 | 0.41 | 25 | -1.97 | -1.7 |
| `4h-donchian-55-0-s2-r4-any-fon-taker` train | 61 | 22.13 | 20.5 | 2.05 | 61.38 | 6.14 | 12.28 | -19.42 | 192.99 | 1.98 | 45.9 | 1.61 | 2.11 |
| `4h-donchian-55-0-s2-r4-any-fon-taker` validation | 24 | -18.81 | -20.35 | -2.035 | 23.93 | 2.39 | 4.79 | -5.77 | 583.07 | 0.4 | 25 | -2 | -1.73 |

Both train passers are one 4h Donchian-55 breakout (maker/taker twins); both **failed validation** (24 trades, about −20 $/trade). The locked test was not scored for selection.

Diagnostic only (did not drive any choice): best-train variant `4h-donchian-55-0-s2-r4-any-fon-maker` — validation net exp -19.98 $ over 24 trades; test 0.19 $ over 21 trades.
Parameter sensitivity (train, one dimension changed): 7/11 neighbours positive; net exp range -12.54 to 20.5 $ — not a stable plateau.

Walk-forward inside train+validation (180-day select, 14-day embargo, 60-day test, same rule with ≥ 20 trades): 11 folds, 3 traded, 1 positive, pooled OOS 44 trades, net -88.63 $.

Maker vs taker (train, 192 twin pairs): maker had better net expectancy in 165 pairs (fee saving), fill rate 99.27 %, average 4-bar markout maker -7.29 bps vs taker -6.67 bps (maker fills are slightly more adverse), 2.97 % of maker fills stopped on the fill bar.

Benchmarks (same periods, same costs, funding included):

| Period | Buy & hold net $ | B&H max DD $ (marked) | EMA 50/200 always-in 1h net $ (trades) | EMA 50/200 always-in 4h net $ (trades) |
|---|---|---|---|---|
| train | 1038.37 | 1304.59 | 547.86 (101) | 594.25 (23) |
| validation | -570.8 | 652.66 | 68.13 (34) | -92.15 (8) |
| test | -119.43 | 406.53 | -108.27 (32) | 726.14 (4) |

Leakage checks: 11 sampled variants recomputed on truncated data — all identical: True.

## Notes and limits

- The 4h EMA always-in benchmark was positive on both locked tests. It is a benchmark, not a candidate: picking it now would be choosing on the test set, and it was negative on ETH validation. It may be pre-declared for a future forward-paper study, nothing more.
- Max drawdown for candidates is on realized trade P&L (not marked to market); buy-and-hold drawdown is marked hourly.
- No spread or liquidity filter was tested: no reliable historical bid/ask or depth data is stored. NOT IMPLEMENTED.
- Regime detection here is limited to an ATR-percentile volatility filter and the funding filter; the funding filter rarely bound at the 0.03 %/8h threshold.
- Fee tier, spread and slippage are assumptions. Results do not authorize any trade, paper activation or policy change.

Raw numbers: `docs/evaluation/phase4b-lowfreq-research-2026-11-12.json`. Re-run: `bun scripts/lowfreq-eval/run.ts`.
