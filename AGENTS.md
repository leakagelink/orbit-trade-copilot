<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- The public homepage reuses the browser-safe plan catalog for comparisons; workflow previews are illustrative and never submit orders or fabricate live prices — keeps marketing aligned with entitlements and trading safety.
- Responsive layout safety is shared in styles.css (zero-minimum grid/flex children, local table scrolling, touch targets and viewport-bounded dialogs); assistant height subtracts shared top/bottom navigation — prevents page overflow and hidden chat controls without changing access rules.
- Shared trading visuals live in global semantic tokens and AppShell; decorative 3D market candles dynamically load Three.js in a browser effect using actual chart data, respecting reduced motion — keeps trading logic untouched and SSR browser-safe.
- Exchange API secrets live only in `connection_credentials` (service-role only, AES-GCM via `src/lib/crypto.server.ts`); browser code never reads them — keeps keys out of the client.
- Orders, positions, trades and snapshots are read-only for users; only server code writes them — prevents fabricated trading records.
- Strategy validation lives in `src/lib/strategy.ts` and is shared by UI and server — one source of truth for deploy eligibility.
- AI chat streams through `/api/chat` (server route, bearer-verified) and persists to `ai_sessions` — keeps the AI key and prompts server-side.
- Bots execute only in `src/lib/engine.server.ts` (cron `/api/public/engine/tick`, plus `emergencyStop`); live mode is entered only via `enableLiveTrading` (typed confirmation, verified connection) and every order first claims a unique `orders.idempotency_key` row — no duplicate or browser-originated orders.
- Exchange I/O goes through `src/lib/exchange-adapters.server.ts` (Web Crypto HMAC, fetch only) and indicator math lives in pure `src/lib/indicators.ts` — Workers-safe and testable.
- Backtests run in pure `src/lib/backtest.ts` via `runBacktestFn`, using the same rule/risk semantics as the engine — results stay comparable to paper trading.
- `trades.realized_pnl` is gross; fees are stored separately and every report subtracts them — avoids double-counting.
- Account-wide limits live in `risk_settings` and are checked by the engine before every entry — UI cannot bypass them.
- Manual trades go through `src/lib/manual.server.ts` (open/close shared by UI server fns, engine tick and emergency stop); forex/commodities run on OANDA (`oanda*` in exchange-adapters, apiKey=token, apiSecret=account ID), paper SL/TP and OANDA broker-close sync run in `manageManualPositions` each tick.
- Charts use `lightweight-charts` via dynamic import inside `src/components/tv-chart.tsx` behind ClientOnly — theme tokens are oklch and must be converted (canvas probe with hex fallback) before passing to the chart.
- Binance production candles and history retry the official data-only host when the primary feed fails; testnet and signed/order endpoints never switch hosts — keeps charts available without changing venues or execution.
- Trade's production Binance chart reads the credential-free public feed in the browser with server fallback; order and AI pricing remain server-only — avoids hosted-region blocks without trusting display data for trading.
- Demo wallet balances change only through `public.wallet_apply` (service role, row-locked, never negative); wallet trade math lives in pure `src/lib/wallet-math.ts` and forex/commodity prices come from Yahoo Finance (`yahooChart` / exchange "yahoo") — no browser-side balance writes.
- Tier access is decided by `public.has_pro_access` and `public.has_elite_access` through `src/lib/plan.server.ts`; `src/lib/plans.ts` mirrors page eligibility in AppShell. Legacy premium maps to the highest tier; subscription writes are service-role-only, and recovery/exits remain owner-accessible after downgrade — prevents privilege escalation and stranded positions.
- Arbitrage math lives in pure `src/lib/arbitrage.ts`; authenticated highest-tier functions use `arbitrage.server.ts` for server-fetched depth and prefunded legs. Each run and both order intents are durably claimed before submission; ambiguous fills lock further runs for review, never blind retry or transfer funds. AI reviews are advisory; live execution requires user confirmation because cross-exchange orders are not atomic.
- New AI calls use the server-only `@lovable.dev/ai-gateway` SDK with generated contracts loaded through `src/ai-gateway.types.ts`; existing AI integrations keep their model selections — typed native requests prevent provider-contract drift.
- Arbitrage reconciliation is lookup-only by durable client order IDs, with a cooling period and compare-and-set persistence; missing, open, partial or unequal fills keep the lock — prevents blind resubmission and racing active execution. Base fees adjust inventory; only quote fees are additionally deducted from actual cash flows.
- Scalps are manual positions flagged `is_scalp` (positions + trades) with `max_hold_until`; rules live in pure `src/lib/scalping.ts`, new entries require highest-tier access and exits run through `checkManualPosition` (engine tick + owner-authenticated `checkScalps` polling) — one exit path for manual trades.
