# Existing worker security tests re-run (no test or source changed) — 2026-11-14T03:30:57Z

Command: `bunx vitest run src/test/phase4h2-isolation.test.ts src/test/phase4h3-token-cleanup.test.ts src/test/worker-auth-session.test.ts src/test/phase4h2-security-regression.test.ts src/test/migration-0054-identity-lifecycle.test.ts`

```text
     [33m[2m✓[22m[39m an admin registers a separate plain user; the owner enrolls it; a full hosted tick commits every candle; history records the registration [33m 911[2mms[22m[39m
     [33m[2m✓[22m[39m 0054 needs 0053; 0053's rollback fails as a whole while 0054 exists; 0054's rollback restores every 0053 body and grant exactly [33m 6778[2mms[22m[39m

[2m Test Files [22m [1m[32m5 passed[39m[22m[90m (5)[39m
[2m      Tests [22m [1m[32m75 passed[39m[22m[90m (75)[39m
[2m   Start at [22m 03:28:38
[2m   Duration [22m 20.06s[2m (transform 2.70s, setup 4.49s, import 4.39s, tests 23.96s, environment 13.37s)[22m

```

`phase4h2-isolation.test.ts` pins the SHA-256 of drafts 0049–0054, their rollbacks and the locked files `futures-paper-worker-hosted.ts` / `.server.ts`; it passed, so none of them changed.
