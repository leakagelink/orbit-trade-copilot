# Phase 4H.5 — Security remediation: final report

Date: 14 Nov 2026. Scope: fix F4, F13, F15, L2–L5 and L7 from `docs/phase-4h4/phase4h4-final-report.md`.
**Phase 4I has not started.**

## 1. Change control (what did NOT happen)

- No production database access; no live sign-in, exchange or AI call; no order.
- No migration applied anywhere real. Drafts 0049–0054 and rollbacks unchanged byte-for-byte.
- No worker account created, enrolled, scheduled or activated; worker flags unset; no route or schedule added.
- T1–T11 unchanged (locked Phase 4G hosted files byte-identical); S1–S8 unchanged (`SESSION_DEFAULTS` pinned).
- Protected files preserved: `futures-paper-worker-hosted.ts` / `.server.ts` untouched — the L7 fix lives in the
  session module (§6). Live trading, Futures, Autopilot, risk settings, emergency stop: untouched.
- AI Prime Tech remains disabled; no AI call was made.

## 2. Status summary

| Issue | Status | One line |
|---|---|---|
| **F4** privilege change during a worker call | **FIXED** (draft 0055; REAL-PG verified) | Promotion and worker-owned accounts are refused for any registered identity, and they wait for in-flight calls |
| **F13(a)** refused calls leave no audit record | **FIXED** (draft 0055) | Refusals are committed to an append-only table in a sub-transaction |
| **F13(b)** newest/middle deletion, modification, reordering | **FIXED for checkpointed rows** | Detected against externally stored checkpoints; rows after the last checkpoint are reported "uncovered" |
| **F13(c)** owner can rewrite the fingerprint chain | **PARTIALLY FIXED** | Detected if checkpoints are stored outside the database (optionally sealed with a key the database never sees). **Prevention is impossible** for an owner/superuser. Storage location and schedule: owner decision (BLOCKED) |
| **F15** worker account is also a normal user | **PARTIALLY FIXED** | Database, data API, server functions and AI routes refuse it (drafts 0055+0056 + server check). Sign-in itself and the sign-in service's self-service (password/email change) cannot be blocked from the database; 0056 hosted support NOT VERIFIED |
| **L2** token usable after sign-out | **PARTIALLY FIXED** | Worker calls require a live session row; NOT VERIFIED that hosted sign-out deletes it at once |
| **L3** late refresh | **FIXED locally / NOT VERIFIED hosted** | Refresh must keep the same session; late replies discarded; a refreshed token dies with its session |
| **L4** failed sign-out | **PARTIALLY FIXED** | Residual lifetime reported; leftover session usable only for worker calls and only up to 600 s (W1) |
| **L5** lost sign-in reply | **PARTIALLY FIXED** | Same 600 s cap; ordinary use blocked by F15 |
| **L7** per-call timer failure | **FIXED for the signed-in path** | Every request has its own limit armed before sending, is cancelled, bounded in number and dies with the tick |
| L7 root cause in locked file | **BLOCKED** (approval) | Minimal diff proposed in §6.3; not applied |
| Worker deployment architecture | **BLOCKED** (owner) | Recommendation unchanged: separate project |
| Timing values | **BLOCKED** | Job limit unmeasured; new values W1–W5 NOT APPROVED |
| Migrations 0049–0056 | **BLOCKED** (owner approval + hosted checks) | See `migration-review.md` |
| Phase 4H.3 missing logs (D-EVID) | **BLOCKED** (owner) | Unchanged; this phase saves evidence as `.txt` |

## 3. F4 — privilege changes during an active call

**Before (4H.4):** promoting the worker or giving it a paper account did not wait for a running call; that call still
wrote; only the next call was refused.

**Fix (0055):**
1. Per-user advisory lock `fpw_identity_lock_key(user)`: worker calls take it **shared**; registration, promotion and
   account creation take it **exclusive** — a change waits for in-flight calls; calls wait for a change.
2. Trigger `fpw_worker_role_guard` (on `user_roles`): admin/super_admin refused for **any registered identity**
   (enabled or disabled) — by any path, including direct table writes.
3. Trigger `fpw_worker_account_guard` (on `futures_paper_accounts`): an account owned by a registered identity is refused.
4. `fpw_admin_set_identity` takes the exclusive lock **before** reading eligibility (closes the write skew: registration
   vs promotion of the same user).
