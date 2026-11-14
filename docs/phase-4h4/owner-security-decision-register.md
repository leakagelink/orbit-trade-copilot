# Phase 4H.4 — Owner security decision register

Prepared 14 Nov 2026 (investigation only). **Every decision below is NOT APPROVED.** Nothing in this register has been
implemented, applied, enabled or scheduled. A decision becomes approved only by an explicit written owner approval that
names its ID (for example "approve D-F4 option 1"). Evidence for each row is in `phase4h4-final-report.md` (section
numbers in brackets) and `evidence/`.

| ID | Subject | Recommended option | Status |
|---|---|---|---|
| D-F4 | Role promotion / account creation during an in-flight worker call | Option 1: refuse promotion and Futures-account creation for a registered worker identity (successor draft) | **NOT APPROVED** |
| D-F13 | Audit integrity against owner-level bypass | Option 2: accept owner-level trust + add detection (chain/version check, trigger-state check, external chain-head anchor) | **NOT APPROVED** |
| D-F15 | Ordinary signed-in rights of the worker identity | Option 1: deny the worker identity all ordinary app use (database guard + server-function guard) | **NOT APPROVED** |
| D-L2L5 | Token / session lifetime after sign-out, late refresh, failed sign-out, lost sign-in reply | Option 1: bind every worker call to a live, young auth session in the database; keep project-wide auth settings unchanged | **NOT APPROVED** |
| D-L7 | Per-call timer armed inside a Promise executor (locked file) | Option 1: session-level per-call abort in the session module, locked file untouched | **NOT APPROVED** |
| D-ARCH | Worker deployment architecture | Option B: separate isolated project | **NOT APPROVED** |
| D-TIME | Tick and per-call timing (S1–S8, T11 call/lease values) | Measure the real job timeout first, then fit values by the stated rule | **NOT APPROVED** |
| D-RISK | Risk and exposure values (T1–T10, paper budgets, costs) | Keep as proposals until paper validation evidence exists | **NOT APPROVED** |
| D-MIG | Apply drafts 0049–0054 | Do not apply yet; apply 0049→0054 (+ an approved successor) in one transaction after the listed evidence exists | **NOT APPROVED** |
| D-EVID | Phase 4H.3 evidence package: 3 raw logs listed in the manifest are missing | Re-run and commit the logs under a non-ignored name, issue a corrected manifest | **NOT APPROVED** |

---

## D-F4 — Role promotion or worker-owned account during an in-flight call  [§2.1]

**Problem (reproduced locally).** `fpw_id_check` (draft 0054 lines 82–107) reads `user_roles` and
`futures_paper_accounts` without locks. A promotion to admin, or a Futures paper account created for the worker, that
commits while one writing worker call is in flight does not wait, and that call still commits. The next call is refused.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | Successor draft: BEFORE INSERT/UPDATE trigger on `user_roles` refusing `admin`/`super_admin` for any user in `futures_paper_worker_identities`; BEFORE INSERT/UPDATE trigger on `futures_paper_accounts` refusing a worker identity as owner. Message: "disable the worker identity first" | Closes the race completely for both paths; makes separation of duties explicit; disabling (already MFA-guarded, F1 fix) stays the only route | Adds a trigger to the app's role table (shared role system); every admin promotion pays one indexed lookup; must not break the signup trigger (inserts only `user`) |
| 2 | Same triggers, but take `FOR UPDATE` on the identity row (waits for in-flight writers holding `FOR SHARE`) instead of refusing | Promotion still possible without a separate disable step; race closed for the four writing wrappers | Promotion can block for up to one call; read wrappers (no lock) still race; an admin-and-worker identity is still possible until the next call refuses it |
| 3 | Accept the residual | No change | One extra call (one candle commit, lease or review mark) by an identity that is already admin/owner; separation of duties briefly violated |

**Dependencies:** D-MIG (needs 0053/0054 objects); a new successor draft number. **Evidence still required:** the
successor draft's local PostgreSQL concurrency test must flip the reproduction (`evidence/repro-f4-f13-postgresql.md`)
from "committed" to "refused"; hosted `user_roles` trigger inventory (read-only, approval needed). **Status: NOT APPROVED.**

## D-F13 — Audit integrity  [§2.2]

**Problem (reproduced locally).** Append-only triggers stop the API roles and ordinary deletes, but the table owner can
`DISABLE TRIGGER` and a superuser can set `session_replication_role = replica`; both deleted audit rows. Refused worker
calls leave no audit row. Deleting a middle config-change row is detectable (broken link, version gap); deleting the
newest row is not. The chain hash is unkeyed SHA-256, so an owner-level actor can rebuild a consistent chain.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| 1 | Accept owner-level trust as documented | No work | Silent tampering by anyone with owner rights (migration access) is undetectable |
| **2 (recommended)** | Accept owner-level trust **and** add detection: (a) admin-only read-only integrity check (per-entity version contiguity 1..n, prev-link continuity, triggers `tgenabled='O'`); (b) periodic export of chain heads (entity, key, version, chain hash) to a place outside this database chosen by the owner; (c) worker refusal codes kept in worker monitoring | Middle deletions, disabled triggers and (with b) tail deletions/chain rewrites become detectable after the fact | Detection, not prevention; (b) needs an external store and a schedule (separate approval); identity-column gaps are not evidence (rolled-back inserts also leave gaps) |
| 3 | Keyed chain (HMAC with a secret outside the database) | Owner-level actor cannot forge a consistent chain without the key | Key custody problem; secret must not be in the same runtime (D-ARCH); more moving parts |

