# Phase 4H.6 — Migration readiness: drafts 0049–0056 as one sequence

**No migration was applied, modified or rolled back.** Drafts and rollbacks are byte-identical to their pins
(`phase4h2-isolation`, `phase4h5-isolation`, Phase 4H.5 manifest 31/31 OK).

## 1. Structure (computed from the files, comments removed)

| Draft | Forward | Single `DO` (atomic by itself) | Predecessor guard | Rollback | Rollback atomic by itself | Rollback drops tables |
|---|---|---|---|---|---|---|
| 0049 ledger v3 | 867 lines, 9 tables | **no** (plain statements) | **none** | 31 lines | no | **9** |
| 0050 gateway | 277 lines, 3 tables | yes | yes | 16 lines | no | **3** |
| 0051 funding/exits | 398 lines, 2 tables | yes | yes | 70 lines | no | **2** |
| 0052 entry completeness | 750 lines, 2 tables | yes | yes | 363 lines | no | **2** (+1 DELETE) |
| 0053 worker identity | 180 lines, 2 tables | yes | yes | 19 lines | no | **2** |
| 0054 identity lifecycle | 186 lines, 1 table | yes | yes | 84 lines | no | **1** |
| 0055 remediation | 403 lines, 1 table | yes | yes (+ byte check of the live shared check) | 111 lines | **yes** | **0** (renames, keeps history) |
| 0056 API boundary | 47 lines | yes | yes (+ no existing hook) | 15 lines | **yes** | 0 |

## 2. Checks

| # | Check | Verdict | Evidence |
|---|---|---|---|
| M1 | Dependency order 0049 → 0056 | **PASS** | each of 0050–0056 refuses without its predecessor (guards above; PGlite chain tests); rollbacks refuse out of order (0054 under 0055, 0055 under 0056) |
| M2 | Compatibility with the hosted history | **PASS (today)** | LS1: hosted = 0000–0039 exactly; LS2: no 0049+ objects. 0049 has no guard and plain `CREATE`, so it would collide only if drafts 0045/0046 had been applied (they are not; 0046 is rejected) |
| M3 | Final numbers | **Owner/apply-time** | The migration tool assigns the next journal numbers (0040…); draft file numbers are proposals. 0040–0048 drafts must not be applied in between (0046 rejected, 0047 superseded) |
| M4 | Proven on a real export | **PARTIAL** | 0049 + 0050: PASS on the 13 Nov export (Phase 4E/4G, local). **0051–0056 never run on a real export.** No verifier exists past 0054 (`verify-local-restore-0054.sh`) |
| M5 | RLS and grants | **PASS** | new tables: RLS on, service-only or no grants (4H.4/4H.5 reviews, PGlite privilege tests); 0055 guard reaches all 60 live RLS tables (LS4); no views to bypass (LS4) |
| M6 | Fixed search paths on owner-rights functions | **PASS** | 0049–0054 (4H.4 review), 0055/0056 (`phase4h5-isolation`) |
| M7 | Transaction safety (forward) | **PASS with condition** | 0050–0056 are single statements. 0049 is not: atomic only if run as one transaction — the platform migration tool wraps each migration in a transaction (tool contract) |
| M8 | Transaction safety (rollback) | **PARTIAL** | 0049–0054 rollbacks are multi-statement and not self-wrapped (4H.4 MR1): atomic only through the migration tool |
| M9 | Rollback completeness | **PASS** | each rollback removes exactly its own objects and restores prior bodies (PGlite tests; 0055 restores 0011 and 0054 bodies byte-for-byte) |
| M10 | Data preservation on rollback | **FAIL** (0049–0054) | 19 `DROP TABLE` across 0049–0054 rollbacks delete the paper ledger, audit and identity history; 0052 rollback deletes rows. 0055/0056 preserve history. Any rollback after activation needs an export first and owner approval (the migration tool also pauses destructive SQL for approval) |
| M11 | Interaction with existing security policies | **PASS with notes** | 0055 replaces `account_mfa_allowed()` only if the live body is byte-identical (LS3: it is); ordinary users' answers unchanged (PGlite matrix). Adds one restrictive policy per table (one cached function call per statement) |
| M12 | 0056 blast radius | **Recorded risk** | the hook runs on **every** data-API request (one primary-key lookup for signed-in users). If it ever errors for everyone, the whole app's data access fails. Mitigations present: rollback order guard (0055 cannot be removed under 0056), `EXCEPTION` on missing user id returns. Needs a hosted smoke test right after apply |
| M13 | Live features assumed but unverified | **BLOCKED** | 0055: sign-out deletes `auth.sessions` rows (LS8), refresh keeps `session_id` (LS9). 0056: hook accepted by the hosted data API (LS14 partial), `request.path` = `/rpc/<fn>` (LS15). Verified live: `auth.sessions` columns and access (LS6), shared-check body (LS3), PostgREST 14.18 (LS12), no existing hook (LS13) |
| M14 | Live `safeupdate` module on data-API sessions | **PASS** | LS13 shows `safeupdate` preloaded; no UPDATE/DELETE without WHERE in any 0049–0056 function body (scan in this phase) |
| M15 | Existing finding MR6 (`has_role` executable by PUBLIC) | **Confirmed live** | LS5: anon can execute `has_role`. Unchanged by 0049–0056 (information leak of roles by id, not escalation) |

## 3. Readiness verdict

**NOT READY to apply.** Blocking items: M4 (real-export chain through 0056 with a fresh export), M13 (hosted
behaviour), owner approval of the sequence and of W1–W5, and an approved post-apply smoke test for M12. M10 requires
an explicit owner decision on whether 0049–0054 rollbacks may destroy history (recommended: never after activation;
export first in all cases).

## 4. Smallest safe additions (recommendations, not made)

1. A verifier `verify-local-restore-0056.sh` (derived from the 0054 one) adding 0055/0056 steps, to run on the next
   export. Tooling only.
2. A successor draft (0057) for the two F13 gaps and the F15 credential gap (`phase4h6-final-report.md` §4).