5. `fpw_id_check` takes the shared lock and row locks `FOR SHARE OF a, e` also on reads, so a disable or revoke waits
   for an in-flight snapshot too. Account ownership was already immutable (0049).

**Evidence (REAL-PG, PostgreSQL 17.11):** the exact 4H.4 reproduction now ends **waited → refused**, for admin,
super_admin and worker-owned account, with an acquire and with a snapshot in flight. Two deterministic write-skew tests
hold one side uncommitted and prove the other waits and is refused. 24 concurrent pairs never end as both.

**Fails closed:** all guards raise errors; a guard that cannot run aborts the change.
**Residual:** an owner/superuser can disable triggers (detectable through F13 checkpoints, not preventable).

## 4. F13 — audit integrity

**(a) Refused calls.** The six worker operations are now reached only through envelope wrappers `fpw_id2_*`. A refusal
(authorization, lease, fence, ledger) is caught in a sub-transaction: the failed work is rolled back, a row is committed
to `futures_paper_worker_refusals` (append-only; RLS on; no policy; no grant), and the caller receives the **original**
SQLSTATE and message in the envelope. Recording is limited to registered identities and capped (W2) to stop table
flooding. Callers that are not identities get the same envelope but no row.

**(b)+(c) Tamper evidence.** The database computes a rolling SHA-256 head over each audit table
(`fpw_audit_checkpoint`, MFA admin only, with a settle margin so in-progress rows are not hashed). An **independent**
TypeScript verifier (`src/lib/audit-checkpoint.ts`, pure, WebCrypto) recomputes the head from an export and compares it
with checkpoints **stored outside the database**; checkpoint records are chained, and can be sealed with an HMAC key the
database never sees. Offline tool: `scripts/audit-checkpoint/audit-checkpoints.ts` (local files only).

Detected in tests: deletion of the newest, a middle or the first row; insertion into a gap; column modification; swaps;
reordered/duplicated exports; altered/removed/reordered checkpoint records; a consistent rewrite of the 0052 hash chain;
deletions with triggers disabled (owner) and with `session_replication_role = replica` (superuser); disabled triggers
at checkpoint time.

**Limits (honest):** rows written after the last checkpoint are "uncovered", not verified. Without a seal key, someone
who can rewrite **both** the database **and** the external store can pass verification. Where checkpoints are stored,
who holds the key and when checkpoints run are **owner decisions** (no paid service needed; e.g. owner-held file
copies). No checkpoint job exists.

## 5. F15 — worker-only account

| Layer | Protection | Verified |
|---|---|---|
| Database rows | `account_mfa_allowed()` false for any registered identity → every existing restrictive policy refuses; plus a restrictive `fpw_worker_identity_guard` on **every** RLS table (covers tables whose policies don't call it) | PGLITE |
| Admin rights | role guard trigger (F4) | PGLITE + REAL-PG |
| Paper accounts / wallet / exchange keys | row guards; keys table is already service-role only | PGLITE |
| Data API (incl. owner-rights functions) | 0056 pre-request hook: a worker identity may send only `POST /rpc/fpw_id2_*` (six) | PGLITE (stand-in); **hosted NOT VERIFIED** |
| Server functions | global security middleware refuses with "This account is a background worker identity and cannot use the app" before any function runs; refusal never depends on the lookup | PURE |
| AI routes | `verifyAiRequest` refuses when `account_mfa_allowed()` is false | PURE |
| Account creation | the sign-in service, not the app, creates accounts; the worker is never created by code | — |

**Cannot be blocked from here:** signing in (the worker needs it), and sign-in-service self-service such as changing
its own password or email. Mitigation: keep the worker password only in the worker's environment; operational control.
If the project ever uses file storage for user files, its rules need the same guard (none found).

## 6. L7 — per-call timeout

### 6.1 Root cause (locked file, unchanged)
In `futures-paper-worker-hosted.ts` `call()`, the timer is armed inside a Promise executor **after** deciding to send:
if `setTimeout` throws, the request is still sent and never cancelled; if the timer never fires, the call waits forever.

### 6.2 Fix without touching the locked file (`src/lib/worker-auth-session.ts`)
Every data request through the signed-in session now:
1. arms its **own** limit before the transport is called — a timer fault refuses the call with **nothing sent**;
2. has a **platform backup timer** when timers are injected (a timer that never fires is covered);
3. gives the transport **one** abort signal combining its own limit, the caller's signal (the hosted adapter's) and
   the end of the tick — the underlying request is cancelled;
