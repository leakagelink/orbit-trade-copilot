# Phase 4H.7 — Credential security report (Task 2: worker password/email change)

Draft `docs/proposed-migrations/0057_worker_credential_pin_and_refusal_tally.sql` (+ rollback) — **NOT APPLIED**.
No sign-in setting, user, credential or session was created or changed anywhere real.

## 1. Problem (Phase 4H.6 F15.7)

Anyone holding a worker access token could change the worker's password or email through the sign-in service. The
worker identity kept its database authority, so a stolen token became lasting control.

## 2. Fix — database (authoritative)

| Part | What it does |
|---|---|
| `fpw_credential_pin(user)` | SHA-256 of the worker's sign-in details, read-only from `auth.users` (email, password hash, pending email and phone changes, recovery/reauthentication requests, phone, ban, deletion, SSO/anonymous flags, role/audience, provider metadata) and `auth.identities` (provider, provider id, email). Column names read from the live catalog (read-only); the migration refuses if any is missing. |
| Registration (`fpw_admin_set_identity`) | Every enable (registration or re-registration) pins the current fingerprint and time, recorded as `PINNED`. Refuses an id that is not a sign-in user. |
| Every worker call (`fpw_id_check`) | Refuses when: no pin (registered before 0057 — re-register); fingerprint differs; or the session was created before the pin. |
| Sticky invalidation (`fpw_record_refusal`) | On the first credential-change refusal, re-verified inside the recorder: identity disabled, every enrollment revoked (audited `ID:REVOKED_CREDENTIALS_CHANGED`), leases ended, `CHANGE_DETECTED` recorded. Changing the details back restores nothing. These writes commit because the envelope's transaction commits. |
| Recovery | Owner resets the password, an admin re-registers (re-pin), each account owner re-enrolls. Sessions from before re-registration stay refused. |
| Ordinary users | Untouched: no auth setting, no write to `auth.*`, no change to their access. |

Ordinary sign-in bookkeeping (`last_sign_in_at`, `updated_at`, identity timestamps and `identity_data`) is deliberately
not fingerprinted, so a normal sign-in does not invalidate the worker.

## 3. Fix — server side (early stop)

`workerUserCheck` (pure, `src/lib/worker-invocation.ts`) runs on the `user` object of every issued session through the
new `verifyUser` option of `runWithWorkerSession`. It refuses: changed email, pending email change, a phone, a non-email
provider or linked identity, a ban, SSO or anonymous. A refusal ends the tick as `TOKEN_USER_REFUSED` **before any data
call** and signs the session out once. A changed password needs no check: the worker's own sign-in then fails
(`AUTH_INVALID_CREDENTIALS`) and the database refuses old tokens.

## 4. Tests (all passing)

| Scenario | Test | Evidence |
|---|---|---|
| Registration pins; fresh session works; ordinary sign-in keeps the pin | phase4h7-credential-0057 | PGLITE |
| Password change → refused; identity disabled; enrollments revoked; lease ended; all recorded | phase4h7-credential-0057 | PGLITE |
| Email change → refused and sticky (changing it back restores nothing) | phase4h7-credential-0057 | PGLITE |
| Requested (unconfirmed) email change; newly linked provider | phase4h7-credential-0057 | PGLITE |
| Stolen token after change; session from before re-registration refused; new session after re-enrollment works | phase4h7-credential-0057 | PGLITE |
| Expired token and stale session still refused (not sticky) | phase4h7-credential-0057 | PGLITE |
| Identity registered before 0057: refused (not disabled) until re-registered | phase4h7-credential-0057 | PGLITE |
| Ordinary users' password/email change: access unchanged | phase4h7-credential-0057 | PGLITE |
| API roles cannot read the new tables or run the fingerprint | phase4h7-credential-0057 | PGLITE |
| Pending email change in the sign-in reply: stop before data calls, signed out | phase4h7-invocation | PGLITE + fake auth |
| Changed password: worker sign-in fails closed, no data call | phase4h7-invocation | PGLITE + fake auth |
| Linked provider in the reply | phase4h7-invocation | PGLITE + fake auth |
| `verifyUser` wiring: refusal, throwing check, malformed code → fail closed; no free text leaks | phase4h7-units | pure |
| Deliberate breaks of the pin check, stickiness, revocation, pre-pin sessions, password/identity fields, re-pinning, user check | mutation-check-4h7 | see `evidence/mutation-check-4h7.txt` |

## 5. Residual risks and live checks (not verified)

1. **Fingerprint stability on hosted sign-in.** If the hosted sign-in service rewrites a fingerprinted field during an
   ordinary sign-in (for example re-hashing a non-bcrypt password hash), the worker is invalidated. That fails closed
   (availability, not safety). Verify after applying: one worker sign-in, then confirm the pin still matches.
2. **Definer read of `auth.users`.** The column catalog was read live; a definer function reading the rows was not run live.
3. **Window before detection.** Between a change and the worker's next call nothing is invalidated, but nothing can be
   done with the worker's authority either: every worker call re-checks first.
4. **Sign-in settings** (re-authentication for password change, email-change confirmation, email confirmation currently
   off) are unchanged and remain an owner decision. They would narrow how a stolen token can change the details at all.

## 6. Verdict

| Item | Result |
|---|---|
| Worker loses authority after a password or email change | **PASS** (PGlite; mutation-checked) |
| Enrollment and active authorization invalidated, sticky | **PASS** |
| Stale tokens cannot restore authority (incl. after re-registration) | **PASS** |
| Ordinary authentication unchanged | **PASS** (no auth setting or `auth.*` write; ordinary access test) |
| Database + server-side enforcement | **PASS** |
| Hosted behaviour (fingerprint stability, definer read) | **BLOCKED** until 0057 is applied with approval and checked |
| Task 2 overall | **PASS (local)** / hosted **BLOCKED** |
