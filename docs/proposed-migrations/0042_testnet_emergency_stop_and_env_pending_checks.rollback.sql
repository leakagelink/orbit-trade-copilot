-- Rollback for DRAFT 0042 (not applied). Restores the two guard functions exactly as they are live today
-- (captured 2026-11-12) and removes the Testnet stop objects. Export testnet_emergency_events first: dropping
-- them deletes the Testnet stop history. After rollback a Testnet stop no longer blocks anything in the database.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_new_entry_intent()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
END $function$;
CREATE OR REPLACE FUNCTION public.guard_futures_live_intent()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c public.exchange_connections%ROWTYPE;
BEGIN
 IF NEW.market_type <> 'usd_m_futures' OR NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 SELECT * INTO c FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
 IF NOT FOUND OR c.exchange<>'binance' OR c.status<>'connected' THEN RAISE EXCEPTION 'Verified owner Binance connection required'; END IF;
 IF NOT c.is_testnet AND NOT public.futures_live_authorized(NEW.user_id, c.id) THEN
  RAISE EXCEPTION 'Production Futures requires live opt-in, no halt and a current PASS certification for this account';
 END IF;
 IF EXISTS (SELECT 1 FROM public.positions WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND is_open AND coalesce(futures_details->>'protection','')<>'confirmed') THEN
  RAISE EXCEPTION 'Unresolved Futures exposure blocks new entries';
 END IF;
 IF EXISTS (SELECT 1 FROM public.orders WHERE user_id=NEW.user_id AND market_type='usd_m_futures' AND status IN ('pending','open','partially_filled')) THEN
  RAISE EXCEPTION 'Unresolved Futures order intent blocks new entries';
 END IF;
 RETURN NEW;
END $function$;
DROP FUNCTION public.testnet_emergency_halt(uuid, text);
DROP FUNCTION public.testnet_emergency_release(uuid);
DROP FUNCTION public.testnet_futures_limits();
DROP TABLE public.testnet_emergency_events;
DROP TABLE public.testnet_emergency_stops;
COMMIT;
