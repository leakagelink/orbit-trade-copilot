# Phase 4H.4 — Security risk resolution assessment — final report

Date: 14 Nov 2026. Baseline: commit `56e42ff` (Phase 4H.3 evidence package). **Investigation only.** No source, test or
migration file was changed; no migration was applied or rolled back; no live database, sign-in service, exchange or AI
provider was contacted; no worker account, enrollment, schedule or activation; no orders; T1–T11 and S1–S8 unchanged.
Phase 4I has **not** started. Owner decisions: `owner-security-decision-register.md` (all **NOT APPROVED**).

**Evidence produced in this phase** (`docs/phase-4h4/evidence/`):
- `repro-f4-f13-postgresql.md` — race and audit reproductions on a throwaway local PostgreSQL 17.11 (127.0.0.1, `/tmp`,
  unprivileged OS user), drafts 0049→0054 read byte-for-byte; output plus full script text.
- `repro-l7-per-call-timer.md` — per-call timer reproduction with fakes only (no network); output plus script.
- `phase4h3-manifest-reverification.md` — re-check of the Phase 4H.3 SHA-256 manifest.
- `existing-tests-rerun.md` — 5 existing worker security test files, 75/75 passed (includes the hash pins of drafts
  0049–0054, rollbacks and the locked Phase 4G files).

Reproduction scripts live in `/tmp` and are copied verbatim into the evidence files; they were not added to the project
as tests.

## 0. Assessment summary

PASS = investigated and the current protection is adequate for this risk. FAIL = a weakness was reproduced or proven
from code and needs an owner decision/remediation before activation. BLOCKED = cannot be decided without live
verification or an owner decision.

| Risk | Assessment | Basis |
|---|---|---|
| F4 in-flight promotion / account creation | **FAIL** (reproduced; low impact, bounded to one call) | §2.1, PostgreSQL reproduction |
| F13 audit integrity | **FAIL** (owner-level bypass reproduced; refused calls unaudited; tail deletion undetectable) | §2.2, PostgreSQL reproduction |
| F15 ordinary signed-in rights | **FAIL** (worker identity has full ordinary-user rights; not restricted by any control) | §2.3, code review |
| L2 access token valid after sign-out | **BLOCKED** (live token lifetime) | §3 |
| L3 late refresh after cleanup | **BLOCKED** (local behaviour PASS; live logout semantics unverified) | §3 |
| L4 failed sign-out not retried | **BLOCKED** (live session lifetime) | §3 |
| L5 sign-in reply lost to timeout | **BLOCKED** (live session lifetime) | §3 |
| L7 per-call timer failure | **FAIL** (reproduced; likelihood very low; tick still bounded) | §4, fake reproduction |
| Worker deployment isolation | **BLOCKED** (owner decision; separate-project behaviour unverified) | §5 |
| Timing values | **BLOCKED** (job timeout never measured) | §6 |
| Migrations 0049–0054 | **BLOCKED** for application; review found no blocking defect in content, 6 findings | §7 |
| Phase 4H.3 evidence package | **FAIL** (3 of 36 manifest entries missing) | §1 |

## 1. Existing evidence re-read and re-verified

Read: Phase 4H.3 final, execution and mutation reports and manifest; Phase 4H.2 token lifecycle, runtime isolation and
security test reports; Phase 4H.1 security review (exact F1–F15 definitions); Phase 4H timing register; source of
`worker-auth-session.ts`, `futures-paper-worker-identity.server.ts`, `futures-paper-worker-identity.ts`,
`futures-paper-worker-hosted.ts`, `futures-paper-worker-hosted.server.ts`, `futures-paper-worker.ts`; drafts 0049–0054
and rollbacks (structured review in §7).

Exact risk definitions used (quoted from the reports, not paraphrased from memory):
- **F4** (4H.1 security review row F4): "A role promotion (insert into `user_roles`) or the creation of a paper account
  for the worker, committed while one worker call is running, can let that single call finish. The next call is refused."
- **F13** (row F13): triggers refuse update/delete/truncate; "a database superuser or table owner can disable triggers";
  "refused worker calls leave no audit row, because they roll back with the call".
- **F15** (row F15): "An enrolled worker identity is also an ordinary signed-in user elsewhere in the app. Row-level
  security returns only rows it owns (none). It should own no other data."
- **L2–L5, L7**: Phase 4H.3 final report §11, rows L2–L5 and L7.

