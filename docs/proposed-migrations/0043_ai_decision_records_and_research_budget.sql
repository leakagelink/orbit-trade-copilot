-- =====================================================================================================
-- 0043 — DRAFT ONLY. NOT APPLIED. Requires separate owner approval.
-- Phase 1 (Engine A research): immutable AI decision records, research run lifecycle, read-only risk
-- evaluation history and research spending limits.
--
-- Guarantees
--  * ai_decision_records and ai_risk_evaluations are insert-only for the backend. No role (including
--    service_role and the table owner through normal DML) can UPDATE, DELETE or TRUNCATE them.
--  * Browser roles can only read their own rows; they cannot insert, change or delete anything. Existing research
--    tables also lose the browser write privileges the hosted database grants by default (RLS already refused them).
--  * The database sets each decision record's SHA-256 fingerprint and timestamps itself.
--  * A research run can change only while queued or running; once finished it is frozen, its identity can
--    never change and runs can never be deleted, so failed and stopped attempts stay in the history.
--  * Existing research output tables become append-only, including TRUNCATE (they are only ever inserted today).
--  * Risk evaluations must say NOT_EXECUTABLE and execution_authorized = false; nothing here can authorize,
--    create or submit an order.
--  * Research spending limits change only through one admin-checked RPC; every change is kept append-only.
--    The backend role can only read limits and their history; browser roles cannot touch either table.
--  * Only that RPC is SECURITY DEFINER (fixed search_path, EXECUTE revoked from PUBLIC and anon, explicit
--    admin check). Validation triggers run as the caller.
--  * No trading, order, position, risk-setting, certification or emergency-stop object is touched.
-- =====================================================================================================

-- 0. Shared append-only guard ------------------------------------------------------------------------
CREATE FUNCTION public.ai_research_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN RAISE EXCEPTION 'AI research history is append-only (% on %)', TG_OP, TG_TABLE_NAME; END $$;

-- 1. Research run lifecycle --------------------------------------------------------------------------
ALTER TABLE public.ai_research_runs DROP CONSTRAINT ai_research_runs_status_check;
ALTER TABLE public.ai_research_runs ADD CONSTRAINT ai_research_runs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'budget_exceeded'));

CREATE FUNCTION public.guard_ai_research_run() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI research history is append-only (DELETE on ai_research_runs)'; END IF;
  IF OLD.status NOT IN ('queued', 'running') THEN RAISE EXCEPTION 'A finished research run cannot be changed'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Research run identity cannot be changed';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'queued' THEN RAISE EXCEPTION 'A running research run cannot return to the queue'; END IF;
  IF NEW.status NOT IN ('queued', 'running') AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_research_runs_guard BEFORE UPDATE OR DELETE ON public.ai_research_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_run();
CREATE TRIGGER ai_research_runs_no_truncate BEFORE TRUNCATE ON public.ai_research_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();

-- 2. Immutable decision records ----------------------------------------------------------------------
CREATE TABLE public.ai_decision_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL UNIQUE REFERENCES public.ai_research_runs(id),
  user_id        uuid NOT NULL,
  market         text NOT NULL CHECK (market IN ('crypto', 'equity')),
  symbol         text NOT NULL,
  timeframe      text NOT NULL CHECK (timeframe = '1d'),
  outcome        text NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed', 'stopped_by_budget', 'cancelled')),
  decided_at     timestamptz NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version IN (1, 2)),
  record         jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  record_sha256  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_decision_records_user_idx ON public.ai_decision_records (user_id, created_at DESC);

