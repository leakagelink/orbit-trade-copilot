# Phase 2 — Historical Evaluation: implementation plan (PROPOSED, not authorized)

Status 12 Nov 2026: plan only. No code, no migration, no paid AI calls. Based on a read-only audit of
`src/lib/backtest.ts`, `backtests.server.ts`, `evaluation.ts`, `replay-evidence.ts`, `indicators.ts`, `metrics.ts`,
`research*.ts` and their tests.

## 1. What exists today
| Area | Today | Gap |
|---|---|---|
| Data source | Public exchange OHLCV (`exchange-adapters.server.ts`); Binance paginated to ~5,000 bars, other venues recent candles only; ≥60 bars required | No gap/grid check, no cache, no completeness guarantee; hash proves internal consistency, not provider provenance; starting capital outside the hashed manifest |
| Lookahead | Signals on bar i-1, filled at bar i open (`backtest.ts`), trailing indicators; tested | No prefix-invariance test per indicator |
| AI leakage | Live research drops incomplete candles and future-dated news | No decision cut-off timestamp; fundamentals are not point-in-time; an LLM asked about past dates can recall outcomes |
| Train / validation / test | None (one recent interval) | Missing |
| Next-bar fills | Next open ± slippage; stop = worse of open/stop; stop wins ties | **Defect:** intrabar stop/target checked before an already-known opening exit; entry bar's stop/target never checked |
| Fees / slippage | Fixed % per side, net includes both | No explicit spread or liquidity model |
| Funding | Not simulated | Missing (futures must be rejected or modelled) |
| Expectancy, win rate, profit factor | Implemented (`evaluation.ts`, `backtest.ts`) | Edge-case tests missing |
| Max drawdown, Sharpe | Implemented | **Defect:** terminal liquidation costs not reflected in the equity curve; Sharpe omits first return; annualisation untested |
| Baselines | None | Buy-and-hold and EMA crossover missing |
| AI decision replay | Forward-only paper observation (`research-paper.ts`) | No historical evaluation of stored decisions |

## 2. Work packages
1. **Point-in-time data contracts** — new pure modules `historical-data.ts`, `point-in-time-evidence.ts`.
   Validate finite OHLCV, strict ascending grid, duplicates, gaps, requested coverage; every evidence item carries an
   availability timestamp; anything available after the decision cut-off is excluded; missing archives fail closed.
   Tests: duplicate bar → rejected; one missing daily bar → rejected with its date; candle closing 1 s after cut-off →
   excluded; a statement for FY2025 published after the cut-off → excluded even though its period predates it.
2. **Simulator v3** (`backtest.ts`, keep v2 for replaying existing evidence). Opening exits before intrabar events;
   entry-bar stop/target checked with stop-first ambiguity; equity includes terminal liquidation costs.
   Tests: known opening exit fills at open, not at a later stop; entry-bar stop triggers; final equity = capital + Σ net.
3. **Costs** — `historical-costs.ts`: separate spread and slippage inputs; funding modelled from timestamped rates or
   futures rejected. Tests: flat-price round trip loses exactly fees + spread + slippage; funding sign follows side.
4. **Metrics** — one module for expectancy, win rate, profit factor, max drawdown, Sharpe. Fixtures: equity
   1000→1200→960 → max drawdown 20%; daily vs hourly annualisation factors √365 and √8760; irregular grid rejected.
5. **Baselines** — `historical-baselines.ts`: buy-and-hold and EMA(12/26) crossover on the identical bars and costs.
   Test: both baselines and the strategy share the same first/last bar and cost inputs.
6. **Chronological splits** — `historical-splits.ts`: train < validation < test with purge/embargo, parameters frozen
   before the test fold, walk-forward option. Tests: folds disjoint and ordered; changing a test-fold bar never changes
   an earlier decision.
7. **AI research evaluation** — `historical-evaluation.server.ts`: first replays **already stored** decisions with zero
   AI calls. Any new historical LLM run is labelled "possibly contaminated (model training data)" and never reported as
   clean out-of-sample evidence. Profitability is never inferred from AI opinions or self-reported confidence.

## 3. Database (draft only, `docs/proposed-migrations/`)
Append-only evaluation runs, folds, evidence manifests and metrics; owner-read RLS, backend-only writes, immutable
provenance hashes, idempotency keys. Applied only after owner approval and a fresh-export rehearsal.

## 4. Cost controls
AI disabled by default for historical work. Any paid historical inference needs explicit owner approval with a
preview of calls, tokens and cost ceiling; hard sample and concurrency caps; atomic reservation before every call
(requires migration 0043 — the pre-0043 fallback is not adequate for batch runs). Test: refused approval → 0 provider
calls. Provider cost stays UNKNOWN unless AI Prime Tech reports it.
