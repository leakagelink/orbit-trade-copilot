# Phase 4H.3 — final token cleanup hardening and production readiness review — final report (13 Nov 2026)

**Nothing was applied, enabled, scheduled or traded.**
- No hosted database access at all (not even read-only); no hosted writes; no auth service or data API contacted.
- No migration applied or rolled back; 0049–0054 and rollbacks are byte-identical (pinned by `phase4h2-isolation.test.ts`).
- No project, worker account, credential, secret, route, schedule or deployment created; both activation flags unset;
  the new setting name `FUTURES_PAPER_WORKER_USER_ID` is set nowhere (tested).
- No Testnet or live order; Autopilot, Live Futures, exchange credentials and risk settings untouched.
- No AI call, no paid service. T1–T11 and S1–S8 unchanged and **NOT APPROVED**. Phase 4I not started.

## 1. Unconditional sign-out — fixed

**The defect (Phase 4H.2).** Sign-out ran *after* a `try { … } finally { … }` block, not inside it. Any unexpected
exception after sign-in — a failing clock or timer, a throwing reply field during validation, a fault inside refresh —
skipped sign-out entirely and rejected the whole call, leaving the server-side session open.

**The fix** (`src/lib/worker-auth-session.ts`, `runWithWorkerSession`):

| Requirement | How it is met |
|---|---|
| Whole lifecycle covered by an outer cleanup structure | Clock reads, timers, sign-in, validation, refresh, body, guarded calls and transports all run inside one `try / catch / finally`. An unexpected exception becomes `TICK_INTERNAL_ERROR` with a bounded stage (`SIGN_IN`, `VERIFY`, `REFRESH`, `CALL`, `BODY`); the function never rejects. |
| Sign-out attempted exactly once when a usable token was received | The access token is remembered as soon as a JWT-shaped token arrives, **before** validation; the `finally` block calls `signOutOnce` once. There is no second call site and no retry. |
| Sign-out runs even after an unexpected exception | `signOutOnce` is self-contained: if the injected timer fails it falls back to the platform timer so the request is still sent with a deadline; every fault inside it is caught. |
| Original failure preserved | The outcome is the **first** failure recorded in the tick. Sign-out codes are never failures of the tick, so a failed sign-out cannot replace it. |
| Tokens forgotten after cleanup | Session closed, tick signal aborted, access and refresh tokens cleared in `finally`. A refresh that finishes later is discarded; a call captured by the body is refused locally; nothing is recorded or reported after the result is returned. |
| No sign-out retry | One attempt (tests assert exactly one in every case). |
| No false claim of termination | `signOut` is `SIGNED_OUT` **only** on a 2xx logout reply. 401/403/404, 429, 5xx, network, timeout and exceptions are `SIGN_OUT_FAILED` with a bounded detail, and `signedOut` is false. (Phase 4H.2 counted 401/403/404 as signed out; that was an unproven claim and is removed.) |
| Bounded `SIGN_OUT_FAILED` status | New result field `signOut: "SIGNED_OUT" | "SIGN_OUT_FAILED" | "NOT_REQUIRED"`; details are `HTTP_nnn`, `HTTP_429`, `NETWORK`, `TIMEOUT` or `EXCEPTION`. |
| Cleanup cannot expose credentials or tokens | Error objects are never read or stringified; only fixed codes are stored. Tests throw errors containing a password and e-mail, and check results, metrics and monitor records for them and for the tokens. |

**Related hardening found by the new tests.** Timers are now armed *before* a request or the body starts (outside
Promise executors). Before, a failing timer let the body run with no deadline and could send a sign-in request with no
timeout whose reply was then ignored. Monitor records that throw or return a rejected promise are counted
(`monitorFailures`) and never affect the tick (no unhandled rejections).

## 2. Adversarial tests

`src/test/phase4h3-token-cleanup.test.ts` — 21 tests, all fake transports:

| Required case | Covered by |
|---|---|
| Unexpected exception after successful sign-in | clock fails right after sign-in; timers fail right after sign-in |
| Unexpected exception during token validation | throwing reply field; clock failing at the validation read |
| Unexpected exception during refresh | refresh reply with a throwing field; refresh transport throwing synchronously |
| Unexpected exception during the worker body | sync throw, rejection, `undefined`, `null`, a hostile thrown object |
| Unexpected exception during monitoring | throws on every record; throws on sign-in/sign-out only; rejects asynchronously |
| Sign-out failure after an unexpected exception | 500, 401, 429, network, timeout, and with every timer broken |
| Sign-out exactly once whenever a usable token was received | asserted in every case above |
| No sign-out without a usable session | 400, 429, 500, network, timeout, empty reply, non-JWT, no token, null body, throwing status, clock failing before sign-in, timers failing from the start, five configuration errors |

