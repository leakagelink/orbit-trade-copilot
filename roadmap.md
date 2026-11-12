# Roadmap

## Engine A Phase 1 — Orbit AI Command Center — 12 November 2026
- [x] Decision records, 12-agent envelopes, bull/bear/manager/portfolio views, source statuses, read-only risk evaluation, token/call/time limits, cancellation, overview/history/cost dashboard; 514 tests pass; signed-in screens checked; no orders
- [ ] Apply draft migration 0043 (permanent records, frozen finished runs, risk evaluation history, admin limits) — waiting on owner review
- [ ] Fresh signed-in research run on the new screens — not run to save AI allowance; waiting on owner request
- [ ] Engine B (Futures scalping AI) and Phases 2–4 — not authorized

## Phase 1.6 preparation only — 12 November 2026 09:04 UTC
- [x] Read-only production check: Autopilot OFF, Live Futures OFF, 0 certification records, nothing open/pending
- [x] Repeatable export practice-restore check; current 06:52 export readable but predates safety migration 0039 → not suitable
- [x] Read-only test-account preflight (GET-only exchange reads); refuses on the production sign-in
- [ ] Verify tomorrow's fresh export — waiting on the new export
- [ ] Read-only verification of dedicated test account — waiting on owner's test sign-in and fresh Testnet key
- [ ] Apply 0040/0041 and run Testnet scenarios — waiting on owner approval

## Phase 1.6 isolated fault-injection certification — 12 November 2026
- [x] Inspect isolation prerequisites — only Testnet connection shares an owner with production; kill switch is account-wide; stopped per Section B
- [ ] Dedicated test sign-in, separate Testnet API key, its Elite access and owner-stated limits — waiting on owner
- [ ] Build INJECTED harness (12 scenarios) and BROKER trigger runs, then Phase 1.6 report — waiting on prerequisites and harness approval

## Phase 1.5 Testnet certification — 12 November 2026
- [x] Verify Testnet-only account, symbol, risk, lease and broker inventory before any mutation
- [x] Execute safe supported broker scenarios A–I; A/B pass after flat-inventory fix, C–I not fully testable on real Testnet without an approved fault harness
- [x] Run regression tests (274 pass) and produce evidence report — decision FAIL / NOT CERTIFIED; stopped before Phase 2
- [ ] Isolated Testnet fault harness for partial fills, protection failure, timeouts, kill switch, concurrency and restart — needs separate owner approval
- [x] Freshly connect AI Prime Tech after the 04:48 UTC workspace move; workspace-shared connection linked; read-only models check HTTP 200; no inference or trading

## Phase 1 authorization and workspace move — 12 November 2026
- [x] Harden Futures accounting, partial fills, protection, risk ordering, attribution, fencing and immutable environments; 271 tests pass and signed-in real/testnet trade views checked; no live orders
- [ ] Phase 2 — waiting for owner approval
- [ ] Fresh real Binance testnet failure lifecycle for the new recovery code — requires owner approval and test credentials; not run
- [x] Freshly connect AI Prime Tech after the 03:42 UTC workspace move; prior links no longer apply — model check HTTP 200
- [x] Freshly connect AI Prime Tech after the 04:25 UTC workspace move; prior links no longer apply — read-only model check run
- [x] Freshly connect AI Prime Tech after the 04:35 UTC workspace move; new workspace-shared connection linked; read-only models check HTTP 200; no inference or trading action


## Workspace move 12 Nov 2026
- [x] Freshly connect AI Prime Tech in the new workspace; previous-workspace connection references no longer apply. Read-only models check returned HTTP 200 and the configured Claude model is available; no inference or trading action was run.

## Binance Futures scalping and scoring — 11 November 2026
- [x] Add separate USD-M Futures execution, broker-side algo protection, reduce-only recovery and UI/AI controls; market_type dispatch prevents Spot confusion; live entries remain certification-gated
- [x] Run scoring/governance/strategy-rule tests — 40 passed; not independent live certification
- [ ] Reconnect AI Prime Tech and verify AI-assisted Futures analysis — owner connection approval required
- [ ] Verify Futures lifecycle on testnet before any real-money test — no testnet credentials available; production account read/trading permission verified, but 0 USDT available, Hedge Mode enabled, current user Free, and owner risk caps not supplied
- [x] 242 tests pass, including 40 scoring/governance/strategy checks and 9 Futures risk/math checks; actual account Elite denial verified, desktop/mobile Futures layout inspected with display-only plan override; no orders or account-mode changes

## AI Prime Tech migration and workspace move — 11 November 2026
- [ ] Reconnect AI Prime Tech in the new workspace after the 15:05 UTC move — connection card declined; owner approval required
- [x] Switch assistant, trade ideas, research, arbitrage review and Autopilot to the AI Prime Tech Claude connection
- [x] Replace unsupported Claude batches with service-only asynchronous model requests; trading safety and interrupted-action rules retained
- [ ] Verify connected AI streams, reports and scheduled replies — new workspace has no linked AI connection; earlier provider/connector smoke calls succeeded, but full app flows remain unverified; no live orders submitted

