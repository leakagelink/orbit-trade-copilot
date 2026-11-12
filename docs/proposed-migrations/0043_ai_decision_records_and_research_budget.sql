-- =====================================================================================================
-- 0043 — DRAFT ONLY. NOT APPLIED. Requires separate owner approval.
-- Phase 1 (TradingAgents TypeScript enhancement): immutable AI decision records + research spending limits.
--
-- Guarantees
--  * ai_decision_records is insert-only for the backend. No role (including service_role and the table owner
--    through normal DML) can UPDATE, DELETE or TRUNCATE it; triggers reject those statements.
--  * Browser roles can only read their own records; they cannot insert, change or delete anything.
--  * The database computes each record's SHA-256 fingerprint and timestamp itself; the app cannot supply them.
--  * Existing research output tables become append-only (they are only ever inserted today).
--  * Research spending limits are changed only by admins through one RPC; every change is kept in an
--    append-only history.
--  * No trading, order, position, risk-setting or emergency-stop object is touched.
-- =====================================================================================================

-- 1. Immutable decision records ----------------------------------------------------------------------
CREATE TABLE public.ai_decision_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL UNIQUE,
  user_id        uuid NOT NULL,
  market         text NOT NULL CHECK (market IN ('crypto', 'equity')),
  symbol         text NOT NULL,
  timeframe      text NOT NULL CHECK (timeframe = '1d'),
  outcome        text NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed', 'stopped_by_budget')),
  decided_at     timestamptz NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  record         jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  record_sha256  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_decision_records_user_idx ON public.ai_decision_records (user_id, created_at DESC);

CREATE FUNCTION public.validate_ai_decision_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  IF jsonb_typeof(NEW.record->'agents') <> 'array' OR jsonb_array_length(NEW.record->'agents') <> 12
     OR (SELECT array_agg(a->>'agent' ORDER BY o) FROM jsonb_array_elements(NEW.record->'agents') WITH ORDINALITY AS t(a, o)) IS DISTINCT FROM agents THEN
    RAISE EXCEPTION 'Decision record must contain all 12 agents in order';
  END IF;
  NEW.created_at := now();
  NEW.record_sha256 := encode(sha256(convert_to(NEW.record::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE FUNCTION public.ai_research_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN RAISE EXCEPTION 'AI research history is append-only (% on %)', TG_OP, TG_TABLE_NAME; END $$;

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
REVOKE ALL ON FUNCTION public.validate_ai_decision_record(), public.ai_research_history_immutable() FROM PUBLIC, anon, authenticated;

-- 2. Existing research outputs become append-only (the app only inserts into them) -------------------
CREATE TRIGGER ai_agent_outputs_immutable BEFORE UPDATE OR DELETE ON public.ai_agent_outputs FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_reports_immutable BEFORE UPDATE OR DELETE ON public.ai_research_reports FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_decisions_immutable BEFORE UPDATE OR DELETE ON public.ai_research_decisions FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_trade_proposals_immutable BEFORE UPDATE OR DELETE ON public.ai_trade_proposals FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();
CREATE TRIGGER ai_research_usage_immutable BEFORE UPDATE OR DELETE ON public.ai_research_usage FOR EACH ROW EXECUTE FUNCTION public.ai_research_history_immutable();

-- 3. Research spending limits (admin-configurable, history kept) ------------------------------------
CREATE TABLE public.ai_research_budget_config (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  per_run_tokens        integer NOT NULL CHECK (per_run_tokens BETWEEN 10000 AND 2000000),
  per_user_month_tokens bigint  NOT NULL CHECK (per_user_month_tokens BETWEEN 10000 AND 500000000),
  platform_month_tokens bigint  NOT NULL CHECK (platform_month_tokens BETWEEN 10000 AND 5000000000),
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
REVOKE ALL ON public.ai_research_budget_config, public.ai_research_budget_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_research_budget_config TO authenticated;
GRANT ALL ON public.ai_research_budget_config TO service_role;
GRANT SELECT, INSERT ON public.ai_research_budget_events TO service_role;
ALTER TABLE public.ai_research_budget_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_research_budget_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_research_budget_read ON public.ai_research_budget_config FOR SELECT TO authenticated USING (true);

CREATE FUNCTION public.set_ai_research_budget(_per_run_tokens integer, _per_user_month_tokens bigint, _platform_month_tokens bigint, _per_run_usd numeric, _platform_month_usd numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'Only an admin can change research spending limits';
  END IF;
  INSERT INTO public.ai_research_budget_config (id, per_run_tokens, per_user_month_tokens, platform_month_tokens, per_run_usd, platform_month_usd, updated_by, updated_at)
  VALUES (true, _per_run_tokens, _per_user_month_tokens, _platform_month_tokens, _per_run_usd, _platform_month_usd, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE SET per_run_tokens = EXCLUDED.per_run_tokens, per_user_month_tokens = EXCLUDED.per_user_month_tokens,
    platform_month_tokens = EXCLUDED.platform_month_tokens, per_run_usd = EXCLUDED.per_run_usd, platform_month_usd = EXCLUDED.platform_month_usd,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.ai_research_budget_events (changed_by, config) VALUES (auth.uid(), jsonb_build_object(
    'per_run_tokens', _per_run_tokens, 'per_user_month_tokens', _per_user_month_tokens, 'platform_month_tokens', _platform_month_tokens,
    'per_run_usd', _per_run_usd, 'platform_month_usd', _platform_month_usd));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.set_ai_research_budget(integer, bigint, bigint, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ai_research_budget(integer, bigint, bigint, numeric, numeric) TO authenticated, service_role;
