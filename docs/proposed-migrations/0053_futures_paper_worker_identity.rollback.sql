-- Rollback for DRAFT 0053 (not applied). Run BEFORE any rollback of 0052–0049. Export the two tables below first:
-- dropping them deletes the worker-identity registry and the owners' enrollments (the 0050 audit rows they wrote stay).
-- service_role regains EXECUTE on the six 0050 gateway functions (their 0050 grants). No CASCADE is used.
GRANT EXECUTE ON FUNCTION public.fpw_acquire_lease(uuid, uuid, integer), public.fpw_release_lease(uuid, uuid, bigint), public.fpw_snapshot(uuid, uuid, bigint),
  public.fpw_evaluated(uuid, uuid, bigint, uuid, text[]), public.fpw_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb),
  public.fpw_mark_review(uuid, uuid, bigint, text) TO service_role;
DROP VIEW public.futures_paper_0053_requires_0052;
DROP FUNCTION public.fpw_id_mark_review(uuid, uuid, bigint, text);
DROP FUNCTION public.fpw_id_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb);
DROP FUNCTION public.fpw_id_evaluated(uuid, uuid, bigint, uuid, text[]);
DROP FUNCTION public.fpw_id_snapshot(uuid, uuid, bigint);
DROP FUNCTION public.fpw_id_release_lease(uuid, uuid, bigint);
DROP FUNCTION public.fpw_id_acquire_lease(uuid, uuid, integer);
DROP FUNCTION public.fpw_id_authorize(uuid);
DROP FUNCTION public.fpw_owner_revoke(uuid, uuid);
DROP FUNCTION public.fpw_owner_enroll(uuid, uuid);
DROP FUNCTION public.fpw_admin_set_identity(uuid, text, boolean);
DROP TABLE public.futures_paper_worker_enrollments;
DROP TABLE public.futures_paper_worker_identities;
