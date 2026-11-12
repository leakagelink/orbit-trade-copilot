# Phase 4C — EMA 50/200 (4h) forward evaluation

**Status: RESEARCH ONLY. Verdict: NO TRADE for BTCUSDT and ETHUSDT.** Offline historical simulation on public Binance USD-M data; no orders, AI, credentials, database, paper engine or scheduler. Nothing here approves a strategy or paper trading.

## 1. What was evaluated and why this is not test-set selection

- Candidate: the Phase 4B benchmark `emaAlwaysIn(..., 50, 200, 1000, 4h)` (`src/lib/lowfreq-research.ts:226-244`), unchanged. Phase 4B noticed it on its locked test, so the Phase 4B window (2023-11-13 → 2026-11-12) is reported only as **contaminated context**, never as evidence.
- Evidence windows (never scored by Phase 4B): **HISTORY_UNSEEN** — Binance history before the Phase 4B window minus a 14-day embargo; **FORWARD** — closed 4h candles after 2026-11-12T00:00Z.
- Specification frozen in `src/lib/ema-forward-research.ts` (`EMA_FORWARD_SPEC`) and `docs/phase-4c/ema-forward-spec.json` at **2026-11-12T18:14:41.665Z**, SHA-256 `fef1112b6bf333e22996ab37ac2fb0232a2dfd3dadcf335a6b95c67e9aa666de`; committed as `4d517a1` **before** any new candle was fetched. The runner refuses to start if the hash differs (`scripts/ema-forward/run.ts`). Run at 2026-11-12T18:16:02.097Z (commit `8470df7`).
- `lowfreq-research.ts` and all Phase 4B artifacts are untouched (protected-file manifest test). `emaAlwaysInTrades` reproduces `emaAlwaysIn` exactly (equivalence tests) and also returns trades and a marked equity path.
- Known contamination that cannot be removed: EMA 50/200 is a widely known rule and its 2019–2023 crypto behaviour is public knowledge; the unseen history is unseen by this project's selection, not by the world.

## 2. Frozen specification

| Item | Frozen value |
|---|---|
| timeframe | 4h (UTC-aligned aggregation of 1h candles; incomplete buckets dropped, never filled) |
| emaFast | 50 |
| emaSlow | 200 |
| emaSeed | SMA of the first N closes of the fetched series (indicators.ema) |
| longShort | both: LONG when EMA50 > EMA200 at the previous 4h close, otherwise SHORT (always in the market once both EMAs exist) |
| entry | at the open of the first bar of the segment, and at the next 4h open after the previous close changes direction |
| exit | reverse at the next 4h open on a direction change; the open position is closed at the segment's last close |
| positionSizing | fixed 1000 USDT notional per position (no compounding, no leverage modelled; quantity = 1000 / entry price) |
| stopLoss | none |
| takeProfit | none |
| maxHoldingPeriod | none (always-in) |
| fees | taker 0.05 % per side (Binance USD-M regular tier list fee; NOT verified against an account) |
| spreadSlippage | spread 0.01 % (half per side) + slippage 0.01 % per side — assumptions, no historical bid/ask data |
| funding | actual historical funding rates charged for events strictly inside (entry, exit); at the funding mark price, or the entry price when the exchange supplies no mark |
| dataSource | Binance USD-M public GET /fapi/v1/klines (1h) and /fapi/v1/fundingRate; credential-free |
| windows | warm-up 60 days after the first candle; embargo 14 days; split [0.6, 0.2, 0.2] train/validation/test with 14-day purge+embargo gaps; walk-forward = non-overlapping 90-day windows, each run as its own segment |
| stress | costs × 2 |
| sensitivity | 4h (20/100, 30/150, 40/200, 50/150, 50/250, 60/200, 100/200) and 1h 50/200 on HISTORY_UNSEEN only; reported, never used to change the candidate |

**Pre-declared decision rule** (from the spec):

- R1: HISTORY_UNSEEN full: >= 30 trades, net expectancy > 0 and t-stat >= 2
- R2: HISTORY_UNSEEN train, validation and test each: net > 0 (beats cash); validation and test each >= 8 trades
- R3: Walk-forward: >= 60 % of 90-day windows with at least one trade are net positive
- R4: HISTORY_UNSEEN full profit factor >= 1.2
- R5: At 2x costs, HISTORY_UNSEEN full net expectancy > 0
- R6: FORWARD: >= 30 closed trades with net expectancy > 0 (required for anything beyond historical evidence)
- any of R1-R5 fails -> NO TRADE; R1-R5 pass but R6 fails -> INSUFFICIENT EVIDENCE; all pass -> CANDIDATE FOR FORWARD-PAPER REVIEW. Every outcome stays RESEARCH_ONLY; none authorizes paper or live trading.

