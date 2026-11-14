# Phase 4H.3 — mutation testing report

Supersedes `docs/phase-4h3/mutation-report.md` of commit `7695eab` (renamed to this file; content rewritten).

## 1. Method

- **File under test:** `src/lib/worker-auth-session.ts` (all mutations edit only this file).
- **Runner:** `scripts/worker-auth/mutation-check-4h3.ts`. For each mutation it checks that the original text occurs
  exactly once, writes the mutated file, runs
  `bunx vitest run src/test/phase4h3-token-cleanup.test.ts src/test/worker-auth-session.test.ts --reporter=json`,
  records the failing test titles, and restores the original bytes (also on exit/interrupt). After the last mutation it
  verifies the file's SHA-256.
- **Detected** = the test run exited non-zero (at least one test failed). **Survived** = all tests passed.
- **Local only:** no network, database, sign-in service or AI provider.
- **Runs:** run A (13 Nov 2026, during implementation) and run B (14 Nov 2026 02:56 UTC, this package). Both gave
  the same result. Raw run-B output: `docs/phase-4h3/evidence/mutation-check-4h3.log`. After run B the file was
  byte-identical: `8605ced84a9c42aae34e3d1a474eb45e53941da33c64b2b0aabed431618774b8`.

## 2. Result

**17 of 19 mutations were detected. 2 were not detected (M8 and M16).** This report does not claim 19/19.

How the 19 are made up — so nothing is counted twice:
- 17 mutations (M1–M17) each remove **one** protection. **15 of these 17 were detected**; M8 and M16 survived.
- 2 mutations (M8b, M16b) are the "secondary safeguard also removed" variants of the two survivors. **Both were
  detected**, and they are already included in the 17/19.

## 3. All 19 mutations

Line numbers refer to the original file with the SHA-256 above. "Expected failure" is what a correct suite must
catch; "Actual result" quotes the failing test titles from run B (abridged where long).

