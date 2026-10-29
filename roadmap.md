# Roadmap

## Phase 1
- [x] Database schema (20+ tables, row-level security, roles, signup trigger)
- [x] Authentication (email + Google + Lovable, verify email, forgot/reset password)
- [x] App shell, landing page, dark/light theme
- [x] Strategy validation engine + metrics library (src/lib)
- [x] Encrypted exchange credential server functions
- [x] AI assistant streaming endpoint (/api/chat)
- [x] Dashboard screen UI (uses src/lib/metrics.ts)
- [x] Exchange connections screen UI (uses src/lib/exchanges.functions.ts)
- [x] Trading bots screen UI
- [x] AI assistant chat screen UI (AI Elements installed)
- [x] Strategy builder screen UI (uses src/lib/strategy.ts)
- [x] Settings screen
- [x] Tests for strategy validation and metrics

## Phase 2
- [x] Exchange adapters (market data for 5 exchanges; key verification for Binance, Bybit, OKX, KuCoin)
- [x] Scheduled paper-trading engine (every minute) + indicators
- [x] Start bots in paper mode, verify exchange keys
- [ ] Coinbase key verification (different key format)
- [ ] Live order placement (later phase, needs explicit safeguards)

## Phase 3
- [x] Live price chart with buy/sell signal preview on the strategy page
- [x] One-click "Deploy to bot" opens the bot form with the strategy pre-selected

## Phase 4
- [x] Backtesting on historical prices (fees, slippage, SL/TP, Sharpe, drawdown)
- [x] Analytics by bot / strategy / pair + monthly PnL
- [x] Account risk limits + emergency stop (enforced by the engine)

## Phase 5–6
See the specification: engine integration, paper/live trading, backtesting, risk engine, billing, admin.