**Dependencies:** D-ARCH (where anchors/monitoring live), D-MIG. **Evidence still required:** whether the hosted platform
permits event triggers or audit logging of DDL (NOT VERIFIED); owner choice of anchor destination. **Status: NOT APPROVED.**

## D-F15 — Ordinary signed-in rights of the worker identity  [§2.3]

**Problem (code review).** The worker identity is a normal account. With its password anyone can sign in to the app and,
like any Free user, store exchange keys, use the demo wallet, open support tickets, write own profile/strategy rows; Pro
features when the plan check passes. Row-level security limits it to its own rows, but nothing enforces "owns no other
data". It cannot create a Futures paper account through the app (no user path), so it cannot disqualify itself that way.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | Successor draft + server change: helper `is_worker_identity(auth.uid())`; added to the existing restrictive per-table guard so the worker sees and writes no ordinary table; the shared server-function security middleware and AI request verification refuse worker identities (needed because some server functions write with the privileged client, bypassing row-level security) | A leaked worker password grants only the six worker calls; no ordinary app use, no stored exchange keys | Touches the shared guard used by every table (regression risk, needs broad tests); must be done before the identity exists |
| 2 | Operational controls only: random unguessable e-mail, long random password stored only as a worker secret, never used in the UI, rotated on suspicion; admin disables the identity on any anomaly | No code change | A leaked credential still has full ordinary-user rights until disabled |
| 3 | Accept residual | — | As option 2 without controls |

Options 1 and 2 are complementary; option 2's controls are recommended in every case. **Dependencies:** D-MIG, D-ARCH.
**Evidence still required:** hosted sign-up settings (open sign-up?) NOT VERIFIED; full downstream authorization audit of
every server function (not completed in this phase). **Status: NOT APPROVED.**

## D-L2L5 — Token and session lifetime  [§3]

**Problem.** L2: a signed-out access token remains valid until it expires (the data API checks the signature, not the
session). L3: a refresh that completes after cleanup is discarded but not signed out. L4: a failed sign-out is not retried.
L5: a sign-in reply lost to a timeout leaves a session the worker never learns about. All hosted lifetimes UNVERIFIED.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | Successor draft: `fpw_id_check` additionally requires the token's `session_id` claim to exist in the auth session table for the caller and the session to be younger than a worker maximum session age (proposal 600 s); project-wide auth settings unchanged | Signed-out tokens refused at once (L2); a late-refreshed token dies with its session (L3); failed sign-out and orphan sessions become useless after the age limit (L4, L5); no effect on ordinary users | Reads a platform-managed table (read only; precedent: the applied MFA check already reads auth tables and the `session_id` claim); hosted readability and claim presence NOT VERIFIED; one extra indexed lookup per call |
| 2 | Shorten the project-wide access-token lifetime and enable a session time-box | Smaller windows for L2–L5 | Applies to **every app user** (more refreshes, forced re-logins); may need a paid plan feature; still not instant |
| 3 | Accept L2–L5 | No work | Window = hosted access-token lifetime (commonly 1 h; NOT VERIFIED). Mitigated by the per-call identity/enrollment check, which still refuses disabled, revoked or promoted identities |

**Safe defaults recommended (not implemented, not approved):** keep S2 3 s, S3 2 s, S4 60 s, S5 120 s, S6 30 s, S8 ≤ 1;
keep 2xx-only sign-out; one sign-in per tick; local-scope sign-out; worker maximum session age 600 s (option 1).
**Dependencies:** D-MIG, D-ARCH. **Evidence still required:** the live checklist in §3.3 (separate approval for a
read-only check). **Status: NOT APPROVED.**

## D-L7 — Per-call timer inside a Promise executor  [§4]

