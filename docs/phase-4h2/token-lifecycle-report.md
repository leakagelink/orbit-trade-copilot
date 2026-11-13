# Phase 4H.2 — worker token lifecycle: design and implementation (13 Nov 2026)

**Status: implemented and tested locally; DISABLED.** Nothing imports the binding; no route, schedule, account, secret or
deployment exists; both activation flags are unset. No migration changed (0049–0054 byte-identical).

## What changed

| File | Change |
|---|---|
| `src/lib/worker-auth-session.ts` (new, SHA-256 `b0ad32ae…5851cf`) | Pure lifecycle module: one bounded session per tick. No imports, no network, no environment, no logging. |
| `src/lib/futures-paper-worker-identity.server.ts` (SHA-256 `1f89dea4…00c3fe`; Phase 4H.1 was `2416b4ea…a45a`) | The old binding kept a long-lived `supabase-js` client with **background auto-refresh and no sign-out** (finding F9). It is replaced by `runIdentityFuturesPaperTick`: plain `fetch` transports, redirects refused, the lifecycle above, still gated by both flags. |

The Phase 4G hosted connection (`futures-paper-worker-hosted.ts`, `.server.ts`) is byte-identical.

## Lifecycle of one tick

```text
t0 ──► sign in (1 request, authTimeout, never retried)
       │  verify issued token: JWT shape · subject = user.id (= expected worker, if given) · role "authenticated"
       │  · iat not in the future (> skew) · expiry = min(exp claim, now + expires_in) · lifetime ≥ minimum
       ▼
       call deadline = min( t0 + tickBudget − signOutReserve ,  tokenExpiry − tokenSafety )
       │
       ├─ body (hosted tick over the six fpw_id_* wrappers) with a guarded call function:
       │    · a call starts only if  now + rpcTimeout ≤ call deadline
       │    · if only the TOKEN blocks the call → refresh at most once (budget permitting), re-verify, same subject
       │    · data API 401 / PGRST301–303 → session closed for the rest of the tick
       │    · refused calls are answered locally ("call not started"); the hosted classifier treats them as
       │      transient = nothing was written (never an unknown outcome → never a commit resend)
       ├─ body cut off at t0 + tickBudget − signOutReserve (session closed, tick signal aborted)
       ▼
       sign out exactly once: POST /auth/v1/logout?scope=local with the newest access token (signOutTimeout)
       forget all tokens  ──►  return bounded codes only            (all of this ends by t0 + tickBudget)
```

**Why `scope=local`.** Global sign-out would revoke every session of the worker, so a slow tick could sign out a
newer overlapping tick. Leases already prevent double processing; local scope ends only this tick's session.

**Why plain `fetch`, not the client library.** The library starts refresh timers and retries some refresh failures
internally with back-off. Plain requests give one attempt per call, a hard deadline and no hidden retries.

## Failure handling (bounded codes)

| Situation | Code | Body runs? | Sign-out? | Retry? |
|---|---|---|---|---|
| Wrong password / unknown user / unconfirmed / banned (400/401/403/422) | `AUTH_INVALID_CREDENTIALS` (+ allowlisted auth error code) | no | no session | no |
| Auth rate limit (429) | `AUTH_RATE_LIMITED`, `retryAfterMs` = Retry-After clamped to [S7 min, S7 max] | no | no session | no — the hint is for any future scheduler |
| Auth 5xx / network error | `AUTH_UNAVAILABLE` (`HTTP_5xx` / `NETWORK`) | no | no session | no |
| Sign-in timeout | `AUTH_TIMEOUT` | no | nothing to sign out (no token received) | no |
| Malformed reply / subject mismatch | `AUTH_MALFORMED_REPLY` | no | yes, if a usable access token came back | no |
| Token already expired / too short / not "authenticated" (e.g. a privileged token) / other identity / iat in future | `TOKEN_EXPIRED` / `TOKEN_LIFETIME_TOO_SHORT` / `TOKEN_NOT_WORKER_ROLE` / `TOKEN_WRONG_IDENTITY` / `CLOCK_SKEW` | no | **yes** (a session exists) | no |
| Refresh rejected / 429 / network / timeout / bad new token | `TOKEN_REFRESH_FAILED` (+ detail) | stops; later calls refused | yes (old token) | no |
| Data API rejects the token | `TOKEN_REJECTED` | later calls refused | yes | no |
| Body exceeds deadline | `TICK_DEADLINE_EXCEEDED` | cut off | yes | no |
| Body throws | `TICK_BODY_FAILED` (error text dropped) | — | yes | no |
| Sign-out 2xx / already invalid (401/403/404) | `SIGNED_OUT` | — | — | — |
| Sign-out 429 / 5xx / network / timeout | `SIGN_OUT_FAILED` (+ detail) | — | one attempt only | no |
| Limits that cannot fit one call, etc. | `CONFIG_INVALID` | no | nothing started | — |