## 3a. BTCUSDT — NO TRADE (RESEARCH_ONLY)

Data: 1h candles 2019-09-08T17:00:00Z → last open 2026-11-12T15:00:00Z (62927 1h, 15731 4h); internal 1h gaps **0**; funding events 7861 (with exchange mark 3325; the rest charged at entry price). HISTORY_UNSEEN 1h SHA-256 `8a9bfb05da3b255e9be788a1252e6037c5b582a681a941f5e9c8089bbeeb4938`; FORWARD 1h SHA-256 `d30382d10ee687e071fe3afa9f9245134cddc2bbdd59b8e1796118ebf2f7bc85`.

Windows: HISTORY_UNSEEN 2019-11-08T00:00:00Z → 2023-10-30T00:00:00Z; train 2019-11-08 → 2022-03-11; validation 2022-03-25 → 2023-01-03; test 2023-01-17 → 2023-10-30; FORWARD 2026-11-12T00:00:00Z → 2026-11-12T16:00:00Z (4 closed 4h candles).

| Period | Trades | Gross exp $ | Net exp $ | Net $ | Net return % | PF | Max DD realized $ | Max DD marked $ | Win % | Avg win $ | Avg loss $ | Exposure % | Avg hold h | Fees $ | Spread $ | Slippage $ | Funding $ | t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| History full | 39 | 125.18 | 113.62 | 4431.19 | 443.12 | 3.4 | 624.72 | 1410.21 | 43.59 | 369.37 | -84.01 | 100 | 893.54 | 41.05 | 4.11 | 8.21 | -397.55 | 1.18 |
| Train | 22 | 206.98 | 187.74 | 4130.35 | 413.03 | 5.32 | 343.21 | 1410.21 | 45.45 | 508.74 | -79.75 | 100 | 931.64 | 23.99 | 2.4 | 4.8 | -392.05 | 1.12 |
| Validation | 10 | -23.9 | -24.06 | -240.58 | -24.06 | 0.66 | 576.25 | 693.69 | 30 | 157.17 | -101.73 | 100 | 681.6 | 9.6 | 0.96 | 1.92 | 10.92 | -0.45 |
| Test | 7 | 52.07 | 48.55 | 339.84 | 33.98 | 3.16 | 112.68 | 300.26 | 71.43 | 99.37 | -78.5 | 100 | 980.57 | 7.27 | 0.73 | 1.45 | -15.21 | 1.04 |
| History full, 2× costs | 39 | 125.18 | 112.25 | 4377.83 | 437.78 | 3.33 | 642.44 | 1415.39 | 43.59 | 367.92 | -85.31 | 100 | 893.54 | 82.1 | 8.21 | 16.42 | -397.55 | 1.17 |
| FORWARD | 1 | 31.12 | 29.91 | 29.91 | 2.99 | — | 0 | 0 | 100 | 29.91 | — | 100 | 16 | 0.98 | 0.1 | 0.2 | 0.06 | — |
| Contaminated 4B window (context only) | 36 | 33.49 | 27.68 | 996.6 | 99.66 | 1.89 | 329.39 | 679.38 | 36.11 | 162.96 | -48.78 | 100 | 730 | 36.5 | 3.65 | 7.3 | -161.73 | 1.28 |

Baselines (same windows, same costs, funding included; 1000 USDT notional):

| Window | Cash | Buy & hold net $ | B&H max DD marked $ | 1h EMA 50/200 net $ (trades) | Candidate net $ |
|---|---|---|---|---|---|
| historyUnseen | 0 | 2165.57 | 5755.7 | 597 (207) | 4431.19 |
| train | 0 | 2777.73 | 3864.27 | -86.02 (132) | 4130.35 |
| validation | 0 | -652.66 | 735 | 93.83 (42) | -240.58 |
| test | 0 | 580.41 | 311.13 | 246.91 (33) | 339.84 |
| contaminated | 0 | 544.43 | 1826.52 | -127.6 (166) | 996.6 |
| forward | 0 | -32.46 | 32.98 | 29.91 (1) | 29.91 |

Walk-forward (90-day windows, no parameter selection): 11/16 traded windows positive. Windows: 2019-11-08 214.56 (3), 2020-02-06 168.69 (5), 2020-05-06 128.41 (3), 2020-08-04 87.13 (3), 2020-11-02 1392.71 (1), 2021-01-31 367.92 (2), 2021-05-01 211.05 (4), 2021-07-30 81.38 (3), 2021-10-28 361.91 (2), 2022-01-26 -659.38 (7), 2022-04-26 411.04 (2), 2022-07-25 -182.61 (4), 2022-10-23 -77.85 (6), 2023-01-21 -10.83 (3), 2023-04-21 -46.79 (3), 2023-07-20 105.94 (3).

