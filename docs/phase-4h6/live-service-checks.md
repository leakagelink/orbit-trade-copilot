# Phase 4H.6 — Live-service checks (read-only)

Date: 14 Nov 2026, 04:45–04:55 UTC. Every check below was a **read**: catalog/aggregate SQL through the platform's
read-only query tool, the public sign-in settings endpoint, and the scheduler's list call. Nothing was written,
configured, signed in, signed out, scheduled or created. No user data was copied into this repository (counts and
schema only). Where the service does not expose the evidence, the item is **BLOCKED** — local tests are never used as
a substitute.

| # | Check | Result | Exact evidence |
|---|---|---|---|
| LS1 | Applied migration history | **PASS** | `drizzle.__drizzle_migrations`: 40 rows; newest hash `9a6ae3af8c0cabe48609617e97dc616f529685c639d14cfd2b82ed81a4e48211` = SHA-256 of `drizzle/migrations/0039_futures_pass_certification_and_autopilot_fencing.sql`; newest `created_at` 1794466478200 = journal `when` of 0039 (12 Nov 2026 06:54:38 UTC). No `supabase_migrations` schema. → hosted history = 0000–0039 exactly |
| LS2 | Drafts 0049–0056 not applied | **PASS** | `to_regclass` of `futures_paper_accounts`, `futures_paper_worker_identities`, `futures_paper_worker_audit` = NULL; 0 functions named `fpw_*` |
| LS3 | Shared security check `account_mfa_allowed()` | **PASS** | SECURITY DEFINER, STABLE, `search_path=public`, owner `postgres`, EXECUTE: postgres, authenticated, service_role (not PUBLIC/anon); `md5(prosrc)` = `0d94eb78725ddba7343ff53692181127`, 321 chars = **byte-identical** to the body draft 0055 requires (same md5 and length computed from the draft) |
| LS4 | Row protection coverage | **PASS** | 60 public tables, all with RLS on; 0 views, 0 materialized views; 29 tables already have a restrictive policy, 31 have none (0055 would add its guard to all 60) |
| LS5 | Owner-rights functions a signed-in caller can run without the shared check | **Recorded** (F15 input) | admin_overview, admin_users (admin-gated inside), bump_strategy_clone, claim_referral, demo_leaderboard, has_elite_access, has_pro_access, has_role (also anon), is_support_operator, marketplace_strategies. A worker identity could call these after 0055 unless 0056 is active |
| LS6 | Sign-in session table shape and access | **PASS** | `auth.sessions` columns include `id uuid`, `user_id uuid`, `created_at timestamptz`, `not_after timestamptz`, `refreshed_at`, `refresh_token_counter`; `postgres` has SELECT on `auth.sessions`, `auth.mfa_factors`, `auth.refresh_tokens`; `authenticated` has none; `auth.refresh_tokens.session_id` → `auth.sessions(id) ON DELETE CASCADE` |
| LS7 | Session time-box | **Recorded** | 12 current sessions, `not_after` NULL on all 12 (no per-session expiry is being set) |
| LS8 | Sign-out deletes the session row immediately | **BLOCKED** | Needs a sign-in and sign-out of a test account (a write to the sign-in service, not allowed). Sign-in logs for the period returned **no rows**. Workspace-session records (15, none revoked; 4 no longer in `auth.sessions`) cannot separate sign-out from expiry. Schema (LS6 cascade) is consistent with deletion but does not prove it |
| LS9 | Refresh keeps the same session id | **BLOCKED** | Not observable without a refresh. Schema: every refresh token belongs to a session (0 tokens without `session_id`), consistent but not proof |
| LS10 | Access-token lifetime | **PARTIAL (indicative only)** | Gaps between consecutive refresh tokens of the same session: 52 gaps, minimum 3,483 s, p10 3,526 s, median 4,735 s → consistent with a ~3,600 s token; the setting itself is not readable |
| LS11 | Public sign-in settings | **Recorded** | `/auth/v1/settings` (public): only email sign-in enabled; `disable_signup=false` (open sign-up); **`mailer_autoconfirm=true`** (email confirmation off); phone autoconfirm off; SAML off. Not exposed: secure email change, secure password change (re-authentication), JWT expiry, session time-box/inactivity, sign-in hooks → **BLOCKED** |
| LS12 | Data API version | **PASS** | `pg_stat_activity.application_name` = `PostgREST 14.18` (10 connections as `authenticator`) |
| LS13 | Existing pre-request hook | **PASS** (none) | `authenticator` settings: `session_preload_libraries=supautils, safeupdate`, `statement_timeout=8s`, `lock_timeout=8s`; no `pgrst.db_pre_request` → 0056's "never replace a hook" precondition holds today |
| LS14 | Can the migration role set the hook (0056) | **PARTIAL** | `supautils.privileged_role_allowed_configs` includes `pgrst.*`; `postgres` is a member of `supabase_privileged_role` and of `authenticator`; `supautils.reserved_roles` lists `authenticator*` (configurable). Consistent with support; **not exercised** |
| LS15 | `request.path` format seen by the hook | **BLOCKED** | Requires a real request with a hook installed. The app's data URL is `/rest/v1/rpc/<fn>` (code); whether the hook sees `/rpc/<fn>` (as 0056 assumes) is unverified. If not, 0056 refuses the worker (fails closed, ordinary users unaffected; probe in `phase4h6-independent-probes.test.ts`) |
| LS16 | Other API surfaces | **PASS** | No `pg_graphql` extension (no GraphQL path); Realtime: 0 published tables, 0 policies; Storage: 2 **private** buckets (`database_export_12_11_26`, `database_export_13_11_26`, 1 object each), 0 storage policies, `storage.objects` RLS on → a signed-in caller (including a worker) reads nothing |
| LS17 | Timeouts | **Recorded** | role `authenticated` statement_timeout 8 s; `anon` 3 s; `authenticator` lock_timeout 8 s; database default statement_timeout 120 s; idle-in-transaction 900 s |
| LS18 | Database owner powers | **Recorded** (F13 input) | `postgres`: not superuser, **BYPASSRLS**, CREATEROLE; `session_replication_role` is in the privileged role's allowed settings → the owner role can disable every trigger, including append-only guards |
| LS19 | Elevated roles | **PASS** | `app_role` = {user, admin, super_admin}; 0055's guard covers both elevated values |
| LS20 | Scheduled jobs | **PASS** (no worker) | 3 active jobs, every minute: `paper-engine-tick` → `/api/public/engine/tick`, `trade-price-alerts` → `/api/public/alerts/tick`, `ai-autopilot-tick` → `/api/public/autopilot/tick`. No worker job |
| LS21 | Scheduled-call time limit | **PASS (measured, read-only)** | `net._http_response` since 13 Nov 22:50 UTC: 1,080 calls, 1,073 × HTTP 200, 0 other status, **7 timed out: "Timeout of 5000 ms reached"** (total 5.00–5.34 s). The scheduling tool has no timeout parameter. → the caller gives up at **5,000 ms** |
| LS22 | Hosting wall-time after the caller gives up | **BLOCKED** | Would need a deliberate long request on a test route (not allowed) |
| LS23 | Worker configuration | **PASS** (not configured) | No `FUTURES_PAPER_WORKER_*` or checkpoint variable in this environment; flags read only in `futures-paper-worker-*.server.ts`; no worker tables, functions or job (LS2, LS20). Cloud secret *names* were not listed (the listing tool can expose values; not used) |
| LS24 | Fresh database export | **BLOCKED** | Newest export object 13 Nov 2026 09:20:40 UTC (`database_export_13_11_26`); exports are limited to one per 24 h → next possible after ≈ 09:19 UTC on 14 Nov; owner action. No export file is available locally (the project's verifiers refuse bucket downloads by design) |

## Not checked (and why)

- Sign-in hooks, rate limits, password/email-change protections, JWT expiry: not readable through any read-only
  interface available here → BLOCKED (owner reads them in the backend's sign-in settings).
- Anything requiring a sign-in, a request through the hook, a test route or a test schedule → BLOCKED by this
  phase's restrictions.
