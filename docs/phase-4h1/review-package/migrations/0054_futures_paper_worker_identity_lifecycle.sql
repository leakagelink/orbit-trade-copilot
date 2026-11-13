-- =====================================================================================================================
-- 0054 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval.
-- Successor of draft 0053 (worker identity), itself on drafts 0049–0052; none is applied. Apply order:
-- 0049 → 0050 → 0051 → 0052 → 0053 → 0054. Rollback order: 0054 → 0053 → 0052 → 0051 → 0050 → 0049.
-- Phase 4H.1 security remediation of the 0053 identity lifecycle. 0049–0053 are left byte-identical; this draft only
-- REPLACES 0053 function bodies (same signatures, same grants) and ADDS one helper, one history table and one guard.
--
--  A. Disabling is always possible. fpw_admin_set_identity keeps the signed-in admin + MFA requirement for every call,
--     but applies the "separate plain user" rule only when ENABLING (registering or re-enabling). An authorized admin
--     can disable an existing identity even after the worker became an admin, a super_admin or a paper account owner.
--     Re-enabling an identity that is no longer a separate plain user is refused.
--  B. Current status on every call. fpw_id_check re-validates, on EVERY worker RPC, that the caller is (now) an enabled
--     identity, is not an admin or super_admin (protected user_roles table via has_role), owns no paper account, and is
--     enrolled (not revoked) by the account's current owner. fpw_id_authorize (used by the two read wrappers) and the
--     four writing wrappers call it; the writing wrappers also take FOR SHARE locks on the identity and enrollment rows,
--     so a disable or revoke waits for an in-flight write and every later write is refused. (Read wrappers take no
--     locks: the gateway may run them in a read-only transaction.) Owner enrollment applies the same eligibility rule.
--  C. Identity history. Every identity registration, enable, disable and label change is recorded once in an
--     append-only table (immutable rows, no truncate), readable only by the database owner.
-- What this does NOT do: it does not take the service key out of the server runtime, does not create a user, a secret,
-- a schedule or a route, and does not change any 0049–0052 object, grant or timing value. A role promotion that commits
-- while one worker call is already running can let that single call finish; the next call is refused (user_roles is not
-- locked by this draft).
-- =====================================================================================================================
DO $$ BEGIN
  IF to_regprocedure('public.fpw_id_authorize(uuid)') IS NULL OR to_regprocedure('public.fpw_admin_set_identity(uuid,text,boolean)') IS NULL
     OR to_regclass('public.futures_paper_worker_identities') IS NULL OR to_regclass('public.futures_paper_0053_requires_0052') IS NULL THEN
    RAISE EXCEPTION '0054 requires draft 0053 (and through it drafts 0049–0052)';
  END IF;
END $$;

CREATE TABLE public.futures_paper_worker_identity_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_user_id uuid NOT NULL,
  old_enabled boolean,
  new_enabled boolean NOT NULL,
  old_label text,
  new_label text NOT NULL,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX futures_paper_worker_identity_changes_worker ON public.futures_paper_worker_identity_changes (worker_user_id, id);
CREATE TRIGGER futures_paper_worker_identity_changes_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_worker_identity_changes FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
CREATE TRIGGER futures_paper_worker_identity_changes_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_identity_changes FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

-- ---------- A. registry: admin + MFA always; plain-user rule only when enabling ----------
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

-- ---------- B. the current-status check used by every worker RPC ----------
CREATE FUNCTION public.fpw_id_check(p_account uuid, p_lock boolean) RETURNS uuid
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

CREATE OR REPLACE FUNCTION public.fpw_id_authorize(p_account uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  RETURN public.fpw_id_check(p_account, false);  -- 0054: current status on every call (no locks: read path)
END $$;

CREATE OR REPLACE FUNCTION public.fpw_owner_enroll(p_account uuid, p_worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_uid uuid := auth.uid(); v_owner uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.futures_paper_accounts WHERE id = p_account;
  IF v_uid IS NULL OR v_owner IS DISTINCT FROM v_uid OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker: only the account owner can enroll a worker'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = p_worker AND enabled) THEN RAISE EXCEPTION 'futures paper worker: not a registered, enabled worker identity'; END IF;
  IF public.has_role(p_worker, 'admin') OR public.has_role(p_worker, 'super_admin') OR EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = p_worker) THEN
    RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (admin role or paper account owner)';
  END IF;
  INSERT INTO public.futures_paper_worker_enrollments AS e (account_id, worker_user_id, user_id) VALUES (p_account, p_worker, v_owner)
  ON CONFLICT (account_id, worker_user_id) DO UPDATE SET enrolled_at = now(), revoked_at = NULL;
  INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) VALUES (p_account, v_owner, 'ID:ENROLLED', 'owner');
  RETURN true;