Also: first failure kept when a body fails after a refresh failure and sign-out also fails; a captured call after the
tick is refused; a refresh in flight at the deadline cut-off is discarded (manual timers, exact ordering); identity
checks (section 3); the binding's new configuration requirement.

**Mutation tests**: 17 of 19 caught, 2 equivalent (independent guard), both combined variants caught —
`docs/phase-4h3/mutation-report.md`.

## 3. Token verification review

| Question | Finding (4H.2) | Change (4H.3) |
|---|---|---|
| Is the reply's user object mandatory? | **No.** A missing user, or a user without a string `id`, was silently accepted. | **Mandatory.** Missing, null, array, id-less, non-UUID → `AUTH_MALFORMED_REPLY` / `USER`; id ≠ token subject → `SUBJECT`. Same for refresh replies. |
| Is the identity matched to the intended worker? | **Only if the caller supplied it** — and the binding did not, so any account with the configured credentials was accepted. | `expectedUserId` is **required** (UUID) or the tick ends `CONFIG_INVALID` before sign-in. The binding requires `FUTURES_PAPER_WORKER_USER_ID` (not a secret) or refuses with `IDENTITY_NOT_CONFIGURED` before any request. Subject, user id and expected id must all match. |
| Anonymous sessions? | Not checked (an anonymous session also has role "authenticated"). | Refused (`TOKEN_NOT_WORKER_ROLE` / `anonymous`) from the claim or the user object. |
| Are decoded claims treated as signature verification? | No — documented. | Still no. A test shows a token with a garbage signature passes the **local** check, documenting that only the data API verifies signatures. The local checks exist only to refuse obviously wrong sessions early and to time calls. |
| Does the database independently validate role and ownership? | Yes, in drafts. | Unchanged: draft 0054's per-call check refuses a disabled or un-enrolled worker, an admin or super-admin role, a worker that owns an account, and a different owner — on every one of the six worker calls (PGlite: `phase4h2-security-regression.test.ts`; real PostgreSQL: `futures-paper-0054.pg.test.ts`). **Proven locally only; not applied to the hosted database.** |

## 4. Preserved

0049–0054 unchanged; nothing applied or rolled back; T1–T11 and S1–S8 unchanged and not approved; no project or
credential created. The Phase 4G hosted connection files are byte-identical (pinned).

**Behaviour changes versus 4H.2** (intended, documented): only 2xx logout counts as signed out; expected identity and
the reply user object are mandatory; anonymous sessions refused; the tick outcome is the first failure (e.g. a refresh
failure followed by a deadline cut-off now reports `TOKEN_REFRESH_FAILED`, with both codes in the metrics);
`SessionResult` gains `signOut`, `internalError` and `monitorFailures`.

## 5. Results

Local tests only — see `docs/phase-4h3/execution-report.md`. New tests 21/21; Phase 4H.2 tests 37/37; local real
PostgreSQL 4/4 + 43/43; full suite 1,335 passed, 0 failed, 66 skipped; typecheck clean; production build succeeded;
mutations 17/19 caught (2 equivalent). **Hosted verification: none performed.** SHA-256 manifest:
`docs/phase-4h3/sha256-manifest.txt`.

## Final readiness verdict

**READY FOR INDEPENDENT REVIEW** of the cleanup fix, identity checks and tests.
**NOT READY for migration application or Futures Paper Worker activation.**

## Remaining production blockers

1. **Fresh export** after 14 Nov 2026 09:19 UTC, then local restore and chain/rollback verification — BLOCKED (time;
   the clock reads 13 Nov 2026).
2. **Runtime isolation (layer C)** — this project's server runtime holds the privileged key; the separate-project path
   needs an owner decision, then real verification (secrets, key absence, job authentication, exact job timeout,
   retries, cost).
3. **Tick timing vs. the job timeout** — S1–S8 and the call timeout must fit the measured job timeout; all NOT APPROVED.
4. **Hosted auth settings UNVERIFIED** — access-token lifetime, session time-box/inactivity, auth rate limits, and the
   exact logout replies. Residual risks: a signed-out access token stays usable until it expires; a failed sign-out
   (now reported honestly) or a sign-in reply lost to a timeout leaves a server session until it expires.
5. **Hosted application and verification of 0049–0054** — needs separate approval.
6. **Worker identity** — creating the account, setting its id, enrolling it, and the activation flags all need separate
   approval.
7. **Residual risks F4, F13, F15** — accept or mitigate (unchanged).
8. **Policy values** T1–T11, S1–S8, lease/RPC timing, participation limits, liquidation buffer, risk budgets and costs
   — NOT APPROVED.