| # | Mutation (what was broken) | Code path (line) | Expected failure | Actual result (run B) | Detected |
|---|---|---|---|---|---|
| M1 | Skip sign-out after an unexpected exception (re-creates the Phase 4H.2 cleanup gap): `if (access !== null && internalError === null) …` | `runWithWorkerSession` → `finally` cleanup, call to `signOutOnce` (365) | Tests that inject exceptions after a token exists must see no sign-out and fail | Failed: exception after sign-in (clock), exception after sign-in (timers), exception during validation, exception during refresh, sign-out failure after an exception | **Yes** |
| M2 | Let unexpected exceptions escape the outer structure: `catch (e) { throw e; }` | `runWithWorkerSession` → outer `catch` (357) | Function rejects instead of returning a bounded result | Failed: both "exception after sign-in" tests, validation exception, sign-out failure after exception, the "no usable session" table (hostile status / clock), timers failing from the start | **Yes** |
| M3 | Remember the token only after validation passed: `issued = null;` | `signInAndRun` → VERIFY stage (253) | A refused or faulting validation leaves the server session without a sign-out | Failed: validation exception, sign-out failure after exception, refused identity signed out once, binding wrong-identity, 4H.2 "refused token is still signed out", 4H.2 "different identity refused and signed out" | **Yes** |
| M4 | Remove the refresh exception handler: `throw new Error("refresh");` | `tryRefresh` → `catch` (279) | Exception during refresh is no longer contained/recorded | Failed: exception during refresh — session closes, no data call, original token signed out once | **Yes** |
| M5 | Count 401/403/404 logout replies as signed out | `signOutOnce` → status mapping (344) | Result would claim termination without proof | Failed: sign-out failure after exception; "only a 2xx logout counts as signed out" | **Yes** |
| M6 | Let a failed sign-out replace the tick outcome: `outcome: signOut === "SIGN_OUT_FAILED" ? "SIGN_OUT_FAILED" : …` | `finish` → `outcome` (197) | Original failure overwritten | Failed: transport exception test, sign-out failure after exception, first-failure test, 2xx-only test | **Yes** |
| M7 | Retry a failed sign-out once | `finally` cleanup (365) | Two sign-out requests | Failed: transport exception, sign-out failure after exception, first-failure, 2xx-only (all assert exactly one attempt) | **Yes** |
| M8 | Cleanup no longer sets `closed = true` and no longer clears `token` / `issued` (the tick-signal abort is **kept**) | `finally` cleanup (360, 363) | A call kept by the body after the tick, or a late operation, could use the remembered token | **All tests passed** | **No** — see §4 |
| M8b | Cleanup no longer closes, aborts **or** clears (all three layers removed) | `finally` cleanup (360–363) | Same as M8 | Failed: "a call captured by the body and used after the tick is refused locally and never reaches the data transport" | **Yes** |
| M9 | Let a monitor exception escape: `catch (e) { throw e; }` | `rec` → monitor `catch` (192) | Monitoring faults change or break the tick | Failed: monitoring exceptions never change the tick | **Yes** |
| M10 | Make the reply's user object optional again (4H.2 behaviour) | `verifyIssuedSession` (141–142) | Missing / malformed user accepted | Failed: missing/null/array/id-less/non-UUID/mismatching users refused; refused identity signed out once / refresh without user | **Yes** |
| M11 | Make the expected identity optional again: `if (o.expectedSub && c.sub !== o.expectedSub)` | `verifyIssuedSession` (145) | Empty expected id accepted | Failed: anonymous sessions and any other identity refused | **Yes** |
| M12 | Accept a missing expected identity in configuration: `if (!L) {` | `runWithWorkerSession` configuration check (205) | Sign-in proceeds without an expected id | Failed: configuration errors never sign in | **Yes** |
| M13 | Accept anonymous sessions: `if (false) return` | `verifyIssuedSession` (144) | Anonymous token accepted | Failed: anonymous sessions and any other identity refused | **Yes** |
| M14 | No fallback timer for sign-out when injected timers fail: `catch { throw new Error("timer"); }` | `signOutOnce` timer setup (335) | Sign-out skipped or unbounded when timers fail | Failed: exception after sign-in (timers fail); sign-out failure after exception | **Yes** |
| M15 | Arm the body deadline inside a Promise executor (re-introduces the defect found in 4H.3) | `signInAndRun` → body deadline (314–316) | Body runs with no deadline when the timer cannot be armed | Failed: exception after sign-in (clock fails before the body) — body must never run | **Yes** |
| M16 | Store a refresh that completes after cleanup started (remove `if (closed) return false;` after the refresh await) | `tryRefresh` (267) | A late refresh could restore a token after cleanup | **All tests passed** | **No** — see §4 |
| M16b | M16 **and** drop the `closed` check in the guarded call after a refresh (`if (!token)` instead of `if (closed \|\| !token)`) | `tryRefresh` (267) + `call` (293) | Same as M16 | Failed: exception during refresh; first-failure; "a refresh still in flight when the body is cut off stores nothing, starts no call and records nothing after the result"; 4H.2 refresh-failure test | **Yes** |
| M17 | Keep recording after the result was returned (remove the `sealed` check) | `rec` (186) | Late records after the result | Failed: refresh in flight at cut-off records nothing after the result | **Yes** |

Bypassing cleanup **is** detected: M1 (skip), M2 (escape), M3 (no token remembered), M7 (double), M8b (no closing at
all) and M14 (no bounded sign-out) each defeat or weaken cleanup in a different way, and each fails at least one test.

## 4. The two mutations that were not detected

### M8 — cleanup does not set `closed` and does not clear the token

**Why no test fails.** After `runWithWorkerSession` returns, the only code that can still reach the session closure is a
guarded `call` function the body kept. Line 288 refuses a call when **any** of three conditions holds:
`closed || !token || tickCtl.signal.aborted`. M8 removes the first two at cleanup, but the cleanup still aborts the tick
signal (line 361), so the third condition refuses the call. The token values stay in the closure, but no code path can
read them: they are never returned, never recorded (`sealed` blocks records) and never sent. From outside the
function the behaviour is identical, so M8 is an *equivalent mutation* with respect to observable behaviour.

