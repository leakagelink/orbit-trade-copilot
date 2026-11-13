-- Rollback for DRAFT 0054 (not applied). Run BEFORE the rollback of 0053, in ONE transaction (psql --single-transaction).
-- Restores the seven 0053 function bodies byte-for-byte (CREATE OR REPLACE keeps their grants; nothing is granted to
-- PUBLIC, anon or service_role), then drops the 0054 helper, guard view and identity history. Export
-- futures_paper_worker_identity_changes first: dropping it deletes the identity history. No CASCADE is used.
-- WARNING: after this rollback the 0053 lifecycle defects return (disable blocked for a promoted worker; status checked
-- only at registration). Disable or revoke every worker identity before running it.
CREATE OR REPLACE FUNCTION public.fpw_admin_set_identity(p_worker uuid, p_label text, p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker identity: admin only'; END IF;
  IF p_worker IS NULL OR p_enabled IS NULL OR p_label IS NULL OR p_label !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'futures paper worker identity: worker, label (a-z, 0-9, -; 3..40) and enabled are required'; END IF;
  IF p_worker = v_uid OR public.has_role(p_worker, 'admin') OR public.has_role(p_worker, 'super_admin')
     OR EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = p_worker) THEN
    RAISE EXCEPTION 'futures paper worker identity: the worker must be a separate plain user (not an admin, not a paper account owner)';
  END IF;
  INSERT INTO public.futures_paper_worker_identities AS w (worker_user_id, label, enabled, created_by, updated_by)
  VALUES (p_worker, p_label, p_enabled, v_uid, v_uid)
  ON CONFLICT (worker_user_id) DO UPDATE SET label = EXCLUDED.label, enabled = EXCLUDED.enabled, updated_by = v_uid, updated_at = now();
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_owner_enroll(p_account uuid, p_worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_owner uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.futures_paper_accounts WHERE id = p_account;
  IF v_uid IS NULL OR v_owner IS DISTINCT FROM v_uid OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker: only the account owner can enroll a worker'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = p_worker AND enabled) THEN RAISE EXCEPTION 'futures paper worker: not a registered, enabled worker identity'; END IF;
  INSERT INTO public.futures_paper_worker_enrollments AS e (account_id, worker_user_id, user_id) VALUES (p_account, p_worker, v_owner)
  ON CONFLICT (account_id, worker_user_id) DO UPDATE SET enrolled_at = now(), revoked_at = NULL;
  INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) VALUES (p_account, v_owner, 'ID:ENROLLED', 'owner');
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_authorize(p_account uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_owner uuid;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled) THEN
    RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity';
  END IF;
  SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
    JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
   WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: account not enrolled for this worker identity'; END IF;
  RETURN v_owner;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_acquire_lease(p_account uuid, p_holder uuid, p_ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_owner uuid := public.fpw_id_authorize(p_account); f bigint;
BEGIN
  f := public.fpw_acquire_lease(p_account, p_holder, p_ttl_seconds);
  IF f IS NOT NULL THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_ACQUIRED', left('worker:' || auth.uid()::text, 64), p_holder, f);
  END IF;
  RETURN f;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_release_lease(p_account uuid, p_holder uuid, p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_owner uuid := public.fpw_id_authorize(p_account); ok boolean;
BEGIN
  ok := public.fpw_release_lease(p_account, p_holder, p_fence);
  IF ok THEN INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_RELEASED', left('worker:' || auth.uid()::text, 64), p_holder, p_fence); END IF;
  RETURN ok;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_owner uuid := public.fpw_id_authorize(p_account); v_seq bigint; v_replay boolean;
BEGIN
  v_replay := EXISTS (SELECT 1 FROM public.futures_paper_commits WHERE account_id = p_account AND bar_t = p_bar_t);
  v_seq := public.fpw_commit(p_account, p_holder, p_fence, p_expected_seq, p_bar_t, p_payload, p_provenance);
  IF NOT v_replay THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:COMMIT', left('worker:' || auth.uid()::text, 64), p_holder, p_fence);
  END IF;
  RETURN v_seq;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_mark_review(p_account uuid, p_holder uuid, p_fence bigint, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.fpw_id_authorize(p_account);
  RETURN public.fpw_mark_review(p_account, p_holder, p_fence, p_code);  -- 0050 writes the REVIEW audit row
END $$;
DROP VIEW public.futures_paper_0054_requires_0053;
DROP FUNCTION public.fpw_id_check(uuid, boolean);
DROP TABLE public.futures_paper_worker_identity_changes;
