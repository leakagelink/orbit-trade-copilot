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
--  * SECURITY DEFINER functions: the admin limits RPC (EXECUTE for authenticated/service_role, explicit admin check)
--    and the four budget-ledger functions (EXECUTE for service_role only). All use a fixed search_path and have EXECUTE
--    revoked from PUBLIC/anon. Validation triggers run as the caller.
--  * Spending limits are reserved atomically before every AI call (section 6): one transaction-scoped advisory lock
--    serializes every reservation on the platform, so concurrent runs and users cannot jointly pass the per-run,
--    per-user daily, per-user monthly or platform monthly caps. Reserved, consumed and released tokens are tracked
--    separately and reconciled with provider-reported usage when the provider reports it.
--  * Each run has exactly one worker (set once). Only that worker can reserve budget, only while the run is running and
--    not cancelled. Outputs can be appended only while the run is in progress; a call that finishes after the run was
--    closed still settles its reservation (flagged as late) but cannot add outputs.
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

-- One worker per run: set once by claim_ai_research_worker (section 6), never changed afterwards.
ALTER TABLE public.ai_research_runs ADD COLUMN worker_id uuid, ADD COLUMN worker_claimed_at timestamptz;

CREATE FUNCTION public.guard_ai_research_run() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI research history is append-only (DELETE on ai_research_runs)'; END IF;
  IF OLD.status NOT IN ('queued', 'running') THEN RAISE EXCEPTION 'A finished research run cannot be changed'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Research run identity cannot be changed';
  END IF;
  IF OLD.worker_id IS NOT NULL AND (NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.worker_claimed_at IS DISTINCT FROM OLD.worker_claimed_at) THEN
    RAISE EXCEPTION 'A research run worker cannot be replaced';
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
  IF NOT EXISTS (SELECT 1 FROM public.ai_research_runs r WHERE r.id = NEW.run_id AND r.status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'Research outputs can only be added while their run is in progress';
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
  IF NOT EXISTS (SELECT 1 FROM public.ai_research_runs r WHERE r.id = NEW.run_id AND r.status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'Research outputs can only be added while their run is in progress';
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
CREATE TRIGGER ai_research_stage_metrics_immutable BEFORE UPDATE OR DELETE ON public.ai_research_stage_metrics FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_stage_metrics_no_truncate BEFORE TRUNCATE ON public.ai_research_stage_metrics FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();

-- Outputs can be appended only to the owner's run while it is in progress: a stale or duplicate worker can never add
-- reports, usage or metrics to a run that has been finalized (for example closed after cancellation).
CREATE FUNCTION public.guard_ai_research_append() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_research_runs r WHERE r.id = NEW.run_id AND r.user_id = NEW.user_id AND r.status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'Research outputs can only be added while their run is in progress (% on %)', TG_OP, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_agent_outputs_append_guard BEFORE INSERT ON public.ai_agent_outputs FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();
CREATE TRIGGER ai_research_reports_append_guard BEFORE INSERT ON public.ai_research_reports FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();
CREATE TRIGGER ai_research_decisions_append_guard BEFORE INSERT ON public.ai_research_decisions FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();
CREATE TRIGGER ai_trade_proposals_append_guard BEFORE INSERT ON public.ai_trade_proposals FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();
CREATE TRIGGER ai_research_usage_append_guard BEFORE INSERT ON public.ai_research_usage FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();
CREATE TRIGGER ai_research_stage_metrics_append_guard BEFORE INSERT ON public.ai_research_stage_metrics FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_append();

-- Defence in depth: the hosted database grants anon/authenticated full table privileges by default and relies on RLS
-- (no write policies exist). TRUNCATE is not subject to RLS, so browser roles lose every write privilege outright.
-- Owner reads keep working through the existing SELECT policies; visitors lose SELECT (no anon policy exists).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ai_research_runs, public.ai_agent_outputs, public.ai_research_reports,
  public.ai_research_decisions, public.ai_trade_proposals, public.ai_research_usage, public.ai_research_stage_metrics FROM anon, authenticated;
REVOKE SELECT ON public.ai_research_runs, public.ai_agent_outputs, public.ai_research_reports, public.ai_research_decisions,
  public.ai_trade_proposals, public.ai_research_usage, public.ai_research_stage_metrics FROM anon;

REVOKE ALL ON FUNCTION public.validate_ai_decision_record(), public.validate_ai_risk_evaluation(), public.guard_ai_research_run(), public.ai_research_history_immutable(), public.guard_ai_research_append() FROM PUBLIC, anon, authenticated;

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

-- 6. Atomic research budget reservations ------------------------------------------------------------
-- Every AI provider call first reserves its projected tokens here. One transaction-scoped advisory lock serializes all
-- reservations and settlements platform-wide, so the sums each reservation checks cannot change underneath it.
-- Counted usage per row: reserved -> reserved_tokens (still in flight), consumed -> consumed_tokens, released -> 0.
-- Usage recorded before this ledger existed (ai_research_usage rows for runs with no reservations) is still counted.
-- A reservation whose worker dies stays "reserved" and keeps counting: unknown usage is never assumed to be zero.
CREATE TABLE public.ai_research_budget_reservations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                   uuid NOT NULL REFERENCES public.ai_research_runs(id),
  user_id                  uuid NOT NULL,
  worker_id                uuid NOT NULL,
  agent                    text NOT NULL CHECK (agent IN ('market','fundamentals','news','sentiment','bull','bear','manager','trader','risk_aggressive','risk_conservative','risk_neutral','portfolio')),
  kind                     text NOT NULL CHECK (kind IN ('call', 'repair')),
  reserved_tokens          bigint NOT NULL CHECK (reserved_tokens > 0),
  status                   text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
  consumed_tokens          bigint CHECK (consumed_tokens IS NULL OR consumed_tokens >= 0),
  usage_basis              text CHECK (usage_basis IS NULL OR usage_basis IN ('provider_reported', 'reservation_estimate')),
  provider_cost_usd        numeric CHECK (provider_cost_usd IS NULL OR provider_cost_usd >= 0),
  settled_after_run_closed boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  settled_at               timestamptz,
  CHECK ((status = 'reserved' AND consumed_tokens IS NULL AND settled_at IS NULL)
      OR (status = 'consumed' AND consumed_tokens IS NOT NULL AND usage_basis IS NOT NULL AND settled_at IS NOT NULL)
      OR (status = 'released' AND consumed_tokens IS NULL AND settled_at IS NOT NULL))
);
CREATE INDEX ai_research_budget_reservations_run_idx ON public.ai_research_budget_reservations (run_id);
CREATE INDEX ai_research_budget_reservations_user_idx ON public.ai_research_budget_reservations (user_id, created_at);
CREATE INDEX ai_research_budget_reservations_created_idx ON public.ai_research_budget_reservations (created_at);

-- A reservation changes exactly once (reserved -> consumed or released); nothing else about it can change.
CREATE FUNCTION public.guard_ai_research_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI research history is append-only (DELETE on ai_research_budget_reservations)'; END IF;
  IF OLD.status <> 'reserved' OR NEW.status NOT IN ('consumed', 'released') THEN RAISE EXCEPTION 'A settled research reservation cannot be changed'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.agent IS DISTINCT FROM OLD.agent OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.reserved_tokens IS DISTINCT FROM OLD.reserved_tokens OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Research reservation identity cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_research_budget_reservations_guard BEFORE UPDATE OR DELETE ON public.ai_research_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_research_reservation();
CREATE TRIGGER ai_research_budget_reservations_no_truncate BEFORE TRUNCATE ON public.ai_research_budget_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_research_history_immutable();
REVOKE ALL ON public.ai_research_budget_reservations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_research_budget_reservations TO service_role;
ALTER TABLE public.ai_research_budget_reservations ENABLE ROW LEVEL SECURITY;

-- Tokens counted against the limits since a time, for one user or (NULL) the whole platform. Caller holds the lock.
CREATE FUNCTION public.ai_research_counted_tokens(_user uuid, _since timestamptz) RETURNS bigint
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce((SELECT sum(CASE x.status WHEN 'reserved' THEN x.reserved_tokens WHEN 'consumed' THEN x.consumed_tokens ELSE 0 END)
                     FROM public.ai_research_budget_reservations x WHERE x.created_at >= _since AND (_user IS NULL OR x.user_id = _user)), 0)
       + coalesce((SELECT sum(u.input_tokens + u.output_tokens) FROM public.ai_research_usage u
                     WHERE u.created_at >= _since AND (_user IS NULL OR u.user_id = _user)
                       AND NOT EXISTS (SELECT 1 FROM public.ai_research_budget_reservations x WHERE x.run_id = u.run_id)), 0)
$$;

-- The worker that executes a run claims it once; a second or stale worker is refused.
CREATE FUNCTION public.claim_ai_research_worker(_run uuid, _user uuid, _worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n integer;
BEGIN
  IF _run IS NULL OR _user IS NULL OR _worker IS NULL THEN RAISE EXCEPTION 'Invalid research worker claim'; END IF;
  UPDATE public.ai_research_runs SET worker_id = _worker, worker_claimed_at = now()
   WHERE id = _run AND user_id = _user AND status = 'running' AND worker_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- Reserve before every AI call. Returns {ok:true, reservation_id} or {ok:false, stopped_by, reason}; nothing is
-- reserved when it refuses. Limits come from ai_research_budget_config, or the built-in defaults when none are saved
-- (these mirror DEFAULT_RESEARCH_BUDGET in src/lib/research-budget.ts; a test keeps them equal).
CREATE FUNCTION public.reserve_ai_research_budget(_run uuid, _user uuid, _worker uuid, _agent text, _kind text, _tokens bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r public.ai_research_runs%ROWTYPE;
  c public.ai_research_budget_config%ROWTYPE;
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  lim_run bigint; lim_day bigint; lim_month bigint; lim_platform bigint; lim_calls integer; lim_repairs integer; lim_secs integer;
  lim_run_usd numeric; lim_platform_usd numeric;
  run_used bigint; run_calls integer; run_repairs integer; run_usd numeric; platform_usd numeric; rid uuid;
  refuse CONSTANT text := 'No further AI calls were made.';
BEGIN
  IF _run IS NULL OR _user IS NULL OR _worker IS NULL OR _tokens IS NULL OR _tokens <= 0 OR _tokens > 2000000 THEN RAISE EXCEPTION 'Invalid research reservation'; END IF;
  IF _kind IS NULL OR _kind NOT IN ('call', 'repair') THEN RAISE EXCEPTION 'Invalid research reservation kind'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_research_budget_reservations', 0));
  SELECT * INTO r FROM public.ai_research_runs WHERE id = _run FOR UPDATE;
  IF NOT FOUND OR r.user_id IS DISTINCT FROM _user THEN RAISE EXCEPTION 'Research run not found for this owner'; END IF;
  IF r.status <> 'running' THEN RETURN jsonb_build_object('ok', false, 'stopped_by', 'run_closed', 'reason', 'This research run has already finished. ' || refuse); END IF;
  IF r.worker_id IS DISTINCT FROM _worker THEN RETURN jsonb_build_object('ok', false, 'stopped_by', 'run_closed', 'reason', 'This research run belongs to another worker. ' || refuse); END IF;
  IF EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.user_id = _user AND a.action = 'ai_research_cancel_requested' AND a.entity_id = _run) THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'cancelled', 'reason', 'Cancelled by you. No further AI calls were made; completed reports are kept.');
  END IF;
  SELECT * INTO c FROM public.ai_research_budget_config WHERE id;
  lim_run := coalesce(c.per_run_tokens, 250000); lim_day := coalesce(c.per_user_day_tokens, 600000);
  lim_month := coalesce(c.per_user_month_tokens, 3000000); lim_platform := coalesce(c.platform_month_tokens, 20000000);
  lim_calls := coalesce(c.max_calls_per_run, 16); lim_repairs := coalesce(c.max_repairs_per_run, 3); lim_secs := coalesce(c.max_run_seconds, 1200);
  lim_run_usd := c.per_run_usd; lim_platform_usd := c.platform_month_usd;
  IF now() - r.created_at > make_interval(secs => lim_secs) THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'max_duration', 'reason', format('Time limit reached: this run passed the %s-minute maximum. ', round(lim_secs / 60.0)) || refuse);
  END IF;
  SELECT coalesce(sum(CASE x.status WHEN 'reserved' THEN x.reserved_tokens WHEN 'consumed' THEN x.consumed_tokens ELSE 0 END), 0),
         count(*) FILTER (WHERE x.status <> 'released'), count(*) FILTER (WHERE x.kind = 'repair' AND x.status <> 'released'), sum(x.provider_cost_usd)
    INTO run_used, run_calls, run_repairs, run_usd FROM public.ai_research_budget_reservations x WHERE x.run_id = _run;
  IF run_calls + 1 > lim_calls THEN RETURN jsonb_build_object('ok', false, 'stopped_by', 'max_calls', 'reason', format('Call limit reached: this run already made %s AI calls. ', lim_calls) || refuse); END IF;
  IF _kind = 'repair' AND run_repairs + 1 > lim_repairs THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'max_repairs', 'reason', format('Format correction not attempted: this run reached its limit of %s corrections', lim_repairs));
  END IF;
  IF run_used + _tokens > lim_run THEN RETURN jsonb_build_object('ok', false, 'stopped_by', 'per_run_tokens', 'reason', format('Spending limit reached: this call could exceed the per-run limit of %s tokens. ', to_char(lim_run, 'FM999,999,999,999')) || refuse); END IF;
  IF public.ai_research_counted_tokens(_user, day_start) + _tokens > lim_day THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'user_day_tokens', 'reason', format('Spending limit reached: your daily research limit of %s tokens would be exceeded. ', to_char(lim_day, 'FM999,999,999,999')) || refuse);
  END IF;
  IF public.ai_research_counted_tokens(_user, month_start) + _tokens > lim_month THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'user_month_tokens', 'reason', format('Spending limit reached: your monthly research limit of %s tokens would be exceeded. ', to_char(lim_month, 'FM999,999,999,999')) || refuse);
  END IF;
  IF public.ai_research_counted_tokens(NULL, month_start) + _tokens > lim_platform THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'platform_month_tokens', 'reason', 'Spending limit reached: the platform''s monthly AI research limit would be exceeded. ' || refuse);
  END IF;
  -- USD limits apply only to provider-reported costs; no price is ever assumed.
  IF lim_run_usd IS NOT NULL AND run_usd IS NOT NULL AND run_usd >= lim_run_usd THEN
    RETURN jsonb_build_object('ok', false, 'stopped_by', 'per_run_usd', 'reason', format('Spending limit reached: provider-reported cost for this run reached $%s. ', lim_run_usd) || refuse);
  END IF;
  IF lim_platform_usd IS NOT NULL THEN
    SELECT sum(x.provider_cost_usd) INTO platform_usd FROM public.ai_research_budget_reservations x WHERE x.created_at >= month_start;
    IF platform_usd IS NOT NULL AND platform_usd >= lim_platform_usd THEN
      RETURN jsonb_build_object('ok', false, 'stopped_by', 'platform_month_usd', 'reason', 'Spending limit reached: provider-reported platform cost for this month reached its limit. ' || refuse);
    END IF;
  END IF;
  INSERT INTO public.ai_research_budget_reservations (run_id, user_id, worker_id, agent, kind, reserved_tokens)
  VALUES (_run, _user, _worker, _agent, _kind, _tokens) RETURNING id INTO rid;
  RETURN jsonb_build_object('ok', true, 'reservation_id', rid);
