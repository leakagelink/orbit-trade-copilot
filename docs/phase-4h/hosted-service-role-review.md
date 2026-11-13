# Phase 4H — hosted connection: service-role security review (13 Nov 2026)

Scope: the disabled hosted Futures-paper worker connection (Phase 4G: `src/lib/futures-paper-worker-hosted.ts`, `.server.ts`) over drafts 0049 + 0050 + 0051. **Nothing was enabled, deployed or scheduled.** This review is a design and a threat model. No privileges were changed.

## 1. What the connection would run as

- **Identity.** On Lovable Cloud the only server-side database identity the Data API offers is the **service role**. It bypasses row-level security, and every server module that uses the generated admin client runs as it (40 non-test server modules today).
- **Where the key lives.** The key is in the server runtime's environment only. The binding loads the generated admin client lazily, inside the handler, and only when `FUTURES_PAPER_WORKER_HOSTED=enabled`. That flag is set nowhere; a test pins it. The binding never reads, returns, logs or forwards a key, and a test pins that too.
- **What the code may call.** A code-level allowlist permits six functions only: `fpw_acquire_lease`, `fpw_release_lease`, `fpw_snapshot`, `fpw_evaluated`, `fpw_commit` and `fpw_mark_review`.
- **What the database permits.** It grants those six functions to `service_role` only. It revokes direct EXECUTE on the 0049 commit (0050) and on the 0051 commit (v4) from every API role. No API role can write ledger, terms or check tables: guard triggers allow writes only inside the commit function.

## 2. Threat model

| Asset | Threat | Current control | Residual |
|---|---|---|---|
| Paper ledger integrity (future activation evidence) | Worker bug or altered worker submits convenient events | 0049 recomputes every figure. 0051 now *requires* the funding charges and exits the recorded candle implies, and refuses fabricated exits, skipped candles and ambiguous touches | **Recorded prices are still worker-supplied (G12).** 0051 proves the events match the recorded candle, not that the candle is the true market candle. The cross-account OHLC conflict check (0050) helps only when two accounts record the same candle |
| Paper configuration | `service_role` may INSERT/UPDATE accounts, account/strategy budgets and cost assumptions directly (0049 grants) | Status/halt changes are audited (0050). A stopped account stays stopped. Ledger columns are frozen outside the commit | **Budget and cost changes are not audited.** A compromised worker could raise a paper budget or lower a cost assumption (paper only; no capital) |
| Everything else in the database (real orders/positions/trades, subscriptions, wallets, encrypted exchange credentials, support data) | The worker code path holds a key that can read or write any public table and call any `service_role` function | Code allowlist. Import-graph tests: the connection reaches only the paper worker stack, with no exchange, order, credential, wallet, bot, Autopilot or AI modules | **The allowlist is enforced in code, not by the database.** A compromise of that code path, a dependency or the runtime has full service-role power. It could, for example, alter subscriptions or wallets, or read credential ciphertext. Decrypting credentials needs a separate secret, and placing real orders needs the exchange modules, which this path does not import |
| The service key itself | Exposure via logs, errors or responses | Codes-only monitoring. Refusal text is redacted (JWTs, keys, bearer tokens, `key=value` secrets, URL credentials). The key is never handled by the binding | The paper worker adds **no new secret**. The same key already serves the rest of the server |
| Availability | Lease theft or long holds | Fenced lease rows (10–300 s). A stalled holder cannot commit after takeover | A compromised worker could hold leases and stall paper accounts (paper only) |

**Privilege escalation.**
- *Within the database:* none found. Browser roles have no grant on the gateway, v3/v4 commits, leases, terms or checks. Every function derives the owner from the account row, and `fpw_evaluated` refuses a mismatching user id.
- *Through the worker:* the escalation is the one already present in any server code, namely full service-role access. The paper connection widens the attack surface by one scheduled code path that processes untrusted public market data. Parsing is pure: no eval and no dynamic imports.

## 3. Least-privilege migration path (design only; nothing created)

| Stage | Change | Effect | Feasibility on Lovable Cloud |
|---|---|---|---|
| 0 (now) | Connection off; six-function code allowlist; DB grants service-only | Nothing runs | Done |
| 1 | Audit triggers for budget, cost-assumption and account-config writes (append-only, bounded codes, actor) | Every paper-configuration change leaves a trace, as status changes already do | Plain SQL in a successor draft |
| 2 (recommended) | **Machine identity:** a dedicated non-admin auth user for the worker. A `futures_paper_worker_identity` registry is writable by the owner only. The six `fpw_*` functions are granted to `authenticated`, each checks `auth.uid()` against the registry, and EXECUTE is revoked from `service_role`. The worker signs in with that user's credentials (a stored secret) and uses short-lived tokens | A leaked worker credential reaches only the paper gateway plus ordinary signed-in-user rights. Row-level security applies. The service key is no longer needed for paper work | Uses only existing sign-in and RPC features. Needs a new secret, a sign-in flow inside the worker, and token refresh. Not built |
| 2-alt | A dedicated database role `fp_worker` (EXECUTE on six functions, no table grants) assumed via custom-role tokens | Narrowest database identity | **Not available with our tools:** it needs project token-signing or `authenticator` role grants that Lovable Cloud does not expose to us |
| 2-alt | Direct Postgres login role over TCP | Same as above | **Not available:** no database password access on Lovable Cloud; feasibility of TCP from Workers unverified |
| 3 | Run the paper worker as a separate deployment that holds only the stage-2 credential, not the service key | Removes full service-role power from the paper code path entirely | Depends on platform deployment options; unverified |

**Recommendation.** Do stage 1 and stage 2 before any activation. Until then, the connection must stay disabled.
