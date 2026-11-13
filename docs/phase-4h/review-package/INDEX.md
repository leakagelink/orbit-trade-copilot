# Phase 4H independent review package — INDEX

Prepared 13 Nov 2026 (UTC) as a **read-only copy** of existing project files. Every file is byte-identical to its source; the SHA-256 below was computed on the source and verified on the copy. No file was edited, regenerated or reformatted. Drafts 0052 and 0053 are **unapplied** proposals.

Files included: **29** (this INDEX.md is not counted and has no fingerprint of its own).

## Included files

| # | Package path | Original source path | Bytes | SHA-256 | Type | Notes |
|---|---|---|---|---|---|---|
| 1 | `reports/phase4h-final-report.md` | `docs/phase-4h/phase4h-final-report.md` | 15,902 | `4092284969b977dedc3e07d5bd0880c6f1b78fa072ec8be3496be46fcb885698` | report | Phase 4H finalization final report (0052/0053, decisions A–C, test evidence, blockers) |
| 2 | `reports/timing-and-rounding-register.md` | `docs/phase-4h/timing-and-rounding-register.md` | 7,623 | `506485ad1441ae0115b80af596de1e31edfee2d1e234027bb33c140042a05ef9` | report | Timing and rounding policy register T1–T11 (all NOT APPROVED) |
| 3 | `reports/owner-decision-register.md` | `docs/phase-4e/owner-decision-register.md` | 10,838 | `4f59bcb546963b54bb31acaf919d81758592e3dca60a5a7a7ff301d09bffd887` | report | Owner decision register (Phase 4H items in §7 and §8) |
| 4 | `reports/phase4h-g2-remediation-report.md` | `docs/phase-4h/phase4h-g2-remediation-report.md` | 11,050 | `6ae7509b6659dcce2acd64e71ba98d1d4801db8ea3d351729c6e4d9f1711f3fa` | report | Earlier Phase 4H report (draft 0051, G2); context for 0052 |
| 5 | `reports/restore-chain-synthetic-selftest.md` | `docs/phase-4h/restore-chain-synthetic-selftest.md` | 8,444 | `aaa751978352812a1be44d9df5560117715d5bb325fa9a4ef9eb4bca2922f6da` | report | Restore verifier self-test on a SYNTHETIC archive, chain 0049→0053 (not backup evidence) |
| 6 | `migrations/0052_futures_paper_entry_completeness_and_exit_only.sql` | `docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.sql` | 64,301 | `e6ed1a01ca93e71cbf680edde7000be724621e0f81a1aae96aaf3886b4ef40d9` | migration | Draft 0052 (unapplied) |
| 7 | `migrations/0052_futures_paper_entry_completeness_and_exit_only.rollback.sql` | `docs/proposed-migrations/0052_futures_paper_entry_completeness_and_exit_only.rollback.sql` | 31,213 | `562128f7033b21238af5fe54e78fbde0d7bea4438cfaa8a5e1b892f938ad84d3` | rollback | Rollback for 0052 |
| 8 | `migrations/0053_futures_paper_worker_identity.sql` | `docs/proposed-migrations/0053_futures_paper_worker_identity.sql` | 14,055 | `d436091177e43ab5bab3522fad29e633561966e9c6b6b1a370b3553f1d48d2bf` | migration | Draft 0053 (unapplied) |
| 9 | `migrations/0053_futures_paper_worker_identity.rollback.sql` | `docs/proposed-migrations/0053_futures_paper_worker_identity.rollback.sql` | 1,478 | `11fec84bcca216a11ae581b1e36d2268742981c8a23e726356328cb0b41923d2` | rollback | Rollback for 0053 |
| 10 | `security/hosted-service-role-review.md` | `docs/phase-4h/hosted-service-role-review.md` | 9,403 | `117b0e57fb6611430994b79d531966a62ceec51b641a051deb22490d6ae40008` | security document | Worker security review / threat model; stage 1–3 design and §4 finalization verdict (BLOCKED) |
| 11 | `security/futures-paper-worker-identity.ts` | `src/lib/futures-paper-worker-identity.ts` | 1,638 | `8fb8f2241e0a662c66420e414d21b41182ea3cee4f187f99caefad380a54ee46` | security document (implementation) | Worker identity: maps the six gateway calls to the fpw_id_* wrappers (pure, disabled) |
| 12 | `security/futures-paper-worker-identity.server.ts` | `src/lib/futures-paper-worker-identity.server.ts` | 2,209 | `2416b4ea4afed1496184eaa562d7bf7927cc4b81bca26940abb595ee4748a45a` | security document (implementation) | Disabled signed-in worker binding: publishable key + worker email/password env vars (names only), never the service key |
| 13 | `security/futures-paper-worker-hosted.ts` | `src/lib/futures-paper-worker-hosted.ts` | 16,741 | `1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824` | security document (implementation) | Phase 4G hosted connection (unchanged): function allowlist, deadline, redaction, refusal mapping |
| 14 | `security/futures-paper-worker-hosted.server.ts` | `src/lib/futures-paper-worker-hosted.server.ts` | 1,587 | `09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5` | security document (implementation) | Phase 4G service-role binding (unchanged, disabled) |
| 15 | `security/futures-paper-worker.ts` | `src/lib/futures-paper-worker.ts` | 14,953 | `4f6bac8308915282eb4b77e10aa36e32d19f788018e466cc22b26dad143ac7e4` | security document (implementation) | Worker loop incl. stopped-account exit-only processing (decision B) |
| 16 | `tests/migration-0052-entry-completeness.test.ts` | `src/test/migration-0052-entry-completeness.test.ts` | 35,155 | `e9ed05f36b7d381e34dacdd8af243b228695c98b5efa3e14567d3005f1cef198` | test | 0052 PGlite adversarial tests (29) |
| 17 | `tests/migration-0053-worker-identity.test.ts` | `src/test/migration-0053-worker-identity.test.ts` | 9,812 | `1da7ad984a21e0e2a5a37ac70709e168f580e37dfa8f89f2f4f12e450c3d4dd5` | test | 0053 PGlite identity/enrollment/authorization/rollback tests (5) |
| 18 | `tests/futures-paper-0052.pg.test.ts` | `src/test/futures-paper-0052.pg.test.ts` | 14,250 | `7e960551fbaae5d16000e223196ebe583dc2cb9c41347d7eaaf30ba49d5c1c01` | test | 0052 real-PostgreSQL concurrency/crash tests (5) |
| 19 | `tests/phase4h-final-isolation.test.ts` | `src/test/phase4h-final-isolation.test.ts` | 7,833 | `f3db2899120006f05ebabf9e6a3bd071c574ec46f93a648a562ac343ac1b567f` | test | Change control: fingerprints, body diffs, no app/route/schedule wiring (5) |
| 20 | `tests/futures-paper-0051-replay.test.ts` | `src/test/futures-paper-0051-replay.test.ts` | 14,581 | `0df5e1fc4383fcf808c0c1bea972c5eab81ea5e16370441155984bc78c228ed7` | test | Synthetic + historical replays (run through 0052 with FP_WITH_0052=1) |
| 21 | `tests/fp-v3-harness.ts` | `src/test/helpers/fp-v3-harness.ts` | 9,239 | `01e3eab5611aa1d82bc350563bec9551c30fd9dcbec02a3cc17208f9d4241742` | test (helper) | Test harness required by the 0052/0053 tests |
| 22 | `tests/fp-v4-harness.ts` | `src/test/helpers/fp-v4-harness.ts` | 2,195 | `ce1e42e772170539656d3fe992324d76adcf58d98f93a7701e26207e909c5e93` | test (helper) | Test harness required by the 0052/0053 tests |
| 23 | `tests/fp-v5-harness.ts` | `src/test/helpers/fp-v5-harness.ts` | 2,117 | `9d5f0e870a53937b1f529ca6aaf412700b61b0c8551ff06355780436ca1370a2` | test (helper) | Test harness for the 0049→0052 chain |
| 24 | `tests/fp-gateway-harness.ts` | `src/test/helpers/fp-gateway-harness.ts` | 6,117 | `16afd2e0a2b163af52e39219d00168737e770206775105ea5a485f6c98fb8a82` | test (helper) | Test harness required by the 0052/0053 tests |
| 25 | `tests/concurrency-check-4h-final.sh` | `scripts/futures-paper/concurrency-check-4h-final.sh` | 1,952 | `e76254a27afe45d779b7cc3e06de9c20ce9f9179601e74b81a05c2d612c90bcb` | test (script) | Throwaway local PostgreSQL orchestration for the real-PG runs |
| 26 | `tests/verify-local-restore-0052.sh` | `scripts/db-export/verify-local-restore-0052.sh` | 33,626 | `845766ee5b6a3743cf48d0f3413bd63c2bcf8051511d046bbe6799f9af9f93ce` | test (script) | Local-only restore verifier for the 0049→0053 chain |
| 27 | `tests/replay-0052-synthetic-1m.json` | `docs/phase-4h/replay-0052-synthetic-1m.json` | 740 | `5b6cc4da17a34e47a10e331e45197a1a777f30735472f76b9b252b94320ace1e` | test (evidence) | Replay statistics through 0052 |
| 28 | `tests/replay-0052-synthetic-5m.json` | `docs/phase-4h/replay-0052-synthetic-5m.json` | 732 | `afda4ea4d06675227374adb6789f0f1fef344445fa42b91194ea154b5f7b61a2` | test (evidence) | Replay statistics through 0052 |
| 29 | `tests/replay-0052-historical.json` | `docs/phase-4h/replay-0052-historical.json` | 506 | `e6594adcba37260e8577e45848b900a25b4338d10c5519d378b476f3fa5303f6` | test (evidence) | Replay statistics through 0052 (Binance 5m, 864 candles) |