**Manifest re-verification — new finding.** 33 of 36 entries match. `local-postgresql-4h1-runner.log`,
`mutation-check-4h3.log` and `mutation-redundancy-4h3.log` are missing: `.gitignore` line 3 (`*.log`) excluded them, so
the commit `56e42ff` never contained them and they were lost when the sandbox restarted. The sidecar hash of the manifest
itself still matches. The committed summaries (`full-suite-summary.txt`, `typecheck.txt`, `build-summary.txt`,
`skipped-tests.md`) are intact. Decision D-EVID.

## 2. Residual risks F4, F13, F15

### 2.1 F4 — promotion or worker-owned account during an in-flight call

- **Technical description.** `fpw_id_check` (0054 lines 82–107) locks only the identity row (line 87, `FOR SHARE` when
  `p_lock`) and the enrollment row (line 99). The admin-role test (`has_role`) and the "owns no paper account" test read
  `user_roles` and `futures_paper_accounts` without locks under READ COMMITTED. A row inserted by another transaction
  after those statements is not seen by the running call and is not blocked by the `FOR SHARE` locks.
- **Code path.** Worker → `fpw_id_acquire_lease` / `fpw_id_commit` / `fpw_id_release_lease` / `fpw_id_mark_review`
  (writing, lock) and `fpw_id_snapshot` / `fpw_id_evaluated` (read, no lock) → `fpw_id_check`.
- **Preconditions.** Drafts applied; an enabled, enrolled worker; an admin promotes the worker (`adminSetRole`,
  `src/lib/admin.functions.ts` lines 8–17, 61–71: an admin may grant `admin`) or the privileged server role inserts a
  Futures paper account owned by the worker, **while** one worker call is between its check and its commit. No ordinary
  user path creates a Futures paper account (only the privileged role may insert, 0049 lines 832–836), and the worker
  cannot promote itself (`user_roles` writes need `super_admin`, applied migration 0000 lines 36–37).
- **Reproduction (evidence/repro-f4-f13-postgresql.md).** Both cases: the concurrent change committed without waiting
  (`concurrentChangeBlockedByInFlightCall: false`), the in-flight call committed a lease row and audit row
  `ID:LEASE_ACQUIRED`, and the next call was refused ("it has an admin role" / "it owns a paper account").
- **Realistic scenario.** An admin promotes the worker account by mistake during a tick; one lease, candle commit or
  review mark completes under an identity that is already admin.
- **Impact.** Security: separation of duties briefly violated for one call; the call can only do what the worker was
  authorised to do a moment earlier on an account its owner enrolled (paper ledger only). Operational: none beyond one
  write. Ledger integrity is unaffected (all ledger checks still run).
- **Existing safeguards.** Every later call refused (tests: 4H.2 regression "promotion … in the MIDDLE of a tick",
  0054 tests 2, 3); disable works even after promotion (F1 fix); window ≤ one call (bounded by the call timeout).
- **Remediation.** Successor draft with refusal triggers on `user_roles` and `futures_paper_accounts` (D-F4 option 1).
- **Regression tests required.** Real-PostgreSQL: the reproduction must show the promotion / account insert refused for
  an enabled or disabled registered identity; non-worker promotions unaffected; signup role insert unaffected;
  disable-then-promote still refused while registered (or allowed after de-registration, per decision); mutation that
  drops either trigger must fail a test; PGlite chain and rollback tests for the successor.
- **Residual after remediation.** Owner-level bypass of triggers (F13 class); read wrappers return the enrolled
  account's own paper data until the next call.

### 2.2 F13 — audit integrity

- **Technical description.** Audit tables (worker audit 0050 lines 65–81; config changes 0052 lines 77–99, hash chain
  lines 140–147; identity changes 0054) use ordinary `BEFORE UPDATE/DELETE/TRUNCATE` triggers. Tables are owned by the
  role that runs the migration (no `ALTER … OWNER`), so the owner/superuser can disable or skip them. Writes made by a
  refused call roll back with it.
- **Reproduction (PostgreSQL).** Service role delete → permission denied; owner delete with triggers → refused
  ("append-only"); owner `DISABLE TRIGGER USER` → trigger state `D`, delete succeeded; superuser
  `session_replication_role = replica` → delete succeeded; a refused worker call (account not enrolled) left the audit
  count unchanged (2 → 2); config chain 1,2,3: deleting version 2 broke 1 link and left a version gap (detectable);
  then deleting version 3 (the newest) broke 0 links (undetectable inside the database).