Parameter sensitivity on HISTORY_UNSEEN (reported only; candidate unchanged): 4h-20/100 net exp 15.01 over 111 (PF 1.43), 4h-30/150 net exp 47.08 over 69 (PF 2.32), 4h-40/200 net exp 75.98 over 51 (PF 2.55), 4h-50/150 net exp 47.72 over 47 (PF 1.98), 4h-50/250 net exp 84.42 over 39 (PF 2.76), 4h-60/200 net exp 114.68 over 35 (PF 3.15), 4h-100/200 net exp 108.14 over 31 (PF 3.03), 1h-50/200 net exp 2.88 over 207 (PF 1.11).

Rule outcomes:

- R1: **FAIL** — 39 trades, net exp 113.62, t 1.18
- R2: **FAIL** — net train 4130.35 / validation -240.58 (10) / test 339.84 (7)
- R3: **PASS** — 11/16 traded windows positive
- R4: **PASS** — profit factor 3.40
- R5: **PASS** — net exp at 2x costs 112.25
- R6: **FAIL** — 1 forward trades (need 30)

## 3b. ETHUSDT — NO TRADE (RESEARCH_ONLY)

Data: 1h candles 2019-11-27T07:00:00Z → last open 2026-11-12T15:00:00Z (61017 1h, 15254 4h); internal 1h gaps **0**; funding events 7627 (with exchange mark 3325; the rest charged at entry price). HISTORY_UNSEEN 1h SHA-256 `7d231cf82b0061554985a1e2d871c552c098ec19ff0e8f00baacde1050a632a5`; FORWARD 1h SHA-256 `49306808a975f355a71cf342a17d6f8a4e8b0d5f296fac17c5d467d678257809`.

Windows: HISTORY_UNSEEN 2020-01-27T00:00:00Z → 2023-10-30T00:00:00Z; train 2020-01-27 → 2022-04-12; validation 2022-04-26 → 2023-01-19; test 2023-02-02 → 2023-10-30; FORWARD 2026-11-12T00:00:00Z → 2026-11-12T16:00:00Z (4 closed 4h candles).

| Period | Trades | Gross exp $ | Net exp $ | Net $ | Net return % | PF | Max DD realized $ | Max DD marked $ | Win % | Avg win $ | Avg loss $ | Exposure % | Avg hold h | Fees $ | Spread $ | Slippage $ | Funding $ | t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| History full | 47 | 63.25 | 50.07 | 2353.28 | 235.33 | 1.88 | 961.34 | 2669.99 | 34.04 | 313.81 | -86.06 | 100 | 700.6 | 49.12 | 4.91 | 9.82 | -555.43 | 0.97 |
| Train | 25 | 133.06 | 109.75 | 2743.73 | 274.37 | 3.06 | 399.28 | 2514.34 | 44 | 370.33 | -94.99 | 100 | 773.76 | 27.22 | 2.72 | 5.44 | -547.42 | 1.19 |
| Validation | 10 | -15.53 | -15.95 | -159.48 | -15.95 | 0.81 | 845.42 | 1183.55 | 20 | 342.97 | -105.68 | 100 | 643.2 | 9.79 | 0.98 | 1.96 | 8.57 | -0.24 |
| Test | 13 | -24.03 | -26.26 | -341.32 | -34.13 | 0.38 | 389.51 | 482.98 | 23.08 | 69.46 | -54.97 | 100 | 498.46 | 13.06 | 1.31 | 2.61 | -11.94 | -1.55 |
| History full, 2× costs | 47 | 63.25 | 48.71 | 2289.42 | 228.94 | 1.85 | 987.49 | 2722.74 | 34.04 | 312.36 | -87.37 | 100 | 700.6 | 98.24 | 9.82 | 19.65 | -555.43 | 0.95 |
| FORWARD | 1 | 22.98 | 21.75 | 21.75 | 2.17 | — | 0 | 0 | 100 | 21.75 | — | 100 | 16 | 0.99 | 0.1 | 0.2 | 0.05 | — |
| Contaminated 4B window (context only) | 34 | 36.3 | 30.7 | 1043.82 | 104.38 | 1.51 | 943.36 | 1397.95 | 38.24 | 237.52 | -97.33 | 100 | 772.94 | 34.33 | 3.43 | 6.87 | -145.72 | 0.93 |

Baselines (same windows, same costs, funding included; 1000 USDT notional):