## Workspace move 8 Nov 2026
- [ ] Reconnect NOWPayments after the 05:17 UTC workspace move — connect card was closed; waiting on owner
- [x] Reconnect NOWPayments in the new workspace (status check OK)

## AI Autopilot requested 8 November 2026 (paper only, existing risk settings, Claude own key)
- [x] Autopilot page and Claude tool loop: account overview, market data, create strategy, backtest, start/stop paper bots, demo trades, Elite scalps, close demo positions, Elite arbitrage scan + paper run
- [x] Demo-only strict tool inputs, per-request limits (5 entries, 3 bots), audit log entries; tests pass
- [ ] Live Claude run — needs the owner's Anthropic API key (secure form declined so far)
- [x] Real-money Autopilot: typed LIVE opt-in, Binance spot + Deriv Multipliers tools, automatic scheduled runs, emergency stop switches AI off
- [ ] First real Deriv buy/sell and Binance live AI trade — not run (needs Claude key; real money)
- [ ] Switch AI Assistant, trade ideas, research and arbitrage review to Claude — still on the previous AI

## Remaining work requested 7 November 2026, Claude selected
- [ ] Switch assistant, trade ideas, research and arbitrage review to the owner's Claude account — secure connection card was declined; no credential supplied, no provider switched; requires approved connection and real report/stream verification
- [x] Improve historical scoring input safety and evidence sufficiency reporting without inventing certification or enabling live bots; retain policy snapshot in new reports, observe drawdown without utility policy, withhold overflow/nonfinite scores; 210 tests pass and signed-in evaluation save/reload plus mobile verified
- [ ] Complete operator/provider/payment/independent-validation tasks listed below when required accounts, evidence and owner details are available

## Native master-prompt completion requested 7 November 2026
- [x] Versioned admin-authored historical performance/risk utilities and approximate confidence intervals; no configured policy means no scores, and incomplete evidence never produces composite/live approval
- [x] Owner-private integrity cases, immutable appeal/review history and atomic entry quarantine; exits remain available; administrator case/policy workflows need independent operator session for end-to-end verification
- [x] Promotion checklists, evidence sufficiency and allocation-withholding guardrails; no fabricated qualified rankings or capital recommendations
- [x] Frozen backtest replay detects removed trades/equity manipulation; browser backtest writes revoked; new position entry fees persist and round-trip cost tests reconcile cash flow
- [x] Read-only Binance/OKX original-order verification persists observations; locks never clear from lookup alone; actual venue recovery needs original verified accounts and atomic ledger reconciliation
- [x] Measured research-agent duration/status/token monitoring; authoritative USD provider cost remains unavailable rather than estimated
- [x] 202 tests pass; signed-in real OKX historical backtest/evaluation saved and reloaded, paper-only draft eligibility persisted, mobile has no overflow and regular-user admin denial verified; build OK; no live orders or inference run for testing
- [ ] Complete validated seven-component scoring, ranked allocations and live promotion — requires independent holdout/paper/prediction/regime evidence and validated administrator policy; current partial historical utilities are not certification
- [ ] Appeals/admin-policy end-to-end — requires independent administrator/operator session; no roles changed for tests
- [ ] Social data and email/legal setup require authorized sources and owner identity; live recovery certification requires isolated provider accounts
- [x] Owner chose native app upgrades, not separate paid hosting/original Python engines

## Exchange account selections
- [x] Add Spot / Futures / Both for Binance, Bybit and OKX with owner-authorized later edits, preserving trading authority and other venues' selections
- [x] 16 tests pass; signed-in Binance Both form verified; build OK
- [ ] Existing connection edit save/reload — current account has no Binance/Bybit/OKX connection; requires user's connection, no test keys saved

## Deriv connection
- [x] Enforce one non-disconnected Deriv per owner with deployed unique index; reject token replacement until disconnect; verified connections display Active; 12 tests pass and signed-in existing pending connection blocks Add without changing the account
- [x] Add owner-private Deriv PAT/App ID storage, read-only Options-account verification and exchange controls; Deriv orders remain unavailable and excluded from Trade/Bots
- [x] 11 connection/safety tests pass; signed-in desktop/mobile PAT form and demo toggle checked with no overflow; build OK
- [ ] Real Deriv save/verification — requires the owner's PAT and matching PAT App ID; no credentials or orders submitted during testing

## Remaining upgrade requested 7 November 2026
- [x] Connect advisory research to isolated, user-confirmed forward paper history; signed-in BTC confirmation, reload and waiting observation verified; no orders or wallet changes
- [x] Enforce atomic UTC-month research-run allowances (operational defaults Pro 10 / Elite 30, claimed attempts counted); usage display and deployed schema verified; token billing caps are not implemented
- [x] Harden emergency-stop result reporting and expose unresolved recovery items without resubmitting orders; verified owner inventory, failure-injection tests and mobile screen; did not close existing positions during testing
- [x] Add historical fee-manifest, candle chronology/range and timestamp integrity checks; preserve fail-closed promotion
- [x] Verify signed-in forward-paper save/reload/observation and mobile recovery; 159 tests passed; browser write grants revoked and verified; no live orders executed
- [ ] Social data, email sender, legal identity and live/provider/operator/MFA testing — require authorized providers, owner details or appropriate accounts; no fabricated setup