- **Additional fact.** `chain_sha256` is plain SHA-256 over public inputs (0052 line 147); an owner-level actor can
  recompute a consistent chain after any edit.
- **Preconditions.** Owner-level database access (migration rights). The API roles cannot do this.
- **Scenario.** An owner-level actor (or a compromised migration path) removes the latest configuration change or the
  audit rows of a period.
- **Impact.** Loss of after-the-fact accountability; no effect on ledger checks or trading authority. Refusals are only
  visible in worker monitoring.
- **Safeguards.** API roles cannot write; enrollment join still refuses after an owner change even with triggers
  bypassed (4H.2 security test 10); config versions are gapless per entity (unique version, advisory lock), so middle
  deletions are detectable.
- **Remediation.** D-F13 option 2: integrity check (version contiguity, prev links, trigger state), external chain-head
  anchoring, refusal codes from worker monitoring.
- **Regression tests required.** Integrity check reports a middle deletion, a disabled trigger and a chain-head mismatch
  against an anchor; reports clean on an untouched chain; not executable by `anon`/`authenticated` (admin wrapper only).
- **Residual.** Owner-level trust cannot be removed inside the database; detection only, and tail/rewrite detection
  depends on an external anchor.

### 2.3 F15 — ordinary signed-in rights of the worker identity

- **Technical description.** The worker identity is a normal account with role `authenticated`. Nothing in 0053/0054 or
  the app restricts its ordinary use; row-level security only scopes it to its own rows. The shared bearer middleware
  validates claims but is not a blanket MFA or identity gate (`src/integrations/supabase/auth-middleware.ts` 94–109).
- **What a holder of the worker password can do (code review, repository history `drizzle/migrations/0000–0039`).**
  Sign in to the app UI; create/edit own profile, strategies (Pro), journal, watchlists/alerts (Pro), support tickets,
  drafts; connect exchanges and store encrypted credentials (`src/lib/exchanges.functions.ts` 25–126, written with the
  privileged client — no plan gate); demo wallet deposits/withdrawals (`src/lib/wallet.functions.ts` 5–26); referral
  claims; Pro/Elite features when the plan check passes. The SQL promotion granting Pro/Elite to every user ended
  9 Nov 2026 (`0018_free_access_until_nov_8.sql`); hosted state NOT VERIFIED. Live bot activation is currently refused
  for everyone (`src/lib/bots.functions.ts` 51–61).
- **What it cannot do.** Read other users' private rows; write `user_roles`; create a Futures paper account (no user path;
  the Spot paper path writes `paper_accounts`, which 0054 does not consider, so the worker cannot disqualify itself);
  call the gateway functions directly.
- **Preconditions.** Worker credential leaked (worker project secrets, logs, a person with access).
- **Scenario.** A leaked worker password is used to sign in as a normal user, store foreign exchange keys and use the app
  under the worker's name; or to change the worker's own password/e-mail through the auth API (locks the worker out or
  survives a rotation).
- **Impact.** No access to the owner's data or capital; abuse of the app as an extra user; worker availability (DoS);
  audit confusion (actions recorded under the worker id).
- **Safeguards.** Row-level security; the six worker calls re-check identity and enrollment; an admin can disable the
  identity at any time (F1 fix).
- **Remediation.** D-F15 option 1 (database guard + server-function guard refusing worker identities) plus option 2
  operational controls.
- **Regression tests required.** For every public table with the restrictive guard: worker identity reads/writes 0 rows;
  every authenticated server function refuses a worker bearer token (table-driven test over the server-function list);
  `/api/chat` and `/api/autopilot` refuse; normal users unaffected; the six worker calls still work.
- **Residual.** Auth-API self-service (password/e-mail change) cannot be blocked by row-level security; mitigated by
  credential custody and disable-on-anomaly.

## 3. Token and session risks L2–L5

### 3.1 Proven locally (code + tests, Phase 4H.3; re-run this phase 75/75)

