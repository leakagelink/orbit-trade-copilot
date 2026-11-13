# Phase 4H.2 — final worker security, token lifecycle and backup readiness — final report (13 Nov 2026)

**Nothing was applied, enabled, scheduled or traded.**
- No migration applied; 0049–0054 and rollbacks are byte-identical; no successor draft was needed.
- No hosted database access at all this phase (not even read-only), and no hosted writes.
- No project, account, worker identity, credential, secret, route, schedule or deployment created.
- Paper worker not activated; both activation flags unset; the binding is imported by nothing.
- No Testnet or live order; Autopilot, Live Futures, exchange credentials and risk settings untouched.
- No AI call, no paid call, no infrastructure purchased. Phase 4I not started.

## Deliverables

| # | Deliverable | Location |
|---|---|---|
| 1 | Token lifecycle design and implementation report | `docs/phase-4h2/token-lifecycle-report.md` |
| 2 | Runtime isolation feasibility report | `docs/phase-4h2/runtime-isolation-feasibility.md` |
| 3 | Security test report | `docs/phase-4h2/security-test-report.md` |
| 4 | Fresh backup and restore report | `docs/phase-4h2/backup-restore-status.md` — **BLOCKED** |
| 5 | Updated migration dependency diagram | `docs/phase-4h2/migration-chain-diagram.md` (unchanged chain) |
| 6 | Final readiness verdict and remaining blockers | this file |

**Code.** `src/lib/worker-auth-session.ts` (new, pure); `src/lib/futures-paper-worker-identity.server.ts` (rewritten:
bounded session per tick replaces the long-lived auto-refreshing client). **Tests.** `src/test/worker-auth-session.test.ts`
(19), `src/test/phase4h2-security-regression.test.ts` (11), `src/test/phase4h2-isolation.test.ts` (7),
`src/test/helpers/fake-auth.ts`.

## Results

| Area | Result |
|---|---|
| 1. Token lifecycle | Implemented: one sign-in per tick, token verification, strict call deadline below both the tick budget and the issued token's lifetime, at most one refresh, no retries, bounded codes, local sign-out after every tick (also after failures), tokens forgotten. 19 tests; 9 of 11 mutations caught, 2 shown equivalent. **Hosted token lifetime, session expiry and auth rate limits are UNVERIFIED.** |
| 2. Runtime isolation | **Feasible on paper, unverified.** A separate Lovable project with its own Cloud can hold its own secrets and run a once-per-minute job authenticated by its own cron secret, without this project's privileged key. Limits: the job call "times out after a few seconds" and cancels the handler (exact value undocumented), which the current 8 s call timeout does not fit; that project would hold its own privileged key; retries undocumented; cost usage-based and unknown. |
| 3. Security regression | All six wrappers verified (existence, authenticated-only, current-status check). Disabled, revoked, admin/super_admin promotion mid-tick, owner promotion and ownership change all refused by the database; legitimate work resumes without duplicates. Import graph: no worker module reaches exchange, wallet, credential, order, Autopilot, AI, bot or admin-client modules, and none of those reaches the worker. Layers A/B/C reported separately. |
| 4. Backup | **BLOCKED**: the clock reads 13 Nov 2026 17:12 UTC, before the required 14 Nov 2026 09:19 UTC; no qualifying export exists. Restore verifier not run on real data. |
| Full suite | 1,314 passed, 0 failed, 66 skipped |
| Real PostgreSQL 17.11 (throwaway) | 4/4 + 43/43 (one run) |

## Final readiness verdict

**READY FOR INDEPENDENT REVIEW** of the token lifecycle, the binding and the Phase 4H.2 tests, together with drafts
0049–0054.

**NOT READY for migration application or Futures Paper Worker activation.**

## Remaining blockers

1. **Fresh export** after 14 Nov 2026 09:19 UTC, then local restore and chain/rollback verification — BLOCKED (time).
2. **Runtime isolation (layer C)** — BLOCKED in this project (its server runtime holds the privileged key). The
   separate-project path needs an owner decision and then practical verification: secrets, key absence, job
   authentication, exact job timeout, retries, cost.
3. **Tick timing vs. job timeout** — the tick budget, call timeout and accounts per tick must fit the measured job
   timeout; values S1–S8 and the call timeout are **NOT APPROVED**.
4. **Hosted auth settings** — access-token lifetime, refresh/session time-box, auth rate limits: UNVERIFIED; owner
   decision on session expiry needed (residual: signed-out access tokens remain valid until expiry; failed sign-outs
   leave sessions).
5. **Hosted verification of 0049–0054** — requires separately approved application.
6. **Residual risks** F4, F13, F15 to accept or mitigate (unchanged; tests show F13 does not bypass enrollment).
7. **Policy values** T1–T11, lease/RPC timing, participation limits, liquidation buffer, risk budgets and trading costs
   remain **NOT APPROVED**.
8. Separate approvals still required for: worker identity creation and enrollment, enabling flags, any route or
   schedule.
