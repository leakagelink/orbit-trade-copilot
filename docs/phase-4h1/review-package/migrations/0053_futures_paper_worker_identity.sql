-- =====================================================================================================================
-- 0053 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Successor of drafts 0049–0052 (all NOT applied). Apply order: 0049 → 0050 → 0051 → 0052 → 0053.
-- Stage 2 of docs/phase-4h/hosted-service-role-review.md: a dedicated SIGNED-IN worker identity replaces the service
-- role for the Futures PAPER gateway. Nothing here creates a user, a credential, a schedule or a route.
--
--  * Registry. futures_paper_worker_identities lists the auth users that may act as the paper worker. Only a signed-in
--    platform admin (public.has_role(auth.uid(), 'admin'), read from the protected user_roles table) can register or
--    disable one, through fpw_admin_set_identity; an admin, a super_admin or a user who owns a paper account cannot be
--    registered (the worker identity must be a plain, otherwise empty account).
--  * Explicit per-account authorization. The account owner — signed in, MFA-aware — enrolls (or revokes) a registered
--    worker for one of their own paper accounts (fpw_owner_enroll / fpw_owner_revoke). A worker can reach only accounts
--    whose owner enrolled it; the owner is always derived from the account row.
--  * Six wrappers fpw_id_* (granted to authenticated only) check auth.uid() against the registry and the enrollment,
--    then call the 0050 gateway function of the same name. Each mutation leaves a bounded-code row in the 0050 worker
--    audit table (lease acquired/released, commit, review hold; refusals roll back with the call and are not stored).
--  * EXECUTE on the six 0050 gateway functions is REVOKED from service_role: after 0053 the paper ledger can be written
--    only by an enrolled worker identity. service_role keeps its 0049 configuration grants (audited by 0052).
-- What this does NOT do (see the security verdict in docs/phase-4h/phase4h-final-report.md): it does not take the
-- service key out of the server runtime the worker would run in, and an authenticated worker still has every right an
-- ordinary signed-in user has elsewhere in the app. It narrows the PAPER LEDGER path only.
-- =====================================================================================================================
DO $$ BEGIN
  IF to_regprocedure('public.futures_paper_commit_bar_v5(uuid,bigint,bigint,jsonb)') IS NULL OR to_regclass('public.futures_paper_config_changes') IS NULL
     OR to_regprocedure('public.has_role(uuid,app_role)') IS NULL OR to_regprocedure('public.account_mfa_allowed()') IS NULL THEN
    RAISE EXCEPTION '0053 requires drafts 0049–0052 and the app''s has_role/account_mfa_allowed functions';
  END IF;
END $$;

CREATE TABLE public.futures_paper_worker_identities (
  worker_user_id uuid PRIMARY KEY,
  label text NOT NULL CHECK (label ~ '^[a-z0-9-]{3,40}$'),
  enabled boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.futures_paper_worker_enrollments (
  account_id uuid NOT NULL REFERENCES public.futures_paper_accounts(id),
  worker_user_id uuid NOT NULL REFERENCES public.futures_paper_worker_identities(worker_user_id),
  user_id uuid NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, worker_user_id),
  CONSTRAINT futures_paper_worker_enrollment_times CHECK (revoked_at IS NULL OR revoked_at >= enrolled_at)
);
CREATE INDEX futures_paper_worker_enrollments_user ON public.futures_paper_worker_enrollments (user_id, account_id);
CREATE TRIGGER futures_paper_worker_identities_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_identities FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_worker_enrollments_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_enrollments FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- ---------- registry and enrollment (signed-in admin / account owner) ----------
CREATE FUNCTION public.fpw_admin_set_identity(p_worker uuid, p_label text, p_enabled boolean) RETURNS boolean
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

CREATE FUNCTION public.fpw_owner_enroll(p_account uuid, p_worker uuid) RETURNS boolean
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

CREATE FUNCTION public.fpw_owner_revoke(p_account uuid, p_worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_owner uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.futures_paper_accounts WHERE id = p_account;
  IF v_uid IS NULL OR v_owner IS DISTINCT FROM v_uid OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker: only the account owner can revoke a worker'; END IF;
  UPDATE public.futures_paper_worker_enrollments SET revoked_at = now() WHERE account_id = p_account AND worker_user_id = p_worker AND revoked_at IS NULL;
  IF FOUND THEN INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) VALUES (p_account, v_owner, 'ID:REVOKED', 'owner'); END IF;
  RETURN FOUND;