| Topic | Local proof |
|---|---|
| One sign-in per tick, never retried, never persisted | `worker-auth-session.ts` 239; no storage; fresh closure per call |
| Token lifetime used = min(`exp`, `expires_in`); tokens under S5 (120 s) refused | lines 147–150 |
| Every call ends before min(tick end − sign-out reserve, token expiry − S4) | lines 235–237, 289–294 |
| At most one refresh, verified with the same identity rules | 260–281 |
| Late refresh after cleanup discarded; waiting call refused; nothing recorded | 267, 293 (Phase 4H.3 late-refresh test) |
| Sign-out exactly once whenever a token was received; only 2xx counts | 356–366, 344 |
| No call starts after cleanup | 288 (`closed`, aborted signal, null token) |
| Session reuse across ticks: none; account isolation: expected worker id mandatory, per-call DB identity/enrollment check, per-account leases | 204, 141–145; 0054 `fpw_id_check` (local) |
| Overlapping ticks | Design only: local-scope sign-out ends only its own session; **no test of two overlapping ticks exists** |

### 3.2 Requires live verification (none performed; no sign-in service contacted)

| Item | Why it matters |
|---|---|
| Access-token lifetime (JWT expiry) | L2 window; S4/S5 fit |
| Refresh-token rotation, reuse interval, reuse detection | L3; whether a discarded rotated token can be replayed |
| Session time-box and inactivity timeout (and whether project-wide only) | L4, L5 lifetime of leftover sessions |
| Exact `logout?scope=local` replies and effect (session row removed, refresh tokens revoked) | L3, L4; 2xx-only rule |
| Whether a signed-out access token still works on the data API | L2 (expected yes; signature-only) |
| Presence of `session_id` and `is_anonymous` claims; readability of the auth session table from a definer function | D-L2L5 option 1; anonymous refusal |
| Token-endpoint rate limits and whether they are per address | AUTH_RATE_LIMITED behaviour, S7 |

### 3.3 Assessment and recommendation

- **L2** BLOCKED: window = hosted token lifetime (NOT VERIFIED). **L3** local PASS / hosted BLOCKED. **L4** BLOCKED:
  leftover session lives until hosted expiry. **L5** BLOCKED: the orphan session's tokens were never delivered to
  anyone, so the confidentiality risk is negligible; it is a lifetime/resource issue.
- **Recommended (not implemented):** bind every worker call to a live, young session in the database (D-L2L5 option 1).
  Precedent in applied history: `account_mfa_allowed()` (migrations 0010/0011) already reads `auth.mfa_factors` and the
  `session_id` claim from a definer function. Avoid changing project-wide auth settings, because they apply to every
  app user. Safe defaults are listed in the register.

## 4. L7 — per-call timer failure

- **Locked file.** `src/lib/futures-paper-worker-hosted.ts` (SHA-256 `1cbca841…a09d824`, pinned by
  `phase4h2-isolation.test.ts`; unchanged). Line 94 arms the timer **inside a Promise executor**; line 97 starts the
  request in the same `Promise.race`.
- **Why initialisation can fail.** Injected timers (`hosted.timers`) that throw; a patched global `setTimeout` (any code
  co-located in the same runtime can patch it — an argument for D-ARCH option B); runtime restrictions on timers outside
  a request context (NOT VERIFIED for the hosted runtime). With the platform timer inside a request, failure is very
  unlikely. A related case is a timer that is armed but never fires.
- **Reproduction (evidence/repro-l7-per-call-timer.md).**
  - A — timer throws: the call is rejected at once as an unclassified exception, **one request was already started**
    and its abort signal is never set.
  - B — timer never fires, reply never arrives: the adapter still waits after 1,500 ms (unbounded at adapter level).
  - C — same as B inside the Phase 4H.3 session: the tick ends at the body deadline (`TICK_DEADLINE_EXCEEDED`, 1,306 ms
    for a 1,500 ms budget), sign-out once (`SIGNED_OUT`), but the in-flight request is **not** aborted by the tick end.
- **Consequences by call (code review).** Lease acquire throws before the worker's `try` (`futures-paper-worker.ts`
  line 68) → account aborted (`TICK_ABORTED`, hosted line 202); a lease created by the already-sent request stays until
  its TTL (default 120 s) → next ticks see `LEASE_BUSY` for that account. Commit throws → treated as a lost reply →
  resent once (lines 125–130) → in case A **two identical commits are sent**; the database's identical-replay rule
  prevents duplication. Snapshot → `LOAD_FAILED`. No ledger corruption path was found.