**Secrecy.** Metrics and results hold codes, HTTP status words, allowlisted auth error codes and latencies only. No
token, refresh token, password, e-mail, header or provider message is stored, returned or logged; the module has no
logging at all. The credentials live only in the binding's closure and are sent only to the password endpoint.

## Session values — engineering defaults, all NOT APPROVED

| # | Value | Default | Rule | Status |
|---|---|---|---|---|
| S1 | Tick budget | **no default** — caller must set | 1 ms … 600,000 ms; must fit sign-in + one call + sign-out | **NOT APPROVED** |
| S2 | Auth request timeout (sign-in, refresh) | 3,000 ms | one attempt | **NOT APPROVED** |
| S3 | Sign-out reserve / timeout | 2,000 ms | reserved inside S1 | **NOT APPROVED** |
| S4 | Token safety margin | 60,000 ms | no call may end within it | **NOT APPROVED** |
| S5 | Minimum token lifetime at issue | 120,000 ms | must exceed S4 + call timeout | **NOT APPROVED** |
| S6 | Clock skew allowance (iat) | 30,000 ms | iat later than now + S6 → refused | **NOT APPROVED** |
| S7 | Rate-limit cooldown bounds | 60,000 … 900,000 ms | Retry-After clamped | **NOT APPROVED** |
| S8 | Refreshes per tick | 1 (0 allowed) | only between calls | **NOT APPROVED** |
| — | Data call timeout | Phase 4G `timeoutMs` (8,000 ms) | reused; part of the existing lease/RPC values | existing — **NOT APPROVED** |

T1–T11 (Phase 4H register) are untouched and remain **NOT APPROVED**.

## Verified token lifetime

The hosted access-token lifetime is **UNVERIFIED** (no hosted auth settings were read). The code does not assume it:
each tick derives the lifetime from the token actually issued (the shorter of the `exp` claim and `expires_in`) and
refuses tokens shorter than S5. The platform default is commonly one hour; that is not evidence for this project.

## Residual risks (documented, not solved by code)

1. **Access tokens outlive sign-out.** The data API checks the token signature, not the session, so a signed-out
   access token stays usable until its `exp`. The worker discards it; the database layer (0054 `fpw_id_check`) still
   refuses a disabled, revoked, promoted or owner identity on every call, independent of the token.
2. **Failed or skipped sign-out** (timeout, 5xx, or a platform that kills the request before the reserve) leaves a
   server-side session whose refresh token the worker never reuses. How long it lives depends on hosted session
   settings (time-box / inactivity), which are **UNVERIFIED**; an owner decision is needed.
3. **Auth rate limits are per hosted setting and possibly per egress address** — shared server egress could hit
   limits caused by others. Hosted values **UNVERIFIED**. One sign-in per tick bounds the worker's own rate.
4. **Market fetches are outside the session.** Only database calls are gated; the deadline cut-off stops waiting
   for a hanging fetch, and no database call starts afterwards.

## Tests

`src/test/worker-auth-session.test.ts` — 19 tests: normal lifecycle; deadline below budget and token; sign-out after
body failure; failed sign-in (invalid credentials, 5xx, network, timeout); expired / short / privileged / anon /
future-iat / wrong-identity / malformed tokens (all signed out); sign-out failures; 429 on sign-in and on refresh;
single refresh with new token; refresh failure modes; refresh disabled; deadline refusal and its classification;
cut-off of an overrunning body; data-API token rejection; allowlist; invalid limits; no secret in any output or console.
End-to-end through the binding: `src/test/phase4h2-security-regression.test.ts` (see security test report).