**Honest caveat.** The requirement says tokens are *forgotten*. Under M8 they remain in memory until garbage
collection, unreachable. A test cannot observe a closure variable without changing the module's interface, so this
part of the requirement is shown by code review (line 363), not by a failing test.

**Evidence that the abort safeguard is what blocks M8.**
- M8b removes `closed`, the token clearing **and** the abort → detected by the captured-call test.
- Redundancy run R3 (below) keeps the abort but removes the aborted-signal check in `call` → detected by the same
  test. So the captured-call test fails exactly when both guard layers are gone.
- Runs R1 and R2 remove only the abort layer (either side) while keeping `closed` + clearing → not detected, as
  predicted: each layer alone is sufficient.

### M16 — a refresh finishing after cleanup is stored

**Why no test fails.** Under M16 a late refresh writes a new token into the closure after cleanup. The guarded call
that was waiting for the refresh then reaches line 293, `if (closed || !token) return refuse(…)`; `closed` is already
`true`, so the call is refused locally and never reaches the data transport. The refusal's record is dropped because
the result is sealed. The stored token is unreachable afterwards (same reasoning as M8). Observable behaviour is
identical, so M16 is equivalent.

**Note on the late refreshed token itself (applies to the original code too).** In both the original and M16, a
refresh that completes after cleanup is **never signed out locally** — the original discards it, M16 stores and then
ignores it. Sign-out was sent with the earlier access token. Whether a local-scope logout also ends the refreshed
session on the hosted sign-in service is **NOT VERIFIED** (hosted behaviour was not contacted). A refreshed access
token stays valid until it expires either way. See the final report, limitation L3.

**Evidence that the post-refresh check is what blocks M16.**
- M16b removes the refresh guard **and** the `closed` part of the post-refresh check → detected, including the
  dedicated late-refresh test ("a refresh still in flight when the body is cut off stores nothing…").
- That late-refresh test passes under M16 alone and under R4 alone (only the post-refresh check weakened) and fails
  only when both are removed (M16b / R5). So each guard alone blocks the late-refresh scenario.

## 5. Redundancy diagnostics (new in this package)

Script `scripts/worker-auth/mutation-redundancy-4h3.ts`, same procedure and same tests; run 14 Nov 2026. Raw output:
`docs/phase-4h3/evidence/mutation-redundancy-4h3.log`. Source restored byte-identical (same SHA-256).

| Run | What was removed | Predicted | Actual | Failing tests |
|---|---|---|---|---|
| R1 | M8 pair, abort layer only: cleanup no longer aborts the tick signal (closed + clearing kept) | survive | survived | — |
| R2 | M8 pair, abort layer only: `call` no longer checks the aborted signal (closed + clearing kept) | survive | survived | — |
| R3 | M8 **and** R2 (both layers gone) | detect | **detected** | captured call used after the tick |
| R4 | M16 pair, post-refresh check only (`if (!token)`; refresh guard kept) | survive | **detected — prediction wrong** | exception during refresh; first-failure; 4H.2 refresh-failure test |
| R5 | M16 **and** R4 (= M16b) | detect | **detected** | as M16b, including the late-refresh test |

**R4 — the prediction was wrong, and why.** The post-refresh `closed` check has a second job: after a **failed**
refresh, `tryRefresh` sets `closed = true` but leaves the earlier token in place, so `!token` is false and only the
`closed` part stops the call. Weakening it lets a call run after a failed refresh, which three tests catch. So this
check is not a pure backup for M16; it is also a primary guard for the failed-refresh path, and it is tested
independently. The late-refresh test itself still passed under R4 (each guard alone blocks the late refresh), which
is the property the diagnostic was meant to show.

## 6. Defect found by testing (not a mutation)

During implementation the new tests found that the body's deadline timer was armed inside a Promise executor, so a
failing timer let the body start with no deadline. It was fixed before run A; M15 re-introduces it and is detected.