**Problem (reproduced with fakes).** In the locked `futures-paper-worker-hosted.ts` (line 94) a timer that cannot be
armed makes the call throw immediately after the request was already started, and that request is never aborted. A
timer that never fires leaves the adapter waiting forever; the session deadline still ends the tick, but the in-flight
request is not aborted by the tick end either.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | In `worker-auth-session.ts` (not locked): arm a per-call timer before the data transport starts and pass one combined abort signal (adapter signal + tick signal + own timer) to the transport; a timer fault refuses the call before sending | Locked file untouched; every identity-path call has its own limit; tick end aborts in-flight requests (narrows L6) | Changes a reviewed module (re-review, new tests, mutation run); does not cover the privileged-client binding (which should not be used) |
| 2 | Edit the locked file: arm the timer before the request (same pattern as Phase 4H.3) and return a "not started" transient on timer failure | Fixes the root cause for both bindings | Requires lifting the hash pin (separate approval), re-review of the Phase 4G adapter |
| 3 | Accept residual | — | Likelihood very low in production (platform timers), impact bounded by the session deadline and the platform request limit |

**Dependencies:** none for option 1 beyond approval. **Evidence still required:** whether the hosted runtime's
`setTimeout` can throw inside a request, and timer/clock behaviour under the runtime's time model (NOT VERIFIED).
**Status: NOT APPROVED.**

## D-ARCH — Worker deployment architecture  [§5]

| Option | Benefits | Risks |
|---|---|---|
| A. Existing project | One codebase, no new project, no cross-project scheduling | The runtime holds the privileged database key; any co-located code (or a patched global) can bypass the worker identity; worker credentials readable by all server code; blast radius = whole database |
| **B. Separate isolated project (recommended)** | Runtime holds only the publishable key and the worker credentials; a compromised worker is limited to the six worker calls (and, with D-F15, nothing else); separate secrets and membership boundary | Second project to maintain (code drift), its own backend and credits, scheduled-call timeout of "a few seconds" (inexact), job authentication via its own cron secret, monitoring split across projects |

**Dependencies:** D-TIME (timeouts), D-F15, D-L2L5. **Evidence still required:** create-and-measure in a later approved
phase: secrets present, privileged key of this project absent, job authentication, exact job timeout, retries, cost.
**Status: NOT APPROVED.**

## D-TIME — Tick and per-call timing  [§6]

**Problem.** The data-call timeout (T11, 8,000 ms) cannot fit a scheduled call that "times out after a few seconds";
the session module would refuse such limits (`CONFIG_INVALID`). The real job timeout has never been measured.

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | Measure the real job timeout J (approved test in the chosen project), then set S1 ≤ 0.6 × J, call timeout ≤ S1 − S2 − S3 − margin, one account per tick at first, lease TTL ≥ 3 × tick interval | Values fitted to evidence; sign-out always inside the job | Needs a measurement phase first |
| 2 | "Start then finish" design (the scheduled call only starts work that finishes elsewhere) | Removes the few-seconds constraint | New design and review; more state |
| 3 | Approve current engineering values | — | Configuration refused or sign-out cut off by the platform (L4) |

**Status: NOT APPROVED** (S1–S8 and all T11 values).

## D-RISK — Risk and exposure values  [§6]

Proposed values on record (paper only): liquidation buffer 5 %, maximum price age 5 s (T6 5,000 ms), proposal expiry 60 s
(T8), estimated cost 0.13 % per instrument/strategy, one account budget with Research and Scalping sub-budgets,
T1–T10 as in `docs/phase-4h/timing-and-rounding-register.md`. The Testnet limits (5 USDT margin, 2 USDT loss reserve,
2 USDT daily, 10 USDT exposure, one position, ≤ 10x) apply to the separate Testnet account only, not to this worker.
**Recommended:** keep all as proposals until paper validation evidence exists, then approve individually.
**Alternatives:** approve now as paper-only; or tighten (e.g. 10 % buffer). **Risk of approving now:** values untested
against forward paper data. **Status: NOT APPROVED.**

## D-MIG — Drafts 0049–0054  [§7]

| Option | Description | Benefits | Risks |
|---|---|---|---|
| **1 (recommended)** | Do not apply now. Later apply 0049→0054 plus the approved successor (D-F4/F15/L2L5) as **one transaction**, after: fresh export + local restore (B1), read-only hosted catalog check of prerequisites, confirmed transaction behaviour of the migration runner, owner decisions above | All-or-nothing; worker gateway never exposed half-built | Longer lead time |
| 2 | Apply 0049–0054 now, successor later | Earlier hosted verification of layer A | Known F4/F15/L2 gaps live; 0050 alone briefly grants the gateway to the privileged role until 0053 revokes it if applied separately |
| 3 | Apply 0049–0052 only (ledger, no identity) | Ledger tables available | Gateway executable by the privileged role with no identity layer |

**Status: NOT APPROVED.** No draft was applied, rolled back or edited.

## D-EVID — Phase 4H.3 evidence package gap  [§1]

Three raw logs listed in `phase4h3-sha256-manifest.txt` are absent from the repository: the project ignores `*.log`, so
they were never committed. 33 of 36 manifest entries still match. **Recommended:** re-run the three commands in a later
approved step, commit the output under a `.txt` name, and issue a corrected manifest; the original bytes cannot be
recovered. **Alternative:** accept the gap and rely on the summaries that were committed. **Status: NOT APPROVED.**
