# Re-verification of the Phase 4H.3 SHA-256 manifest — run 2026-11-14T03:28:31Z

```text
src/lib/worker-auth-session.ts: OK
src/lib/futures-paper-worker-identity.server.ts: OK
src/lib/AGENTS.md: OK
src/test/phase4h3-token-cleanup.test.ts: OK
src/test/worker-auth-session.test.ts: OK
src/test/phase4h2-security-regression.test.ts: OK
scripts/worker-auth/mutation-check-4h3.ts: OK
scripts/worker-auth/mutation-redundancy-4h3.ts: OK
docs/phase-4h3/phase4h3-final-report.md: OK
docs/phase-4h3/phase4h3-execution-report.md: OK
docs/phase-4h3/phase4h3-mutation-report.md: OK
docs/phase-4h3/evidence/build-summary.txt: OK
docs/phase-4h3/evidence/full-suite-summary.txt: OK
sha256sum: docs/phase-4h3/evidence/local-postgresql-4h1-runner.log: No such file or directory
docs/phase-4h3/evidence/local-postgresql-4h1-runner.log: FAILED open or read
sha256sum: docs/phase-4h3/evidence/mutation-check-4h3.log: No such file or directory
docs/phase-4h3/evidence/mutation-check-4h3.log: FAILED open or read
sha256sum: docs/phase-4h3/evidence/mutation-redundancy-4h3.log: No such file or directory
docs/phase-4h3/evidence/mutation-redundancy-4h3.log: FAILED open or read
docs/phase-4h3/evidence/skipped-tests.md: OK
docs/phase-4h3/evidence/typecheck.txt: OK
docs/proposed-migrations/0049_futures_paper_ledger_v3.sql: OK
docs/proposed-migrations/0050_futures_paper_worker_gateway.sql: OK
docs/proposed-migrations/0051_futures_paper_event_completeness.sql: OK
docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql: OK
docs/proposed-migrations/0053_futures_paper_worker_identity.sql: OK
docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.sql: OK
docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql: OK
docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql: OK
docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql: OK
docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.rollback.sql: OK
docs/proposed-migrations/0053_futures_paper_worker_identity.rollback.sql: OK
docs/proposed-migrations/0054_futures_paper_worker_identity_lifecycle.rollback.sql: OK
src/lib/futures-paper-worker-identity.ts: OK
src/lib/futures-paper-worker-hosted.ts: OK
src/lib/futures-paper-worker-hosted.server.ts: OK
src/test/helpers/fake-auth.ts: OK
src/test/phase4h2-isolation.test.ts: OK
scripts/futures-paper/concurrency-check-4h1.sh: OK
sha256sum: WARNING: 3 listed files could not be read
--- sidecar:
docs/phase-4h3/phase4h3-sha256-manifest.txt: OK
--- git check-ignore:
.gitignore:3:*.log	docs/phase-4h3/evidence/local-postgresql-4h1-runner.log
.gitignore:3:*.log	docs/phase-4h3/evidence/mutation-check-4h3.log
.gitignore:3:*.log	docs/phase-4h3/evidence/mutation-redundancy-4h3.log
--- tracked evidence files:
docs/phase-4h3/evidence/build-summary.txt
docs/phase-4h3/evidence/full-suite-summary.txt
docs/phase-4h3/evidence/skipped-tests.md
docs/phase-4h3/evidence/typecheck.txt
```
