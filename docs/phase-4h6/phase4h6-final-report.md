# Phase 4H.6 — Independent security verification and activation readiness: final report

Date: 14 Nov 2026. Subject: Phase 4H.5 (commit `0b49efb`). **Phase 4I has not started.**

## 1. Change control

- No production database writes; no migration applied, modified or rolled back; drafts 0049–0056 byte-identical.
- No sign-in, sign-out or sign-in setting change; no account created; no scheduler, cron or worker activation.
- No exchange, Testnet or AI provider call; no order; no external or paid service; no checkpoint job or key.
- Autopilot, Live Futures, T1–T11, S1–S8 and locked files untouched.
- Live access was read-only: catalog/aggregate SQL, the public sign-in settings endpoint, the scheduler list
  (`live-service-checks.md`). Added in the repository: these documents, `evidence/`, and one test file
  (`src/test/phase4h6-independent-probes.test.ts`).

## 2. Verdicts

| Item | Verdict | Key evidence |
|---|---|---|
| F4 promotion / paper-account ownership during in-flight calls | **PASS** (draft; hosted BLOCKED until applied) | REAL-PG 15/15 re-run; UPDATE paths probed; enum fully covered (LS19) |
| F13(a) refusals inside the six wrappers | **PASS** | assertions check row contents and no other writes |
| F13(a′) refusals outside the wrappers (data-API hook, privilege errors, timeouts) | **FAIL** | probes; 0055 line 221 and the same clause in each wrapper |
| F13(a″) cap hides later refusals silently | **FAIL** | probe; 0055 line 202 |
| F13(b) deletion/insertion/reordering/modification of checkpointed rows | **PASS** | pure + PGlite + REAL-PG; mutation Q9 |
| F13(c) database-owner rewrite detection | **PARTIAL** | only with an independent store, none exists; owner can disable triggers live (LS18) |
| F15 server actions, AI routes, table rows, Storage/Realtime/GraphQL | **PASS** | reviewed assertions; LS4, LS16 |
| F15 direct data requests to owner-rights functions | **PARTIAL** | needs 0056; hosted support partial (LS14), path format BLOCKED (LS15) |
| F15 password / email change | **FAIL** | no control anywhere; email confirmation off live (LS11) |
| L2 sign-out | **PARTIAL** | local PASS; hosted deletion BLOCKED (LS8) |
| L3 refresh | **PARTIAL** | local PASS; hosted BLOCKED (LS9) |
| L4 failed sign-out / L5 lost reply | **PARTIAL** | worker calls bounded at 600 s; token ≈ 1 h elsewhere (LS10, indicative) |
| L7 timeout / cancellation / timer failure / tick end / late reply | **PASS** | assertions reviewed; `fetch` receives the signal; mutations S1–S11 re-run |
| L7 root cause in locked file | **BLOCKED** (approval) | §5 |
| Scheduled-call limit | **PASS (measured)** 5,000 ms | LS21 |
| Timing fit of current values | **FAIL** | ≥ 13,000 ms needed vs 5,000 ms |
| Hosting background time | **BLOCKED** | LS22 |
| Migrations 0049–0056 | **NOT READY** (PARTIAL) | `migration-readiness.md` |
| Deployment architecture | **BLOCKED** (owner) | recommendation B (conditional), `worker-architecture-decision.md` |

Full detail: `security-verification-matrix.md`.

### Corrections to Phase 4H.5 claims
1. 4H.5 reported F13(a) **FIXED**. Only refusals that reach a wrapper body are recorded; refusals at the data-API
   boundary, privilege errors and timeouts are not, and the cap drops records silently. Corrected to **FAIL** for
   those cases.
2. 4H.5 §5 implied existing restrictive policies refuse the worker everywhere. Live: only 29 of 60 tables have one;
   the other 31 rely entirely on 0055's new guard (which 0055 does add to all 60).
3. 4H.5 called the scheduled-job limit unmeasured. Measured now: 5,000 ms, which makes the current limits unusable.
4. 4H.5 rated F15 PARTIAL; this review found the concrete consequence: a password change through the sign-in service
   gives lasting control of the worker identity.

## 3. Tests that do not prove what they appear to

- `phase4h5-migration-0056` models the data API (role switch + settings + hook call). It proves the hook's logic,
  **not** that the hosted data API calls it or what `request.path` contains.
