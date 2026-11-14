# Phase 4H.3 — Final Token Cleanup Hardening — final report and audit

Implementation: commit `7695eab` (13 Nov 2026). Audit and evidence package: 14 Nov 2026. Phase 4I has **not** been
started.

**Verdict: READY FOR INDEPENDENT REVIEW** (cleanup fix, identity checks, tests and evidence).
**NOT READY for migration application, worker-account setup or Futures Paper Worker activation.**

Companion reports (same folder): `phase4h3-execution-report.md` (commands, results, skipped tests),
`phase4h3-mutation-report.md` (19 mutations, 17 detected), `phase4h3-sha256-manifest.txt` (hashes). Raw run output:
`evidence/`.

---

## 1. Exact scope

Phase 4H.3 was limited to (brief: `Phase 4H.3 — Final Token Cleanup Hardening & Production Readiness Review`):

1. Make sign-out unconditional in `src/lib/worker-auth-session.ts`: one outer cleanup structure over the whole
   lifecycle; sign-out exactly once when a usable token was received; original failure preserved; tokens forgotten;
   no retry; no false termination claim; bounded `SIGN_OUT_FAILED`; no credential or token exposure.
2. Adversarial tests for every exception point, plus mutation tests showing a cleanup bypass is detected.
3. Token-verification review: mandatory reply user, matched to the JWT subject and to the intended enrolled worker;
   decoded claims are not signature verification; database authorization independently re-checks role and ownership.
4. Preserve: no change to drafts 0049–0054; no migration applied or rolled back; T1–T11 and S1–S8 unchanged and not
   approved; no project or credential created.
5. Run and report all local checks, clearly separated from hosted verification.

Out of scope and **not done**: hosted database access or writes, migrations, worker activation, routes, schedules,
worker account, Testnet or live orders, Autopilot, AI calls, paid infrastructure, Phase 4I.

## 2. Implementation changes

| Area | Phase 4H.2 behaviour | Phase 4H.3 behaviour |
|---|---|---|
| Cleanup structure | Sign-out ran **after** `try { … } finally { … }`; an unexpected exception skipped it and rejected the call | One outer `try / catch / finally` (lines 356–366) covers clock reads, timers, sign-in, validation, refresh, body, guarded calls and transports; the function never rejects |
| When sign-out happens | Only after the normal path | Whenever a JWT-shaped access token was received — remembered **before** validation (line 253), so refused or faulting validation is still signed out |
| Sign-out attempts | One | Exactly one (single call site, line 365); no retry |
| Logout reply 401/403/404 | Counted as signed out (`ALREADY_INVALID`) | `SIGN_OUT_FAILED` with `HTTP_401/403/404`; only 2xx is `SIGNED_OUT` (line 344) |
| Tick outcome | Last relevant code | **First** failure recorded in the tick (lines 187–188, 197); sign-out codes are not failures |
| Unexpected errors | Rejected promise | `TICK_INTERNAL_ERROR` with bounded stage `SIGN_IN` / `VERIFY` / `REFRESH` / `CALL` / `BODY` |
| After the result | Late records possible | `sealed` (line 186): nothing recorded after return; `closed`, aborted signal and cleared tokens refuse every later call |
| Monitor faults | Could throw into the tick | Sync throws and async rejections are counted in `monitorFailures` and ignored (lines 189–192) |
| Timers | Body deadline armed inside a Promise executor | Sign-in/refresh timer (line 219) and body deadline (line 316) armed **before** the request/body starts; sign-out falls back to the platform timer if the injected timer fails (line 335) |
| Reply user object | Optional | Mandatory, UUID, equal to the token subject (lines 141–142) |
| Expected worker id | Optional; the binding passed none | Mandatory in options (line 205) and in the binding (`FUTURES_PAPER_WORKER_USER_ID`, UUID) |
| Anonymous sessions | Not checked | Refused from the claim or the user object (line 144) |
| Result shape | — | New fields `signOut`, `internalError`, `monitorFailures` |

S1–S8 defaults (`SESSION_DEFAULTS`, lines 61–64) are byte-identical to Phase 4H.2.

## 3. Files

**Modified in Phase 4H.3 (commit `7695eab`, relative to Phase 4H.2 commit `2463190`):**

