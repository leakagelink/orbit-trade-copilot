# Phase 4H.2 — runtime isolation feasibility (13 Nov 2026)

**Question.** Can a separate Lovable project run the Futures paper worker without access to this project's
privileged server key?

**Method.** Lovable documentation only (questions answered from the official docs on 13 Nov 2026) plus this
project's code. **No project, account, credential, secret, schedule or deployment was created**, so every
conclusion below is **documented, not demonstrated**.

## Verdict: FEASIBLE ON PAPER — UNVERIFIED; activation path remains BLOCKED

| Question | Finding (source) | Confidence |
|---|---|---|
| Can a separate project keep its own secrets? | Yes. Runtime secrets belong to one project's built-in backend; they are not copied on remix and are write-only. Without Lovable Cloud the docs give no way to hold runtime secrets for server code. Workspace "build secrets" are build-time only (Enterprise). | documented |
| Would the worker project see this project's privileged key? | No: each project's backend and secrets are separate. **But** enabling Cloud on the worker project gives it **its own** privileged key for **its own** backend. That key cannot touch this project's database, but it exists in the worker runtime. | documented / inferred |
| Can it run scheduled server-side work? | Yes. Managed jobs can run at most **once per minute**; TanStack Start projects have the job call an API route. Database-only SQL jobs can run more often. | documented |
| How is the scheduled call authenticated? | The platform stores `LOVABLE_CRON_SECRET` in that project and the route checks it with `authenticateCronRequest` before doing work. Routes under `/api/public/` bypass site auth, so the check is mandatory. | documented |
| Time limit | The scheduled HTTP call "times out after a few seconds" and **the handler is cancelled with it**. No exact number is documented. Longer work must be started and finished outside that request. | documented (inexact) |
| Retries | Not documented. | unknown |
| Cost | Usage-based Cloud credits (database, compute, network, storage). Free/Pro/Business workspaces get a 20-credit monthly Cloud grant; every job run uses credits, and a minute job keeps the backend from auto-pausing. **No amount can be estimated** without measurement. | documented, amount UNKNOWN |

## How it would work (if approved later)

```text
 worker project (own Cloud)                                  this project (Cloud)
 ──────────────────────────                                  ─────────────────────
 job (≥ 1 min) ──► /api/public/paper-tick                     data API + auth (publishable key)
                   authenticateCronRequest(LOVABLE_CRON_SECRET)        ▲
                   runIdentityFuturesPaperTick ─ sign in ─────────────┤ worker identity (plain user, enrolled,
                                                ─ six fpw_id_* calls ─┤ re-checked by 0054 on every call)
                                                ─ sign out ───────────┘
 secrets: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (of THIS project), FUTURES_PAPER_WORKER_EMAIL / _PASSWORD,
          the two activation flags. Never this project's privileged key.
```

The worker code in this repository already needs only the publishable key and the worker identity
(`futures-paper-worker-identity.server.ts`); it would be copied into the worker project's own code.

## Limitations and failure handling

1. **"Few seconds" handler cancellation vs. the tick.** A cancelled handler cannot sign out. The tick budget (S1)
   must therefore end clearly before the job timeout. The current data-call timeout (8 s) does **not** fit a
   few-second limit: the lifecycle refuses such a configuration (`CONFIG_INVALID`). Either a much shorter call
   timeout and one account per tick, or an owner-approved "start then finish" design, would be needed. The exact
   timeout must be measured before any value is approved.
2. **The worker project's own privileged key** sits in its runtime. It cannot reach this project's data, but the
   worker code must never use it; an import-graph test like `phase4h2-isolation.test.ts` would have to be added there.
3. **Who can change the worker project's code** can read the worker password at runtime. The password only grants the
   worker identity's rights (layer A bounds it), but workspace membership of the worker project is a security boundary.
4. **Connectors / integrations** linked at workspace level must not be linked to the worker project.
5. **Missed or failed runs** are not retried by any documented mechanism; leases expire (TTL) and the next run
   recomputes. A run cancelled mid-commit is resolved by the existing identical-replay rule.
6. **Monitoring**: the worker returns bounded codes only; where they are stored (worker project's own table, or this
   project's audit through a wrapper) is an open design decision.

## What remains to verify before relying on it (all need owner approval)

- Create the worker project and confirm in practice: secrets present, no access to this project's privileged key,
  job authentication, exact job timeout, retry behaviour and measured cost.
- Apply 0049 → 0054 here (separate approval) so the database layer exists.
- Create the worker identity and enrollment (separate approval).