- PGlite stand-ins for `auth.sessions`: prove 0055's logic, **not** that hosted sign-out deletes the row.
- The "recording is capped" test asserts the silent drop as intended behaviour (the gap itself).
- The 24-pair race test alone was insufficient (mutation P3 survived in 4H.5); the deterministic tests are the proof.

## 4. Remaining gaps and smallest safe change

| Gap | Exact location | Resolved by | Smallest safe change |
|---|---|---|---|
| F15.7 password/email change | sign-in service self-service (outside DB/API); `fpw_id_check` (0055 line 137) never compares credentials | **code (new draft) + owner setting** | 0057: store `fpw_credential_pin(worker)` at registration; refuse in `fpw_id_check` if it changed (sketch below). Owner: password re-authentication, email-change confirmation (OD-4) |
| F13.3 silent cap | `fpw_record_refusal` (0055 line 202) | code (new draft) | 0057: when the cap is reached, insert one `fn='records_dropped'` row per identity per window |
| F13.2 boundary refusals | 0056 hook raises → transaction aborted; privileges checked before function bodies | **cannot be fixed in the database** | Owner decision: rely on platform request logs (retention unverified) or accept |
| F13.6 independent store | no store, no key, admin+MFA needed to take a checkpoint | owner decision | §6 |
| 0056 path format / hook support | `fpw_api_pre_request` (0056) | live verification | Post-apply smoke test (OD-12); fails closed if wrong |
| L2/L3 hosted behaviour | GoTrue sign-out / refresh | live verification | OD-12 |
| Timing | `worker-auth-session.ts` line 180; identity binding line 65 (8,000 ms default) | owner values + measurement | OD-1 |
| L7 root cause | `futures-paper-worker-hosted.ts` `call()` lines 93–94 (locked) | approval | §5 |
| Real-export proof | no verifier past 0054 | tooling + fresh export | OD-10 |

Credential-pin sketch for 0057 (not drafted; live prerequisites verified: `postgres` can read `auth.users`, columns
`email`, `encrypted_password`, `email_change`, `phone`, `phone_change`, `banned_until`, `deleted_at` exist):
```sql
CREATE FUNCTION public.fpw_credential_pin(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', u.email, u.encrypted_password, coalesce(u.email_change,''), coalesce(u.phone,''),
         coalesce(u.phone_change,''), coalesce(u.banned_until::text,''), coalesce(u.deleted_at::text,'')), 'UTF8')), 'hex')
  FROM auth.users u WHERE u.id = p $$;
-- registration stores it; fpw_id_check: IF stored_pin IS DISTINCT FROM public.fpw_credential_pin(v_uid) THEN
--   RAISE EXCEPTION 'futures paper worker: sign-in details changed since registration (an admin must re-register)'; END IF;
```

## 5. Locked file — proposed diff (approval requested, NOT applied)

`src/lib/futures-paper-worker-hosted.ts`, function `call()`, lines 93–98 (SHA-256 pinned
`1cbca841…a09d824`):
```diff
-    const ctl = new AbortController(), t0 = o.clock.now(); let h: unknown;
-    const deadline = new Promise<{ timedOut: true }>((res) => { h = timers.setTimeout(() => { ctl.abort(); res({ timedOut: true }); }, timeoutMs); });
+    const ctl = new AbortController(), t0 = o.clock.now(); let h: unknown = null, fire = (_: { timedOut: true }) => {};
+    const deadline = new Promise<{ timedOut: true }>((res) => { fire = res; });
+    try { h = timers.setTimeout(() => { ctl.abort(); fire({ timedOut: true }); }, timeoutMs); }
+    catch { rec({ code: "RPC_TRANSIENT", accountId, fn, pgCode: null, latencyMs: 0 }); return { kind: "transient", pgCode: null, code: "RPC_TRANSIENT" }; }
     let out: Classified;
     try {
       const r = await Promise.race([o.rpc(fn, args, ctl.signal).then((reply) => ({ reply }), (thrown: unknown) => ({ thrown: thrown ?? "error" })), deadline]);
       out = classifyRpc(r);
-    } finally { timers.clearTimeout(h); }
+    } finally { try { timers.clearTimeout(h); } catch { /* */ } }
```
Requires re-pinning the file in `phase4g-isolation`/`phase4h5-isolation` and new tests. Not blocking: the session
module already bounds and cancels every request on the signed-in path (L7 PASS).