- **Does the whole-tick limit protect resources?** It bounds the worker's waiting and guarantees sign-out inside the
  budget (case C). It does not abort in-flight requests (the data transport receives only the adapter's signal;
  `worker-auth-session.ts` line 300; the binding ignores the tick signal, identity binding lines 61–62). Server-side
  work of such a request is bounded by the database statement/request limits, not by the worker. Concurrency: leases and
  fences (0050) keep a second worker from processing the same account; an orphan request can still commit if its lease
  is still valid — the same as the existing "unknown outcome" case.
- **Remediation without touching protected files (proposal, not applied).** In `worker-auth-session.ts`, inside `call`,
  before `o.data(...)`:

  ```ts
  // proposal only — arm the per-call limit BEFORE the transport starts; combine adapter, tick and own signals
  const own = new AbortController();
  const h = timers.setTimeout(() => own.abort(), lim.rpcTimeoutMs);          // throws → caught → refused, nothing sent
  const onAbort = () => own.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  tickCtl.signal.addEventListener("abort", onAbort, { once: true });
  try { return await o.data(target, args, access, own.signal); /* + existing token-rejection handling */ }
  finally { timers.clearTimeout(h); signal.removeEventListener("abort", onAbort); tickCtl.signal.removeEventListener("abort", onAbort); }
  ```

  Arming happens inside the existing pre-transport `try` so a fault maps to `CALL_REFUSED_SESSION_CLOSED` (local
  refusal, classified "nothing written"). Optional second step (needs lifting the pin): the same arm-before-start
  pattern at hosted line 94.
- **Tests required.** Timer throws → no request started, local refusal, sign-out once; stalled adapter timer → request
  aborted at `rpcTimeoutMs`; tick cut-off aborts an in-flight request; commit path sends no second request when the timer
  fails; listeners removed (no leak across calls); mutation runs removing each of the three abort sources must fail.
- **Residual.** A request already accepted by the server may still complete there (L6); JavaScript cannot stop running
  body code.

## 5. Worker deployment isolation

| Aspect | A. Existing project | B. Separate isolated project |
|---|---|---|
| Authentication / privileged-role isolation | Runtime holds this database's privileged key; the worker identity limits only the worker's own credential (layer A), not co-located code | Runtime holds only this project's publishable key and the worker credentials; no privileged key for this database (its own backend key exists but cannot reach this database) |
| Database access | Six worker calls via the data API; any server code can use the privileged client | Six worker calls via the public data API only |
| Secrets / credential boundary | Project secrets readable by all server code (worker password next to the privileged key) | Separate secret set; workspace membership of the worker project becomes a boundary |
| Network | Same data API endpoints either way | Same, from a different runtime |
| Resource limits / timeouts | Scheduled call "times out after a few seconds" (inexact) — same platform | Same; must be measured in the chosen project |
| Operational cost | Job runs on existing credits | Second backend and job runs; minute jobs keep it from pausing; amount UNKNOWN |
| Monitoring / recovery | One place | Split; bounded codes need a home (open decision); code drift between copies needs a hash check |
| Blast radius if the worker is compromised | Whole database (privileged key), all user data | The worker identity's rights only: six calls on enrolled paper accounts, plus ordinary-user rights until D-F15 is done |

**Recommendation: B.** The whole purpose of 0053/0054 is that the worker never holds privileged database power; in A
that guarantee cannot hold (Phase 4H.1 layer C), and co-located code can even patch timers (§4). B's costs are
operational and measurable. Conditions: D-F15 first; no workspace connectors on the worker project; its own cron-secret
check on the route; an import-graph test there forbidding its own privileged client; measured timeout before D-TIME.
Design only; nothing created.

## 6. Timing and risk values

All NOT APPROVED. Key conflict: T11 call timeout 8,000 ms versus a scheduled call of "a few seconds"
(Phase 4H.2 runtime isolation report): `validateLimits` (`worker-auth-session.ts` 154–163) would refuse such a
configuration. Recommended rule in D-TIME; risk values summarised in D-RISK.

## 7. Migration review 0049–0054 (no file modified)

Applied history in this repository is `drizzle/migrations/0000–0039` (there is no `supabase/migrations`). Prerequisites
found there: `app_role` enum (`user`,`admin`,`super_admin`) and `has_role` (0000 lines 2, 29–34); `account_mfa_allowed`
(0010, replaced in 0011). The last hosted catalog read (Phase 4H.1, 13 Nov) matched; **current hosted state NOT VERIFIED.**