## Approved safety and trading intelligence upgrade
- [x] Server-only bot mutations and connection verification; owner-bound engine reads; signed-in draft create/reload/delete verified
- [x] Fail-closed risk reads, open-loss limits, ambiguous-order locks and paused-bot exit management; 136 tests pass
- [x] Atomic account risk gate serializes pending entry intents and includes reserved exposure
- [x] Prior-bar/next-open gap-aware simulations; complete canonical-hashed config/candle/trade/equity evidence
- [x] Append-only independent evaluation history, duplicate/fabricated-profit/hash checks and explainable sufficiency screen; signed-in save/reload and mobile checked
- [ ] Full validated numerical scoring/live promotion — experimental policy controls and historical utilities now exist; independent holdout/paper/prediction/regime evidence and policy validation remain required; live activation stays blocked
- [ ] Durable exchange reconciliation and full kill-switch recovery — needs isolated provider failure-testing setup; uncertain fills stay locked, never auto-resubmitted
- [ ] Legacy/venue cost reconciliation and qualified portfolio allocation — new fees, immutable integrity appeals and allocation guardrails exist; actual historical fees, consolidated FX/correlation evidence and independent operator verification remain required
- [ ] Indian live trading — broker/static-IP/compliance approval required; original external Python engines excluded by owner's native-upgrades choice

## AI research — Phase 3
- [x] Add owner-private trader, three risk assessments and portfolio synthesis with upstream failure guards
- [x] Persist advisory historical scenarios with deterministic levels; no sizing or order submission
- [x] 120 tests pass; signed-in BTC research saved five decision reports and one proposal, persisted on reload/download; desktop/mobile checked with no overflow or page errors
- [x] Isolated user-confirmed forward paper scenarios and atomic research-run allowances; reports never submit orders; no token-denominated billing ceiling

## AI research — Phase 2
- [x] Verified Yahoo headline metadata, ticker/date filtering and provenance; missing sources are not fabricated
- [x] News analyst, Bull–Bear debate and research-manager synthesis with dependency failure guards
- [x] Private report storage, source links and structured JSON report download
- [x] 109 safety/regression tests pass; build OK
- [ ] Social sentiment inference — needs authorized social-data access; public feeds returned 403, so reports explicitly say unavailable
- [x] Signed-in inference, report reload/download and desktop/mobile verification completed with a real BTC research run

## AI research — Phase 1
- [x] Owner-private research runs, analyst reports and usage records
- [x] Advisory Market and Fundamentals pipeline with real server-fetched data; missing financial statements remain unavailable
- [x] Minimal research screen, history and failure recovery
- [x] 100 tests passed, build OK, signed-out research redirects to sign-in without runtime errors
- [x] Signed-in report persistence and desktop/mobile research rendering verified

## Promotions
- [x] All plans free for every signed-in user until 4 Nov 2026 (end of day, India time)
- [x] NOWPayments reconnected in new workspace as a workspace-shared connector

## App experience
- [x] Modern animated splash screen on app load
- [x] Caching on all screens so the app loads fast
- [x] NOWPayments reconnected after second workspace move (workspace-shared connector)

## Crypto plan payments (NOWPayments)
- [x] Connect NOWPayments in the new workspace
- [x] Pro $249/mo, $1999/yr; Elite $449/mo, $3899/yr shown on Plans page with crypto checkout
- [x] Payment-confirmation endpoint activates the plan only after NOWPayments confirms the payment

## Launch readiness and growth
- [x] Terms, Privacy, Risk Disclosure and Refund pages linked from the homepage
- [x] Admin panel (role-checked overview and user list)
- [x] Getting-started checklist and beginner lessons
- [x] Invite links with referral tracking (rewards reviewed manually)
- [x] Opt-in demo leaderboard (paper trades, 30 days, net of fees) and Pro strategy marketplace
- [x] Hindi menu option and installable phone app icon
- [x] Paid checkout — crypto via NOWPayments
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
- [x] Paid checkout — crypto via NOWPayments

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

## Phase 1.6 (Option A approved: dedicated test account)
- [x] Read-only setup checklist prepared (no harness, migrations, setting changes or orders)
- [ ] Owner creates test sign-in, new Testnet key, Elite access, limits — blocked on owner
- [ ] Read-only verification of test account — after owner says ready
- [ ] Start Phase 1.6 — blocked on explicit owner approval
- [ ] Owner decision: production certified flag + live Autopilot still on while Phase 1.5 is FAIL

## Workspace move (12 Nov 05:54 UTC)
- [x] Connect AI Prime Tech in the new workspace (done 12 Nov)

- [x] Reconnect AI Prime Tech in this workspace and verify (done 12 Nov)