## 6. Checkpoint storage design (no store created, no key generated)

| Criterion | C1. Owner's offline copies | C2. Separate code repository | C3. Public timestamp anchoring (e.g. OpenTimestamps) |
|---|---|---|---|
| What is stored | checkpoint JSON files on your own device + a second personal location | checkpoint records appended as commits to a repository owned by a **different** account than this project's, protected branch, no force-push | only the hash of each checkpoint record, anchored in a public timestamp chain; files kept as in C1 |
| Independence from the database owner | High (nothing in Lovable or the database can reach it) | High if the repository and its account are not connected to this project (this project's own repository is written by the platform — **not** suitable) | Highest (public, append-only) |
| Key ownership and rotation | You hold the HMAC key (password manager); rotate with a new key id; old records verify with old key | Same key; repository history adds a second ordering proof | No key needed to prove *when*; HMAC still needed against a rewritten local store |
| Tamper detection | On verification; fails if any covered row changed or a record was altered (with key) | Same, plus commit history shows edits | Proves a record existed at a time; any later rewrite cannot be back-dated |
| Operational complexity | Low, manual | Medium (git account, protected branch) | Medium–high (extra tool, delayed confirmations) |
| Cost | Free | Free tier | Free |
| Recovery | Any surviving copy verifies; lose all copies → coverage restarts at the next checkpoint | Clone verifies; account loss → C1 copies | Proofs + C1 copies |

Recommendation: **C2 + C1**, sealed with an owner-held key; C3 optional later. Constraint found in this review: taking
a checkpoint requires an admin **with two-step verification** (`fpw_audit_checkpoint`, 0055 line 310), so it is a
manual owner task unless a separate design is approved (OD-8).

## 7. Verification runs (this phase)

| Run | Result |
|---|---|
| Phase 4H.5 manifest | 31 / 31 OK |
| REAL-PG Phase 4H.5 suite (throwaway PostgreSQL 17.11) | 15 / 15 passed |
| Deliberate-break re-run | 25 / 25 detected; session file and draft restored (hash-checked) |
| Independent probes (new) | 7 / 7 passed (each confirms a predicted gap or a held protection) |
| Full suite | 1,409 passed, 81 skipped, 0 failed (117 files passed, 13 skipped) |
| Type check | 0 errors |

## 8. Answer: what blocks safe activation of a controlled paper worker, and which need owner approval

**Blocked by failing or unverified technical facts:**
1. **Timing** — current limits need ≥ 13,000 ms. The measured scheduled-call limit is 5,000 ms. *Owner approval:*
   new S/T values (OD-1) and a measurement on a test route.
2. **Worker password/email can be changed** through the sign-in service (F15 FAIL). *Owner approval:* the 0057
   credential-pin draft (OD-3) and the sign-in settings (OD-4).
3. **Refusal records can be silently dropped** after the cap (F13 FAIL). *Owner approval:* 0057 marker (OD-5).
   Boundary refusals can't be recorded in the database at all. *Owner approval:* accept this, or rely on platform
   logs (OD-5).
4. **No independent checkpoint store or key**, and a checkpoint needs an admin with two-step verification (F13
   PARTIAL). *Owner approval:* OD-6, OD-7, OD-8.
5. **Hosted behaviour unverified:** sign-out deleting the session, refresh keeping the session id, the data API
   accepting the hook, the request path format, and background time. *Owner approval:* the post-apply test with a
   throwaway account (OD-12) and the test-route measurement (OD-1).
6. **Drafts 0049–0056 not applied**, and 0051–0056 never tried on real data. *Owner approval:* a fresh export
   (possible after ≈ 09:19 UTC today) and its restore test (OD-10), then applying the drafts (OD-11), and a rollback
   policy (OD-13).

**Blocked only on owner decisions:**
7. Deployment architecture (OD-2).
8. W1–W5 values (OD-9).
9. Paper risk values (OD-15).
10. Creating the worker account, enrolling it, setting the job secret, setting the flags and creating the schedule —
    each a separate approval (OD-17).

**Not blocking, but approval requested:** the locked-file L7 diff (OD-14), the Phase 4H.3 missing logs (OD-16) and
MR6 (OD-18).

**Every blocker above needs owner approval** before it can be closed. None can be resolved by code alone under the
current change control: the code fixes (0057, verifier extension) are small and ready to draft once approved.
