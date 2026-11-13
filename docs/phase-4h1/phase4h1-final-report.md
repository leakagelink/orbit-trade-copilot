# Phase 4H.1 — security remediation and independent-review preparation — final report (13 Nov 2026)

**Nothing was applied, enabled, scheduled or traded.**
- No migration was applied to Lovable Cloud, and there were no hosted writes. The only hosted access was one read-only catalog query.
- No worker account, secret, credential or deployment was created.
- No worker, route, schedule or paper trading was enabled; both worker activation flags remain unset.
- No real or Testnet order was placed.
- Autopilot, Live Futures, exchange credentials and risk settings were not touched.
- No paid call was made and no AI call was made.
- Phase 4I was not started.

## Deliverables

| # | Deliverable | Location |
|---|---|---|
| 1 | Successor migration and rollback | `docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql` (SHA-256 `391beac68e7de77112542f7c84b2b58628bf634fc39c8ee56a670532d3c47177`) and `.rollback.sql` (`4e78cebeedf8794859206013b22b178aabb08e375dd52478a97cc0ec12d34569`) |
| 2 | Identity lifecycle tests | `src/test/migration-0054-identity-lifecycle.test.ts` (17, PGlite)<br>`src/test/futures-paper-0054.pg.test.ts` (4, real PostgreSQL)<br>`src/test/phase4h1-isolation.test.ts` (4)<br>`migration-0053-worker-identity.test.ts` can now also run through 0054 (`FP_WITH_0054=1`) |
| 3 | Complete dependency package | `docs/phase-4h1/review-package/` and `phase4h1-independent-review-package.zip` (Files) |
| 4 | SHA-256 manifest | `docs/phase-4h1/review-package/MANIFEST.md` |
| 5 | Security review | `docs/phase-4h1/security-review.md` |
| 6 | Test execution report | `docs/phase-4h1/test-execution-report.md` |
| 7 | Backup and restore status | `docs/phase-4h1/backup-restore-status.md` (**BLOCKED**) |
| 8 | Dependency and rollback diagram | `docs/phase-4h1/migration-chain-diagram.md` |
| 9 | Unresolved blockers | below |
| 10 | Recommendation | below |

**Tooling.**
- `scripts/db-export/verify-local-restore-0054.sh`: local-only verifier for the 0049 → 0054 chain.
- `scripts/futures-paper/concurrency-check-4h1.sh`.

## What 0054 changes

**A. Disabling is always possible.**
- `fpw_admin_set_identity` still requires a signed-in admin with MFA for every call.
- The "separate plain user" rule now applies only when enabling. Disabling needs an existing identity and keeps its label.
- Re-enabling an identity that is no longer eligible is refused.

**B. Current status on every call.** The new `fpw_id_check` runs on every one of the six worker functions. It refuses a caller that is:
- disabled;
- an admin;
- a super_admin;
- the owner of any paper account;
- not enrolled, or revoked, for the account's current owner.

The four writing functions lock the identity and enrollment rows (FOR SHARE), so a disable or revoke takes effect between writes, never during one. Owner enrollment applies the same eligibility rule.

**C. History.** An append-only identity-change history was added.

**What did not change.**
- 0049–0053 are byte-identical.
- Same function signatures and grants.
- No new access for PUBLIC, `anon` or `service_role`.
- No timing or policy value changed.

## Results (details in the test execution report)

| Area | Result |
|---|---|
| PGlite | 0054 lifecycle 17/17; 0053 5/5 (alone and through 0054); 0052 29/29; 0051 + replays through 0052 27/27; gateway/hosted/0051/0052 89/89; through 0051 + 0052 35/36 (expected rollback-guard case) |
| Mutation testing | 13 PGlite mutations and 1 real-PostgreSQL lock mutation: **all caught**. 0054 fingerprint re-verified unchanged |
| Real PostgreSQL 17.11 (local, throwaway) | 4/4 + 43/43 on three runs |
| Full suite / typecheck / build | 1,277 passed, 0 failed, 66 skipped / passed / passed |
| Synthetic replays | 0 refusals, 0 mismatches (consistency only; **not profitability evidence**) |
| Hosted | read-only: drafts not applied; role functions as expected. **No draft verified on the hosted database** |
| Market data | none fetched |
| Restore | **BLOCKED**; synthetic tooling self-test only |

## Unresolved blockers

1. **Fresh export.** No export after 14 Nov 2026 09:19 UTC exists yet, so there is no real full-chain restore or rollback evidence.
2. **Runtime credential isolation (layer C): BLOCKED.**
   - The worker would share the server runtime that holds the service-role key.
   - A separate deployment needs an owner decision. A separate Lovable project is plausible but unverified; external infrastructure needs approval.
3. **Hosted verification of 0049–0054.** Not possible without owner-approved application (not authorized).
4. **Worker token lifecycle (F9).**
   - Design needed: sign-in per tick, sign-out, deadline versus token lifetime, auth rate limits.
   - Hosted auth settings are unverified.
   - The code is unchanged and disabled.
5. **Residual risks to accept or mitigate.**
   - F4: role promotion during one in-flight call.
   - F13: owner-level trigger bypass.
   - F15: the worker's ordinary signed-in rights.
6. **Policy values still NOT APPROVED.** This covers:
   - T1–T11;
   - lease duration and RPC timeout;
   - participation limits;
   - liquidation buffer;
   - risk budgets;
   - trading costs.
7. **Earlier items.**
   - Final migration numbering and owner review of 0049–0054.
   - Separate approvals for enabling the hosted connection and for any schedule.

## Recommendation

**READY FOR REVIEW**, for independent technical and security review of drafts 0049–0054, the disabled worker code, the tests and the reports. The package is complete: originals plus new drafts, with a SHA-256 manifest.

**NOT ready for migration application or worker activation.** Blockers 1–4 stand, and passing local tests do not authorize either.
