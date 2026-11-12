-- PROPOSED — NOT APPLIED. Apply only after owner approval and a verified export of the current database, byte-for-byte.
-- 0040: certification records become backend-written only. Browser roles lose every write privilege (INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN); signed-in owners keep read access, still filtered by the existing
-- owner-only RLS policy. TRUNCATE is also blocked for every role so the table stays append-only. No rows, settings,
-- limits, policies or certification results are changed.

REVOKE ALL ON public.futures_certifications FROM anon;
REVOKE ALL ON public.futures_certifications FROM authenticated;
GRANT SELECT ON public.futures_certifications TO authenticated;
GRANT ALL ON public.futures_certifications TO service_role;

-- The agent's read-only inspection role inherited INSERT from schema defaults; it must never record certifications.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.futures_certifications FROM sandbox_exec';
  END IF;
END $$;

-- Row-level immutability triggers do not fire on TRUNCATE; block it at statement level for every role.
CREATE TRIGGER futures_certifications_no_truncate BEFORE TRUNCATE ON public.futures_certifications
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_evaluation_mutation();