## Missing files

No replacement was written for any item below.

| Requested item | Status |
|---|---|
| Standalone worker secret-handling and token-lifecycle document | **MISSING.** No such document exists. The only coverage is `security/hosted-service-role-review.md` (stage 2 row; §4 notes that token refresh during long ticks is **unverified**) and the comments in `security/futures-paper-worker-identity.server.ts`. Secret storage and token refresh were never designed or tested beyond that |
| Standalone database function allowlist / permission document | **MISSING as a separate document.** Covered by the GRANT/REVOKE statements in `migrations/0053_futures_paper_worker_identity.sql`, the allowlist in `security/futures-paper-worker-hosted.ts` (six gateway functions) and the wrapper mapping in `security/futures-paper-worker-identity.ts`. The 0050 grants are in the excluded 0050 draft (below) |
| Standalone entry-fill derivation / stopped-account exit-only document | **MISSING as a separate document.** Covered by `reports/phase4h-final-report.md` §3–§4 and the comments in `migrations/0052_…sql` |
| Separate Phase 4H owner decision register | **MISSING as a separate file.** Phase 4H decisions live in the shared register `reports/owner-decision-register.md` (source `docs/phase-4e/`), §7 and §8 |

## Intentionally excluded

- **Not requested, but the 0052/0053 tests depend on these.** They are left unchanged in the repository and have not been copied. 0052 replaces 0049's commit function and 0051's gateway, so a reviewer will likely want 0049–0051. Fingerprints:

| Source path | SHA-256 |
|---|---|
| `docs/proposed-migrations/0049_futures_paper_ledger_v3.sql` | `fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35` |
| `docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql` | `e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb` |
| `docs/proposed-migrations/0050_futures_paper_worker_gateway.sql` | `40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa` |
| `docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql` | `93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b` |
| `docs/proposed-migrations/0051_futures_paper_event_completeness.sql` | `58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788` |
| `docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql` | `41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf` |
| `src/lib/futures-paper-engine.ts` | `588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9` |
| `src/lib/futures-paper-engine-v3.ts` | `4e507828bfb32110399c755b840863a0392fb27eeecc471064478bd42267c313` |
| `src/lib/futures-paper-worker-queries.ts` | `fca2f3b0f78ef9a685dd87d5e926e8dd1a03684186c38ed9dc043c2f1c9dd0de` |
| `src/test/fixtures/futures-paper-history-5m.json` | `4cb0299d6340e68cfdf09d10ed2fe93b1144bbc4afcbb3b4adeef3c6c417e269` |

- **Not Phase 4H material:**
  - Earlier phase reports, migrations 0001–0048 and the 0051 replay JSONs.
  - Earlier isolation tests that received only narrow allowances (`phase4f-alignment-isolation`, `phase4g-isolation`, `phase4h-isolation`).
  - `src/lib/AGENTS.md`.
- **Never included:**
  - `.env`, secrets, keys, tokens or passwords.
  - Database exports and backup archives.
  - `node_modules`, build output and `.git`.
- **What the included files contain instead.** They name environment variables (`FUTURES_PAPER_WORKER_EMAIL`, `FUTURES_PAPER_WORKER_PASSWORD`, `PGPASSWORD`, …) only so the code can read them or deliberately unset them; no value is present. The redaction patterns in `futures-paper-worker-hosted.ts` are regular expressions, not credentials.

## Status reminder

- **Nothing was applied.** No migration has been applied to Lovable Cloud.
- **Nothing is running.** No worker, schedule or paper engine is enabled.
- **Nothing was traded.** No order was placed.
- **Still blocked.** Hosted worker security and the fresh export remain **BLOCKED** (see the final report).