4. never uses a late reply (outcome "unknown", status 0) and a late reply never changes session state;
5. coalesces an identical in-flight request (never sent twice) and caps requests in flight (W4 = 4);
6. aborts anything still in flight when the tick body returns, before sign-out.
The whole-tick limit is unchanged.

### 6.3 Proposed change to the locked file — approval requested, NOT applied
```ts
// futures-paper-worker-hosted.ts, call(): arm the timer outside the executor, refuse before sending on failure
const ctl = new AbortController(), t0 = o.clock.now(); let h: unknown = null, fire = (_: { timedOut: true }) => {};
const deadline = new Promise<{ timedOut: true }>((res) => { fire = res; });
try { h = timers.setTimeout(() => { ctl.abort(); fire({ timedOut: true }); }, timeoutMs); }
catch { rec({ code: "RPC_TRANSIENT", accountId, fn, pgCode: null, latencyMs: 0 }); return { kind: "transient", pgCode: null, code: "RPC_TRANSIENT" }; }
// ...race unchanged...; finally { try { timers.clearTimeout(h); } catch { /* */ } }
```
It changes T-pinned bytes, so it needs explicit approval and a re-pin. With §6.2 in place it is defence in depth for
the signed-in path; it would also cover the older privileged binding (not used by the identity worker).

## 7. L2–L5 — session and token

**Local contract (PURE):** a token must carry a UUID `session_id`, an `iat`, and be younger than `maxTokenAgeMs`
(W3 = 300 s); a refresh must return the **same** session; on refusal the original token is still signed out once; an
unacknowledged sign-out reports how long the token may remain usable; the first failure is preserved as the outcome.

**Database contract (0055):** every worker call requires the caller's `session_id` to exist in `auth.sessions` for that
user, not expired, and created less than W1 = 600 s ago. A signed-out session therefore stops worker calls at once —
**if** the hosted sign-out deletes the row (NOT VERIFIED). Settings for ordinary users are unchanged.

**Live settings to verify (read-only, separate approval):** sign-out deletes the session row immediately; refresh keeps
`session_id`; access-token lifetime; `auth.sessions.created_at`/`not_after` exist and are readable by the migration
owner; time-box / inactivity settings; rate limits.

## 8. Verification

| Check | Result |
|---|---|
| Full suite | 1,402 passed, 81 skipped, 0 failed (116 files) |
| REAL-PG (new suite) | 15 / 15 passed |
| REAL-PG (earlier suites, 9 files) | 47 / 47 passed |
| Mutation check | 25 / 25 removed protections detected |
| Type check | 0 errors |
| Production build | succeeded (output deleted) |

Details: `security-remediation-test-report.md`; migrations: `migration-review.md`; hashes: `sha256-manifest.txt`.

## 9. New values — all NOT APPROVED

| Id | Value | Where |
|---|---|---|
| W1 | maximum worker session age 600 s | 0055 `fpw_worker_session_max_age()` |
| W2 | 120 refusal records per identity per 10 min | 0055 `fpw_refusal_record_cap()` |
| W3 | maximum token age at use 300 s | `SESSION_GUARDS.maxTokenAgeMs` |
| W4 | at most 4 requests in flight | `SESSION_GUARDS.maxInFlight` |
| W5 | checkpoint settle margin 300 s (recommended argument) | `fpw_audit_checkpoint(p_settle_seconds)` |

These are engineering constants, not S1–S8 or T1–T11.

## 10. Before activation (each needs its own approval)

1. Owner decisions in `docs/phase-4h4/owner-security-decision-register.md` plus W1–W5 and §6.3.
2. Fresh database export after 14 Nov 09:19 UTC; local restore through 0056.
3. Read-only hosted check: migration history (final numbers), `account_mfa_allowed()` body, `auth.sessions`,
   sign-out/refresh behaviour, data-API pre-request hook support.
4. Checkpoint storage location, key custody and schedule (F13).
5. Deployment decision (separate project recommended) and job time-limit measurement.
6. Approval to apply 0049–0056 together; then, separately, worker account, enrollment, flags and schedule.