| File | Change |
|---|---|
| `src/lib/worker-auth-session.ts` | Cleanup, identity, timer and precedence changes in §2 |
| `src/lib/futures-paper-worker-identity.server.ts` | Requires and UUID-checks `FUTURES_PAPER_WORKER_USER_ID`; passes it as `expectedUserId` |
| `src/lib/AGENTS.md` | One existing rule (the signed-in binding) reworded to mention the mandatory identity and 2xx-only sign-out |
| `src/test/worker-auth-session.test.ts` | Expected identity in fixtures; 401/403/404 now `SIGN_OUT_FAILED` (stricter) |
| `src/test/phase4h2-security-regression.test.ts` | Fake backend sets the expected worker id |

**Created in Phase 4H.3:** `src/test/phase4h3-token-cleanup.test.ts` (21 tests), `scripts/worker-auth/mutation-check-4h3.ts`.

**Created or changed in this evidence package (14 Nov):**
- Renamed and rewritten: `execution-report.md` → `phase4h3-execution-report.md`, `mutation-report.md` →
  `phase4h3-mutation-report.md`, `sha256-manifest.txt` → `phase4h3-sha256-manifest.txt`; this report rewritten.
- New: `scripts/worker-auth/mutation-redundancy-4h3.ts` (diagnostic only; edits the source temporarily and restores it
  byte-identical), `docs/phase-4h3/evidence/*` (raw logs and summaries), `phase4h3-sha256-manifest.txt.sha256`.
- **No source or test file was changed by this package.**

**Unchanged (verified by `git diff --name-only 2463190`, working tree included):** every other file, including
drafts 0049–0054 and their rollbacks, `src/lib/futures-paper-worker-hosted.ts`, `src/lib/futures-paper-worker-hosted.server.ts`,
`src/lib/futures-paper-worker-identity.ts`, `src/test/helpers/fake-auth.ts`, `src/test/phase4h2-isolation.test.ts`,
`docs/phase-4h/timing-and-rounding-register.md`, `.env`, `supabase/config.toml`, all `src/integrations/supabase/*`
generated files, `src/start.ts`, `src/routes/**` and `src/routeTree.gen.ts`.

## 4. Sign-out cleanup: implementation and control flow

```text
runWithWorkerSession(options, body)
 ├─ configuration check (limits, expected worker id) ── invalid ──► CONFIG_INVALID, signOut NOT_REQUIRED, no request
 ├─ try
 │   └─ signInAndRun()
 │       ├─ arm sign-in timer, then send ONE sign-in request (stage SIGN_IN)
 │       │    └─ non-2xx / 429 / timeout / network ──► failure code, no token → no sign-out needed
 │       ├─ remember JWT-shaped access token  ◄── from here a server session may exist (stage VERIFY)
 │       ├─ verify reply (user, subject, expected id, role, anonymous, clock, lifetime) ── refused ──► failure code
 │       ├─ arm body deadline, then run body (stage BODY) with guarded call()
 │       │    ├─ call(): allowlist → closed/aborted? → deadline? → at most one refresh (stage REFRESH) → transport
 │       │    └─ deadline fires ──► closed, tick signal aborted, TICK_DEADLINE_EXCEEDED
 │       └─ body result / TICK_BODY_FAILED
 ├─ catch (any unexpected exception) ──► TICK_INTERNAL_ERROR + stage
 └─ finally (always)
     ├─ closed = true; abort tick signal
     ├─ access = remembered token; token = null; issued = null
     └─ if access ≠ null: signOutOnce(access)   ◄── exactly once, never throws, never retries
          └─ 2xx ► SIGNED_OUT ; anything else ► SIGN_OUT_FAILED (HTTP_nnn / HTTP_429 / NETWORK / TIMEOUT / EXCEPTION)
finish(): outcome = FIRST failure (or TICK_COMPLETED); sealed = true (no later records)
```

`signOutOnce` (lines 329–352) catches every fault of its own, including a throwing transport, a throwing injected
timer (falls back to the platform timer) and a throwing clock (latency omitted). Its record is made before `sealed`.

## 5. Token lifecycle and late-refresh handling

- One sign-in per tick; never retried. The call deadline is the earlier of the body end (tick budget minus the
  sign-out reserve) and the token expiry minus the safety margin.
- A call starts only if it can finish (call timeout) before the deadline; otherwise it is refused locally with a
  reply the hosted classifier treats as "nothing written".
- At most one refresh per tick, only when the token (not the budget) would block the next call, and only if a refresh
  plus a call still fit. A failed or invalid refresh closes the session; nothing is retried.