END $$;

-- After a provider call (success or failure). With provider-reported tokens the first reservation of the group takes the
-- actual total (repair reservations of the same call record 0); without them every reservation is consumed in full
-- (usage unknown, never assumed lower). Allowed after the run closed so an in-flight call is still accounted, flagged.
CREATE FUNCTION public.settle_ai_research_budget(_reservations uuid[], _worker uuid, _consumed_tokens bigint, _cost_usd numeric) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n integer;
BEGIN
  IF _reservations IS NULL OR cardinality(_reservations) = 0 OR _worker IS NULL THEN RAISE EXCEPTION 'Invalid research settlement'; END IF;
  IF _consumed_tokens IS NOT NULL AND _consumed_tokens < 0 OR _cost_usd IS NOT NULL AND _cost_usd < 0 THEN RAISE EXCEPTION 'Invalid research usage'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_research_budget_reservations', 0));
  UPDATE public.ai_research_budget_reservations x SET
    status = 'consumed',
    consumed_tokens = CASE WHEN _consumed_tokens IS NULL THEN x.reserved_tokens WHEN x.id = _reservations[1] THEN _consumed_tokens ELSE 0 END,
    usage_basis = CASE WHEN _consumed_tokens IS NULL THEN 'reservation_estimate' ELSE 'provider_reported' END,
    provider_cost_usd = CASE WHEN x.id = _reservations[1] THEN _cost_usd END,
    settled_at = now(),
    settled_after_run_closed = (SELECT r.status NOT IN ('queued', 'running') FROM public.ai_research_runs r WHERE r.id = x.run_id)
  WHERE x.id = ANY(_reservations) AND x.worker_id = _worker AND x.status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(_reservations) THEN RAISE EXCEPTION 'Research reservation already settled or owned by another worker'; END IF;
  RETURN n;
END $$;

-- A reservation whose call was never sent (for example the run was cancelled right after reserving).
CREATE FUNCTION public.release_ai_research_budget(_reservation uuid, _worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_research_budget_reservations', 0));
  UPDATE public.ai_research_budget_reservations SET status = 'released', settled_at = now()
   WHERE id = _reservation AND worker_id = _worker AND status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Research reservation already settled or owned by another worker'; END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.ai_research_counted_tokens(uuid, timestamptz), public.guard_ai_research_reservation(),
  public.claim_ai_research_worker(uuid, uuid, uuid), public.reserve_ai_research_budget(uuid, uuid, uuid, text, text, bigint),
  public.settle_ai_research_budget(uuid[], uuid, bigint, numeric), public.release_ai_research_budget(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_research_worker(uuid, uuid, uuid), public.reserve_ai_research_budget(uuid, uuid, uuid, text, text, bigint),
  public.settle_ai_research_budget(uuid[], uuid, bigint, numeric), public.release_ai_research_budget(uuid, uuid) TO service_role;
