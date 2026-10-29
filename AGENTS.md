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
- Exchange API secrets live only in `connection_credentials` (service-role only, AES-GCM via `src/lib/crypto.server.ts`); browser code never reads them — keeps keys out of the client.
- Orders, positions, trades and snapshots are read-only for users; only server code writes them — prevents fabricated trading records.
- Strategy validation lives in `src/lib/strategy.ts` and is shared by UI and server — one source of truth for deploy eligibility.
- AI chat streams through `/api/chat` (server route, bearer-verified) and persists to `ai_sessions` — keeps the AI key and prompts server-side.
- Bots execute only in `src/lib/engine.server.ts`, invoked by the cron route `/api/public/engine/tick`; the engine is paper-only and pauses live bots — bots never run from the browser and live orders need an explicit later phase.
- Exchange I/O goes through `src/lib/exchange-adapters.server.ts` (Web Crypto HMAC, fetch only) and indicator math lives in pure `src/lib/indicators.ts` — Workers-safe and testable.
