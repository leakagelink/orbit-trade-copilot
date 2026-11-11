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
- Strategy governance keeps versioned admin-authored historical utilities separate from live authority; rejected evidence atomically quarantines strategy entries with immutable independent appeals/reviews, while exits stay available — partial scores cannot authorize capital or live bots.
- Deriv connections store owner PAT/App ID encrypted; Deriv trades only as Multipliers via `deriv-trade.server.ts` (OTP WebSocket), claimed orders, money stop loss required, and stay out of bot/crypto selectors — Options are never treated as spot.
- AI research is owner-private, Pro-gated and advisory; durable claims precede analysts, debate and decision stages, missing sources stay unavailable, and pure historical-volatility proposals never size or submit orders — keeps inference deduplicated and trading authority unchanged.
- AI Autopilot acts only via strict tools reusing UI server paths; live tools require typed LIVE opt-in and risk limits; short cron ticks submit/poll service-only asynchronous AI requests or advance one tool, never replaying interrupted actions — no withdrawals, keys or admin.
- Subdirectories have their own `AGENTS.md`; read it before changing files there.
- Toolkit extras use owner-scoped tables and Pro guards; alerts run on a separate authenticated cron and atomically claim a one-time notification, while trading-event triggers create durable inbox records — notifications cannot submit orders or delay risk exits.
- Optional MFA is enforced by a restrictive public-table policy and shared server-function security middleware; AppShell challenges before mounting protected content, and workspace session records are activity observations rather than an authoritative Auth device inventory — prevents UI-only security claims.
- Exports paginate owner reads and escape formulas; calendar and status use real provider/measured data.
- Support mailbox uses immutable owners, append-only messages and atomic support-only RPCs; drafts and folder state are participant-private — no arbitrary recipients.
- The public homepage reuses the browser-safe plan catalog for comparisons; workflow previews are illustrative and never submit orders or fabricate live prices — keeps marketing aligned with entitlements and trading safety.
- Public brand name and canonical site URL come from `src/lib/site.ts` (legal heads, canonical/og:url) and `public/sitemap.xml` — one place to change branding or domain.
- Responsive layout safety is shared in styles.css (zero-minimum grid/flex children, local table scrolling, touch targets and viewport-bounded dialogs); assistant height subtracts shared top/bottom navigation — prevents page overflow and hidden chat controls without changing access rules.
- Shared trading visuals live in global semantic tokens and AppShell; decorative 3D market candles dynamically load Three.js in a browser effect using actual chart data, respecting reduced motion — keeps trading logic untouched and SSR browser-safe.
- Exchange API secrets live only in `connection_credentials` (service-role only, AES-GCM via `src/lib/crypto.server.ts`); browser code never reads them — keeps keys out of the client.
- Orders, positions, trades and snapshots are read-only for users; only server code writes them — prevents fabricated trading records.
- Strategy validation lives in `src/lib/strategy.ts` and is shared by UI and server — one source of truth for deploy eligibility.
- AI chat streams through `/api/chat` (server route, bearer-verified) and persists to `ai_sessions` — keeps the AI key and prompts server-side.
- Bots execute only in `src/lib/engine.server.ts` (cron `/api/public/engine/tick`, plus `emergencyStop`); live mode is entered only via `enableLiveTrading` (typed confirmation, verified connection) and every order first claims a unique `orders.idempotency_key` row — no duplicate or browser-originated orders.
- `trades.realized_pnl` is gross; fees are stored separately and every report subtracts them — avoids double-counting.
- Account-wide `risk_settings` cap every entry; USD-M Futures also require separate bounded opt-in and service-only testnet certification — UI/AI cannot bypass them.
- Charts use `lightweight-charts` via dynamic import inside `src/components/tv-chart.tsx` behind ClientOnly — theme tokens are oklch and must be converted (canvas probe with hex fallback) before passing to the chart.
- Trade's production Binance chart reads the credential-free public feed in the browser with server fallback; order and AI pricing remain server-only — avoids hosted-region blocks without trusting display data for trading.
- Demo wallet balances change only through `public.wallet_apply` (service role, row-locked, never negative); wallet trade math lives in pure `src/lib/wallet-math.ts` and forex/commodity prices come from Yahoo Finance (`yahooChart` / exchange "yahoo") — no browser-side balance writes.
- Tier access is decided by `public.has_pro_access` and `public.has_elite_access` through `src/lib/plan.server.ts`; `src/lib/plans.ts` mirrors page eligibility in AppShell. Legacy premium maps to the highest tier; subscription writes are service-role-only, and recovery/exits remain owner-accessible after downgrade — prevents privilege escalation and stranded positions.
- All platform AI shares `ai-provider.ts` model facts and server-only `ai-prime.server.ts` connector transport; no silent provider fallback, and async request RPCs are service-only — keeps credentials private and provider billing consistent.
- Growth features (referrals, demo leaderboard, marketplace, admin overview) read through security-definer RPCs that return only aggregated or opted-in data, and admin RPCs check has_role themselves — keeps other users' private data out of the browser.
- Plan payments are prepaid NOWPayments crypto invoices: prices live in `src/lib/billing.ts` and are read server-side, callbacks are only hints — the payment is re-read from NOWPayments and `public.apply_crypto_payment` (service role) checks order/amount and activates once — prevents forged or underpaid activations.
