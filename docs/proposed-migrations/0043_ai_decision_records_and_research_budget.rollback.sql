-- Rollback for DRAFT 0043 (not applied). Export ai_decision_records, ai_risk_evaluations and
-- ai_research_budget_events first: dropping them deletes the immutable decision, risk-evaluation and limit-change
-- history. Research keeps working (the app falls back to provisional records and default limits).
-- Runs that ended as queued, cancelled or budget_exceeded are relabelled for the original status list; the
-- original reason stays in their error text. No trading object is affected.
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
DROP FUNCTION public.set_ai_research_budget(integer, bigint, bigint, bigint, integer, integer, integer, numeric, numeric);
DROP TABLE public.ai_research_budget_events;
DROP TABLE public.ai_research_budget_config;
DROP TABLE public.ai_risk_evaluations;
DROP TABLE public.ai_decision_records;
DROP FUNCTION public.validate_ai_risk_evaluation();
DROP FUNCTION public.validate_ai_decision_record();
DROP FUNCTION public.guard_ai_research_run();
DROP FUNCTION public.ai_research_history_immutable();