- A refresh reply is verified with the same mandatory user/subject/expected-id rules.
- **Late refresh:** if cleanup starts while a refresh is in flight, the refresh result is discarded when it arrives
  (`if (closed) return false`, line 267), the waiting call is refused (line 293), and nothing is recorded (line 186).
  Test: "a refresh still in flight when the body is cut off…" (manual timers, exact ordering).
- Tokens are held only in the function's closure and are cleared at cleanup; they are never returned, logged,
  recorded or put in error text (tests search results and monitor records for tokens and credentials).

## 6. Worker identity validation

A session is accepted only if **all** hold (lines 135–152): the reply has a plain `user` object with a UUID `id`; the
token has `sub`, `role`, numeric `exp`; `user.id` equals `sub` (case-insensitive UUID compare); role is
`authenticated`; neither claim nor user marks the session anonymous; `sub` equals the mandatory expected worker id;
issue time is not in the future beyond the skew; lifetime is above the minimum.

The binding refuses with `IDENTITY_NOT_CONFIGURED` **before any request** if `FUTURES_PAPER_WORKER_USER_ID` is missing
or not a UUID, and with `IDENTITY_DISABLED` unless both activation flags are set (neither is set anywhere).

**Not signature verification.** Claims are decoded locally only to refuse obviously wrong sessions and to time calls;
a test shows a token with a garbage signature passes the local check. Signature verification is the data API's job,
and the draft 0054 per-call check (`fpw_id_check`) independently re-checks, on every one of the six worker calls,
that the identity is active, is not admin or super-admin, owns no account, and is enrolled by the account owner.
That database check is **proven locally only** (PGlite and throwaway real PostgreSQL); 0054 is not applied.

## 7. Timer failure and timeout handling

| Situation | Behaviour | Test |
|---|---|---|
| Injected timers fail from the start | Sign-in timer cannot be armed → exception before any request → `TICK_INTERNAL_ERROR` / `SIGN_IN`, no request sent, no sign-out needed | "timers that fail from the start…" |
| Timers fail after sign-in | Body deadline cannot be armed → body never runs → `TICK_INTERNAL_ERROR` / `BODY`; sign-out uses the platform-timer fallback, once | "exception after successful sign-in (timers fail)…" |
| Clock fails after sign-in | Exception before the body → body never runs; signed out once | "exception after successful sign-in (clock fails…)" |
| Sign-in / refresh / sign-out hang | Each has its own deadline (`authTimeoutMs`, `signOutTimeoutMs`) → `AUTH_TIMEOUT`, `TOKEN_REFRESH_FAILED`/`TIMEOUT`, `SIGN_OUT_FAILED`/`TIMEOUT` | lifecycle + 4H.2 tests |
| Body exceeds its deadline | Cut off: session closed, tick signal aborted, `TICK_DEADLINE_EXCEEDED`, sign-out within the reserved budget | 4H.2 "a body that outlives the deadline…" |

## 8. Error handling and failure precedence

- The outcome is the **first** code in `FAILURE_CODES` recorded during the tick, else `TICK_COMPLETED`.
- `SIGNED_OUT` / `SIGN_OUT_FAILED` are not failure codes, so cleanup can never replace the outcome; the sign-out result
  is reported separately (`signOut`, `signedOut`, last metric).
- `internalError` keeps the stage of the **first** unexpected exception (`??=`).
- Error objects are never read or stringified; every metric is a fixed code plus a bounded detail.
- A data-transport exception after the request may have been sent reaches the body unchanged (the hosted classifier
  treats it as an unknown outcome and never blindly resends a commit).

## 9. Independent security review checklist