| Check | Result |
|---|---|
| Schema assumptions | 0050–0054 each raise if their predecessor objects are missing; **0049 has no guard** and uses plain `CREATE` (collides with 0045/0046 objects if those were ever applied; hosted history ended at 0039 at the last export) |
| RLS and ownership | Every new table has RLS. Ledger/evidence tables: owner-read `user_id = auth.uid() AND account_mfa_allowed()`, no write policies. Leases, identities, identity changes: no policies. Ownership = migration role (no `ALTER OWNER`) → F13 |
| Grants and function privileges | Final state after 0054: `authenticated` EXECUTE only on the admin, owner and six `fpw_id_*` wrappers; `fpw_id_check`/`fpw_id_authorize` not executable by API roles; gateway revoked from `service_role` (0053); no grant to PUBLIC/`anon`. Verified locally by existing tests |
| SECURITY DEFINER / search path | All definer functions fix `search_path`: `'public'` in 0049–0053 (all tables schema-qualified, no dynamic SQL → low risk), `'public','pg_temp'` in 0054 |
| Rollback safety | **No rollback file contains BEGIN/COMMIT**; dependency-guard views stop out-of-order rollback only if the whole file runs in one transaction (0054 rollback relies on `--single-transaction`). Rollbacks are destructive: 0049R drops ledger history, 0054R drops identity history, no refusal when data exists. Hosted migration-runner transaction behaviour NOT VERIFIED |
| Environment isolation | Paper-only objects; budgets constrained to `environment = 'paper'`; no reference to orders, exchange connections, credentials, wallets or bots |
| Worker account requirements | Registered and enabled by an MFA admin (0053/0054); not admin/super_admin; owns no Futures paper account; enrolled, not revoked, by the account's current owner; re-checked on every call |
| Dependency ordering | Strict 0049→0050→0051→0052→0053→0054. 0051/0052 replace `fpw_commit` (and 0052 replaces v3) with unchanged signatures; each rollback restores the predecessor body |

Findings: **MR1** non-transactional rollback files; **MR2** destructive rollbacks without data refusal (export first);
**MR3** 0049 lacks a predecessor/collision guard; **MR4** F4 race confirmed in `fpw_id_check`; **MR5** owner-level
trigger bypass (F13); **MR6** observation outside these drafts: baseline `has_role` has no explicit `REVOKE … FROM
PUBLIC` (pre-existing; lets a caller test whether a given user id has a role) — not changed, owner may review.
No blocking defect in the drafts' content was found; application remains **NOT APPROVED**.

## 8. Outstanding live-verification requirements (each needs separate approval)

1. Fresh database export after 14 Nov 2026 09:19 UTC, local restore, chain and rollback verification (B1; still in the
   future at the time of writing, ~03:30 UTC).
2. Read-only hosted catalog check: prerequisites, `user_roles` triggers, definer-function readability of auth tables,
   migration history, migration-runner transaction behaviour.
3. Auth settings and behaviour list in §3.2.
4. If D-ARCH B: create the worker project, then measure secrets, key absence, job authentication, exact timeout,
   retries and cost.
5. Hosted runtime timer and clock behaviour (§4).
6. Hosted sign-up settings (F15).

## 9. Exact next steps for Phase 4I (not started; each gated)

1. Owner decides D-F4, D-F13, D-F15, D-L2L5, D-L7, D-ARCH, D-TIME, D-RISK, D-MIG, D-EVID (register).
2. If approved: one draft-only successor migration covering D-F4 option 1, D-F15 database guard and D-L2L5 option 1,
   with rollback, PGlite chain tests and real-PostgreSQL concurrency tests (the §2.1 reproduction must flip to refused).
3. If approved: D-L7 option 1 and the D-F15 server-function guard, with tests and a mutation run.
4. If approved: D-EVID re-run and corrected Phase 4H.3 manifest.
5. Items in §8 in the listed order, each with its own approval.
6. Only then: a separate request to apply 0049→0054 plus the successor in one transaction; worker account, enrollment,
   flags and schedule remain separate approvals after that.

**Confirmation.** This was an investigation-only phase: no source-code, test-code or migration change; nothing applied,
enabled, scheduled or traded; no live service contacted; T1–T11 and S1–S8 unchanged; all decisions NOT APPROVED.
