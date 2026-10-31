# Roadmap

## Launch readiness and growth
- [x] Terms, Privacy, Risk Disclosure and Refund pages linked from the homepage
- [x] Admin panel (role-checked overview and user list)
- [x] Getting-started checklist and beginner lessons
- [x] Invite links with referral tracking (rewards reviewed manually)
- [x] Opt-in demo leaderboard (paper trades, 30 days, net of fees) and Pro strategy marketplace
- [x] Hindi menu option and installable phone app icon
- [ ] Paid checkout — waiting for Pro/Elite monthly and yearly prices
- [ ] Email notifications — waiting for the owner's email domain setup
- [ ] Legal pages company name, country and contact — placeholders until owner provides them
- [ ] Copy trading and Zerodha/Upstox — deferred by owner

## Support-only mailbox
- [x] Private threaded in-app user/support messages, append-only replies and owner-only drafts; existing requests preserved
- [x] Inbox, sent, search, unread, star, archive and trash/restore controls with participant-private folder state
- [x] Dashboard/mailbox navigation and support operator view; Free mailbox access without unlocking paid dashboard
- [x] Signed-in send, follow-up reply and draft reload checked; recipient validation tests and mobile no-overflow checks pass; 22 relevant tests, build OK
- [ ] Support-operator reply-to-user end-to-end — needs an operator account; current account is a regular user and roles were not changed

## Trading toolkit and account safety
- [x] Paid watchlist and server-checked price alerts with atomic one-time delivery and stale-quote rejection
- [x] Paid trading journal and paginated, formula-safe trade-history CSV export
- [x] Economic calendar with real TradingView events, isolated cross-origin rendering and attribution
- [x] Durable trade, bot, connection and price notifications; new workspace-session warnings in Settings
- [x] Two-step verification, public-table/server enforcement, workspace device activity and revoke-other-sessions controls
- [x] Support tickets, role-protected operator replies and measured on-demand connectivity checks
- [x] Free restrictions and signed-in support save/reload checked; calendar events/navigation checked; paid layouts inspected with display-only plan override; mobile no overflow; 46 combined safety/regression tests passed
- [ ] Paid save/export/alert delivery end-to-end — no Pro/Elite test account exists; no subscriptions were changed for testing
- [ ] Authenticator enrollment/re-login and operator replies end-to-end — requires an actual authenticator-enabled session and support-operator account; current account was not modified
- [ ] Scheduled alert delivery on hosted app — schedule installed; app must be published, and provider quotes must be reachable from hosting

## Homepage redesign
- [x] Replace homepage with full trading-platform presentation, market coverage, workflows, safeguards, FAQ and three-tier comparison
- [x] Add cohesive 3D trading imagery and mobile-friendly signup calls to action
- [x] Verify workflow tabs, yearly selection, FAQ, mobile menu and signup destination; no overflow at 393/320px, no browser errors, 21 tests passed and build OK

## Three subscription tiers
- [x] Free / Pro / Elite with monthly and yearly selector, existing-feature comparison and no invented prices
- [x] Paid-tier access checks; Elite-only new scalping/arbitrage entries; owner recovery and exits retained
- [x] Verified signed-in Free account: three cards, yearly selection, Elite upgrade screens, mobile no-overflow; 30 access/trading tests passed, build OK
- [ ] Paid checkout — waiting for monthly/yearly prices, currency and payment setup

## All-screen mobile optimization
- [x] Fit all page sections, headers, forms, charts and locally scrollable tables to mobile widths
- [x] Optimize chat viewport/history selector, dialogs, touch targets and bottom-bar clearance
- [x] Check all 14 main screens at 393px, builder and selected screens at 320px, four tablet screens, desktop Trade and public pages; no page overflow, 21 tests pass. Pro layouts inspected with browser-only plan response override, not paid trading execution.

## Trading UI refresh
- [x] Modern trading workspace, dimensional surfaces and animated 3D market scene using actual candles
- [x] Polish Trade/Wallet screens, shared controls and mobile layout without changing trading rules
- [x] Verify signed-in Trade/Wallet, 3D rendering, theme switching, mobile menu, no page overflow and reduced-motion behavior; 21 existing tests pass

## Scalping (Elite)
- [x] Scalping page: 1m/5m/15m chart, one-click buy/sell with % stop/target set on the server, auto time limit, close all
- [x] Stops/targets/time limits checked every 5s while the page is open (every minute otherwise); today's scalp stats
- [x] Scalping bot templates (EMA 9/21, RSI dip, Stoch RSI) → strategy → deploy to bot
- [ ] Live-account scalps (exchange/OANDA) — not tested: needs a user-connected account

## Arbitrage
- [x] Add read-only Binance/OKX reconciliation by durable client ID; missing, open, partial or unequal fills stay locked
- [x] Verify Free browser restriction and paper execution/math/duplicate-request/reconciliation tests (24 tests passed)
- [ ] Verify authenticated Elite paper scan/execution/history in browser — blocked: only current account is Free; no Elite test session available
- [ ] Verify exchange connections and small confirmed test/live trades — requires user-connected prefunded accounts and explicit trade confirmation
- [x] Elite-only multi-exchange opportunity scanner with executable bid/ask prices and fee estimates
- [x] Prefunded Binance ↔ OKX spot execution with typed confirmation, durable order claims and partial-fill visibility; Bybit/KuCoin scan and paper only
- [x] Arbitrage screen, AI review, execution history and access/math tests
- [ ] Unattended arbitrage / automatic inventory recovery — deferred: user chose advisory AI; needs exchange-tested reconciliation and separately confirmed recovery orders

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
