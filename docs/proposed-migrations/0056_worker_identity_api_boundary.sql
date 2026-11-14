-- =====================================================================================================================
-- 0056 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval, after the hosted
-- migration history has been read. Successor of draft 0055. Apply order: … → 0055 → 0056. Rollback: 0056 → 0055 → ….
-- Phase 4H.5, F15 (API boundary). 0055 removes every row a worker identity could see or write through row-level
-- security and makes the shared server checks refuse it. Database functions that run with their owner's rights
-- (SECURITY DEFINER) and are executable by every signed-in user still answer a direct data-API call from the worker.
-- This draft closes that path at the data API itself: a request hook (the data API's documented pre-request setting
-- on the authenticator role) refuses EVERY data-API request of a registered worker identity except POST to the six
-- worker operations of 0055 (/rpc/fpw_id2_*). It returns at once for anonymous callers, the service role and every
-- ordinary user (one primary-key lookup).
-- Separate from 0055 because it changes a project-level data-API setting: hosted support for this setting, the exact
-- request.path format, and whether the migration role may ALTER ROLE authenticator are NOT VERIFIED. If request.path is
-- missing or formatted differently, the worker is refused (fails closed); ordinary users are unaffected.
-- It refuses to apply when any pre-request hook is already configured (it never replaces someone else's hook).
-- ONE statement (a single DO block): all-or-nothing whatever the runner does.
-- =====================================================================================================================
DO $mig$
BEGIN
  IF to_regprocedure('public.fpw_caller_is_worker()') IS NULL OR to_regclass('public.futures_paper_0055_requires_0054') IS NULL THEN
    RAISE EXCEPTION '0056 requires draft 0055';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN RAISE EXCEPTION '0056 requires the data API role authenticator'; END IF;
  IF EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS c(v)
              WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'authenticator') AND c.v LIKE 'pgrst.db_pre_request=%') THEN
    RAISE EXCEPTION '0056 refuses: a data-API pre-request hook is already configured (review it first; this draft never replaces it)';
  END IF;

  CREATE FUNCTION public.fpw_api_pre_request() RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid; v_path text; v_method text;
  BEGIN
    BEGIN v_uid := auth.uid(); EXCEPTION WHEN others THEN RETURN; END;  -- no user id: not a worker identity
    IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid) THEN RETURN; END IF;
    v_path := current_setting('request.path', true); v_method := current_setting('request.method', true);
    IF v_method = 'POST' AND v_path IN ('/rpc/fpw_id2_acquire_lease', '/rpc/fpw_id2_release_lease', '/rpc/fpw_id2_snapshot',
                                         '/rpc/fpw_id2_evaluated', '/rpc/fpw_id2_commit', '/rpc/fpw_id2_mark_review') THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'futures paper worker identity: only the six worker operations are allowed' USING ERRCODE = '42501';
  END $f$;
  REVOKE ALL ON FUNCTION public.fpw_api_pre_request() FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.fpw_api_pre_request() TO anon, authenticated, service_role;  -- runs as the request role

  ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.fpw_api_pre_request';
  PERFORM pg_notify('pgrst', 'reload config');
END
$mig$;
