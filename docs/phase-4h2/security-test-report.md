# Phase 4H.2 — security test report (13 Nov 2026)

All tests are local: PGlite (in-memory PostgreSQL) and one throwaway local PostgreSQL 17.11. No hosted database,
auth service, network, account or secret was used. Fake tokens are unsigned look-alikes created by the tests.

## Three layers — what each test proves

| Layer | Meaning | Where it lives | Proven by | Status |
|---|---|---|---|---|
| **A. Database authorization** | The database itself refuses the caller | Drafts 0053/0054 (`fpw_id_check`, enrollments, grants) | PGlite: `phase4h2-security-regression.test.ts`, `migration-0054-identity-lifecycle.test.ts`; real PostgreSQL: `futures-paper-0054.pg.test.ts` | **Proven locally only.** Drafts are NOT applied on the hosted database, so layer A does not exist in production yet |
| **B. Code allowlisting** | The worker code can only ask for allowed things | identity mapping, session allowlist, binding transport allowlist, import graph | `worker-auth-session.test.ts`, `phase4h2-security-regression.test.ts` (B), `phase4h2-isolation.test.ts` | Proven. Code rules can be changed by anyone who can change the code; they are not a security boundary on their own |
| **C. Runtime isolation** | The process running the worker holds no privileged key | deployment | — | **BLOCKED / not testable here**: in this project the server runtime holds the privileged key. See `runtime-isolation-feasibility.md` |

## New tests

**`src/test/worker-auth-session.test.ts`** (19, layer B) — token lifecycle; see `token-lifecycle-report.md`.

**`src/test/phase4h2-security-regression.test.ts`** (11) — 0049 → 0054 in PGlite, driven through the real binding
`runIdentityFuturesPaperTick` with a fake auth service and data API on `fetch`:

| # | Test | Layer | Result |
|---|---|---|---|
| 1 | Binding refuses without both flags, without credentials, and for a non-https backend | B | pass |
| 2 | Full signed-in tick commits all 6 candles; exactly one sign-in and one local sign-out; only the password, logout and six wrapper endpoints are requested; the publishable key is never a bearer; the password goes only to the password endpoint; no secret in the result; nothing logged | A+B | pass |
| 3 | Transport refuses non-wrapper names (`fpw_commit`, admin/owner functions, `wallet_apply`, injection-like names) without any request | B | pass |
| 4 | Wrong credentials and a 429 end the tick before any data call (cooldown 120 s from Retry-After) | B | pass |
| 5 | **All six wrappers**: exist, EXECUTE only for `authenticated` (not anon, not service_role, not PUBLIC), and each body calls the current-status check | A | pass |
| 6 | **Disabled identity** between ticks: next tick writes nothing, database refuses, sign-out still happens | A | pass |
| 7 | **Revoked enrollment**: same; re-enrolling resumes; no duplicate commits | A | pass |
| 8–9 | **Promotion to admin / super_admin in the middle of a tick**: every later call reached the database and was refused; nothing committed; the pre-promotion lease could not be released and blocked the next tick until it expired; after demotion and expiry, exactly 6 commits, no duplicates | A | pass |
| 10 | **Account ownership change**: refused by the immutability trigger; when the trigger is bypassed (residual F13), the old owner's enrollment stops working on all six wrappers; restoring the owner restores access | A | pass |
| 11 | Worker that **becomes a paper account owner** is refused through the signed-in path | A | pass |

**`src/test/phase4h2-isolation.test.ts`** (7, layer B / change control) — 0049–0054 + rollbacks byte-identical, no
successor draft, journal ends at 0039; Phase 4G connection unchanged; lifecycle module has no imports or I/O; the
binding has no client library, privileged key, logging or timers, uses refused redirects and local sign-out, and
reaches exactly the paper-worker stack; **no worker module reaches exchange, wallet, credential, order, Autopilot,
AI/research, bot, admin-client or server-function modules**, and none of 20+ such modules reaches the worker; nothing
in the app, routes or schedules reaches the binding; flags unset.

## Mutation checks (deliberate breaks, each reverted)

| Mutation | Caught |
|---|---|
| Skip sign-out | yes |
| Unbounded refreshes | yes |
| Accept expired token | yes |
| Accept non-"authenticated" (privileged) token | yes |
| Treat 429 as ordinary failure | yes |
| Keep session after data-API 401 | yes |
| Longer of claim/reply lifetime wins | yes |
| Global instead of local sign-out | yes |
| Remove the binding's wrapper allowlist | yes (after adding test 3) |
| Remove the budget-only call cut-off | not caught — **equivalent**: the token-bound deadline is never later than the budget cut-off, so the second check refuses the same calls |
| Don't close the session at the body deadline | not caught — **equivalent**: sign-out starts right after and closes the session synchronously first |

## Regression results

| Suite | Result |
|---|---|
| Full suite (`bunx vitest run`) | **1,314 passed, 0 failed, 66 skipped** (skipped = real-PostgreSQL suites needing a URL, run separately, plus 19 for drafts 0043–0045) |
| Real PostgreSQL 17.11, throwaway (`scripts/futures-paper/concurrency-check-4h1.sh`) | 0054: 4/4; then 0052, 0051, hosted, worker and earlier concurrency suites: 43/43 (one run this phase) |
| Earlier change-control tests (4F, 4G, 4H, 4H.1) | pass unchanged |
| Typecheck / build | run by the platform after this change (see final report) |

## Residual risks carried forward

- **F4** a role promotion committing during one in-flight call lets that call finish (next call refused) — unchanged.
- **F13** the database owner can bypass triggers — test 10 shows the enrollment join still refuses.
- **F15** the worker identity keeps ordinary signed-in rights on other tables (RLS-limited) — unchanged.
- **New:** access tokens stay valid until `exp` after sign-out; failed sign-out leaves a session (see lifecycle report).