CREATE FUNCTION public.validate_ai_decision_record() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE agents text[] := ARRAY['market','fundamentals','news','sentiment','bull','bear','manager','trader','risk_aggressive','risk_conservative','risk_neutral','portfolio'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_research_runs r WHERE r.id = NEW.run_id AND r.user_id = NEW.user_id AND r.symbol = NEW.symbol) THEN
    RAISE EXCEPTION 'Decision record must match an existing research run, owner and symbol';
  END IF;
  IF NEW.record->>'runId' IS DISTINCT FROM NEW.run_id::text OR NEW.record->>'userId' IS DISTINCT FROM NEW.user_id::text
     OR NEW.record->>'symbol' IS DISTINCT FROM NEW.symbol OR NEW.record->>'outcome' IS DISTINCT FROM NEW.outcome THEN
    RAISE EXCEPTION 'Decision record content does not match its columns';
  END IF;
  IF (NEW.record->>'advisoryOnly')::boolean IS NOT TRUE OR (NEW.record->>'executionAllowed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Decision records are advisory only';
  END IF;
  IF NEW.schema_version = 2 AND (NEW.record->>'schemaVersion' IS DISTINCT FROM '2'
     OR (NEW.record #>> '{riskEvaluation,evaluation,executionAuthorized}') IS DISTINCT FROM 'false'
     OR (NEW.record #>> '{riskEvaluation,evaluation,status}') IS DISTINCT FROM 'NOT_EXECUTABLE') THEN
    RAISE EXCEPTION 'Decision record risk evaluation must be non-executable';
  END IF;
  IF jsonb_typeof(NEW.record->'agents') <> 'array' OR jsonb_array_length(NEW.record->'agents') <> 12
     OR (SELECT array_agg(a->>'agent' ORDER BY o) FROM jsonb_array_elements(NEW.record->'agents') WITH ORDINALITY AS t(a, o)) IS DISTINCT FROM agents THEN
    RAISE EXCEPTION 'Decision record must contain all 12 agents in order';
  END IF;
  NEW.created_at := now();
  NEW.record_sha256 := encode(sha256(convert_to(NEW.record::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER ai_decision_records_validate BEFORE INSERT ON public.ai_decision_records
  FOR EACH ROW EXECUTE FUNCTION public.validate_ai_decision_record();
CREATE TRIGGER ai_decision_records_immutable BEFORE UPDATE OR DELETE ON public.ai_decision_records
  FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_decision_records_no_truncate BEFORE TRUNCATE ON public.ai_decision_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();

REVOKE ALL ON public.ai_decision_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_decision_records TO authenticated;
GRANT SELECT, INSERT ON public.ai_decision_records TO service_role;
ALTER TABLE public.ai_decision_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_decision_records_owner_read ON public.ai_decision_records FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.account_mfa_allowed());

-- 3. Read-only risk evaluation history ----------------------------------------------------------------
CREATE TABLE public.ai_risk_evaluations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  uuid NOT NULL REFERENCES public.ai_research_runs(id),
  user_id                 uuid NOT NULL,
  symbol                  text NOT NULL,
  market_type             text NOT NULL CHECK (market_type IN ('crypto', 'equity', 'unknown')),
  proposed_direction      text NOT NULL CHECK (proposed_direction IN ('LONG', 'SHORT', 'NONE')),
  decision                text NOT NULL CHECK (decision IN ('PREVIEW_ONLY', 'INSUFFICIENT_DATA', 'REJECTED')),
  execution_authorized    boolean NOT NULL DEFAULT false CHECK (execution_authorized = false),
  estimated_position_size numeric CHECK (estimated_position_size IS NULL OR estimated_position_size >= 0),
  estimated_risk_amount   numeric CHECK (estimated_risk_amount IS NULL OR estimated_risk_amount >= 0),
  available_risk_budget   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(available_risk_budget) = 'object'),
  account_exposure        numeric,
  rejection_reasons       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rejection_reasons) = 'array'),
  missing_inputs          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_inputs) = 'array'),
  evaluation              jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object'),
  evaluated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_risk_evaluations_run_idx ON public.ai_risk_evaluations (run_id, evaluated_at DESC);
CREATE INDEX ai_risk_evaluations_user_idx ON public.ai_risk_evaluations (user_id, evaluated_at DESC);

CREATE FUNCTION public.validate_ai_risk_evaluation() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_research_runs r WHERE r.id = NEW.run_id AND r.user_id = NEW.user_id AND r.symbol = NEW.symbol) THEN
    RAISE EXCEPTION 'Risk evaluation must match an existing research run, owner and symbol';
  END IF;
  IF NEW.evaluation->>'status' IS DISTINCT FROM 'NOT_EXECUTABLE' OR NEW.evaluation->>'executionAuthorized' IS DISTINCT FROM 'false'
     OR NEW.evaluation->>'decision' IS DISTINCT FROM NEW.decision THEN
    RAISE EXCEPTION 'Risk evaluations are research-only and never authorize execution';
  END IF;
  NEW.evaluated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER ai_risk_evaluations_validate BEFORE INSERT ON public.ai_risk_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.validate_ai_risk_evaluation();