| Window | Cash | Buy & hold net $ | B&H max DD marked $ | 1h EMA 50/200 net $ (trades) | Candidate net $ |
|---|---|---|---|---|---|
| historyUnseen | 0 | 8982.59 | 23507.68 | 2077.13 (195) | 2353.28 |
| train | 0 | 16067.87 | 15889.45 | 2084.89 (108) | 2743.73 |
| validation | 0 | -499.94 | 700.64 | 385.26 (44) | -159.48 |
| test | 0 | 50.26 | 367.26 | -239.94 (39) | -341.32 |
| contaminated | 0 | -330.4 | 1667.24 | 99.33 (170) | 1043.82 |
| forward | 0 | -24.32 | 27.81 | 21.75 (1) | 21.75 |

Walk-forward (90-day windows, no parameter selection): 8/15 traded windows positive. Windows: 2020-01-27 422.9 (3), 2020-04-26 245.9 (3), 2020-07-25 63.29 (3), 2020-10-23 2193.45 (1), 2021-01-21 -229.08 (5), 2021-04-21 141.22 (2), 2021-07-20 96.74 (4), 2021-10-18 -88.76 (6), 2022-01-16 -239.09 (6), 2022-04-16 606.08 (2), 2022-07-15 -429.4 (5), 2022-10-13 -661.74 (6), 2023-01-11 174.36 (3), 2023-04-11 -307.98 (7), 2023-07-10 -1.93 (4).

Parameter sensitivity on HISTORY_UNSEEN (reported only; candidate unchanged): 4h-20/100 net exp 34.8 over 101 (PF 1.95), 4h-30/150 net exp 55.42 over 59 (PF 2.03), 4h-40/200 net exp 42.49 over 53 (PF 1.75), 4h-50/150 net exp 73.33 over 51 (PF 2.38), 4h-50/250 net exp 195.23 over 29 (PF 4.42), 4h-60/200 net exp 85.26 over 41 (PF 2.81), 4h-100/200 net exp 178.97 over 31 (PF 4.65), 1h-50/200 net exp 10.65 over 195 (PF 1.36).

Rule outcomes:

- R1: **FAIL** — 47 trades, net exp 50.07, t 0.97
- R2: **FAIL** — net train 2743.73 / validation -159.48 (10) / test -341.32 (13)
- R3: **FAIL** — 8/15 traded windows positive
- R4: **PASS** — profit factor 1.88
- R5: **PASS** — net exp at 2x costs 48.71
- R6: **FAIL** — 1 forward trades (need 30)

## 4. Interpretation

- **BTCUSDT — NO TRADE.** Positive over the whole unseen history (PF 3.40, robust to 2× costs), but the evidence is concentrated: 22 of 39 trades and ~93 % of the net came from the 2019–2022 trend in the *train* third; validation lost (−240.58 $ over 10 trades); test was positive but had only 7 trades (< 8 required). t-stat 1.18 < 2. Walk-forward 11/16 positive passes R3, but R1 and R2 fail.
- **ETHUSDT — NO TRADE.** Validation and test both lost (−159.48 $, −341.32 $); 8/15 walk-forward windows positive (53 % < 60 %); t-stat 0.97.
- **FORWARD:** 4 closed 4h candles exist (≈16 hours). The single forward "trade" per symbol is the always-in position force-closed at the window end, not a strategy exit — **INSUFFICIENT EVIDENCE** regardless (R6 needs ≥ 30 closed trades; at this candidate's ~10 trades/year that is roughly 3 years of forward data).
- Neighbouring parameters were also profitable on the unseen history, consistent with a generic trend-following effect in 2019–2021 rather than a tuned optimum; the out-of-sample thirds still failed. Funding was a large cost (BTC −397.55 $, ETH −555.43 $ over the unseen history), far larger than fees.
- Buy-and-hold beat the candidate on ETH unseen history (8982.59 $ vs 2353.28 $) with a much larger marked drawdown (23507.68 $ vs 2669.99 $); on BTC the candidate exceeded buy-and-hold (4431.19 $ vs 2165.57 $). None of this is a recommendation.

## 5. Limitations

- Fees, spread and slippage are assumptions (not verified against an account); no historical bid/ask or depth.
- Funding before the exchange began publishing a funding mark price is charged at the entry price.
- Fixed 1000 USDT notional, no leverage, no liquidation modelling, no compounding; always-in exposure ≈ 100 %.
- Max drawdown "realized" is on closed-trade P&L; "marked" is at 4h closes with open-position costs excluded until close.
- Thirds of an always-in series start and end flat, so each period's first/last trade is truncated by design.
- Re-run: `bun scripts/ema-forward/run.ts` (refuses if the spec hash changed). Raw artifact: `docs/evaluation/phase4c-ema-forward-2026-11-12.json`.

**Explicit research verdict: NO TRADE (BTCUSDT), NO TRADE (ETHUSDT); status RESEARCH_ONLY; not connected to the Futures Paper Engine.**
