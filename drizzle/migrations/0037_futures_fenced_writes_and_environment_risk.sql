CREATE OR REPLACE FUNCTION public.set_execution_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE derived text; is_test boolean; original_id uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.execution_environment IS DISTINCT FROM OLD.execution_environment THEN RAISE EXCEPTION 'Execution environment is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.mode='paper' THEN derived:='paper';
 ELSE
  IF TG_TABLE_NAME='trades' THEN
   original_id := (to_jsonb(NEW)->>'order_id')::uuid;
   SELECT execution_environment INTO derived FROM public.orders WHERE id=original_id;
  END IF;
  IF derived IS NULL OR derived='legacy_unknown' THEN
   SELECT is_testnet INTO is_test FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
   derived:=CASE WHEN is_test IS NULL THEN 'legacy_unknown' WHEN is_test THEN 'testnet' ELSE 'production' END;
  END IF;
 END IF;
 IF NEW.execution_environment IS NULL THEN NEW.execution_environment:=derived;
 ELSIF NEW.execution_environment<>derived AND derived<>'legacy_unknown' THEN RAISE EXCEPTION 'Execution environment does not match the trading account'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_execution_environment() FROM PUBLIC;

CREATE FUNCTION public.futures_write_position(_position uuid,_holder uuid,_fence bigint,_patch jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p public.positions%ROWTYPE; l public.futures_execution_leases%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.positions WHERE id=_position AND market_type='usd_m_futures' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Futures position unavailable'; END IF;
 SELECT * INTO l FROM public.futures_execution_leases WHERE connection_id=p.exchange_connection_id FOR UPDATE;
 IF NOT FOUND OR l.holder<>_holder OR l.fence<>_fence OR l.expires_at<=now() THEN RAISE EXCEPTION 'Execution fence lost'; END IF;
 UPDATE public.positions SET
  entry_price=coalesce((_patch->>'entry_price')::numeric,entry_price), quantity=coalesce((_patch->>'quantity')::numeric,quantity),
  current_price=coalesce((_patch->>'current_price')::numeric,current_price), unrealized_pnl=coalesce((_patch->>'unrealized_pnl')::numeric,unrealized_pnl),
  stop_loss=coalesce((_patch->>'stop_loss')::numeric,stop_loss),take_profit=coalesce((_patch->>'take_profit')::numeric,take_profit),
  futures_details=CASE WHEN _patch ? 'futures_details' THEN _patch->'futures_details' ELSE futures_details END WHERE id=_position;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.futures_write_position(uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.futures_write_position(uuid,uuid,bigint,jsonb) TO service_role;

-- Futures budgets are isolated by immutable environment. Spot retains the original central gate behavior.
CREATE OR REPLACE FUNCTION public.guard_new_entry_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.risk_settings%ROWTYPE; exposure numeric; reserved numeric; position_count integer; pending_count integer; pnl numeric; env text;
BEGIN
 IF NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 IF NEW.price IS NULL OR NEW.price<=0 OR NEW.quantity<=0 THEN RAISE EXCEPTION 'Entry intent requires a positive verified reference price and quantity'; END IF;
 SELECT * INTO r FROM public.risk_settings WHERE user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Risk settings required before an entry'; END IF;
 IF r.trading_halted THEN RAISE EXCEPTION 'Trading is halted'; END IF;
 env:=CASE WHEN NEW.market_type='usd_m_futures' THEN NEW.execution_environment ELSE NULL END;
 IF env IS NOT NULL AND env NOT IN ('testnet','production') THEN RAISE EXCEPTION 'Futures environment unavailable'; END IF;
 IF env IS NOT NULL AND EXISTS(SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND execution_environment='legacy_unknown') THEN RAISE EXCEPTION 'Legacy Futures exposure requires reconciliation'; END IF;
 SELECT count(*),coalesce(sum(entry_price*quantity),0) INTO position_count,exposure FROM public.positions WHERE user_id=NEW.user_id AND is_open AND (env IS NULL OR execution_environment=env);
 SELECT count(*),coalesce(sum(quantity*price),0) INTO pending_count,reserved FROM public.orders WHERE user_id=NEW.user_id AND status IN ('pending','open','partially_filled') AND idempotency_key NOT LIKE '%:exit:%' AND (env IS NULL OR execution_environment=env);
 IF r.max_total_positions IS NOT NULL AND position_count+pending_count>=r.max_total_positions THEN RAISE EXCEPTION 'Account position limit reached including pending intents'; END IF;
 IF r.max_open_exposure IS NOT NULL AND exposure+reserved+NEW.quantity*NEW.price>r.max_open_exposure THEN RAISE EXCEPTION 'Account exposure limit reached including pending intents'; END IF;
 SELECT coalesce(sum(net_pnl),0) INTO pnl FROM public.trades WHERE user_id=NEW.user_id AND closed_at>=date_trunc('day',now()) AND (env IS NULL OR execution_environment=env);
 SELECT pnl+coalesce(sum(least(unrealized_pnl,0)),0) INTO pnl FROM public.positions WHERE user_id=NEW.user_id AND is_open AND (env IS NULL OR execution_environment=env);
 IF r.max_daily_loss IS NOT NULL AND pnl<=-r.max_daily_loss THEN RAISE EXCEPTION 'Account loss limit reached'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_new_entry_intent() FROM PUBLIC;
