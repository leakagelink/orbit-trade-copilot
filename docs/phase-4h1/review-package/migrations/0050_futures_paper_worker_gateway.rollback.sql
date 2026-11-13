-- Rollback for DRAFT 0050 (not applied). Run BEFORE any rollback of 0049. Export the three tables below first: dropping
-- them deletes the candle provenance records and the worker/status audit trail. 0049 objects and data are untouched,
-- except that service_role regains direct EXECUTE on futures_paper_commit_bar_v3 (its 0049 grant). No CASCADE is used.
DROP TRIGGER futures_paper_accounts_status_audit ON public.futures_paper_accounts;
DROP FUNCTION public.fpw_mark_review(uuid, uuid, bigint, text);
DROP FUNCTION public.fpw_commit(uuid, uuid, bigint, bigint, bigint, jsonb, jsonb);
DROP FUNCTION public.fpw_evaluated(uuid, uuid, bigint, uuid, text[]);
DROP FUNCTION public.fpw_snapshot(uuid, uuid, bigint);
DROP FUNCTION public.fpw_release_lease(uuid, uuid, bigint);
DROP FUNCTION public.fpw_acquire_lease(uuid, uuid, integer);
DROP TABLE public.futures_paper_candle_provenance;
DROP TABLE public.futures_paper_worker_audit;
DROP TABLE public.futures_paper_worker_leases;
DROP FUNCTION public.fpw_candle_digest(uuid, bigint, text, boolean);
DROP FUNCTION public.fpw_audit_status_change();
GRANT EXECUTE ON FUNCTION public.futures_paper_commit_bar_v3(uuid, bigint, bigint, jsonb) TO service_role;