CREATE TRIGGER ai_risk_evaluations_immutable BEFORE UPDATE OR DELETE ON public.ai_risk_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_risk_evaluations_no_truncate BEFORE TRUNCATE ON public.ai_risk_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();

REVOKE ALL ON public.ai_risk_evaluations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_risk_evaluations TO authenticated;
GRANT SELECT, INSERT ON public.ai_risk_evaluations TO service_role;
ALTER TABLE public.ai_risk_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_risk_evaluations_owner_read ON public.ai_risk_evaluations FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.account_mfa_allowed());

-- 4. Existing research outputs become append-only (the app only inserts into them) -------------------
CREATE TRIGGER ai_agent_outputs_immutable BEFORE UPDATE OR DELETE ON public.ai_agent_outputs FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_reports_immutable BEFORE UPDATE OR DELETE ON public.ai_research_reports FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_decisions_immutable BEFORE UPDATE OR DELETE ON public.ai_research_decisions FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_trade_proposals_immutable BEFORE UPDATE OR DELETE ON public.ai_trade_proposals FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_usage_immutable BEFORE UPDATE OR DELETE ON public.ai_research_usage FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_agent_outputs_no_truncate BEFORE TRUNCATE ON public.ai_agent_outputs FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_reports_no_truncate BEFORE TRUNCATE ON public.ai_research_reports FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_decisions_no_truncate BEFORE TRUNCATE ON public.ai_research_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_trade_proposals_no_truncate BEFORE TRUNCATE ON public.ai_trade_proposals FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_usage_no_truncate BEFORE TRUNCATE ON public.ai_research_usage FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();

-- Defence in depth: the hosted database grants anon/authenticated full table privileges by default and relies on RLS
-- (no write policies exist). TRUNCATE is not subject to RLS, so browser roles lose every write privilege outright.
-- Owner reads keep working through the existing SELECT policies; visitors lose SELECT (no anon policy exists).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ai_research_runs, public.ai_agent_outputs, public.ai_research_reports,
  public.ai_research_decisions, public.ai_trade_proposals, public.ai_research_usage, public.ai_research_stage_metrics FROM anon, authenticated;
REVOKE SELECT ON public.ai_research_runs, public.ai_agent_outputs, public.ai_research_reports, public.ai_research_decisions,
  public.ai_trade_proposals, public.ai_research_usage, public.ai_research_stage_metrics FROM anon;

REVOKE ALL ON FUNCTION public.validate_ai_decision_record(), public.validate_ai_risk_evaluation(), public.guard_ai_research_run(), public.ai_research_history_immutable() FROM PUBLIC, anon, authenticated;

