# Backup and restore status — Phase 4H.1 (13 Nov 2026, 14:1x UTC)

**Status: BLOCKED.**

| Item | Finding |
|---|---|
| Fresh export created after 14 Nov 2026 09:19 UTC | **Not available.** The current time (13 Nov 2026, ~14:15 UTC) is before that cut-off, so no such export can exist yet. None was found in Files or uploads |
| Earlier exports (13 Nov) | Not used as a substitute |
| Restore of a real export | **Not run** |
| Full migration chain + reverse rollback on a real export | **Not run** |
| Tooling | `scripts/db-export/verify-local-restore-0054.sh` extends the 0052 verifier with 0054. It runs local-only, in a disposable PostgreSQL on a private socket. It refuses URLs and connection strings, unsets ambient connection variables, and leaves the original archive untouched |
| Tooling self-test | Run on a **synthetic** archive (`restore-chain-0054-synthetic-selftest.md`). Every chain step passed. The two expected FAILs (no migration history, no 0039 objects) mean the archive is synthetic. **This is not a backup restore and must not be presented as one** |

**When a fresh export exists:**
1. Record its SHA-256.
2. Run `scripts/db-export/verify-local-restore-0054.sh /path/to/export.backup` locally.
3. Keep the original file unchanged.

Do not connect to or modify the hosted database at any step.
