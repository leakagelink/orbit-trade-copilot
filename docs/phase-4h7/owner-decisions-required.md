# Phase 4H.7 — Owner decisions required

**Every decision below is NOT APPROVED.** Nothing here was applied, created, scheduled or activated. Ids continue the
Phase 4H.6 register (`docs/phase-4h6/owner-decisions-required.md`); items closed or changed by this phase are marked.

| Id | Decision | Recommendation | Status |
|---|---|---|---|
| OD-T1 (replaces OD-1) | **Invocation limits I1–I10** (3,600 ms budget, 1,200 ms margin, sign-in 600, data call 450, sign-out 400, market 600, intents 200, 15 s lease, 60 s slot, 6 candles) | Approve for the paper worker after OD-T2 | NOT APPROVED |
| OD-T2 | **Safe hosted timing probe**: a temporary, unauthenticated-refusing test route that measures worker-host → database and → sign-in latency and cold start, without signing in or writing | Approve one short-lived probe, removed after measuring | NOT APPROVED |
| OD-T3 | **Capacity**: one schedule keeps up with ≤ 6 one-minute accounts at ≤ 75 ms per request (worker timing report §5) | Start with one account; add schedules or longer timeframes later | NOT APPROVED |
| OD-2 | Deployment architecture | Unchanged from Phase 4H.6 | NOT APPROVED |
| OD-3 → **draft ready** | Credential pinning (0057 part 1) | Review `0057_worker_credential_pin_and_refusal_tally.sql`; apply only with OD-11 | NOT APPROVED |
| OD-4 | Sign-in settings (password-change re-authentication, email-change confirmation) | Unchanged; would narrow how a stolen token can change details at all | NOT APPROVED |
| OD-5 → **draft ready** | Refusal tally and dropped counter (0057 part 2); accept that category B lives only in logs and category C is unrecordable | Accept | NOT APPROVED |
| OD-A1 (with OD-6…OD-8) | External checkpoint store, key custody, schedule; include the 0057 tally in each checkpoint | As Phase 4H.6 | NOT APPROVED |
| OD-A2 | **Worker log retention** for category B evidence (worker host and platform request logs) | Verify retention before activation; export weekly with checkpoints | NOT APPROVED |
| OD-9 | W1–W5 values | Unchanged | NOT APPROVED |
| OD-10 (extended) | **Fresh export** and its restore through **0057** with `verify-local-restore-0057.sh` | Take the export, run the verifier, keep the preserved copies | NOT APPROVED |
| OD-M1 | **Recovery step R3**: if 0049 must ever be rolled back while retired 0055/0057 history exists, re-bind that history's triggers to a stand-alone guard (no row touched) | Approve as the documented procedure; never run without a fresh export | NOT APPROVED |
| OD-M2 (with OD-13) | Destructive rollbacks 0049–0054 | Never run after activation; always export first | NOT APPROVED |
| OD-11 (extended) | Apply drafts **0049–0057** in order | Only after OD-3, OD-5, OD-9, OD-10, OD-T1 | NOT APPROVED |
| OD-12 (extended) | Post-apply live checks, now including: one worker-style sign-in leaves the 0057 fingerprint unchanged; the definer fingerprint read works | With a throwaway non-worker test account first | NOT APPROVED |
| OD-14 | Locked-file L7 diff | Still optional: the bounded invocation already limits every call | NOT APPROVED |
| OD-15 | Paper risk values (5 % buffer, 5 s, 60 s, 0.13 %, sub-budgets) | Approve for the paper worker only | NOT APPROVED |
| OD-16 | Phase 4H.3 missing logs | Unchanged | NOT APPROVED |
| OD-17 | Worker account, enrollment, job secret, flags, schedule — each separately | Only after every item above | NOT APPROVED |
| OD-18 | `has_role` callable anonymously | Unchanged | NOT APPROVED |

## Exact conditions before a controlled Paper Worker activation

1. A fresh owner export restores cleanly through 0057 with the verifier (OD-10), preserved copies kept.
2. Drafts 0049–0057 approved and applied in order, byte-for-byte (OD-11), then the post-apply checks pass (OD-12).
3. Hosted timing measured with the probe (OD-T2) and I1–I10 approved or adjusted (OD-T1); W1–W5 (OD-9) and the paper
   risk values (OD-15) approved.
4. Deployment architecture (OD-2) and log retention (OD-A2) decided; checkpoint store and key decided (OD-A1, OD-6…8).
5. Sign-in settings reviewed (OD-4).
6. Then, each separately approved: the worker sign-in account, its registration (pins its fingerprint), one account
   enrollment, the job secret, the environment flags, one schedule (OD-17). Live Futures and Autopilot stay off.