-- 5. Research spending limits (admin-configurable, history kept) ------------------------------------
CREATE TABLE public.ai_research_budget_config (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  per_run_tokens        integer NOT NULL CHECK (per_run_tokens BETWEEN 10000 AND 2000000),
  per_user_day_tokens   bigint  NOT NULL CHECK (per_user_day_tokens BETWEEN 10000 AND 100000000),
  per_user_month_tokens bigint  NOT NULL CHECK (per_user_month_tokens BETWEEN 10000 AND 500000000),
  platform_month_tokens bigint  NOT NULL CHECK (platform_month_tokens BETWEEN 10000 AND 5000000000),
  max_calls_per_run     integer NOT NULL CHECK (max_calls_per_run BETWEEN 1 AND 60),
  max_repairs_per_run   integer NOT NULL CHECK (max_repairs_per_run BETWEEN 0 AND 12),
  max_run_seconds       integer NOT NULL CHECK (max_run_seconds BETWEEN 60 AND 3600),
  per_run_usd           numeric CHECK (per_run_usd IS NULL OR (per_run_usd > 0 AND per_run_usd <= 10000)),
  platform_month_usd    numeric CHECK (platform_month_usd IS NULL OR (platform_month_usd > 0 AND platform_month_usd <= 1000000)),
  updated_by            uuid NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ai_research_budget_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by uuid NOT NULL,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ai_research_budget_events_immutable BEFORE UPDATE OR DELETE ON public.ai_research_budget_events
  FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_budget_events_no_truncate BEFORE TRUNCATE ON public.ai_research_budget_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
-- The backend only reads the limits; only the admin-checked RPC below (running as the table owner) writes them.
-- Browser roles have no direct access at all (limits are shown through an authenticated server function).
REVOKE ALL ON public.ai_research_budget_config, public.ai_research_budget_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_research_budget_config TO service_role;
GRANT SELECT ON public.ai_research_budget_events TO service_role;
ALTER TABLE public.ai_research_budget_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_research_budget_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.set_ai_research_budget(_per_run_tokens integer, _per_user_day_tokens bigint, _per_user_month_tokens bigint, _platform_month_tokens bigint,
  _max_calls_per_run integer, _max_repairs_per_run integer, _max_run_seconds integer, _per_run_usd numeric, _platform_month_usd numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'Only an admin can change research spending limits';
  END IF;
  INSERT INTO public.ai_research_budget_config (id, per_run_tokens, per_user_day_tokens, per_user_month_tokens, platform_month_tokens, max_calls_per_run,
    max_repairs_per_run, max_run_seconds, per_run_usd, platform_month_usd, updated_by, updated_at)
  VALUES (true, _per_run_tokens, _per_user_day_tokens, _per_user_month_tokens, _platform_month_tokens, _max_calls_per_run, _max_repairs_per_run,
    _max_run_seconds, _per_run_usd, _platform_month_usd, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE SET per_run_tokens = EXCLUDED.per_run_tokens, per_user_day_tokens = EXCLUDED.per_user_day_tokens,
    per_user_month_tokens = EXCLUDED.per_user_month_tokens, platform_month_tokens = EXCLUDED.platform_month_tokens,
    max_calls_per_run = EXCLUDED.max_calls_per_run, max_repairs_per_run = EXCLUDED.max_repairs_per_run, max_run_seconds = EXCLUDED.max_run_seconds,
    per_run_usd = EXCLUDED.per_run_usd, platform_month_usd = EXCLUDED.platform_month_usd, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.ai_research_budget_events (changed_by, config) VALUES (auth.uid(), jsonb_build_object(
    'per_run_tokens', _per_run_tokens, 'per_user_day_tokens', _per_user_day_tokens, 'per_user_month_tokens', _per_user_month_tokens,
    'platform_month_tokens', _platform_month_tokens, 'max_calls_per_run', _max_calls_per_run, 'max_repairs_per_run', _max_repairs_per_run,
    'max_run_seconds', _max_run_seconds, 'per_run_usd', _per_run_usd, 'platform_month_usd', _platform_month_usd));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.set_ai_research_budget(integer, bigint, bigint, bigint, integer, integer, integer, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ai_research_budget(integer, bigint, bigint, bigint, integer, integer, integer, numeric, numeric) TO authenticated, service_role;
