# Phase 4H.3 — mutation report (13 Nov 2026)

**What this is.** Each mutation deliberately breaks one protection in `src/lib/worker-auth-session.ts`, runs the
lifecycle tests (`src/test/phase4h3-token-cleanup.test.ts` + `src/test/worker-auth-session.test.ts`), then restores
the original bytes. Script: `scripts/worker-auth/mutation-check-4h3.ts` (local only; no network, database or auth
service). After the run the file was verified **byte-identical** (SHA-256 `8605ced84a9c42aae34e3d1a474eb45e53941da33c64b2b0aabed431618774b8`).

**Result: 17 of 19 caught. The 2 survivors are equivalent mutations** — a second, independent guard blocks the same
behaviour, so nothing observable changes. For each survivor a combined mutation that also removes the second guard
was added and **was caught** (M8b, M16b).

| # | Protection removed | Result | Tests that failed (abridged) |
|---|---|---|---|
| M1 | Sign-out skipped after an unexpected exception (**the 4H.2 cleanup gap**) | CAUGHT | exception after sign-in (clock / timers), during validation, during refresh, sign-out failure after exception |
| M2 | Unexpected exceptions escape the outer structure | CAUGHT | same group + "no sign-out when sign-in never produced a session" |
| M3 | Token only remembered after validation passed (refused/faulting validation not signed out) | CAUGHT | validation exception, refused identity, binding wrong-identity, 4H.2 refused-token tests |
| M4 | Refresh exception handler removed | CAUGHT | exception during refresh |
| M5 | 401/403/404 logout replies counted as signed out | CAUGHT | sign-out failure after exception; only-2xx sign-out test |
| M6 | A failed sign-out replaces the original outcome | CAUGHT | transport exception; first-failure; only-2xx sign-out |
| M7 | A failed sign-out is retried once | CAUGHT | same group (exactly-one-attempt assertions) |
| M8 | Cleanup does not set "closed" or forget the token (abort kept) | **SURVIVED — equivalent** | — the aborted tick signal still refuses every later call; tokens are unreachable from outside |
| M8b | Cleanup does not close, abort **or** forget | CAUGHT | captured call used after the tick |
| M9 | Monitor exceptions escape | CAUGHT | monitoring exceptions |
| M10 | Reply user object optional again (4H.2) | CAUGHT | malformed/missing user; refresh without user |
| M11 | Expected identity optional in verification (4H.2) | CAUGHT | other identity / empty expected id |
| M12 | Missing expected identity accepted in configuration | CAUGHT | configuration errors never sign in |
| M13 | Anonymous sessions accepted | CAUGHT | anonymous sessions refused |
| M14 | No fallback timer for sign-out when injected timers fail | CAUGHT | timers fail after sign-in; sign-out failure after exception |
| M15 | Body deadline armed inside a Promise executor (body can run with no deadline) | CAUGHT | clock fails before the body |
| M16 | A refresh finishing after cleanup is stored | **SURVIVED — equivalent** | — the guarded call re-checks "closed" after the refresh, so no call starts; the stored token is unreachable |
| M16b | Late refresh stored **and** the post-refresh closed check removed | CAUGHT | refresh in flight at cut-off |
| M17 | Records still made after the result was returned | CAUGHT | refresh in flight at cut-off |

**Bypassing cleanup is detected**: M1, M2, M3, M8b and M14 each bypass or weaken the cleanup path in a different way,
and each fails at least one test.

During development the new tests also found a real defect (fixed before this run): the body's deadline timer was armed
inside a Promise executor, so a failing timer let the body start with no deadline. Timers are now armed before any
request or body starts (M15 re-introduces the defect and is caught).
