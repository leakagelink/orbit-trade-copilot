# Phase 4H.6 — Worker deployment and timing decision

Status: **recommendation only — NOT APPROVED.** Nothing was created, deployed or scheduled.

## 1. Facts used (all live read-only unless marked)

| Fact | Value | Source |
|---|---|---|
| Scheduler | jobs are 5-field cron (≥ 1 per minute) that POST to a `/api/public/...` route of the **same** project; no timeout parameter | scheduler tool schema; LS20 |
| Scheduled-call limit | **5,000 ms** (7 of 1,080 calls in 6 h ended with "Timeout of 5000 ms reached") | LS21 |
| Hosting time after the caller gives up | unknown | LS22 BLOCKED |
| Database limits for signed-in calls | statement_timeout 8 s, lock_timeout 8 s | LS17 |
| This project's server runtime | holds the privileged database key (`client.server.ts`, used by server functions and the engine); BYPASSRLS | code; LS18 |
| Worker binding | uses only the publishable key + the worker's own email/password; plain `fetch`; never the privileged key | `futures-paper-worker-identity.server.ts` lines 30–46; `phase4h-final-isolation` |
| Saved owner preference | "keep upgrades in the existing app; no separate paid Python hosting" | project memory |

## 2. Comparison

| Criterion | A. Inside the current project | B. Dedicated separate project |
|---|---|---|
| Database privileges reachable by the worker's runtime | **Everything**: the same runtime holds the privileged key (the worker code does not use it, but a defect in worker code runs beside it) | Only what the worker credential allows: with 0055+0056, the six worker operations |
| Secret exposure | Worker email/password stored with every other server secret; readable by all server code and by anyone who can change this project | Separate secret store; this project holds no worker secret |
| Isolation | Logical only (identity, code tests) | Runtime + project boundary; a worker-code exploit (e.g. via external market data) cannot reach this project's privileged key |
| Incremental risk vs today | Low in privilege terms (the runtime is already all-powerful); adds one external-input code path next to the privileged key | Adds a second public route and project to secure |
| Scheduled-job limit | 5,000 ms (measured) | Same platform → expected 5,000 ms; **not measured** in a second project |
| Timeout compatibility with current values | **FAIL** — current limits need ≥ 13,000 ms (§3) | **FAIL** — same |
| Operational cost | none extra | a second project (hosting/credits per the owner's plan — unknown); conflicts with the saved "no separate paid hosting" preference **if** it costs money |
| Complexity | one codebase, one deploy | two deploys; worker code must be kept identical (version pin + fingerprint check); monitoring split |
| Recovery | admin disables the identity (stops every call at once, F4/0054); pause the job; unset the flag | admin disables the identity **in this project** (same effect, independent of project B); pause B's job |
| Job authentication | the public route must verify a job secret itself | same, in project B |

## 3. Timing compatibility (both options)

`worker-auth-session.ts` line 180 refuses limits where `authTimeout + rpcTimeout + signOutTimeout > tickBudget`.
Defaults: 3,000 + 8,000 (identity binding line 65) + 2,000 = **13,000 ms** minimum tick, against a **5,000 ms**
measured job limit. Activation with current values is therefore impossible (refused as `CONFIG_INVALID`) or, if the
tick budget were set beyond the job limit, sign-out would be cut off (L4).

Options (owner values — S1–S8 / T11 are not changed here):
1. **Fit inside 5 s** — e.g. tick budget ≤ 3,000 ms (0.6 × J), sign-in ≤ 1,000, per call ≤ 1,000, sign-out ≤ 700,
   one account per tick. Most worker calls are short, but any call that the client stops at 1 s while the database
   continues (up to 8 s) becomes "outcome unknown" (handled by leases/fences, but more frequent).
2. **Start then finish** — the route answers at once and continues in the background. Requires measuring the
   hosting's background time limit (BLOCKED, LS22) and a new review.
3. Approve current values — not workable (refused or cut off).

Recommended: option 1, measured first in a non-production test route (separate approval), values approved by the owner.

## 4. Recommendation

**B — dedicated separate project**, provided it does not add paid hosting the owner has declined. Reason: it is the
only option where a defect or exploit in the worker's code is limited to the six paper operations; in A it sits beside
a key that bypasses every protection reviewed in this phase. Timing does not distinguish the options (both FAIL with
current values and both need option 1).

If the owner keeps the worker in this project (saved preference, cost), A is acceptable **only with**:
the worker route never importing the privileged client (enforced by a test, as today for the binding), a job secret
checked first in the route, the worker password stored as its own secret, and the same 0055+0056 protections — and the
owner accepting that a runtime compromise exposes everything regardless of the worker.

## 5. Evidence still required (separate approvals)

- Cost of a second project on the owner's plan.
- Job limit and background-time limit measured on a test route in the chosen project.
- Job-secret verification on the worker route.
