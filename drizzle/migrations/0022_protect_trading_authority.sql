REVOKE INSERT, UPDATE, DELETE ON public.trading_bots FROM authenticated;
REVOKE UPDATE ON public.exchange_connections FROM authenticated;
GRANT SELECT ON public.trading_bots, public.exchange_connections TO authenticated;
GRANT ALL ON public.trading_bots, public.exchange_connections TO service_role;
CREATE FUNCTION public.enforce_bot_owner_references() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.exchange_connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exchange_connections c WHERE c.id=NEW.exchange_connection_id AND c.user_id=NEW.user_id AND c.exchange=NEW.exchange) THEN RAISE EXCEPTION 'Bot connection owner or exchange mismatch'; END IF;
 IF NEW.strategy_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.strategies s WHERE s.id=NEW.strategy_id AND s.user_id=NEW.user_id) THEN RAISE EXCEPTION 'Bot strategy owner mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_owner_references BEFORE INSERT OR UPDATE ON public.trading_bots FOR EACH ROW EXECUTE FUNCTION public.enforce_bot_owner_references();
ALTER TABLE public.ai_trade_proposals ADD CONSTRAINT proposal_required_safety_flags CHECK (jsonb_typeof(proposal)='object' AND proposal ? 'advisoryOnly' AND proposal ? 'executionAllowed' AND jsonb_typeof(proposal->'advisoryOnly')='boolean' AND jsonb_typeof(proposal->'executionAllowed')='boolean' AND (proposal->>'advisoryOnly')::boolean IS TRUE AND (proposal->>'executionAllowed')::boolean IS FALSE) NOT VALID;
ALTER TABLE public.ai_trade_proposals VALIDATE CONSTRAINT proposal_required_safety_flags;