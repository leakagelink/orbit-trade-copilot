# Phase 4H.5 — Migration review (drafts 0055 and 0056)

Date: 14 Nov 2026. Both drafts are **DRAFT ONLY — NOT APPLIED**. Drafts 0049–0054 and their rollbacks are unchanged
(byte-for-byte; pinned by `src/test/phase4h2-isolation.test.ts`). No migration was applied, rolled back or recorded
anywhere real. All evidence below is local: PGlite (in-memory) and a throwaway PostgreSQL 17.11 on 127.0.0.1.

## 1. Numbering

| Source inspected | Result |
|---|---|
| Applied history in this repository (`drizzle/migrations/meta/_journal.json`) | ends at `0039_futures_pass_certification_and_autopilot_fencing`; no file above 0039 in `drizzle/migrations/` |
| Unapplied drafts (`docs/proposed-migrations/`) | 0040–0054 present (0049–0054 = the worker chain) |
| Hosted migration history | **NOT VERIFIED** — reading it needs production database access, which this phase forbids |

0055 and 0056 are therefore **proposed numbers** (the next free draft numbers). Each file states that the final number
is assigned at owner approval, after the hosted history has been read. Nothing depends on the number itself.

## 2. Files

| File | Purpose |
|---|---|
| `docs/proposed-migrations/0055_futures_paper_worker_security_remediation.sql` | F4, F13(a)+(b), F15 (row-level and server checks), L2–L5 (database side) |
| `docs/proposed-migrations/0055_futures_paper_worker_security_remediation.rollback.sql` | reverses 0055, keeps refusal history |
| `docs/proposed-migrations/0056_worker_identity_api_boundary.sql` | F15 at the data-API boundary (only the six worker operations for a worker identity) |
| `docs/proposed-migrations/0056_worker_identity_api_boundary.rollback.sql` | removes only its own hook |

Apply order: 0049 → 0050 → 0051 → 0052 → 0053 → 0054 → 0055 → 0056. Rollback order: 0056 → 0055 → 0054 → … → 0049.
Hashes: `sha256-manifest.txt`.

## 3. What 0055 changes

| Object | Kind | Change |
|---|---|---|
| `fpw_identity_lock_key(uuid)` | new, immutable SQL | advisory-lock key per user |
| `fpw_worker_session_max_age()` | new, immutable | **W1 = 600 s** (proposal, NOT APPROVED) |
| `fpw_refusal_record_cap()` | new, immutable | **W2 = 120 refusal records per identity per 10 min** (proposal, NOT APPROVED) |
| `fpw_caller_is_worker()` | new, definer, stable | true only for the caller itself |
| `fpw_guard_worker_role()` + trigger `fpw_worker_role_guard` on `user_roles` | new | refuses admin/super_admin for any registered identity (enabled or not), after taking the identity lock |
| `fpw_guard_worker_account()` + trigger `fpw_worker_account_guard` on `futures_paper_accounts` | new | refuses an account owned by a registered identity, after taking the identity lock |
| `fpw_admin_set_identity` | replaced (same signature) | 0054 body + exclusive identity lock before any eligibility read |
| `fpw_id_check` | replaced (same signature) | 0054 body + shared identity lock (writes), live/young session check, `FOR SHARE OF a, e` |
| `futures_paper_worker_refusals` | new table | append-only (update/delete/truncate triggers), RLS on, **no policy, no grant** |
| `fpw_record_refusal` | new, definer | records only for registered identities; bounded text; capped |
| `fpw_id2_*` (six) | new, definer | envelope wrappers: lock check first, 0054 wrapper in a sub-transaction, refusal classes recorded |
| `fpw_cp_field`, `fpw_cp_us`, `fpw_audit_checkpoint` | new | checkpoint head over each audit table (admin + MFA only) |
| `account_mfa_allowed()` | replaced (same signature/attributes) | **applied 0011 body verified byte-for-byte first**, plus "caller is not a registered worker identity" |
| `fpw_worker_identity_guard` | new restrictive policy | on every public table with RLS at apply time |
| `futures_paper_0055_requires_0054` | new view | rollback-order guard |
| grants | changed | `fpw_id2_*` → authenticated only; `fpw_id_*` (0053/0054 six) revoked from authenticated; `fpw_audit_checkpoint` → authenticated (admin check inside); `fpw_caller_is_worker` → anon, authenticated, service_role; everything else revoked from PUBLIC/anon/authenticated/service_role |

0056: `fpw_api_pre_request()` (definer, stable) and `ALTER ROLE authenticator SET pgrst.db_pre_request`, then a config
reload notification. It refuses to apply if any pre-request hook already exists.

## 4. Review checklist

