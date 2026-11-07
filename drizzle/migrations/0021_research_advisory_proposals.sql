CREATE TABLE public.ai_research_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, user_id uuid NOT NULL,
 agent text NOT NULL CHECK (agent IN ('trader','risk_aggressive','risk_conservative','risk_neutral','portfolio')),
 status text NOT NULL CHECK(status IN ('completed','unavailable','failed')), report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,agent),
 FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id)
);
GRANT SELECT ON public.ai_research_decisions TO authenticated;
GRANT ALL ON public.ai_research_decisions TO service_role;
ALTER TABLE public.ai_research_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY decision_owner_read ON public.ai_research_decisions FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.ai_trade_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, user_id uuid NOT NULL,
 proposal jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id),
 FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id),
 CONSTRAINT proposal_advisory_only CHECK(proposal->>'advisoryOnly' = 'true' AND proposal->>'executionAllowed' = 'false')
);
GRANT SELECT ON public.ai_trade_proposals TO authenticated;
GRANT ALL ON public.ai_trade_proposals TO service_role;
ALTER TABLE public.ai_trade_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_owner_read ON public.ai_trade_proposals FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
COMMENT ON TABLE public.ai_trade_proposals IS 'Owner-private historical research scenarios; never executable orders or authorization to trade';