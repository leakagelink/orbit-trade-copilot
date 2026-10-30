# Roadmap

## Arbitrage
- [ ] Pro-only multi-exchange opportunity scanner with executable bid/ask prices and fee estimates
- [ ] Prefunded two-exchange execution, durable order claims and partial-fill visibility
- [ ] Arbitrage screen, execution history and access/math tests

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

## Phase 5
- [x] Live market orders (Binance, Bybit, OKX, KuCoin; testnet for Binance/Bybit/OKX)
- [x] Go Live with typed confirmation, Back to paper
- [x] Automatic SL/TP/exit management for live positions (checked every minute)
- [x] Emergency stop: close everything
- [ ] Zerodha / Upstox — blocked: needs a paid Kite Connect / Upstox developer app
- [ ] Coinbase live orders — different key format

## Manual trading (extra)
- [x] Trade page: TradingView lightweight chart, crypto/forex/commodities, buy/sell, SL/TP, close
- [x] OANDA adapter (forex + commodities, practice account support)
- [x] AI trade idea from live data + "Ask the AI" strategy link

## Wallet, markets & plans
- [x] Demo wallet: deposit / withdraw (virtual USD), funds manual trades, history
- [x] All major/cross/exotic forex pairs + metals, energy, grains, softs, livestock via Yahoo Finance
- [x] AI one-click trade with the AI's stop/target (Pro, user confirms)
- [x] Free vs Pro: Free = manual trading + wallet; Pro = AI, strategies, bots, backtests, analytics (enforced on server + database)
- [ ] Pro checkout (Stripe) — waiting for the user to confirm Stripe setup and the Pro price
- [ ] Real-money wallet — not possible without broker/money-transmitter licences; real money trades via the user's own broker

## Phase 6
See the specification: engine integration, paper/live trading, backtesting, risk engine, billing, admin.
