-- Rollback for DRAFT 0056 (not applied). Run BEFORE the rollback of 0055. ONE statement (a single DO block).
-- Removes the data-API pre-request hook only if it is this draft's hook, then drops the function. No data is touched.
-- WARNING: afterwards a worker identity can again call other owner-rights database functions directly (F15 residual).
DO $rb$
BEGIN
  IF to_regprocedure('public.fpw_api_pre_request()') IS NULL THEN RAISE EXCEPTION 'draft 0056 is not applied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS c(v)
                  WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'authenticator') AND c.v = 'pgrst.db_pre_request=public.fpw_api_pre_request') THEN
    RAISE EXCEPTION 'refusing: the configured pre-request hook is not the one set by draft 0056 (review it first)';
  END IF;
  ALTER ROLE authenticator RESET pgrst.db_pre_request;
  PERFORM pg_notify('pgrst', 'reload config');
  DROP FUNCTION public.fpw_api_pre_request();
END
$rb$;
