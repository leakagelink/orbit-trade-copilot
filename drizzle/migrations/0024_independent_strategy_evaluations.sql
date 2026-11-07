CREATE TABLE public.strategy_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,strategy_id uuid NOT NULL,backtest_id uuid NOT NULL,
 model_version text NOT NULL,mode text NOT NULL CHECK(mode IN ('backtest','paper','live')),status text NOT NULL CHECK(status IN ('INSUFFICIENT_DATA','REJECTED','SCORED')),
 evidence_hash text, report jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(strategy_id) REFERENCES public.strategies(id),FOREIGN KEY(backtest_id) REFERENCES public.backtests(id)
);
GRANT SELECT ON public.strategy_evaluations TO authenticated;
GRANT ALL ON public.strategy_evaluations TO service_role;
ALTER TABLE public.strategy_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY evaluation_owner_read ON public.strategy_evaluations FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE FUNCTION public.prevent_evaluation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Evaluation evidence is append-only'; END $$;
CREATE TRIGGER evaluations_append_only BEFORE UPDATE OR DELETE ON public.strategy_evaluations FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();
COMMENT ON TABLE public.strategy_evaluations IS 'Independent deterministic evaluations; no agent writes, no live execution authority, immutable evaluation history';