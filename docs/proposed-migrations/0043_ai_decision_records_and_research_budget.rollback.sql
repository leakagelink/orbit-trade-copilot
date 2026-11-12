-- Rollback for DRAFT 0043 (not applied). Export ai_decision_records and ai_research_budget_events first:
-- dropping them deletes the immutable decision history and the limit-change history. Research runs keep working
-- (the app falls back to provisional records and default limits). No trading object is affected.
DROP TRIGGER ai_agent_outputs_immutable ON public.ai_agent_outputs;
DROP TRIGGER ai_research_reports_immutable ON public.ai_research_reports;
DROP TRIGGER ai_research_decisions_immutable ON public.ai_research_decisions;
DROP TRIGGER ai_trade_proposals_immutable ON public.ai_trade_proposals;
DROP TRIGGER ai_research_usage_immutable ON public.ai_research_usage;
DROP FUNCTION public.set_ai_research_budget(integer, bigint, bigint, numeric, numeric);
DROP TABLE public.ai_research_budget_events;
DROP TABLE public.ai_research_budget_config;
DROP TABLE public.ai_decision_records;
DROP FUNCTION public.validate_ai_decision_record();
DROP FUNCTION public.ai_research_history_immutable();