END $$;

-- ---------- the four writing wrappers: 0053 bodies, authorization through the locking check ----------
CREATE OR REPLACE FUNCTION public.fpw_id_acquire_lease(p_account uuid, p_holder uuid, p_ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_owner uuid := public.fpw_id_check(p_account, true); f bigint;
BEGIN
  f := public.fpw_acquire_lease(p_account, p_holder, p_ttl_seconds);
  IF f IS NOT NULL THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_ACQUIRED', left('worker:' || auth.uid()::text, 64), p_holder, f);
  END IF;
  RETURN f;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_release_lease(p_account uuid, p_holder uuid, p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_owner uuid := public.fpw_id_check(p_account, true); ok boolean;
BEGIN
  ok := public.fpw_release_lease(p_account, p_holder, p_fence);
  IF ok THEN INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:LEASE_RELEASED', left('worker:' || auth.uid()::text, 64), p_holder, p_fence); END IF;
  RETURN ok;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_commit(p_account uuid, p_holder uuid, p_fence bigint, p_expected_seq bigint, p_bar_t bigint, p_payload jsonb, p_provenance jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_owner uuid := public.fpw_id_check(p_account, true); v_seq bigint; v_replay boolean;
BEGIN
  v_replay := EXISTS (SELECT 1 FROM public.futures_paper_commits WHERE account_id = p_account AND bar_t = p_bar_t);
  v_seq := public.fpw_commit(p_account, p_holder, p_fence, p_expected_seq, p_bar_t, p_payload, p_provenance);
  IF NOT v_replay THEN
    INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor, holder, fence) VALUES (p_account, v_owner, 'ID:COMMIT', left('worker:' || auth.uid()::text, 64), p_holder, p_fence);
  END IF;
  RETURN v_seq;
END $$;
CREATE OR REPLACE FUNCTION public.fpw_id_mark_review(p_account uuid, p_holder uuid, p_fence bigint, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  PERFORM public.fpw_id_check(p_account, true);
  RETURN public.fpw_mark_review(p_account, p_holder, p_fence, p_code);  -- 0050 writes the REVIEW audit row
END $$;

-- Rollback-order guard: 0053's rollback (DROP VIEW futures_paper_0053_requires_0052, DROP TABLE
-- futures_paper_worker_identities; no CASCADE, one transaction) fails as a whole while 0054 exists.
CREATE VIEW public.futures_paper_0054_requires_0053 AS
  SELECT g.id, w.worker_user_id FROM public.futures_paper_0053_requires_0052 g CROSS JOIN public.futures_paper_worker_identities w WHERE false;

-- ---------- privileges: nothing new for PUBLIC, anon, authenticated or service_role ----------
REVOKE ALL ON public.futures_paper_0054_requires_0053, public.futures_paper_worker_identity_changes FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.futures_paper_worker_identity_changes ENABLE ROW LEVEL SECURITY;
-- No policy and no grant: identity history is written only by fpw_admin_set_identity and read by the database owner.
REVOKE ALL ON FUNCTION public.fpw_id_check(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
-- CREATE OR REPLACE keeps each replaced function's 0053 privileges (authenticated EXECUTE on the admin/owner/wrapper
-- functions; nothing on fpw_id_authorize). Re-stated so a reviewer sees the full result in one place:
REVOKE ALL ON FUNCTION public.fpw_admin_set_identity(uuid, text, boolean), public.fpw_owner_enroll(uuid, uuid), public.fpw_id_authorize(uuid),
  public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_id_mark_review(uuid, uuid, bigint, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fpw_id_authorize(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fpw_admin_set_identity(uuid, text, boolean), public.fpw_owner_enroll(uuid, uuid),
  public.fpw_id_acquire_lease(uuid, uuid, integer), public.fpw_id_release_lease(uuid, uuid, bigint), public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_id_mark_review(uuid, uuid, bigint, text) TO authenticated;
