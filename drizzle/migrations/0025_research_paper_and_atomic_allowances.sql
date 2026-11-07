CREATE TABLE public.ai_research_allowances (
 user_id uuid NOT NULL, period date NOT NULL, run_limit integer NOT NULL DEFAULT 10 CHECK(run_limit BETWEEN 1 AND 1000), used integer NOT NULL DEFAULT 0 CHECK(used >= 0), PRIMARY KEY(user_id,period)
);
GRANT SELECT ON public.ai_research_allowances TO authenticated;
GRANT ALL ON public.ai_research_allowances TO service_role;
ALTER TABLE public.ai_research_allowances ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_allowance_owner ON public.ai_research_allowances FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE OR REPLACE FUNCTION public.claim_ai_research(_id uuid,_user_id uuid,_symbol text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p date := date_trunc('month',now() AT TIME ZONE 'UTC')::date; lim integer; consumed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(_user_id::text,0));
 IF EXISTS(SELECT 1 FROM public.ai_research_runs WHERE id=_id AND user_id=_user_id AND symbol=_symbol) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.ai_research_runs WHERE id=_id) THEN RAISE EXCEPTION 'Research request belongs to a different owner or symbol'; END IF;
 IF NOT public.has_pro_access(_user_id) THEN RAISE EXCEPTION 'Paid access required'; END IF;
 IF _symbol NOT IN ('BTC-USD','ETH-USD','SOL-USD','AAPL','MSFT','RELIANCE.NS','TCS.NS') THEN RAISE EXCEPTION 'Unsupported research symbol'; END IF;
 IF EXISTS(SELECT 1 FROM public.ai_research_runs WHERE user_id=_user_id AND status='running') THEN RAISE EXCEPTION 'A research run is already in progress; inspect its outcome first'; END IF;
 INSERT INTO public.ai_research_allowances(user_id,period,run_limit,used) SELECT _user_id,p,CASE WHEN public.has_elite_access(_user_id) THEN 30 ELSE 10 END,count(*) FROM public.ai_research_runs WHERE user_id=_user_id AND created_at >= p::timestamp AT TIME ZONE 'UTC' ON CONFLICT DO NOTHING;
 SELECT run_limit,used INTO lim,consumed FROM public.ai_research_allowances WHERE user_id=_user_id AND period=p FOR UPDATE;
 IF consumed >= lim THEN RAISE EXCEPTION 'Monthly research allowance reached'; END IF;
 INSERT INTO public.ai_research_runs(id,user_id,symbol) VALUES(_id,_user_id,_symbol);
 UPDATE public.ai_research_allowances SET used=used+1 WHERE user_id=_user_id AND period=p;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_ai_research(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_research(uuid,uuid,text) TO service_role;
COMMENT ON TABLE public.ai_research_allowances IS 'UTC-month bounded research runs. Claimed attempts consume capacity even on unknown or failed inference; usage tokens remain separate. Defaults: Pro 10, Elite 30. No automatic retries.';
CREATE TABLE public.ai_research_paper (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL UNIQUE REFERENCES public.ai_trade_proposals(id), user_id uuid NOT NULL, run_id uuid NOT NULL,
 symbol text NOT NULL, mode text NOT NULL DEFAULT 'paper' CHECK(mode='paper'), quantity numeric NOT NULL CHECK(quantity>0 AND quantity<=1000000), fee_pct numeric NOT NULL CHECK(fee_pct BETWEEN 0.01 AND 5), slippage_pct numeric NOT NULL CHECK(slippage_pct BETWEEN 0.01 AND 5),
 confirmed_at timestamptz NOT NULL DEFAULT now(), proposal jsonb NOT NULL CHECK(proposal->>'advisoryOnly'='true' AND proposal->>'executionAllowed'='false'),
 FOREIGN KEY(run_id,user_id) REFERENCES public.ai_research_runs(id,user_id)
);
GRANT SELECT ON public.ai_research_paper TO authenticated;
GRANT ALL ON public.ai_research_paper TO service_role;
ALTER TABLE public.ai_research_paper ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_paper_owner ON public.ai_research_paper FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE TABLE public.ai_research_paper_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), paper_id uuid NOT NULL REFERENCES public.ai_research_paper(id), user_id uuid NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), result jsonb NOT NULL, evidence jsonb NOT NULL
);
GRANT SELECT ON public.ai_research_paper_observations TO authenticated;
GRANT ALL ON public.ai_research_paper_observations TO service_role;
ALTER TABLE public.ai_research_paper_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_observations_owner ON public.ai_research_paper_observations FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE FUNCTION public.protect_research_paper() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Research paper evidence is append-only'; END IF;
 IF TG_TABLE_NAME='ai_research_paper' THEN
 IF NOT EXISTS(SELECT 1 FROM public.ai_trade_proposals p WHERE p.id=NEW.proposal_id AND p.user_id=NEW.user_id AND p.run_id=NEW.run_id AND p.proposal=NEW.proposal) THEN RAISE EXCEPTION 'Paper confirmation owner or proposal mismatch'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.ai_research_paper p WHERE p.id=NEW.paper_id AND p.user_id=NEW.user_id) THEN RAISE EXCEPTION 'Paper observation owner mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_paper_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_research_paper FOR EACH ROW EXECUTE FUNCTION public.protect_research_paper();
CREATE TRIGGER research_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_research_paper_observations FOR EACH ROW EXECUTE FUNCTION public.protect_research_paper();
CREATE INDEX research_paper_history ON public.ai_research_paper(user_id,confirmed_at DESC);
CREATE INDEX research_observation_history ON public.ai_research_paper_observations(paper_id,observed_at DESC);
COMMENT ON TABLE public.ai_research_paper IS 'Explicit user-sized isolated forward paper research; no wallet, orders, credentials or live execution. Confirmation snapshots are immutable.';
CREATE TABLE public.trading_safety_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, action text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.trading_safety_events TO authenticated;
GRANT ALL ON public.trading_safety_events TO service_role;
ALTER TABLE public.trading_safety_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY safety_event_owner ON public.trading_safety_events FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE FUNCTION public.safety_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Safety events are append-only'; END $$;
CREATE TRIGGER safety_event_guard BEFORE UPDATE OR DELETE ON public.trading_safety_events FOR EACH ROW EXECUTE FUNCTION public.safety_event_immutable();