CREATE TABLE public.ai_research_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, user_id uuid NOT NULL, agent text NOT NULL CHECK(agent IN ('news','sentiment','bull','bear','manager')), status text NOT NULL CHECK(status IN ('completed','unavailable','failed')), report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,agent), FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id)
);
GRANT SELECT ON public.ai_research_reports TO authenticated;
GRANT ALL ON public.ai_research_reports TO service_role;
ALTER TABLE public.ai_research_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY phase_two_owner_read ON public.ai_research_reports FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
ALTER TABLE public.ai_research_runs ADD COLUMN research_evidence jsonb;
COMMENT ON COLUMN public.ai_research_runs.research_evidence IS 'Server-fetched news provenance and explicit social-data availability for advisory research';