| # | Question | Answer | Implementation evidence | Test evidence | Remaining limitations |
|---|---|---|---|---|---|
| 1 | Can an unexpected exception after sign-in still trigger sign-out? | **Yes, always** | Outer `try/catch/finally` (356–366); token remembered before validation (253) | Section 1 of `phase4h3-token-cleanup.test.ts` (clock, timers, validation, refresh, body, monitor, transports); mutations M1, M2, M3 detected | A fault inside the platform's own `fetch` / runtime termination of the whole process cannot be covered by application code |
| 2 | Can sign-out execute more than once? | **No** (per tick) | Single call site (365); `signOutOnce` has no loop or retry | Every lifecycle case asserts exactly one sign-out request; M7 detected | One sign-out per tick, by design; there is no second attempt even when the first fails (see L4) |
| 3 | Can sign-out failure overwrite the original tick failure? | **No** | Sign-out codes excluded from `FAILURE_CODES`; outcome = first failure (197) | "sign-out failure after an unexpected exception…", "the first failure stays the outcome…"; M6 detected | — |
| 4 | Are 401/403/404 logout replies treated as confirmed sign-out? | **No** | Only 2xx → `SIGNED_OUT` (344) | 2xx-only test (401, 403, 404, 429, 500, network); M5 detected | Real hosted logout replies were not observed (UNVERIFIED) |
| 5 | Can a late token refresh restore a forgotten token? | **No usable restoration** | `if (closed) return false` after the refresh await (267); post-refresh `closed` check (293); `sealed` (186) | Late-refresh test (manual timers); M16b and M17 detected; M16 alone survives because 293 still blocks (equivalent) | The late refreshed token is discarded but never signed out; hosted session semantics UNVERIFIED (L3) |
| 6 | Can any operation continue after token cleanup? | **No data call can start**; body code may keep running locally | `closed`, aborted tick signal, cleared token, three-way check (288) | "a call captured by the body and used after the tick is refused…"; M8b detected; M8 equivalent | JavaScript cannot kill a running body; a data request already sent before cleanup can still complete on the server (L6) |
| 7 | Can an anonymous session be accepted? | **No** | Claim `is_anonymous` or `user.is_anonymous` → `TOKEN_NOT_WORKER_ROLE` (144) | "anonymous sessions and any identity other than the expected worker are refused"; M13 detected | Relies on the hosted service setting the anonymous marker (UNVERIFIED) |
| 8 | Can a different user impersonate the intended worker? | **Not through this module**: any other identity is refused and signed out | `sub` = `user.id` = expected id (141–145); draft 0054 per-call DB check | Wrong-identity tests (pure + binding via fake fetch); PGlite regression; real-PG 0054 4/4; M10, M11 detected | A forged token with the right `sub` passes the **local** check; only the data API signature check stops it (hosted, UNVERIFIED). Anyone holding the worker's real credentials *is* the worker (credential custody, L10/L12) |
| 9 | Is the expected worker ID mandatory? | **Yes** | Options check (205) → `CONFIG_INVALID`; binding UUID check | Configuration-errors test (missing, empty, non-UUID); M12 detected | — |
| 10 | What if `FUTURES_PAPER_WORKER_USER_ID` is missing? | Binding throws `IDENTITY_NOT_CONFIGURED` **before any request** (no sign-in) | `futures-paper-worker-identity.server.ts` env check | "refuses before any request when the expected worker id is missing or not a UUID" (fetch never called); "configured nowhere … unset" | The variable is unset everywhere today; whoever sets it later must set the enrolled worker's id (owner task) |
| 11 | What if timer initialization fails? | Before sign-in: no request sent. After sign-in: body never runs, sign-out on platform-timer fallback | Timers armed before requests/body (219, 316); fallback (335) | "timers that fail from the start…", "exception after successful sign-in (timers fail)…"; M14, M15 detected | The Phase 4G hosted per-call timer (pinned file) is still armed inside a Promise executor (L7) |
| 12 | Can the worker execute without a bounded time limit? | **No, at the session level**: sign-in, refresh, body and sign-out each have a deadline armed before they start, and the body end leaves a sign-out reserve inside the tick budget | Lines 219, 235, 316, 330–335; `validateLimits` (154–163) | Timer/clock/hang tests; 4H.2 deadline cut-off test; M15 detected | Per-call limit inside the hosted adapter depends on L7; tick budget vs the real scheduler/job timeout is unmeasured (blocker B3) |

## 10. Strict change-control verification

"VERIFIED" means proven from the repository, this sandbox or the agent's own tool record. Anything that would need
hosted access to prove is labelled **NOT VERIFIED** — hosted systems were deliberately not contacted.