| Requirement | 0055 | 0056 | Evidence |
|---|---|---|---|
| **Transactional safety** | The whole file is ONE `DO` statement: all-or-nothing whatever the runner does (fixes 4H.4 finding MR1 for the new drafts) | same | `phase4h5-isolation` "ONE statement"; `phase4h5-migration-0055` §7 "all-or-nothing": a failure near the end left 0 functions, 0 triggers, 0 policies |
| Preconditions fail closed | requires 0054 objects, `user_roles`/`has_role`, `workspace_sessions`, `auth.sessions`, `auth.mfa_factors`, `auth.jwt()`, `auth.uid()`; refuses if `account_mfa_allowed()` differs from 0011 (body, definer, stable, search_path); refuses if a refusal table (or its retired copy) exists | requires 0055; requires role `authenticator`; refuses if any `pgrst.db_pre_request` is set | §7 test "changed account_mfa_allowed() body refuses the whole draft"; 0056 test "refuses to replace an existing hook" |
| **No silent deletion of history** | forward: no DROP/DELETE/TRUNCATE. Rollback: **renames** the refusal table to `futures_paper_worker_refusals_0055_retired` (still append-only, still closed to API roles) | no data touched | `phase4h5-isolation` "no draft or rollback deletes history"; rollback test reads the kept row and confirms delete is still refused |
| **RLS and owner isolation** | refusal table: RLS, no policy, no grant; every RLS table gets a restrictive worker guard; ordinary users' `account_mfa_allowed()` answers are identical to 0011 in the tested matrix (aal1/aal2, verified factor, revoked workspace session, no user) | ordinary users, anon and service role pass unchanged | §3 "ordinary users …"; §4 F15 tests; 0056 "ordinary users … never affected" |
| **Fixed SECURITY DEFINER search paths** | every function fixes `search_path` (`public, pg_temp`; helpers `pg_catalog`; `account_mfa_allowed` keeps 0011's `public`) | `public, pg_temp` | `phase4h5-isolation`; §7 privileges test (16 functions) |
| **Explicit privileges** | listed in §3; nothing for PUBLIC; anon only `fpw_caller_is_worker` | hook executable by anon/authenticated/service_role (it runs as the request role) | §7 privileges test; 0056 privileges test |
| **Safe rollback** | one statement; refuses unless 0056 is gone; restores 0011 and 0054 bodies byte-for-byte (compared with a database that never had 0055); re-grants the 0054 wrappers; keeps history | refuses unless the configured hook is its own | §7 rollback test; 0056 rollback test; 0054 rollback refused while 0055 exists, works after |
| **Environment isolation** | paper-only objects; nothing references orders, exchange connections, credentials, wallets, bots, Autopilot or real Futures | data-API setting only | grep of both files; `phase4h2-isolation` import-graph tests unchanged |
| Worker account requirements | still: registered by MFA admin, not admin/super_admin, owns no paper account, enrolled by the current owner — now also: **can never become admin or own a paper account while registered**, and every call needs a **live session younger than W1** | only the six `POST /rpc/fpw_id2_*` requests | §2, §3 tests; real-PostgreSQL suite |
| Dependency ordering | 0054 rollback blocked by `futures_paper_0055_requires_0054`; 0055 rollback blocked while `fpw_api_pre_request` exists | — | §7 and 0056 tests |

## 5. Findings and residual risks

| # | Finding | Severity | Status |
|---|---|---|---|
| R1 | 0055 replaces `account_mfa_allowed()`, an applied function used by every user. Mitigated by the byte-for-byte precondition, identical attributes, the unchanged-answer matrix and an exact rollback. | Medium (blast radius) | Needs owner review; hosted body NOT VERIFIED |
| R2 | 0055 reads `auth.sessions` (columns `id`, `user_id`, `created_at`, `not_after`) from a definer function. Precedent: applied `account_mfa_allowed()` reads `auth.mfa_factors`. Hosted readability and column names **NOT VERIFIED**; if missing, the migration refuses. | Medium | NOT VERIFIED |
| R3 | The restrictive guard is added to tables that exist when 0055 runs; tables created later need their own (policies that call `account_mfa_allowed()` are covered automatically; 0056 covers the data API). | Low | Documented; test lists every RLS table |
| R4 | Worker reads now lock rows `FOR SHARE` and take a shared advisory lock: an admin disable or owner revoke waits for at most one in-flight call (bounded by the call timeout). | Low | By design (F4) |
| R5 | Checkpoints with `p_settle_seconds` below the longest transaction can raise false alarms (never hide tampering). Recommended 300 s (W5, NOT APPROVED). | Low | Documented |
| R6 | 0056 changes a project-level data-API setting; support for `pgrst.db_pre_request`, the exact `request.path` format, and whether the migration role may `ALTER ROLE authenticator` are **NOT VERIFIED**. If `request.path` differs, the worker is refused (fails closed); ordinary users are unaffected. | Medium | NOT VERIFIED |
| R7 | `ALTER ROLE authenticator` applies to every database on the server (cluster-wide role). Hosted projects have one database; the local test cluster resets the setting per throwaway database. | Low | Documented |
| R8 | Re-applying 0055 after its rollback is refused while the retired refusal table exists (deliberate: history must be reviewed, never overwritten). | Low | By design |
| R9 | Earlier findings unchanged because 0049–0054 must not be edited: MR1 (0049–0054 rollbacks not atomic), MR2 (0049/0054 rollbacks destructive), MR3 (0049 has no predecessor guard), MR6 (`has_role` executable by PUBLIC). | as in 4H.4 | Unchanged; owner decision |
| R10 | Owner/superuser can still disable triggers, change functions, or replace these drafts' objects. 0055 makes that **detectable** for rows covered by externally stored checkpoints; it cannot prevent it. | High (inherent) | Residual by design |

## 6. Verdict

No blocking defect was found in 0055 or 0056 in local testing. Both remain **NOT APPROVED for application**. Before
any application: fresh export + local restore through 0056; read-only hosted check of items R1, R2, R6 and the
migration history (for final numbers); owner approval of W1, W2, W5 and the drafts; apply 0049→0056 together.
