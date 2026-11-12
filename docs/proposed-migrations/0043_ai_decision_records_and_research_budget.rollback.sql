-- Rollback for DRAFT 0043 (not applied). Export ai_decision_records, ai_risk_evaluations, ai_research_budget_events
-- and ai_research_budget_reservations first: dropping them deletes the immutable decision, risk-evaluation, limit-change
-- and spending-reservation history. Research keeps working (the app falls back to provisional records, default
-- limits and per-run in-memory limits; platform-wide caps are then no longer atomic).
-- Runs that ended as queued, cancelled or budget_exceeded are relabelled for the original status list; the
-- original reason stays in their error text. No trading object is affected.
--
-- DELIBERATE DEVIATION FROM THE PRE-0043 STATE: this rollback does NOT give browser roles (anon, authenticated)
-- back the INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privileges, nor anon SELECT, that 0043 removes from
-- the seven existing research tables. Before 0043 those privileges came only from hosted default grants; no policy
-- ever allowed a browser write, and TRUNCATE bypasses RLS entirely. Restoring them would reopen that hole and serves no
-- feature, so the security hardening survives a rollback of the Phase 1 schema. Owners keep reading their own rows
-- through the existing SELECT policies; the backend role is unaffected.
DROP TRIGGER ai_research_runs_guard ON public.ai_research_runs;
DROP TRIGGER ai_research_runs_no_truncate ON public.ai_research_runs;
UPDATE public.ai_research_runs r SET
  status = CASE WHEN EXISTS (SELECT 1 FROM public.ai_agent_outputs o WHERE o.run_id = r.id AND o.status = 'completed') THEN 'partial' ELSE 'failed' END,
  error = CASE r.status WHEN 'cancelled' THEN 'Cancelled: ' WHEN 'budget_exceeded' THEN 'Stopped by a research limit: ' ELSE 'Not started: ' END || coalesce(r.error, 'no reason recorded')
WHERE r.status IN ('queued', 'cancelled', 'budget_exceeded');
ALTER TABLE public.ai_research_runs DROP CONSTRAINT ai_research_runs_status_check;
ALTER TABLE public.ai_research_runs ADD CONSTRAINT ai_research_runs_status_check CHECK (status IN ('running', 'completed', 'partial', 'failed'));
DROP TRIGGER ai_agent_outputs_immutable ON public.ai_agent_outputs;
DROP TRIGGER ai_research_reports_immutable ON public.ai_research_reports;
DROP TRIGGER ai_research_decisions_immutable ON public.ai_research_decisions;
DROP TRIGGER ai_trade_proposals_immutable ON public.ai_trade_proposals;
DROP TRIGGER ai_research_usage_immutable ON public.ai_research_usage;
DROP TRIGGER ai_research_stage_metrics_immutable ON public.ai_research_stage_metrics;
DROP TRIGGER ai_agent_outputs_no_truncate ON public.ai_agent_outputs;
DROP TRIGGER ai_research_reports_no_truncate ON public.ai_research_reports;
DROP TRIGGER ai_research_decisions_no_truncate ON public.ai_research_decisions;
DROP TRIGGER ai_trade_proposals_no_truncate ON public.ai_trade_proposals;
DROP TRIGGER ai_research_usage_no_truncate ON public.ai_research_usage;
DROP TRIGGER ai_research_stage_metrics_no_truncate ON public.ai_research_stage_metrics;
DROP TRIGGER ai_agent_outputs_append_guard ON public.ai_agent_outputs;
DROP TRIGGER ai_research_reports_append_guard ON public.ai_research_reports;
DROP TRIGGER ai_research_decisions_append_guard ON public.ai_research_decisions;
DROP TRIGGER ai_trade_proposals_append_guard ON public.ai_trade_proposals;
DROP TRIGGER ai_research_usage_append_guard ON public.ai_research_usage;
DROP TRIGGER ai_research_stage_metrics_append_guard ON public.ai_research_stage_metrics;
DROP FUNCTION public.release_ai_research_budget(uuid, uuid);
DROP FUNCTION public.settle_ai_research_budget(uuid[], uuid, bigint, numeric);
DROP FUNCTION public.reserve_ai_research_budget(uuid, uuid, uuid, text, text, bigint);
DROP FUNCTION public.claim_ai_research_worker(uuid, uuid, uuid);
DROP FUNCTION public.ai_research_counted_tokens(uuid, timestamptz);
DROP TABLE public.ai_research_budget_reservations;
DROP FUNCTION public.guard_ai_research_reservation();
DROP FUNCTION public.set_ai_research_budget(integer, bigint, bigint, bigint, integer, integer, integer, numeric, numeric);
DROP TABLE public.ai_research_budget_events;
DROP TABLE public.ai_research_budget_config;
DROP TABLE public.ai_risk_evaluations;
DROP TABLE public.ai_decision_records;
DROP FUNCTION public.validate_ai_risk_evaluation();
DROP FUNCTION public.validate_ai_decision_record();
DROP FUNCTION public.guard_ai_research_run();
DROP FUNCTION public.guard_ai_research_append();
DROP FUNCTION public.ai_research_history_immutable();
ALTER TABLE public.ai_research_runs DROP COLUMN worker_claimed_at, DROP COLUMN worker_id;
-- Browser write and TRUNCATE privileges intentionally stay revoked (see the note at the top).
