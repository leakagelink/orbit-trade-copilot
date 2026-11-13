# Draft migration dependency and rollback diagram — Phase 4H.1 (13 Nov 2026)

None of these drafts is applied. A read-only hosted catalog check on 13 Nov 2026 found:
- the migration journal ends at 0039 (40 rows);
- zero `futures_paper*` relations;
- zero `fp*_` / `fpw_*` functions.

```text
 hosted, applied            drafts (docs/proposed-migrations/, NOT applied)
 ───────────────            ───────────────────────────────────────────────────────────────────────────
 0000 … 0039  ──►  0049 ledger v3 ──► 0050 worker gateway ──► 0051 event completeness ──►
                   (paper ledger,      (lease/fence, 6 fpw_*     (required funding + exits,
                    v3 commit,          functions, provenance,    v4 commit; gateway → v4)
                    budgets)            worker audit; service_role)
             ──►  0052 entry completeness ──► 0053 worker identity ──► 0054 identity lifecycle (Phase 4H.1)
                  (v5 commit, entry checks,   (registry, enrollments,   (disable always possible; current
                   stopped exit-only, config   6 fpw_id_* wrappers;      status on every call; FOR SHARE on
                   audit; gateway → v5)        gateway revoked from      writes; identity history)
                                               service_role)

 Apply order    : 0049 → 0050 → 0051 → 0052 → 0053 → 0054     (each in ONE transaction)
 Rollback order : 0054 → 0053 → 0052 → 0051 → 0050 → 0049     (each in ONE transaction, no CASCADE)
```

| Draft | Refuses to apply unless | Its rollback is blocked while the successor exists because | Rollback restores |
|---|---|---|---|
| 0049 | (base) | 0050 objects depend on 0049 tables (out-of-order rollback refused: verifier and tests) | — (drops the paper ledger) |
| 0050 | 0049 present | 0051's guard view depends on `futures_paper_worker_leases` | 0049's service-role grant on v3 |
| 0051 | 0049 + 0050 present | 0052 objects depend on 0051 objects (out-of-order rollback refused: verifier and tests) | 0050's gateway body |
| 0052 | 0049–0051 present | 0053's guard view selects from `futures_paper_config_changes` | 0049's v3 body and 0051's gateway body, byte-for-byte |
| 0053 | 0052 + `has_role` + `account_mfa_allowed` present | 0054's guard view `futures_paper_0054_requires_0053` depends on 0053's guard view and `futures_paper_worker_identities` | the service role's EXECUTE on the six 0050 gateway functions |
| **0054** | 0053 present (`fpw_id_authorize`, `fpw_admin_set_identity`, the identity table, 0053's guard view) | (last in chain) | the seven 0053 function bodies and grants, byte-for-byte |

## Rollback cautions
- **One transaction only.** Run each rollback in a single transaction (`psql --single-transaction`). In particular, 0053's rollback starts with a GRANT to `service_role`. Run outside one transaction, a refused 0053 rollback would leave that GRANT in place even though the rest of the rollback fails.
  - Tested: with a single transaction, the refused rollback leaves the service role without gateway access (PGlite test plus local verifier row "Failed 0053 rollback restored no service-role gateway access").
- **0054 rollback reopens the 0053 defects.**
  - Disabling a promoted worker becomes impossible again.
  - Status is checked only at registration.
  - Disable or revoke every worker identity before rolling 0054 back.
- **Export identity history first.** Rolling back 0054 deletes the identity history table, so export it before rolling back.
