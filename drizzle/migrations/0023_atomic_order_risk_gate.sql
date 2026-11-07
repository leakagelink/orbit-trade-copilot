CREATE FUNCTION public.guard_new_entry_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.risk_settings%ROWTYPE; exposure numeric; reserved numeric; position_count integer; pending_count integer; pnl numeric;
BEGIN
 IF NEW.idempotency_key LIKE '%:exit:%' THEN RETURN NEW; END IF;
 IF NEW.price IS NULL OR NEW.price<=0 OR NEW.quantity<=0 THEN RAISE EXCEPTION 'Entry intent requires a positive verified reference price and quantity'; END IF;
 SELECT * INTO r FROM public.risk_settings WHERE user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Risk settings required before an entry'; END IF;
 IF r.trading_halted THEN RAISE EXCEPTION 'Trading is halted'; END IF;
 SELECT count(*),coalesce(sum(entry_price*quantity),0) INTO position_count,exposure FROM public.positions WHERE user_id=NEW.user_id AND is_open;
 SELECT count(*),coalesce(sum(quantity*price),0) INTO pending_count,reserved FROM public.orders WHERE user_id=NEW.user_id AND status IN ('pending','open','partially_filled') AND idempotency_key NOT LIKE '%:exit:%';
 IF r.max_total_positions IS NOT NULL AND position_count+pending_count>=r.max_total_positions THEN RAISE EXCEPTION 'Account position limit reached including pending intents'; END IF;
 IF r.max_open_exposure IS NOT NULL AND exposure+reserved+NEW.quantity*NEW.price>r.max_open_exposure THEN RAISE EXCEPTION 'Account exposure limit reached including pending intents'; END IF;
 SELECT coalesce(sum(realized_pnl-fees),0) INTO pnl FROM public.trades WHERE user_id=NEW.user_id AND closed_at>=date_trunc('day',now());
 SELECT pnl+coalesce(sum(least(unrealized_pnl,0)),0) INTO pnl FROM public.positions WHERE user_id=NEW.user_id AND is_open;
 IF r.max_daily_loss IS NOT NULL AND pnl<=-r.max_daily_loss THEN RAISE EXCEPTION 'Account loss limit reached'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_new_entry_intent() FROM PUBLIC;
CREATE TRIGGER entry_intent_risk_gate BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_new_entry_intent();