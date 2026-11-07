CREATE TABLE public.ai_research_runs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, symbol text NOT NULL, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','partial','failed')), snapshot jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(id,user_id)
);
GRANT SELECT ON public.ai_research_runs TO authenticated;
GRANT ALL ON public.ai_research_runs TO service_role;
ALTER TABLE public.ai_research_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_read ON public.ai_research_runs FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.ai_agent_outputs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, user_id uuid NOT NULL, agent text NOT NULL CHECK(agent IN ('market','fundamentals')), status text NOT NULL CHECK(status IN ('completed','unavailable','failed')), report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,agent), FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id)
);
GRANT SELECT ON public.ai_agent_outputs TO authenticated;
GRANT ALL ON public.ai_agent_outputs TO service_role;
ALTER TABLE public.ai_agent_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY analyst_read ON public.ai_agent_outputs FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.ai_research_usage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, user_id uuid NOT NULL, agent text NOT NULL, model text NOT NULL, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,agent), FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id)
);
GRANT SELECT ON public.ai_research_usage TO authenticated;
GRANT ALL ON public.ai_research_usage TO service_role;
ALTER TABLE public.ai_research_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_read ON public.ai_research_usage FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE INDEX research_owner_history ON public.ai_research_runs(user_id,created_at DESC);
CREATE FUNCTION public.claim_ai_research(_id uuid,_user_id uuid,_symbol text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(_user_id::text,0));
 IF EXISTS(SELECT 1 FROM public.ai_research_runs WHERE id=_id) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.ai_research_runs WHERE user_id=_user_id AND status='running' AND created_at>now()-interval '10 minutes') THEN RAISE EXCEPTION 'A research run is already in progress'; END IF;
 INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES(_id,_user_id,_symbol);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_ai_research(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_research(uuid,uuid,text) TO service_role;