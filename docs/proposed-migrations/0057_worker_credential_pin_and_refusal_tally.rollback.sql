-- Rollback for DRAFT 0057 (not applied). Run BEFORE the rollback of 0056. ONE statement (a single DO block).
-- Restores byte-for-byte the 0055 bodies of fpw_admin_set_identity, fpw_id_check and fpw_record_refusal; drops the 0057
-- functions; the tally guard is renamed (it still guards the retired tally). History is NOT deleted: the three tables are
-- renamed to *_0057_retired (with their indexes and sequence, so 0057 can be re-applied), keep their append-only
-- triggers and stay unreadable by the API roles. No CASCADE is used. NOTE: like 0055's retired refusal table, the
-- retired tables' triggers use futures_paper_history_immutable() from 0049, so 0049 cannot be rolled back while any
-- retired history exists (docs/phase-4h7/migration-restore-report.md, recovery procedure).
-- WARNING: afterwards a worker whose password or email changed keeps worker authority again (F15.7 open) and refusals
-- above the cap are dropped silently again (F13.3 open). Disable every worker identity before running it.
DO $rb$
BEGIN
  IF to_regclass('public.futures_paper_worker_credential_pins') IS NULL OR to_regprocedure('public.fpw_0057_requires_0056()') IS NULL THEN
    RAISE EXCEPTION 'draft 0057 is not applied';
  END IF;
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

  CREATE OR REPLACE FUNCTION public.fpw_record_refusal(p_fn text, p_account uuid, p_state text, p_msg text) RETURNS void
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

  DROP FUNCTION public.fpw_0057_requires_0056();
  DROP FUNCTION public.fpw_audit_refusal_completeness();
  DROP FUNCTION public.fpw_credential_pin(uuid);
  -- Index and sequence names are schema-wide: renamed too, so 0057 can be re-applied after this history is reviewed.
  ALTER INDEX public.futures_paper_worker_credential_pins_pkey RENAME TO fpw_cred_pins_0057_retired_pkey;
  ALTER INDEX public.futures_paper_worker_credential_events_pkey RENAME TO fpw_cred_events_0057_retired_pkey;
  ALTER INDEX public.futures_paper_worker_credential_events_worker RENAME TO fpw_cred_events_0057_retired_worker;
  ALTER SEQUENCE public.futures_paper_worker_credential_events_id_seq RENAME TO fpw_cred_events_0057_retired_id_seq;
  ALTER INDEX public.futures_paper_worker_refusal_tally_pkey RENAME TO fpw_refusal_tally_0057_retired_pkey;
  ALTER FUNCTION public.fpw_refusal_tally_guard() RENAME TO fpw_refusal_tally_guard_0057_retired;  -- still guards the retired tally
  ALTER TABLE public.futures_paper_worker_credential_pins RENAME TO futures_paper_worker_credential_pins_0057_retired;
  ALTER TABLE public.futures_paper_worker_credential_events RENAME TO futures_paper_worker_credential_events_0057_retired;
  ALTER TABLE public.futures_paper_worker_refusal_tally RENAME TO futures_paper_worker_refusal_tally_0057_retired;
END
$rb$;
