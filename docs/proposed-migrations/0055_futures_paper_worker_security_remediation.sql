-- =====================================================================================================================
-- 0055 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval, after the hosted
-- migration history has been read (this repository's applied history ends at drizzle 0039; drafts 0040–0054 are
-- unapplied). Successor of draft 0054 (and through it 0049–0053). Apply order: 0049 → … → 0054 → 0055 (→ 0056).
-- Rollback order: (0056 →) 0055 → 0054 → … → 0049. 0049–0054 are left byte-identical.
-- Phase 4H.5 security remediation of the findings in docs/phase-4h4/phase4h4-final-report.md:
--
--  F4  In-flight privilege changes. A registered worker identity (enabled or not) can never receive the admin or
--      super_admin role (trigger on user_roles) and can never own a Futures paper account (trigger on
--      futures_paper_accounts). Registration, promotion and account creation for one user serialize on one
--      transaction-level advisory lock, which every worker call also holds in SHARED mode for its whole transaction,
--      so a change can neither interleave with registration nor commit while a worker call is running. Every worker
--      call (reads included, through the new wrappers below) also locks its identity, enrollment and account rows FOR
--      SHARE: a disable, revoke or label change waits for an in-flight call and every later call is refused.
--      (Account ownership was already immutable: 0049 guard_futures_paper_account.)
--  F13 Audit integrity. (a) Refused worker calls are recorded: six new envelope wrappers fpw_id2_* run the 0054
--      wrapper inside a sub-transaction; a refusal (SQLSTATE class P0/22/23) rolls back only that sub-transaction, is
--      written to the append-only futures_paper_worker_refusals table (registered identities only, capped per
--      identity) and is returned as {"ok":false,"sqlstate","message"} — the transaction commits, so the record
--      survives. (b) fpw_audit_checkpoint (admin + MFA) returns a rolling SHA-256 head, row count, covered id range
--      and trigger states of each audit table, to be stored OUTSIDE this database (src/lib/audit-checkpoint.ts and
--      scripts/audit-checkpoint/). Deleting, inserting, modifying or reordering any covered row — the newest
--      included — or rewriting the 0052 hash chain then no longer matches a stored checkpoint. This is DETECTION
--      against owner-level actors, not prevention; rows written after the latest stored checkpoint are not covered.
--  F15 Worker-only identity. public.account_mfa_allowed() (applied migration 0011; body verified byte-for-byte
--      before it is replaced) also returns false for a registered worker identity, so every row-level policy and
--      server-side check that already uses it — the shared server-function security middleware and the AI route
--      verification included — refuses the worker. A restrictive policy fpw_worker_identity_guard is added to every
--      public table with row-level security, so tables whose policies do not call account_mfa_allowed() refuse it too.
--      Direct calls of other database functions are closed by draft 0056 (API request boundary).
--  L2–L5 Live, young session. fpw_id_check additionally requires the token's session_id claim to name a current auth
--      session of the caller (a signed-out session no longer exists), unexpired by its own not_after, created at most
--      public.fpw_worker_session_max_age() ago (proposal: 600 s, NOT APPROVED), and a token exp in the future.
--      Project-wide auth settings are NOT changed; ordinary users are unaffected.
-- The whole file is ONE statement (a single DO block), so it applies all-or-nothing even if the runner does not wrap
-- it in a transaction. It creates no user, credential, schedule or route and changes no 0049–0054 grant except closing
-- the 0053/0054 wrappers to the API in favour of fpw_id2_*. It reads auth.sessions and auth.mfa_factors read-only
-- (hosted readability from a definer function NOT VERIFIED; the migration refuses if they are missing).
-- =====================================================================================================================
DO $mig$
BEGIN
  -- ---------- preconditions (fail closed) ----------
  IF to_regprocedure('public.fpw_id_check(uuid,boolean)') IS NULL OR to_regclass('public.futures_paper_0054_requires_0053') IS NULL
     OR to_regclass('public.futures_paper_worker_identity_changes') IS NULL THEN
    RAISE EXCEPTION '0055 requires draft 0054 (and through it drafts 0049–0053)';
  END IF;
  IF to_regclass('public.user_roles') IS NULL OR to_regprocedure('public.has_role(uuid,app_role)') IS NULL
     OR to_regclass('public.workspace_sessions') IS NULL OR to_regclass('auth.sessions') IS NULL OR to_regclass('auth.mfa_factors') IS NULL
     OR to_regprocedure('auth.jwt()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '0055 requires user_roles/has_role, workspace_sessions, auth.sessions, auth.mfa_factors, auth.jwt() and auth.uid()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.account_mfa_allowed()') AND prosecdef AND provolatile = 's'
       AND proconfig = ARRAY['search_path=public']
       AND prosrc = $b$ SELECT auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspace_sessions WHERE id::text=auth.jwt()->>'session_id' AND user_id=auth.uid() AND revoked_at IS NOT NULL) AND (coalesce(auth.jwt()->>'aal','aal1')='aal2' OR NOT EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id=auth.uid() AND status='verified')); $b$) THEN
    RAISE EXCEPTION '0055 refuses: public.account_mfa_allowed() differs from the reviewed applied migration 0011 (review the hosted body first)';
  END IF;
  IF to_regclass('public.futures_paper_worker_refusals') IS NOT NULL OR to_regclass('public.futures_paper_worker_refusals_0055_retired') IS NOT NULL THEN
    RAISE EXCEPTION '0055 refuses: a refusal table from an earlier 0055 application exists (review it first)';
  END IF;

  -- ---------- helpers ----------
  CREATE FUNCTION public.fpw_identity_lock_key(p_user uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT hashtextextended('fpw-identity:' || p_user::text, 0) $f$;
  -- Engineering proposals, NOT APPROVED policy values (register W1 and W2 in docs/phase-4h5/phase4h5-final-report.md).
  CREATE FUNCTION public.fpw_worker_session_max_age() RETURNS interval
  LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT interval '600 seconds' $f$;
  CREATE FUNCTION public.fpw_refusal_record_cap() RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT 120 $f$;
  -- True only for the signed-in caller itself (never reveals whether another user is a worker identity).
  CREATE FUNCTION public.fpw_caller_is_worker() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
    SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = auth.uid())
  $f$;

  -- ---------- F4: no elevated role, no paper account for a registered worker identity ----------
  CREATE FUNCTION public.fpw_guard_worker_role() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  BEGIN
    IF NEW.role::text IN ('admin', 'super_admin') THEN
      -- Waits for registration and for every in-flight worker call of this user, then decides on committed state.
      PERFORM pg_advisory_xact_lock(public.fpw_identity_lock_key(NEW.user_id));
      IF EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'futures paper worker identity: a registered worker identity cannot receive the % role (use a different account)', NEW.role
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END $f$;
  CREATE TRIGGER fpw_worker_role_guard BEFORE INSERT OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.fpw_guard_worker_role();

  CREATE FUNCTION public.fpw_guard_worker_account() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  BEGIN
    PERFORM pg_advisory_xact_lock(public.fpw_identity_lock_key(NEW.user_id));
    IF EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'futures paper worker identity: a registered worker identity cannot own a Futures paper account' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $f$;
  CREATE TRIGGER fpw_worker_account_guard BEFORE INSERT ON public.futures_paper_accounts FOR EACH ROW EXECUTE FUNCTION public.fpw_guard_worker_account();

  -- Registry (0054 body + the same advisory lock before any eligibility read).
  CREATE OR REPLACE FUNCTION public.fpw_admin_set_identity(p_worker uuid, p_label text, p_enabled boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); w public.futures_paper_worker_identities%ROWTYPE; v_found boolean;
  BEGIN
    IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker identity: admin only'; END IF;
    IF p_worker IS NULL OR p_enabled IS NULL THEN RAISE EXCEPTION 'futures paper worker identity: worker and enabled are required'; END IF;
    PERFORM pg_advisory_xact_lock(public.fpw_identity_lock_key(p_worker));  -- 0055: serializes with promotion, account creation and worker calls
    SELECT * INTO w FROM public.futures_paper_worker_identities WHERE worker_user_id = p_worker FOR UPDATE;
    v_found := FOUND;
    IF NOT p_enabled THEN
      IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker identity: not a registered worker identity'; END IF;
      IF p_label IS NOT NULL AND p_label IS DISTINCT FROM w.label THEN RAISE EXCEPTION 'futures paper worker identity: disabling keeps the label (pass NULL or the current label)'; END IF;
      IF w.enabled THEN
        UPDATE public.futures_paper_worker_identities SET enabled = false, updated_by = v_uid, updated_at = now() WHERE worker_user_id = p_worker;
        INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor) VALUES (p_worker, true, false, w.label, w.label, v_uid);
      END IF;
      RETURN true;
    END IF;
    IF p_label IS NULL OR p_label !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'futures paper worker identity: worker, label (a-z, 0-9, -; 3..40) and enabled are required'; END IF;
    IF p_worker = v_uid OR public.has_role(p_worker, 'admin') OR public.has_role(p_worker, 'super_admin')
       OR EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = p_worker) THEN
      RAISE EXCEPTION 'futures paper worker identity: the worker must be a separate plain user (not an admin, not a paper account owner)';
    END IF;
    INSERT INTO public.futures_paper_worker_identities AS x (worker_user_id, label, enabled, created_by, updated_by)
    VALUES (p_worker, p_label, true, v_uid, v_uid)
    ON CONFLICT (worker_user_id) DO UPDATE SET label = EXCLUDED.label, enabled = true, updated_by = v_uid, updated_at = now();
    IF NOT v_found OR NOT w.enabled OR w.label IS DISTINCT FROM p_label THEN
      INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor)
      VALUES (p_worker, CASE WHEN v_found THEN w.enabled END, true, CASE WHEN v_found THEN w.label END, p_label, v_uid);
    END IF;
    RETURN true;
  END $f$;

  -- ---------- F4 + L2–L5: the current-status check used by every worker call ----------
  CREATE OR REPLACE FUNCTION public.fpw_id_check(p_account uuid, p_lock boolean) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); v_owner uuid; v_claims jsonb; v_sid text; v_exp numeric; v_created timestamptz; v_not_after timestamptz; v_found boolean;
  BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
    -- 0055 F4: held for the whole transaction; promotion, account creation and registration of this user wait for it.
    IF p_lock THEN PERFORM pg_advisory_xact_lock_shared(public.fpw_identity_lock_key(v_uid)); END IF;
    IF p_lock THEN PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled FOR SHARE;
    ELSE PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled; END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
    -- 0055 L2–L5: the token must belong to a live, young auth session of this caller (signed-out sessions no longer exist).
    BEGIN v_claims := auth.jwt(); EXCEPTION WHEN others THEN v_claims := NULL; END;
    v_sid := v_claims->>'session_id';
    IF v_sid IS NULL OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'futures paper worker: worker session is not active (no session id)';
    END IF;
    BEGIN v_exp := (v_claims->>'exp')::numeric; EXCEPTION WHEN others THEN v_exp := NULL; END;
    IF v_exp IS NULL OR v_exp <= extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (token expired)'; END IF;
    SELECT s.created_at, s.not_after INTO v_created, v_not_after FROM auth.sessions s WHERE s.id = v_sid::uuid AND s.user_id = v_uid;
    v_found := FOUND;
    IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (signed out or unknown)'; END IF;
    IF v_not_after IS NOT NULL AND v_not_after <= clock_timestamp() THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (session expired)'; END IF;
    IF v_created IS NULL OR v_created < clock_timestamp() - public.fpw_worker_session_max_age() THEN
      RAISE EXCEPTION 'futures paper worker: worker session is not active (older than the worker maximum session age)';
    END IF;
    IF public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'super_admin') THEN
      RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it has an admin role)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = v_uid) THEN
      RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it owns a paper account)';
    END IF;
    IF p_lock THEN
      SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
        JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
       WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL FOR SHARE OF a, e;
    ELSE
      SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
        JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
       WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: account not enrolled for this worker identity'; END IF;
    RETURN v_owner;
  END $f$;

  -- ---------- F13 (a): refused calls are recorded ----------
  CREATE TABLE public.futures_paper_worker_refusals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_user_id uuid NOT NULL,
    account_id uuid,
    fn text NOT NULL CHECK (fn IN ('acquire_lease', 'release_lease', 'snapshot', 'evaluated', 'commit', 'mark_review')),
    sqlstate text NOT NULL CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
    reason text NOT NULL CHECK (length(reason) <= 200),
    session_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX futures_paper_worker_refusals_worker ON public.futures_paper_worker_refusals (worker_user_id, created_at DESC);
  CREATE TRIGGER futures_paper_worker_refusals_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_worker_refusals FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
  CREATE TRIGGER futures_paper_worker_refusals_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_refusals FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

  CREATE FUNCTION public.fpw_record_refusal(p_fn text, p_account uuid, p_state text, p_msg text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); v_sid uuid;
  BEGIN
    -- Only registered identities are recorded (anyone else could otherwise fill the table); bounded per identity.
    IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid) THEN RETURN; END IF;
    IF (SELECT count(*) FROM public.futures_paper_worker_refusals WHERE worker_user_id = v_uid AND created_at > clock_timestamp() - interval '10 minutes') >= public.fpw_refusal_record_cap() THEN RETURN; END IF;
    BEGIN v_sid := nullif(auth.jwt()->>'session_id', '')::uuid; EXCEPTION WHEN others THEN v_sid := NULL; END;
    INSERT INTO public.futures_paper_worker_refusals (worker_user_id, account_id, fn, sqlstate, reason, session_id)
    VALUES (v_uid, p_account, p_fn, CASE WHEN p_state ~ '^[0-9A-Z]{5}$' THEN p_state ELSE 'XX000' END,
            left(regexp_replace(coalesce(p_msg, ''), '[^ -~]', '?', 'g'), 200), v_sid);
  END $f$;

  -- Six envelope wrappers. Each takes the 0055 locks first (reads included), runs the 0054 wrapper in a
  -- sub-transaction and returns {"ok":true,"data":…} or {"ok":false,"sqlstate":…,"message":…}. Only refusal classes
  -- are caught (raise_exception, data_exception, integrity_constraint_violation): serialization failures, lock and
  -- statement timeouts, missing objects and connection errors still abort the transaction as before.
  CREATE FUNCTION public.fpw_id2_acquire_lease(p_account uuid, p_holder uuid, p_ttl_seconds integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := to_jsonb(public.fpw_id_acquire_lease(p_account, p_holder, p_ttl_seconds));
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('acquire_lease', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;
  CREATE FUNCTION public.fpw_id2_release_lease(p_account uuid, p_holder uuid, p_fence bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := to_jsonb(public.fpw_id_release_lease(p_account, p_holder, p_fence));
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('release_lease', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;
  CREATE FUNCTION public.fpw_id2_snapshot(p_account uuid, p_holder uuid, p_fence bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := public.fpw_id_snapshot(p_account, p_holder, p_fence);
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('snapshot', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;
  CREATE FUNCTION public.fpw_id2_evaluated(p_account uuid, p_holder uuid, p_fence bigint, p_user uuid, p_ids text[]) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := to_jsonb(public.fpw_id_evaluated(p_account, p_holder, p_fence, p_user, p_ids));
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('evaluated', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;
  CREATE FUNCTION public.fpw_id2_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := to_jsonb(public.fpw_id_commit(p_account, p_holder, p_fence, p_expected_seq, p_bar_t, p_payload, p_provenance));
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('commit', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;
  CREATE FUNCTION public.fpw_id2_mark_review(p_account uuid, p_holder uuid, p_fence bigint, p_code text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v jsonb; v_state text; v_msg text;
  BEGIN
    BEGIN
      PERFORM public.fpw_id_check(p_account, true);
      v := to_jsonb(public.fpw_id_mark_review(p_account, p_holder, p_fence, p_code));
      RETURN jsonb_build_object('ok', true, 'data', v);
    EXCEPTION WHEN raise_exception OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    PERFORM public.fpw_record_refusal('mark_review', p_account, v_state, v_msg);
    RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
  END $f$;

  -- ---------- F13 (b): checkpoints for storage outside this database ----------
  -- Canonical row = every column as hex(UTF-8 text) or '~' for NULL, joined by '|'; timestamps as integer
  -- microseconds since the epoch. Head = sha256(prev_head || '|' || row) over rows in id order, starting from
  -- sha256('fpw-audit-v1|' || table). src/lib/audit-checkpoint.ts implements the same encoding independently.
  CREATE FUNCTION public.fpw_cp_field(p text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT coalesce(encode(convert_to(p, 'UTF8'), 'hex'), '~') $f$;
  CREATE FUNCTION public.fpw_cp_us(p timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT floor(extract(epoch FROM p) * 1000000)::bigint::text $f$;
  CREATE FUNCTION public.fpw_audit_checkpoint(p_table text, p_after_id bigint, p_prev_head text, p_settle_seconds integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_h text; v_n bigint := 0; v_to bigint := p_after_id; v_max bigint; r record; v_cut timestamptz; v_rel regclass; v_tg jsonb;
  BEGIN
    IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper audit checkpoint: admin only'; END IF;
    IF p_after_id IS NULL OR p_after_id < 0 OR p_settle_seconds IS NULL OR p_settle_seconds < 0 OR p_settle_seconds > 3600 THEN
      RAISE EXCEPTION 'futures paper audit checkpoint: after_id >= 0 and settle seconds 0..3600 are required';
    END IF;
    IF (p_after_id = 0) <> (p_prev_head IS NULL) OR (p_prev_head IS NOT NULL AND p_prev_head !~ '^[0-9a-f]{64}$') THEN
      RAISE EXCEPTION 'futures paper audit checkpoint: the first checkpoint starts at id 0 without a previous head; later ones continue from the stored previous head';
    END IF;
    v_h := coalesce(p_prev_head, encode(sha256(convert_to('fpw-audit-v1|' || p_table, 'UTF8')), 'hex'));
    -- Rows younger than the settle margin are left for the next checkpoint (a transaction that drew a lower id may
    -- still be committing). Only false alarms, never missed tampering, can result from a too-small margin.
    v_cut := clock_timestamp() - make_interval(secs => p_settle_seconds);
    IF p_table = 'futures_paper_worker_audit' THEN
      v_rel := 'public.futures_paper_worker_audit'::regclass;
      SELECT max(id) INTO v_max FROM public.futures_paper_worker_audit WHERE created_at <= v_cut;
      FOR r IN SELECT id, concat_ws('|', public.fpw_cp_field(id::text), public.fpw_cp_field(account_id::text), public.fpw_cp_field(user_id::text), public.fpw_cp_field(code),
                 public.fpw_cp_field(actor), public.fpw_cp_field(holder::text), public.fpw_cp_field(fence::text), public.fpw_cp_field(public.fpw_cp_us(created_at))) AS c
                 FROM public.futures_paper_worker_audit WHERE id > p_after_id AND id <= coalesce(v_max, p_after_id) ORDER BY id LOOP
        v_h := encode(sha256(convert_to(v_h || '|' || r.c, 'UTF8')), 'hex'); v_n := v_n + 1; v_to := r.id;
      END LOOP;
    ELSIF p_table = 'futures_paper_config_changes' THEN
      v_rel := 'public.futures_paper_config_changes'::regclass;
      SELECT max(id) INTO v_max FROM public.futures_paper_config_changes WHERE changed_at <= v_cut;
      FOR r IN SELECT id, concat_ws('|', public.fpw_cp_field(id::text), public.fpw_cp_field(user_id::text), public.fpw_cp_field(entity), public.fpw_cp_field(entity_key),
                 public.fpw_cp_field(operation), public.fpw_cp_field(old_value::text), public.fpw_cp_field(new_value::text), public.fpw_cp_field(actor_role),
                 public.fpw_cp_field(actor_uid::text), public.fpw_cp_field(actor_label), public.fpw_cp_field(reason), public.fpw_cp_field(version::text),
                 public.fpw_cp_field(value_sha256), public.fpw_cp_field(prev_sha256), public.fpw_cp_field(chain_sha256), public.fpw_cp_field(public.fpw_cp_us(changed_at))) AS c
                 FROM public.futures_paper_config_changes WHERE id > p_after_id AND id <= coalesce(v_max, p_after_id) ORDER BY id LOOP
        v_h := encode(sha256(convert_to(v_h || '|' || r.c, 'UTF8')), 'hex'); v_n := v_n + 1; v_to := r.id;
      END LOOP;
    ELSIF p_table = 'futures_paper_worker_identity_changes' THEN
      v_rel := 'public.futures_paper_worker_identity_changes'::regclass;
      SELECT max(id) INTO v_max FROM public.futures_paper_worker_identity_changes WHERE created_at <= v_cut;
      FOR r IN SELECT id, concat_ws('|', public.fpw_cp_field(id::text), public.fpw_cp_field(worker_user_id::text), public.fpw_cp_field(old_enabled::text), public.fpw_cp_field(new_enabled::text),
                 public.fpw_cp_field(old_label), public.fpw_cp_field(new_label), public.fpw_cp_field(actor::text), public.fpw_cp_field(public.fpw_cp_us(created_at))) AS c
                 FROM public.futures_paper_worker_identity_changes WHERE id > p_after_id AND id <= coalesce(v_max, p_after_id) ORDER BY id LOOP
        v_h := encode(sha256(convert_to(v_h || '|' || r.c, 'UTF8')), 'hex'); v_n := v_n + 1; v_to := r.id;
      END LOOP;
    ELSIF p_table = 'futures_paper_worker_refusals' THEN
      v_rel := 'public.futures_paper_worker_refusals'::regclass;
      SELECT max(id) INTO v_max FROM public.futures_paper_worker_refusals WHERE created_at <= v_cut;
      FOR r IN SELECT id, concat_ws('|', public.fpw_cp_field(id::text), public.fpw_cp_field(worker_user_id::text), public.fpw_cp_field(account_id::text), public.fpw_cp_field(fn),
                 public.fpw_cp_field(sqlstate), public.fpw_cp_field(reason), public.fpw_cp_field(session_id::text), public.fpw_cp_field(public.fpw_cp_us(created_at))) AS c
                 FROM public.futures_paper_worker_refusals WHERE id > p_after_id AND id <= coalesce(v_max, p_after_id) ORDER BY id LOOP
        v_h := encode(sha256(convert_to(v_h || '|' || r.c, 'UTF8')), 'hex'); v_n := v_n + 1; v_to := r.id;
      END LOOP;
    ELSE
      RAISE EXCEPTION 'futures paper audit checkpoint: unknown audit table';
    END IF;
    SELECT coalesce(jsonb_object_agg(t.tgname, t.tgenabled::text), '{}'::jsonb) INTO v_tg FROM pg_trigger t WHERE t.tgrelid = v_rel AND NOT t.tgisinternal;
    RETURN jsonb_build_object('v', 1, 'table', p_table, 'after_id', p_after_id, 'to_id', v_to, 'count', v_n, 'head', v_h,
                              'triggers', v_tg, 'taken_at_us', public.fpw_cp_us(clock_timestamp()));
  END $f$;

  -- ---------- F15: worker identities get nothing from ordinary row-level access ----------
  -- Byte-for-byte the 0011 body plus one condition (checked first). Same language, volatility, definer and search_path.
  CREATE OR REPLACE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$ SELECT auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id=auth.uid()) AND NOT EXISTS(SELECT 1 FROM public.workspace_sessions WHERE id::text=auth.jwt()->>'session_id' AND user_id=auth.uid() AND revoked_at IS NOT NULL) AND (coalesce(auth.jwt()->>'aal','aal1')='aal2' OR NOT EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id=auth.uid() AND status='verified')); $f$;
  DECLARE t record;
  BEGIN
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity ORDER BY c.relname LOOP
      EXECUTE format('CREATE POLICY fpw_worker_identity_guard ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT NOT public.fpw_caller_is_worker())) WITH CHECK ((SELECT NOT public.fpw_caller_is_worker()))', t.relname);
    END LOOP;
  END;

  -- Rollback-order guard: 0054's rollback (DROP VIEW futures_paper_0054_requires_0053, no CASCADE) fails while 0055 exists.
  CREATE VIEW public.futures_paper_0055_requires_0054 AS
    SELECT g.id, r.id AS refusal_id FROM public.futures_paper_0054_requires_0053 g CROSS JOIN public.futures_paper_worker_refusals r WHERE false;

  -- ---------- privileges ----------
  REVOKE ALL ON public.futures_paper_0055_requires_0054, public.futures_paper_worker_refusals FROM PUBLIC, anon, authenticated, service_role;
  ALTER TABLE public.futures_paper_worker_refusals ENABLE ROW LEVEL SECURITY;
  -- No policy and no grant on refusals: written only by fpw_record_refusal, read by the database owner and checkpoints.
  -- (The guard loop above ran before this table enabled row-level security; it has no policy at all.)
  REVOKE ALL ON FUNCTION public.fpw_identity_lock_key(uuid), public.fpw_worker_session_max_age(), public.fpw_refusal_record_cap(),
    public.fpw_guard_worker_role(), public.fpw_guard_worker_account(), public.fpw_record_refusal(text, uuid, text, text),
    public.fpw_cp_field(text), public.fpw_cp_us(timestamptz), public.fpw_audit_checkpoint(text, bigint, text, integer),
    public.fpw_id2_acquire_lease(uuid, uuid, integer), public.fpw_id2_release_lease(uuid, uuid, bigint), public.fpw_id2_snapshot(uuid, uuid, bigint),
    public.fpw_id2_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id2_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
    public.fpw_id2_mark_review(uuid, uuid, bigint, text), public.fpw_caller_is_worker() FROM PUBLIC, anon, authenticated, service_role;
  -- Row-level policies call this as the querying role; 0056 calls it from the API request hook.
  GRANT EXECUTE ON FUNCTION public.fpw_caller_is_worker() TO anon, authenticated, service_role;
  -- The six worker operations: only the envelope wrappers are reachable through the API from now on.
  GRANT EXECUTE ON FUNCTION public.fpw_id2_acquire_lease(uuid, uuid, integer), public.fpw_id2_release_lease(uuid, uuid, bigint), public.fpw_id2_snapshot(uuid, uuid, bigint),
    public.fpw_id2_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id2_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
    public.fpw_id2_mark_review(uuid, uuid, bigint, text) TO authenticated;
  REVOKE EXECUTE ON FUNCTION public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_snapshot(uuid, uuid, bigint),
    public.fpw_id_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
    public.fpw_id_mark_review(uuid, uuid, bigint, text) FROM authenticated;
  -- Checkpoints: signed-in admin + MFA (checked inside).
  GRANT EXECUTE ON FUNCTION public.fpw_audit_checkpoint(text, bigint, text, integer) TO authenticated;
  -- fpw_id_check and fpw_admin_set_identity keep their 0054 privileges (CREATE OR REPLACE keeps grants);
  -- account_mfa_allowed keeps 0010's (authenticated, service_role).
END
$mig$;