END $$;

-- The signed-in caller must be an enabled worker identity enrolled (not revoked) by the account's owner.
CREATE FUNCTION public.fpw_id_authorize(p_account uuid) RETURNS uuid
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

-- ---------- the six worker wrappers (authenticated only) ----------
CREATE FUNCTION public.fpw_id_acquire_lease(p_account uuid, p_holder uuid, p_ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_owner uuid := public.fpw_id_authorize(p_account); f bigint;
BEGIN
  f := public.fpw_acquire_lease(p_account, p_holder, p_ttl_seconds);
  IF f IS NOT NULL THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_ACQUIRED', left('worker:' || auth.uid()::text, 64), p_holder, f);
  END IF;
  RETURN f;
END $$;
CREATE FUNCTION public.fpw_id_release_lease(p_account uuid, p_holder uuid, p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_owner uuid := public.fpw_id_authorize(p_account); ok boolean;
BEGIN
  ok := public.fpw_release_lease(p_account, p_holder, p_fence);
  IF ok THEN INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_RELEASED', left('worker:' || auth.uid()::text, 64), p_holder, p_fence); END IF;
  RETURN ok;
END $$;
CREATE FUNCTION public.fpw_id_snapshot(p_account uuid, p_holder uuid, p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.fpw_id_authorize(p_account);
  RETURN public.fpw_snapshot(p_account, p_holder, p_fence);
END $$;
CREATE FUNCTION public.fpw_id_evaluated(p_account uuid, p_holder uuid, p_fence bigint, p_user uuid, p_ids text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.fpw_id_authorize(p_account);
  RETURN public.fpw_evaluated(p_account, p_holder, p_fence, p_user, p_ids);
END $$;
CREATE FUNCTION public.fpw_id_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb) RETURNS bigint
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
CREATE FUNCTION public.fpw_id_mark_review(p_account uuid, p_holder uuid, p_fence bigint, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.fpw_id_authorize(p_account);
  RETURN public.fpw_mark_review(p_account, p_holder, p_fence, p_code);  -- 0050 writes the REVIEW audit row
END $$;

-- Rollback-order guard: 0052's rollback (DROP TABLE futures_paper_config_changes, no CASCADE) fails while 0053 exists.
CREATE VIEW public.futures_paper_0053_requires_0052 AS SELECT id FROM public.futures_paper_config_changes WHERE false;

-- ---------- privileges and row security ----------
REVOKE ALL ON public.futures_paper_0053_requires_0052 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.futures_paper_worker_identities, public.futures_paper_worker_enrollments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.futures_paper_worker_identities, public.futures_paper_worker_enrollments TO service_role;
GRANT SELECT ON public.futures_paper_worker_enrollments TO authenticated;
ALTER TABLE public.futures_paper_worker_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.futures_paper_worker_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY futures_paper_worker_enrollments_owner_read ON public.futures_paper_worker_enrollments FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.account_mfa_allowed());
-- No policy on identities: only the definer functions and service_role (monitoring, BYPASSRLS) read it.
REVOKE ALL ON FUNCTION public.fpw_admin_set_identity(uuid, text, boolean), public.fpw_owner_enroll(uuid, uuid), public.fpw_owner_revoke(uuid, uuid), public.fpw_id_authorize(uuid),
  public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_snapshot(uuid, uuid, bigint),
  public.fpw_id_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_id_mark_review(uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fpw_admin_set_identity(uuid, text, boolean), public.fpw_owner_enroll(uuid, uuid), public.fpw_owner_revoke(uuid, uuid),
  public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_snapshot(uuid, uuid, bigint),
  public.fpw_id_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_id_mark_review(uuid, uuid, bigint, text) TO authenticated;
-- The paper ledger is no longer writable with the service key: the gateway is reachable only through fpw_id_*.
REVOKE EXECUTE ON FUNCTION public.fpw_acquire_lease(uuid, uuid, integer), public.fpw_release_lease(uuid, uuid, bigint), public.fpw_snapshot(uuid, uuid, bigint),
  public.fpw_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_mark_review(uuid, uuid, bigint, text) FROM service_role;