| Claim | Evidence | Status |
|---|---|---|
| No migrations applied | Drafts 0049–0054 and rollbacks byte-identical (hashes in the manifest equal the pins checked by `phase4h2-isolation.test.ts`, which passed); no migration tool or SQL against the hosted database was used in Phase 4H.3 or this package | VERIFIED for the repository and the agent's actions. Hosted migration history **NOT VERIFIED** (reading it would contact the hosted database) |
| No production database contacted | Agent tool record: no backend/database tool was invoked; PostgreSQL tests used a throwaway 127.0.0.1 cluster after unsetting all connection variables; PGlite runs in-process | Agent record: none. Network-level proof **NOT VERIFIED** (the sandbox has network egress and no packet capture was taken) |
| No sign-in service contacted | All auth tests use fake transports; binding tests use a fake `fetch` and the fake URL `https://backend.test`; the binding refuses without both activation flags | Agent record and code review: none. Network-level proof **NOT VERIFIED** |
| No AI provider calls | No AI tool or provider code path was used; the AI provider is disabled by the owner; tests in scope use no AI module | Agent record: none. Network-level proof and provider-side logs **NOT VERIFIED** |
| No worker enabled or scheduled | `FUTURES_PAPER_WORKER_HOSTED`, `_IDENTITY`, `_USER_ID`, `_EMAIL`, `_PASSWORD` unset in this sandbox (checked); absent from `.env`, `supabase/config.toml` (test); only tests import the identity binding; no route or schedule file changed; no schedule tool used | VERIFIED for the repository and sandbox. Hosted secrets and hosted schedules **NOT VERIFIED** |
| No real or Testnet orders | No exchange code path was run; worker tests use fakes and local databases; no trading tool used | Agent record: none. Exchange-side order history **NOT VERIFIED** |
| No T1–T11 or S1–S8 values changed | `timing-and-rounding-register.md` unchanged since `2463190`; `SESSION_DEFAULTS` byte-identical; no file defining T values changed | **VERIFIED** (repository) |
| No production credentials or settings changed | No secrets or settings tool used; `.env`, `supabase/config.toml`, generated backend files unchanged since `2463190` | VERIFIED for the repository. Hosted secret values and settings **NOT VERIFIED** |
| No unrelated protected files overwritten | `git diff --name-only 2463190` lists only the 11 Phase 4H.3 files; this package adds only docs, evidence and one diagnostic script; mutation scripts restored the source byte-identical (SHA-256 checked after each run) | **VERIFIED** (repository) |

## 11. Remaining security limitations

| # | Limitation | Effect | Who decides / next step |
|---|---|---|---|
| L1 | Local claim decoding is not signature verification | A forged token is stopped only by the data API (hosted) and the DB check | Verify hosted signature enforcement when 0054 is applied |
| L2 | A signed-out access token stays valid until it expires | Window = hosted access-token lifetime (UNVERIFIED) | Owner: check/approve token lifetime |
| L3 | A refresh that finishes after cleanup is discarded but not signed out | Relies on local-scope logout ending the same session on the hosted service (UNVERIFIED); its access token lives until expiry | Verify hosted logout semantics |
| L4 | A failed sign-out is not retried (by requirement) | Server session remains until hosted expiry/time-box (UNVERIFIED); reported honestly as `SIGN_OUT_FAILED` | Owner: accept or require session time-box |
| L5 | A sign-in reply lost to a timeout may leave a session the worker never learns about | Cannot be signed out by the worker | Same as L4 |
| L6 | Body cut-off cannot stop running JavaScript; a request already sent may finish on the server | No new data call can start; in-flight results are classified as unknown and never blindly resent | Accept as residual |
| L7 | Phase 4G `futures-paper-worker-hosted.ts` arms its per-call timer inside a Promise executor (line 94; file pinned and unchanged) | Only if the platform timer itself failed would an already-started call lose its per-call limit; the session body deadline still bounds the tick | Owner decision: approve a small follow-up fix in a later phase |
| L8 | "Forgotten" tokens are dropped references; JavaScript cannot zero memory | Unreachable strings remain until garbage collection; M8 survives for this reason (equivalent) | Accept as residual |
| L9 | Database authorization (draft 0054) proven only locally | Not in force on the hosted database | Approve and apply 0049–0054, then verify hosted |
| L10 | Runtime isolation: this project's server runtime holds the privileged key | Co-located code could bypass the worker identity | Owner: separate-project decision, then verification |
| L11 | Monitoring failures are swallowed (counted only) | Loss of observability is silent except `monitorFailures` | Accept or add alerting later |
| L12 | Expected worker id is configuration, not a secret | Whoever can change hosting configuration can also change the worker credentials | Hosting access control (owner) |

## 12. Requirement status

