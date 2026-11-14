-- Rollback for DRAFT 0055 (not applied). Run BEFORE the rollback of 0054 and AFTER the rollback of 0056 (if 0056 was
-- applied). The whole file is ONE statement (a single DO block): it applies all-or-nothing whatever the runner does.
-- Restores byte-for-byte: public.account_mfa_allowed() (applied migration 0011), fpw_admin_set_identity and fpw_id_check
-- (draft 0054); removes the 0055 triggers, restrictive guard policies, envelope wrappers, checkpoint and helper
-- functions; re-opens the six 0053/0054 wrappers to authenticated (their 0054 state).
-- History is NOT deleted: the refusal table is renamed to futures_paper_worker_refusals_0055_retired, keeps its
-- append-only triggers and stays unreadable by the API roles. No CASCADE is used.
-- WARNING: after this rollback F4, F13(a), F15 and L2–L5 are open again (docs/phase-4h4). Disable every worker
-- identity before running it.
DO $rb$
DECLARE t record;
BEGIN
  IF to_regprocedure('public.fpw_api_pre_request()') IS NOT NULL THEN RAISE EXCEPTION 'roll back draft 0056 before 0055'; END IF;
  IF to_regclass('public.futures_paper_0055_requires_0054') IS NULL OR to_regclass('public.futures_paper_worker_refusals') IS NULL THEN
    RAISE EXCEPTION 'draft 0055 is not applied';
  END IF;
  -- F15
  CREATE OR REPLACE FUNCTION public.account_mfa_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspace_sessions WHERE id::text=auth.jwt()->>'session_id' AND user_id=auth.uid() AND revoked_at IS NOT NULL) AND (coalesce(auth.jwt()->>'aal','aal1')='aal2' OR NOT EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id=auth.uid() AND status='verified')); $$;
  FOR t IN SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND p.polname = 'fpw_worker_identity_guard' ORDER BY c.relname LOOP
    EXECUTE format('DROP POLICY fpw_worker_identity_guard ON public.%I', t.relname);
  END LOOP;
  -- F4
  DROP TRIGGER fpw_worker_role_guard ON public.user_roles;
  DROP TRIGGER fpw_worker_account_guard ON public.futures_paper_accounts;
  DROP FUNCTION public.fpw_guard_worker_role();
  DROP FUNCTION public.fpw_guard_worker_account();
  CREATE OR REPLACE FUNCTION public.fpw_admin_set_identity(p_worker uuid, p_label text, p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_uid uuid := auth.uid(); w public.futures_paper_worker_identities%ROWTYPE; v_found boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker identity: admin only'; END IF;
  IF p_worker IS NULL OR p_enabled IS NULL THEN RAISE EXCEPTION 'futures paper worker identity: worker and enabled are required'; END IF;
  SELECT * INTO w FROM public.futures_paper_worker_identities WHERE worker_user_id = p_worker FOR UPDATE;
  v_found := FOUND;
  IF NOT p_enabled THEN
    -- Disabling never depends on what the worker has become since registration (admin, super_admin, account owner).
    IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker identity: not a registered worker identity'; END IF;
    IF p_label IS NOT NULL AND p_label IS DISTINCT FROM w.label THEN RAISE EXCEPTION 'futures paper worker identity: disabling keeps the label (pass NULL or the current label)'; END IF;
    IF w.enabled THEN
      UPDATE public.futures_paper_worker_identities SET enabled = false, updated_by = v_uid, updated_at = now() WHERE worker_user_id = p_worker;
      INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor) VALUES (p_worker, true, false, w.label, w.label, v_uid);
    END IF;
    RETURN true;
  END IF;
  -- Registering or (re-)enabling: the worker must be a separate plain user NOW.
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
END $$;
  CREATE OR REPLACE FUNCTION public.fpw_id_check(p_account uuid, p_lock boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_uid uuid := auth.uid(); v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
  IF p_lock THEN PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled FOR SHARE;
  ELSE PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
  IF public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it has an admin role)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it owns a paper account)';
  END IF;
  IF p_lock THEN
    SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
      JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
     WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL FOR SHARE OF e;
  ELSE
    SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
      JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
     WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: account not enrolled for this worker identity'; END IF;
  RETURN v_owner;
END $$;
  -- the six 0053/0054 wrappers become the API path again
  GRANT EXECUTE ON FUNCTION public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_snapshot(uuid, uuid, bigint),
    public.fpw_id_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
    public.fpw_id_mark_review(uuid, uuid, bigint, text) TO authenticated;
  DROP FUNCTION public.fpw_id2_acquire_lease(uuid, uuid, integer);
  DROP FUNCTION public.fpw_id2_release_lease(uuid, uuid, bigint);
  DROP FUNCTION public.fpw_id2_snapshot(uuid, uuid, bigint);
  DROP FUNCTION public.fpw_id2_evaluated(uuid, uuid, bigint, uuid, text[]);
  DROP FUNCTION public.fpw_id2_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb);
  DROP FUNCTION public.fpw_id2_mark_review(uuid, uuid, bigint, text);
  DROP FUNCTION public.fpw_record_refusal(text, uuid, text, text);
  DROP FUNCTION public.fpw_audit_checkpoint(text, bigint, text, integer);
  DROP FUNCTION public.fpw_cp_field(text);
  DROP FUNCTION public.fpw_cp_us(timestamptz);
  DROP FUNCTION public.fpw_caller_is_worker();
  DROP FUNCTION public.fpw_refusal_record_cap();
  DROP FUNCTION public.fpw_worker_session_max_age();
  DROP FUNCTION public.fpw_identity_lock_key(uuid);
  -- F13: keep the refusal history (renamed, still append-only, still closed to the API roles)
  DROP VIEW public.futures_paper_0055_requires_0054;
  ALTER TABLE public.futures_paper_worker_refusals RENAME TO futures_paper_worker_refusals_0055_retired;
  REVOKE ALL ON public.futures_paper_worker_refusals_0055_retired FROM PUBLIC, anon, authenticated, service_role;
  COMMENT ON TABLE public.futures_paper_worker_refusals_0055_retired IS 'RETIRED by the 0055 rollback: refusal history kept, no longer written';
END
$rb$;