| Requirement (Phase 4H.3 brief) | Status | Evidence |
|---|---|---|
| 1.1 Outer cleanup structure over the whole lifecycle | **PASS** | §4; M1, M2 detected |
| 1.2 Sign-out exactly once when a usable token was received | **PASS** | §4; M3, M7 detected |
| 1.3 Sign-out even after an unexpected exception | **PASS** | Section 1 tests; M1, M14 detected |
| 1.4 Original failure preserved | **PASS** | §8; M6 detected |
| 1.5 Tokens forgotten after cleanup | **PASS** (behaviour by test; clearing itself by code review — M8 equivalent) | §5; M8b detected; L8 |
| 1.6 Never retry sign-out | **PASS** | M7 detected |
| 1.7 No termination claim when sign-out fails | **PASS** | M5 detected |
| 1.8 Bounded `SIGN_OUT_FAILED` status | **PASS** | Bounded detail set; tests |
| 1.9 Cleanup cannot expose credentials or tokens | **PASS** (local) | `expectNoSecrets` in every case |
| 2.1–2.8 Adversarial tests (all eight cases) | **PASS** | 21/21; mapping in `phase4h3-token-cleanup.test.ts` sections 1–3 |
| 2.9 Mutation tests show cleanup bypass is detected | **PASS** — 17/19 detected; 2 equivalent survivors explained | `phase4h3-mutation-report.md` |
| 3.1 Reply user object mandatory and matched to the subject | **PASS** | M10 detected |
| 3.2 Signed-in identity is the intended enrolled worker | **PASS** locally (expected id mandatory) / hosted enrollment **BLOCKED** (no worker account, 0054 not applied) | M11, M12 detected |
| 3.3 Database independently validates role and ownership | **PASS locally only**; hosted **BLOCKED** (0054 unapplied) | PGlite 11/11, real PG 0054 4/4 |
| 3.4 Decoded claims not treated as signature verification | **PASS** | Garbage-signature test; L1 |
| 4.1 Migrations 0049–0054 unmodified | **PASS** | Manifest hashes = isolation pins |
| 4.2 No migration applied or rolled back | **PASS** (agent record) / hosted state **NOT VERIFIED** | §10 |
| 4.3 T1–T11, S1–S8 unchanged; nothing approved | **PASS** | §10 |
| 4.4 No project or credentials created | **PASS** (agent record) | §10 |
| 5.1 New lifecycle tests | **PASS** 21/21 | Execution report row 1 |
| 5.2 Existing Phase 4H.2 tests | **PASS** 37/37 | Row 2 |
| 5.3 Local PostgreSQL tests | **PASS** 4/4 + 43/43 | Row 3 |
| 5.4 Full suite | **PASS** 1,335 passed, 0 failed, 66 skipped (all skips explained) | Row 4 |
| 5.5 Typecheck and production build | **PASS** | Rows 5–6 |
| 5.6 Mutation tests | **PASS** (17/19; not 19/19) | Row 7 |
| 5.7 Results separated from hosted verification | **PASS** | All reports; hosted verification: none |
| Production readiness (fresh export, runtime isolation, hosted auth settings, hosted migrations, worker identity) | **BLOCKED** | §13 |

No requirement is FAIL.

## 13. Unresolved blockers and owner decisions

**Blockers before any activation:**
- **B1 Fresh database export** taken after 14 Nov 2026 09:19 UTC, then local restore and chain/rollback verification.
  BLOCKED by time: at the time of this audit (14 Nov 2026 ~03:05 UTC) that moment has not yet been reached.
- **B2 Runtime isolation** (privileged key present in this project's server runtime) — needs the owner's decision on a
  separate project, then real verification (secrets, key absence, job authentication, exact job timeout, retries, cost).
- **B3 Tick timing vs the real job timeout** — S1–S8 and the call timeout must be fitted to a measured timeout.
- **B4 Hosted sign-in settings UNVERIFIED** — access-token lifetime, session time-box/inactivity, rate limits, exact
  logout replies, anonymous marker and refresh/logout semantics (limitations L2–L5; checklist items 4, 5, 7).
- **B5 Hosted application and verification of drafts 0049–0054** — separate approval required.
- **B6 Worker identity** — creating the account, setting `FUTURES_PAPER_WORKER_USER_ID`, owner enrollment, and both
  activation flags — separate approval each.

**Security risks requiring owner decisions:**
- Accept or mitigate residual risks **F4, F13, F15** (unchanged from earlier phases).
- Accept L2–L5 (session/token lifetime after a failed or late sign-out) or require a shorter hosted token lifetime /
  session time-box.
- Decide whether to approve a follow-up fix for **L7** (hosted per-call timer pattern) in a later phase.
- Runtime isolation decision (**B2 / L10**).
- Approve or change all policy values: T1–T11, S1–S8, lease/RPC timing, participation limits, liquidation buffer,
  risk budgets and costs — all **NOT APPROVED**.

## 14. Recommendation

**READY FOR INDEPENDENT REVIEW.** Not ready for migration application, worker-account configuration, scheduling or
activation. Phase 4I not started.
